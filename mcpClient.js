/**
 * guIDE MCP Client — Model Context Protocol client for external tool servers.
 * Connects to MCP servers via stdio transport, discovers tools, and routes execution.
 * Copyright (c) 2025-2026 Brendan Gray (GitHub: FileShot)
 * All Rights Reserved. See LICENSE for terms.
 *
 * Config format (mcp_config.json in project root):
 * {
 *   "mcpServers": {
 *     "server-name": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
 *       "env": {}
 *     }
 *   }
 * }
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class MCPClient {
  constructor(options = {}) {
    this.projectPath = options.projectPath || process.cwd();
    this._servers = new Map(); // serverName → { process, tools, status, config }
    this._toolServerMap = new Map(); // toolName → serverName
    this._discoveredTools = []; // merged tool definitions from all servers
    this._onLog = options.onLog || (() => {});
    this._onToolsChanged = options.onToolsChanged || null;
    this._shuttingDown = false;
  }

  // ─── Config Loading ──────────────────────────────────────────────────────

  /**
   * Load MCP server config from mcp_config.json in the project root.
   * Returns the parsed config or null if not found.
   */
  loadConfig() {
    const configPaths = [
      path.join(this.projectPath, 'mcp_config.json'),
      path.join(this.projectPath, '.guide', 'mcp_config.json'),
    ];
    for (const configPath of configPaths) {
      if (fs.existsSync(configPath)) {
        try {
          const raw = fs.readFileSync(configPath, 'utf8');
          const config = JSON.parse(raw);
          this._onLog(`[MCPClient] Loaded config from ${configPath}`);
          return config;
        } catch (e) {
          this._onLog(`[MCPClient] Failed to parse ${configPath}: ${e.message}`);
          return null;
        }
      }
    }
    return null;
  }

  /**
   * Initialize all MCP servers from config. Returns array of server names started.
   */
  async initFromConfig(config) {
    if (!config || !config.mcpServers || typeof config.mcpServers !== 'object') {
      this._onLog('[MCPClient] No mcpServers in config');
      return [];
    }
    const started = [];
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      try {
        await this.startServer(name, serverConfig);
        started.push(name);
      } catch (e) {
        this._onLog(`[MCPClient] Failed to start server "${name}": ${e.message}`);
      }
    }
    return started;
  }

  // ─── Server Lifecycle ────────────────────────────────────────────────────

  /**
   * Start an MCP server via stdio transport.
   * Spawns the process, waits for initialization, then discovers tools.
   */
  async startServer(name, config) {
    if (this._servers.has(name)) {
      await this.stopServer(name);
    }

    const command = config.command;
    const args = config.args || [];
    const env = { ...process.env, ...(config.env || {}) };

    if (!command) {
      throw new Error(`Server "${name}" has no command specified`);
    }

    this._onLog(`[MCPClient] Starting server "${name}": ${command} ${args.join(' ')}`);

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: this.projectPath,
      shell: process.platform === 'win32',
    });

    const serverEntry = {
      name,
      process: child,
      config,
      tools: [],
      status: 'starting',
      requestId: 0,
      pendingRequests: new Map(),
      buffer: '',
    };

    this._servers.set(name, serverEntry);

    // Handle stdout — JSON-RPC messages are line-delimited
    child.stdout.on('data', (data) => {
      serverEntry.buffer += data.toString();
      this._processBuffer(name);
    });

    // Handle stderr — log it
    child.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) this._onLog(`[MCPClient:${name}:stderr] ${msg.substring(0, 500)}`);
    });

    // Handle exit — auto-restart with exponential backoff on unexpected exit
    child.on('exit', (code) => {
      this._onLog(`[MCPClient] Server "${name}" exited with code ${code}`);
      const entry = this._servers.get(name);
      if (entry) {
        entry.status = 'stopped';
        // Reject all pending requests
        for (const [, reject] of entry.pendingRequests.values()) {
          reject(new Error(`Server "${name}" exited`));
        }
        entry.pendingRequests.clear();
        // Auto-restart if not shutting down and exit was unexpected
        if (!this._shuttingDown && code !== 0 && entry._restartCount < 3) {
          const delay = [5000, 15000, 45000][entry._restartCount] || 45000;
          entry._restartCount = (entry._restartCount || 0) + 1;
          this._onLog(`[MCPClient] Auto-restarting "${name}" in ${delay}ms (attempt ${entry._restartCount}/3)`);
          setTimeout(() => {
            if (!this._shuttingDown && this._servers.has(name)) {
              this.startServer(name, config).catch(err => {
                this._onLog(`[MCPClient] Auto-restart failed for "${name}": ${err.message}`);
              });
            }
          }, delay);
        }
        // Notify tools changed (tools from this server are no longer available)
        if (this._onToolsChanged) this._onToolsChanged();
      }
    });

    child.on('error', (err) => {
      this._onLog(`[MCPClient] Server "${name}" error: ${err.message}`);
      serverEntry.status = 'error';
    });

    // Initialize the server (MCP handshake)
    try {
      await this._sendRequest(name, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'guIDE', version: '3.0' },
      });

      // Send initialized notification
      this._sendNotification(name, 'notifications/initialized', {});

      serverEntry.status = 'initialized';
      this._onLog(`[MCPClient] Server "${name}" initialized`);

      // Discover tools
      await this._discoverTools(name);

      return serverEntry;
    } catch (e) {
      serverEntry.status = 'error';
      this._onLog(`[MCPClient] Server "${name}" init failed: ${e.message}`);
      throw e;
    }
  }

  /**
   * Stop an MCP server gracefully.
   */
  async stopServer(name) {
    const entry = this._servers.get(name);
    if (!entry) return;

    entry.status = 'stopping';
    try {
      // Send shutdown request
      await this._sendRequest(name, 'shutdown', {}, 5000);
    } catch {
      // Ignore shutdown errors
    }

    try {
      entry.process.kill('SIGTERM');
    } catch {}

    // Remove tool mappings
    for (const tool of entry.tools) {
      this._toolServerMap.delete(tool.name);
    }
    this._servers.delete(name);
    this._rebuildDiscoveredTools();
  }

  /**
   * Stop all servers.
   */
  async stopAll() {
    this._shuttingDown = true;
    const names = [...this._servers.keys()];
    for (const name of names) {
      try {
        await this.stopServer(name);
      } catch {}
    }
  }

  // ─── Tool Discovery ─────────────────────────────────────────────────────

  async _discoverTools(name) {
    const entry = this._servers.get(name);
    if (!entry) return;

    try {
      const result = await this._sendRequest(name, 'tools/list', {});

      if (result && result.tools && Array.isArray(result.tools)) {
        entry.tools = result.tools.map(t => ({
          name: t.name,
          description: t.description || '',
          parameters: this._convertInputSchema(t.inputSchema),
          _mcpServer: name, // track which server owns this tool
        }));

        this._onLog(`[MCPClient] Server "${name}" has ${entry.tools.length} tools: ${entry.tools.map(t => t.name).join(', ')}`);

        // Update tool→server mapping
        for (const tool of entry.tools) {
          this._toolServerMap.set(tool.name, name);
        }

        this._rebuildDiscoveredTools();
      }
    } catch (e) {
      this._onLog(`[MCPClient] Failed to discover tools from "${name}": ${e.message}`);
    }
  }

  /**
   * Convert JSON Schema inputSchema to the flat parameter format used by guIDE tool defs.
   */
  _convertInputSchema(schema) {
    if (!schema || !schema.properties) return {};
    const params = {};
    const required = new Set(schema.required || []);
    for (const [key, prop] of Object.entries(schema.properties)) {
      params[key] = {
        type: prop.type || 'string',
        description: prop.description || '',
        required: required.has(key),
      };
      if (prop.enum) params[key].enum = prop.enum;
      if (prop.default !== undefined) params[key].default = prop.default;
    }
    return params;
  }

  /**
   * Rebuild the merged discovered tools list from all servers.
   */
  _rebuildDiscoveredTools() {
    this._discoveredTools = [];
    for (const [, entry] of this._servers) {
      if (entry.tools && entry.tools.length > 0) {
        this._discoveredTools.push(...entry.tools);
      }
    }
    if (this._onToolsChanged) {
      this._onToolsChanged(this._discoveredTools);
    }
  }

  /**
   * Get all discovered tool definitions from MCP servers.
   */
  getDiscoveredTools() {
    return this._discoveredTools;
  }

  // ─── Tool Execution ──────────────────────────────────────────────────────

  /**
   * Execute a tool call on the appropriate MCP server.
   * Returns the tool result or null if the tool is not from an MCP server.
   */
  async executeTool(toolName, params) {
    const serverName = this._toolServerMap.get(toolName);
    if (!serverName) return null; // Not an MCP tool

    const entry = this._servers.get(serverName);
    if (!entry || entry.status !== 'initialized') {
      return { success: false, error: `MCP server "${serverName}" is not running` };
    }

    try {
      const result = await this._sendRequest(serverName, 'tools/call', {
        name: toolName,
        arguments: params,
      });

      // MCP tool results have content array
      if (result && result.content) {
        const textParts = result.content
          .filter(c => c.type === 'text')
          .map(c => c.text);
        const imageParts = result.content
          .filter(c => c.type === 'image')
          .map(c => ({ type: 'image', mimeType: c.mimeType, data: c.data }));

        const output = textParts.join('\n');
        const isError = result.isError === true;

        return {
          success: !isError,
          output,
          images: imageParts.length > 0 ? imageParts : undefined,
          error: isError ? output : undefined,
          _mcpServer: serverName,
        };
      }

      return { success: true, output: JSON.stringify(result), _mcpServer: serverName };
    } catch (e) {
      return { success: false, error: `MCP tool "${toolName}" failed: ${e.message}`, _mcpServer: serverName };
    }
  }

  /**
   * Check if a tool name belongs to an MCP server.
   */
  isMCPTool(toolName) {
    return this._toolServerMap.has(toolName);
  }

  /**
   * Get list of connected server names and their status.
   */
  getServerStatus() {
    const status = {};
    for (const [name, entry] of this._servers) {
      status[name] = {
        status: entry.status,
        toolCount: entry.tools.length,
        tools: entry.tools.map(t => t.name),
      };
    }
    return status;
  }

  // ─── JSON-RPC Transport ──────────────────────────────────────────────────

  _processBuffer(name) {
    const entry = this._servers.get(name);
    if (!entry) return;

    const lines = entry.buffer.split('\n');
    // Keep the last incomplete line in the buffer
    entry.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const message = JSON.parse(trimmed);
        this._handleMessage(name, message);
      } catch {
        // Not valid JSON — skip
      }
    }
  }

  _handleMessage(name, message) {
    const entry = this._servers.get(name);
    if (!entry) return;

    if (message.id && entry.pendingRequests.has(message.id)) {
      const { resolve, reject } = entry.pendingRequests.get(message.id);
      entry.pendingRequests.delete(message.id);

      if (message.error) {
        reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        resolve(message.result);
      }
    } else if (message.method) {
      // Notification from server — log it
      this._onLog(`[MCPClient:${name}:notify] ${message.method}`);
    }
  }

  _sendRequest(serverName, method, params, timeoutMs = 30000) {
    const entry = this._servers.get(serverName);
    if (!entry) return Promise.reject(new Error(`Server "${serverName}" not found`));

    const id = ++entry.requestId;
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params: params || {},
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.pendingRequests.delete(id);
        reject(new Error(`Request "${method}" to "${serverName}" timed out (${timeoutMs}ms)`));
      }, timeoutMs);

      entry.pendingRequests.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });

      try {
        const payload = JSON.stringify(request) + '\n';
        entry.process.stdin.write(payload);
      } catch (e) {
        entry.pendingRequests.delete(id);
        clearTimeout(timer);
        reject(new Error(`Failed to send request to "${serverName}": ${e.message}`));
      }
    });
  }

  _sendNotification(serverName, method, params) {
    const entry = this._servers.get(serverName);
    if (!entry) return;

    const notification = {
      jsonrpc: '2.0',
      method,
      params: params || {},
    };

    try {
      const payload = JSON.stringify(notification) + '\n';
      entry.process.stdin.write(payload);
    } catch (e) {
      this._onLog(`[MCPClient] Failed to send notification to "${serverName}": ${e.message}`);
    }
  }
}

module.exports = { MCPClient };

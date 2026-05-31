'use strict';

/**
 * Language Server Manager — spawns LSP servers and bridges to Monaco via IPC.
 * Tier 1: typescript-language-server, pyright, rust-analyzer, gopls (when on PATH).
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const SERVER_DEFS = {
  typescript: {
    languages: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact', 'json'],
    command: process.platform === 'win32' ? 'typescript-language-server.cmd' : 'typescript-language-server',
    args: ['--stdio'],
  },
  python: {
    languages: ['python'],
    command: process.platform === 'win32' ? 'pyright-langserver.cmd' : 'pyright-langserver',
    args: ['--stdio'],
  },
  rust: {
    languages: ['rust'],
    command: 'rust-analyzer',
    args: [],
  },
  go: {
    languages: ['go'],
    command: 'gopls',
    args: ['serve'],
  },
  yaml: {
    languages: ['yaml', 'yml'],
    command: process.platform === 'win32' ? 'yaml-language-server.cmd' : 'yaml-language-server',
    args: ['--stdio'],
  },
};

/** Detect which LSP languages to start based on project marker files */
function detectProjectLanguages(projectPath) {
  const langs = new Set();
  if (!projectPath) return [];
  try {
    const has = (name) => fs.existsSync(path.join(projectPath, name));
    if (has('package.json') || has('tsconfig.json') || has('jsconfig.json')) langs.add('typescript');
    if (has('pyproject.toml') || has('requirements.txt') || has('setup.py') || has('Pipfile')) langs.add('python');
    if (has('Cargo.toml')) langs.add('rust');
    if (has('go.mod')) langs.add('go');
    const listDir = (d) => {
      try { return fs.readdirSync(path.join(projectPath, d)); } catch { return []; }
    };
    if (listDir('.').some((f) => /\.(ya?ml)$/i.test(f))) langs.add('yaml');
  } catch (_) {}
  return [...langs];
}

class LanguageServerManager extends EventEmitter {
  constructor() {
    super();
    this._servers = new Map(); // id -> { proc, language, cwd }
    this._buffer = new Map(); // id -> string buffer for stdout framing
    this._pending = new Map(); // request id -> { resolve, reject, timer, method }
    this._nextId = 2; // id 1 reserved for initialize
    this._bundleManager = null;
    this._restartCounts = new Map(); // serverId -> count
  }

  setBundleManager(bundleManager) {
    this._bundleManager = bundleManager;
  }

  async _resolveCommand(key) {
    if (this._bundleManager) {
      try {
        const cmd = await this._bundleManager.ensureLanguage(key);
        if (cmd?.command) return cmd;
      } catch (e) {
        console.warn(`[LSP] bundle ensure ${key} failed:`, e.message);
        const fallback = this._bundleManager.getCommand(key);
        if (fallback?.command) return fallback;
      }
    }
    const def = SERVER_DEFS[key];
    return def ? { command: def.command, args: def.args, bundled: false } : null;
  }

  /** Start LSP for a language in project cwd. Returns { success, serverId?, error? } */
  async start(language, cwd) {
    const key = this._pickServerKey(language);
    if (!key) return { success: false, error: `No LSP configured for ${language}` };

    const existing = [...this._servers.entries()].find(([, s]) => s.key === key && s.cwd === cwd);
    if (existing) return { success: true, serverId: existing[0], alreadyRunning: true };

    const def = SERVER_DEFS[key];
    const resolved = await this._resolveCommand(key);
    if (!resolved?.command) return { success: false, error: `No LSP configured for ${language}` };

    let proc;
    try {
      proc = spawn(resolved.command, resolved.args || def?.args || [], {
        cwd: cwd || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        env: process.env,
      });
    } catch (e) {
      return { success: false, error: e.message };
    }

    const serverId = `${key}-${Date.now()}`;
    this._servers.set(serverId, { proc, key, cwd, language });
    this._buffer.set(serverId, '');

    proc.stdout.on('data', (chunk) => {
      this._onStdout(serverId, chunk.toString());
    });
    proc.stderr.on('data', (chunk) => {
      this.emit('log', { serverId, stderr: chunk.toString() });
    });
    proc.on('exit', (code) => {
      const meta = this._servers.get(serverId);
      this._servers.delete(serverId);
      this._buffer.delete(serverId);
      this.emit('exit', { serverId, code, key: meta?.key, cwd: meta?.cwd });
      // Auto-restart once on crash
      if (code !== 0 && meta?.key && meta?.cwd) {
        const rk = `${meta.key}:${meta.cwd}`;
        const count = (this._restartCounts.get(rk) || 0) + 1;
        this._restartCounts.set(rk, count);
        if (count <= 2) {
          setTimeout(() => {
            this.start(meta.language || meta.key, meta.cwd).catch(() => {});
          }, 1500);
        }
      }
    });

    // initialize request
    this._send(serverId, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        processId: process.pid,
        rootUri: cwd ? `file:///${cwd.replace(/\\/g, '/')}` : null,
        capabilities: {},
      },
    });
    this._send(serverId, { jsonrpc: '2.0', method: 'initialized', params: {} });

    return { success: true, serverId, command: resolved.command, bundled: resolved.bundled };
  }

  _pickServerKey(language) {
    const lang = (language || '').toLowerCase();
    for (const [key, def] of Object.entries(SERVER_DEFS)) {
      if (def.languages.some(l => lang.includes(l) || l.includes(lang))) return key;
    }
    if (['ts', 'tsx', 'js', 'jsx'].includes(lang)) return 'typescript';
    if (lang === 'py') return 'python';
    if (lang === 'yaml' || lang === 'yml') return 'yaml';
    return null;
  }

  _send(serverId, msg) {
    const s = this._servers.get(serverId);
    if (!s?.proc?.stdin?.writable) return;
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
    s.proc.stdin.write(header + body);
  }

  /** Fire-and-forget notification (no response expected) */
  sendNotification(serverId, method, params) {
    this._send(serverId, { jsonrpc: '2.0', method, params });
  }

  /** Send request and wait for correlated JSON-RPC response */
  sendRequest(serverId, method, params, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const s = this._servers.get(serverId);
      if (!s?.proc?.stdin?.writable) {
        reject(new Error(`LSP server ${serverId} not available`));
        return;
      }
      const id = ++this._nextId;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`LSP request timeout: ${method}`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer, method });
      this._send(serverId, { jsonrpc: '2.0', id, method, params });
    });
  }

  /** Start all detected LSP servers for a project directory */
  async autoStartForProject(projectPath) {
    const results = [];
    for (const lang of detectProjectLanguages(projectPath)) {
      const r = await this.start(lang, projectPath);
      results.push({ language: lang, ...r });
    }
    return results;
  }

  findServer(language, cwd) {
    const key = this._pickServerKey(language);
    if (!key) return null;
    const resolved = cwd ? path.resolve(cwd) : null;
    for (const [id, s] of this._servers.entries()) {
      if (s.key === key && (!resolved || path.resolve(s.cwd) === resolved)) return id;
    }
    return null;
  }

  async ensureServer(language, cwd) {
    const resolved = path.resolve(cwd || process.cwd());
    let serverId = this.findServer(language, resolved);
    if (serverId) return { success: true, serverId };
    const r = await this.start(language, resolved);
    return r.success ? { success: true, serverId: r.serverId } : r;
  }

  _onStdout(serverId, chunk) {
    let buf = (this._buffer.get(serverId) || '') + chunk;
    while (true) {
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = buf.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) break;
      const len = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (buf.length < bodyStart + len) break;
      const body = buf.slice(bodyStart, bodyStart + len);
      buf = buf.slice(bodyStart + len);
      try {
        const msg = JSON.parse(body);
        // Resolve pending request/response correlation
        if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
          const pending = this._pending.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this._pending.delete(msg.id);
            if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else pending.resolve(msg.result);
          }
        }
        // Forward publishDiagnostics as dedicated event
        if (msg.method === 'textDocument/publishDiagnostics' && msg.params) {
          this.emit('diagnostics', { serverId, ...msg.params });
        }
        this.emit('message', { serverId, msg });
      } catch (_) {}
    }
    this._buffer.set(serverId, buf);
  }

  stop(serverId) {
    const s = this._servers.get(serverId);
    if (s?.proc) {
      try { s.proc.kill(); } catch (_) {}
    }
    this._servers.delete(serverId);
    this._buffer.delete(serverId);
    for (const [id, p] of this._pending.entries()) {
      clearTimeout(p.timer);
      p.reject(new Error('LSP server stopped'));
      this._pending.delete(id);
    }
  }

  stopAll() {
    for (const id of [...this._servers.keys()]) this.stop(id);
  }

  listRunning() {
    return [...this._servers.entries()].map(([id, s]) => ({ id, key: s.key, cwd: s.cwd, language: s.language }));
  }
}

module.exports = { LanguageServerManager, SERVER_DEFS, detectProjectLanguages };

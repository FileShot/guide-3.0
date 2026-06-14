/**
 * guIDE MCP Tools Server — Model Context Protocol tools for browser automation,
 * web search, code execution, and system interaction.
 * Copyright (c) 2025-2026 Brendan Gray (GitHub: FileShot)
 * All Rights Reserved. See LICENSE for terms.
 *
 * Provides tool definitions + execution for the LLM to use autonomously.
 */
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const https = require('https');
const http = require('http');

// Extracted tool modules
const mcpBrowserTools = require('./tools/mcpBrowserTools');
const mcpGitTools = require('./tools/mcpGitTools');
const {
  parseToolCalls: standaloneParseToolCalls,
  repairToolCalls,
  _recoverWriteFileContent,
  TOOL_NAME_ALIASES,
  VALID_TOOLS,
} = require('./tools/toolParser');
const { canonicalizeToolParams } = require('./tools/canonicalizeToolParams');
const {
  formatCompactToolLine,
  getAgentToolPromptHeader,
  getAgentToolCatalogRules,
} = require('./agentModeResolver');
const streamTrace = require('./streamTrace');

/** run_command / terminal_run timing (ms) */
const COMMAND_SOFT_WARNING_MS = 180000;
const COMMAND_DEFAULT_TIMEOUT_MS = 600000;
const COMMAND_MAX_TIMEOUT_MS = 600000;
const COMMAND_MIN_TIMEOUT_MS = 5000;

const RUN_COMMAND_TIMEOUT_HINT =
  'Do not launch chrome.exe, firefox.exe, Tor Browser, or debug Playwright/geckodriver via run_command. Use browser_navigate, fetch_webpage, or allow browser automation setup. For long builds pass a higher timeout param or use terminal_run.';

/** Format uptime seconds into human-readable string */
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(' ');
}

/** Tools that may attach similarNames on ENOENT (path param → sibling scan). */
const ENOENT_SUGGEST_PATH_TOOLS = {
  list_directory: 'dirPath',
  read_file: 'filePath',
  get_file_info: 'filePath',
  open_file_in_editor: 'filePath',
  search_in_file: 'filePath',
  delete_file: 'filePath',
  rename_file: 'oldPath',
  copy_file: 'source',
};

class MCPToolServer {
  constructor(options = {}) {
    this.webSearch = options.webSearch || null;
    this.ragEngine = options.ragEngine || null;
    this.terminalManager = options.terminalManager || null;
    this.mcpClient = options.mcpClient || null;
    this._userDataPath = options.userDataPath || null;
    this._isPathAllowed = typeof options.isPathAllowed === 'function' ? options.isPathAllowed : null;

    // Agent persistent PTY session (separate from user's terminal)
    this._agentPty = null;
    this._agentPtyId = null;
    this._agentPtyBuffer = '';
    this._agentPtyResolve = null;
    this._agentPtyShell = null;
    this._projectPath = options.projectPath ? path.resolve(options.projectPath) : null;

    // Execution policy for command tools (run_command, terminal_run)
    this._executionPolicy = options.executionPolicy || 'auto';
    this._commandAllowList = new Set(options.commandAllowList || []);
    this._commandDenyList = new Set(options.commandDenyList || []);
    this._commandShell = (options.commandShell || 'powershell'); // Windows default for run_command
    // When false (default), all tools auto-execute without frontend approval.
    this._requireToolApproval = options.requireToolApproval !== undefined ? options.requireToolApproval : false;
    this.browserManager = null;
    this.playwrightBrowser = null;
    this.gitManager = null;
    this.imageGen = null;

    this.toolHistory = [];
    this.maxHistory = 50;

    // File change backups for undo (filePath → { original, timestamp, tool, isNew })
    this._fileBackups = new Map();
    this._maxFileBackups = 200;

    // Checkpoint turn tracking
    this._turnSnapshots = [];
    this._maxTurnSnapshots = 20;
    this._currentTurnId = null;
    this._currentTurnCapture = new Map();

    // Load persisted checkpoints from disk
    this._loadCheckpointsFromDisk();

    // Caches
    this._toolDefsCache = null;
    this._toolPromptCache = null;
    this._allToolDefsCache = null;

    // Disabled tools (set by frontend via context.disabledTools)
    this._disabledTools = new Set();

    // TODO list
    this._todos = [];
    this._todoNextId = 1;
    this.onTodoUpdate = null;
    this._send = options.send || null;

    // Scratchpad
    this._scratchDir = this._projectPath ? path.join(this._projectPath, '.guide-scratch') : null;

    // Permission gates for destructive operations
    this.onPermissionRequest = null;
    this._destructiveTools = new Set([
      'delete_file', 'replace_in_file', 'write_file', 'terminal_run',
      'git_commit', 'git_push', 'git_reset', 'git_branch_delete',
      'kill_process', 'set_env_var', 'restore_checkpoint',
    ]);

    // Rate limiting: max calls per tool type within the rate window
    this._rateLimits = {
      write_file: { max: 10, window: 10000 },
      edit_file: { max: 10, window: 10000 },
      delete_file: { max: 5, window: 10000 },
      run_command: { max: 8, window: 10000 },
      terminal_run: { max: 8, window: 10000 },
      web_search: { max: 4, window: 30000 },
      fetch_webpage: { max: 6, window: 30000 },
      http_request: { max: 6, window: 30000 },
    };
    this._rateCounters = new Map(); // tool -> [{timestamp}]

    // Active child processes from run_command, keyed by childId. Killed on
    // cancelGeneration() so Stop actually stops.
    this._activeChildren = new Map();
    this._nextChildId = 1;

    // Plan / agent phase context (set per ai-chat turn from electron-main)
    this._agentContext = { planMode: false, agentPhase: 'planning' };
  }

  setAgentContext(ctx = {}) {
    this._agentContext = {
      planMode: !!(ctx.planMode),
      agentPhase: ctx.agentPhase || 'planning',
    };
  }

  // ─── Child Process Management ───────────────────────────────────────────

  killActiveChildren(reason) {
    // Also kill agent PTY session on cancel
    this._killAgentPty();
    if (this._activeChildren.size === 0) return 0;
    const count = this._activeChildren.size;
    console.log(`[MCPToolServer] killActiveChildren: ${count} process(es), reason=${reason || 'unspecified'}`);
    for (const [id, child] of this._activeChildren) {
      try {
        if (process.platform === 'win32') {
          // Windows: SIGTERM does not cascade to shell children. Use taskkill /T /F
          // to terminate the entire process tree rooted at the shell.
          try { require('child_process').execSync(`taskkill /pid ${child.pid} /T /F`, { windowsHide: true, stdio: 'ignore' }); } catch (_) {}
        } else {
          child.kill('SIGTERM');
          setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 500).unref();
        }
      } catch (_) {}
      this._activeChildren.delete(id);
    }
    return count;
  }

  // ─── T30-Fix: projectPath getter/setter — always normalize to absolute ───
  // When the frontend sends a relative projectPath (e.g. "r19-stress-test\my-blank-app"),
  // _sanitizeFilePath's startsWith comparison fails (absolute resolved vs relative projNorm),
  // causing false "path traversal blocked" on every file operation. Normalizing on assignment
  // ensures all downstream code (path.join, path.resolve, startsWith checks) works correctly.
  get projectPath() { return this._projectPath; }
  set projectPath(val) {
    const _prev = this._projectPath;
    this._projectPath = val ? path.resolve(val) : null;
    this._scratchDir = this._projectPath ? path.join(this._projectPath, '.guide-scratch') : null;
    if (_prev !== this._projectPath) {
      // Tool prompt embeds the project path in its header — invalidate so next
      // getToolPrompt() rebuilds with the current path rather than returning a
      // stale cached prompt pointing at the previous project.
      this._toolPromptCache = null;
      const _stack = new Error().stack.split('\n').slice(2, 4).map(l => l.trim()).join(' | ');
      console.log(`[MCPToolServer] DIAG-PP: projectPath changed "${_prev}" → "${this._projectPath}" | ${_stack}`);
    }
  }

  // ─── Tool Toggle Management ───────────────────────────────────────────────

  setDisabledTools(toolNames) {
    const newSet = new Set(Array.isArray(toolNames) ? toolNames : []);
    const changed = newSet.size !== this._disabledTools.size ||
      [...newSet].some(t => !this._disabledTools.has(t));
    this._disabledTools = newSet;
    if (changed) {
      // Invalidate caches so prompts reflect the updated tool set
      this._toolDefsCache = null;
      this._toolPromptCache = null;
      console.log(`[MCPToolServer] Disabled tools updated: ${newSet.size} disabled`);
    }
  }

  // ─── Parameter Normalization ─────────────────────────────────────────────

  _normalizeBrowserParams(toolName, params) {
    return canonicalizeToolParams(toolName, params);
  }

  _normalizeFsParams(toolName, params) {
    return canonicalizeToolParams(toolName, params);
  }

  // ─── Timeout Wrapper ─────────────────────────────────────────────────────

  _withTimeout(promise, ms = 60000, label = 'operation') {
    return Promise.race([
      promise,
      new Promise((resolve) =>
        setTimeout(() => resolve({ success: false, error: `${label} timed out after ${ms / 1000}s` }), ms)
      ),
    ]);
  }

  // ─── Rate Limiting ──────────────────────────────────────────────────────

  _checkRateLimit(toolName) {
    const limit = this._rateLimits[toolName];
    if (!limit) return { allowed: true };
    const now = Date.now();
    let timestamps = this._rateCounters.get(toolName) || [];
    // Prune timestamps outside the window
    timestamps = timestamps.filter(t => (now - t) < limit.window);
    if (timestamps.length >= limit.max) {
      return { allowed: false, count: timestamps.length, max: limit.max, window: limit.window };
    }
    timestamps.push(now);
    this._rateCounters.set(toolName, timestamps);
    return { allowed: true };
  }

  // ─── Path Sanitization ───────────────────────────────────────────────────

  _sanitizeFilePath(filePath) {
    if (!filePath) return filePath;

    const resolved = (this.projectPath && !path.isAbsolute(filePath))
      ? path.resolve(this.projectPath, filePath)
      : path.resolve(filePath);

    if (this._isPathAllowed && this._isPathAllowed(resolved)) {
      if (this.projectPath) {
        const resolvedNorm = resolved.replace(/\\/g, '/').toLowerCase();
        const projNorm = this.projectPath.replace(/\\/g, '/').toLowerCase();
        if (resolvedNorm === projNorm || resolvedNorm.startsWith(projNorm + '/')) {
          const projBasename = path.basename(this.projectPath).toLowerCase();
          const afterProj = resolvedNorm.substring(projNorm.length);
          if (afterProj === '/' + projBasename || afterProj.startsWith('/' + projBasename + '/')) {
            const rest = afterProj.substring(('/' + projBasename).length);
            const corrected = this.projectPath + rest.replace(/\//g, path.sep);
            console.log(`[MCPToolServer] Doubled project root corrected: "${filePath}" → "${corrected}"`);
            return corrected;
          }
        }
      }
      return resolved;
    }

    if (!this.projectPath) {
      const err = new Error(
        path.isAbsolute(filePath)
          ? `Path "${filePath}" is not allowed. Use a path under your home folder, documents, downloads, desktop, or app data.`
          : `Path "${filePath}" is relative but no project is open. Open a project or use an absolute path to an allowed location.`,
      );
      err.code = 'EPATHNOTALLOWED';
      throw err;
    }

    const projectResolved = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(this.projectPath, filePath);
    const resolvedNorm = projectResolved.replace(/\\/g, '/').toLowerCase();
    const projNorm = this.projectPath.replace(/\\/g, '/').toLowerCase();

    if (resolvedNorm === projNorm || resolvedNorm.startsWith(projNorm + '/')) {
      const projBasename = path.basename(this.projectPath).toLowerCase();
      const afterProj = resolvedNorm.substring(projNorm.length);
      if (afterProj === '/' + projBasename || afterProj.startsWith('/' + projBasename + '/')) {
        const rest = afterProj.substring(('/' + projBasename).length);
        const corrected = this.projectPath + rest.replace(/\//g, path.sep);
        console.log(`[MCPToolServer] Doubled project root corrected: "${filePath}" → "${corrected}"`);
        return corrected;
      }
      return projectResolved;
    }

    const err = new Error(
      `Path "${filePath}" is outside allowed locations. Use a path inside the project ("${this.projectPath}") or an allowed folder (home, documents, app data).`,
    );
    err.code = 'EOUTSIDEPROJECT';
    throw err;
  }

  _sanitizeShellArg(str) {
    if (!str || typeof str !== 'string') return '';
    return str
      .replace(/[\x00]/g, '')
      .replace(/[`]/g, '')
      .replace(/[\n\r]/g, ' ')
      .trim();
  }

  // ─── Tool Definitions ────────────────────────────────────────────────────

  getToolDefinitions() {
    if (this._toolDefsCache) return this._toolDefsCache;
    const allDefs = this._getAllToolDefs();
    // Filter out disabled tools
    if (this._disabledTools.size > 0) {
      this._toolDefsCache = allDefs.filter(t => !this._disabledTools.has(t.name));
    } else {
      this._toolDefsCache = allDefs;
    }
    return this._toolDefsCache;
  }

  /** Returns ALL tool definitions regardless of disabled state (for UI display). */
  getAllToolDefinitions() {
    return this._getAllToolDefs();
  }

  _getAllToolDefs() {
    if (this._allToolDefsCache) return this._allToolDefsCache;
    this._allToolDefsCache = [
      {
        name: 'web_search',
        description: 'Search the web (DuckDuckGo and fallbacks). Returns title, url, and short snippet per hit — not full page text. After every web_search, in the same continuation, you MUST call fetch_webpage on the first and second ranked result URLs (or each URL if fewer than two) before your final answer. Do not ask the user whether to fetch. Ground answers in fetched page text; do not substitute generic descriptions of sites or brands.',
        parameters: {
          query: { type: 'string', description: 'Search query', required: true },
          maxResults: { type: 'number', description: 'Max results (default 5)', required: false },
        },
      },
      {
        name: 'fetch_webpage',
        description: 'Fetch a URL and return extracted page text (HTML stripped). Required immediately after web_search in the same continuation: call for the first and second ranked result URLs from the search results (or the only URL if one hit) before answering. Do not ask the user for permission to fetch. For interactive browsing, use browser_navigate instead.',
        parameters: {
          url: { type: 'string', description: 'URL to fetch', required: true },
        },
      },
      {
        name: 'read_file',
        description: 'Read the contents of a file. Supports partial reads by specifying a line range. Paths relative to the project root resolve inside the project; absolute paths work for allowed locations outside the project (home, documents, downloads, desktop, app data). Read a file before using edit_file to get the exact text for replacement.',
        parameters: {
          filePath: { type: 'string', description: 'Relative or absolute file path', required: true },
          startLine: { type: 'number', description: 'Start line (1-based, optional)', required: false },
          endLine: { type: 'number', description: 'End line (inclusive, optional)', required: false },
          reason: { type: 'string', description: 'One sentence explaining why you are reading this file', required: false },
        },
      },
      {
        name: 'write_file',
        description: 'Create or overwrite a file with the provided content. Replaces the entire file. For large files, use write_file for the initial content, then append_to_file for subsequent sections.',
        parameters: {
          filePath: { type: 'string', description: 'File path', required: true },
          content: { type: 'string', description: 'File content', required: true },
          reason: { type: 'string', description: 'One sentence explaining why you are writing this file', required: false },
        },
      },
      {
        name: 'search_codebase',
        description: 'Search the indexed codebase using semantic search (RAG). Finds functions, classes, patterns, and concepts by meaning rather than exact text match.',
        parameters: {
          query: { type: 'string', description: 'Search query', required: true },
          maxResults: { type: 'number', description: 'Max results', required: false },
          reason: { type: 'string', description: 'One sentence explaining what you are looking for in the codebase', required: false },
        },
      },
      {
        name: 'run_command',
        description: 'Execute a shell command in the project directory and return the output. Default max wait 10 minutes (pass timeout in ms for long npm/build jobs, up to 600000). A UI warning appears at 3 minutes; the command is killed only at max timeout. IMPORTANT: Each call spawns a fresh shell — cd, set VAR=, export VAR= do NOT persist between calls. Do NOT use run_command to launch chrome.exe, firefox.exe, Tor Browser, or debug Playwright/geckodriver — use browser_navigate or fetch_webpage instead. Default shell: Windows = PowerShell, Unix = /bin/sh. Set shell="cmd" on Windows to force cmd.exe.',
        parameters: {
          command: { type: 'string', description: 'Command to execute', required: true },
          shell: { type: 'string', description: 'Shell to use on Windows: "powershell" (default) or "cmd". Ignored on Unix.', required: false },
          cwd: { type: 'string', description: 'Working directory', required: false },
          timeout: { type: 'number', description: 'Max wait in ms before kill (default 600000, max 600000)', required: false },
          reason: { type: 'string', description: 'One sentence explaining why this command needs to be run', required: false },
        },
      },
      {
        name: 'terminal_run',
        description: 'Execute a command in a persistent terminal session. Unlike run_command (fresh shell each call), this uses a persistent PTY — cd, environment variables, conda activate, nvm use, and other shell state persist across calls. Shell: Windows = PowerShell, Unix = $SHELL (bash/zsh). Use this when you need shell state to persist (e.g., cd into a directory then run multiple commands, activate a virtual environment, or run a dev server and check its output). Falls back to run_command if persistent terminal is unavailable.',
        parameters: {
          command: { type: 'string', description: 'Command to execute in the persistent terminal', required: true },
          timeout: { type: 'number', description: 'Timeout in ms (default 30000)', required: false },
          reset: { type: 'boolean', description: 'Reset the terminal session (start fresh) — use if the session is stuck or you need a clean environment', required: false },
        },
      },
      {
        name: 'list_directory',
        description: 'List files and directories at a given path. Use "." to list the project root. Returns names, types, and sizes of entries.',
        parameters: {
          dirPath: { type: 'string', description: 'Directory path — use "." for project root', required: true },
          recursive: { type: 'boolean', description: 'Recursive listing', required: false },
        },
      },
      {
        name: 'find_files',
        description: 'Find files matching a name or glob pattern in the project. Searches recursively from the project root.',
        parameters: {
          pattern: { type: 'string', description: 'File name or glob pattern', required: true },
        },
      },
      {
        name: 'analyze_error',
        description: 'Analyze an error message and stack trace against the codebase to locate the source of the error and suggest fixes.',
        parameters: {
          errorMessage: { type: 'string', description: 'Error message', required: true },
          stackTrace: { type: 'string', description: 'Stack trace', required: false },
        },
      },
      // ── Browser Tools ──
      {
        name: 'browser_navigate',
        description: 'Navigate to a URL in a Playwright-controlled Chrome browser. Auto-launches the browser if needed.',
        parameters: {
          url: { type: 'string', description: 'Full URL to navigate to (must include https:// or http://)', required: true },
          reason: { type: 'string', description: 'One sentence explaining why you are navigating to this URL', required: false },
        },
      },
      {
        name: 'browser_snapshot',
        description: 'Get an accessibility snapshot of the current browser page with [ref=eN] element refs. Returns the accessibility tree (roles, names, interactive elements) and page text. Call before clicking or typing to discover element refs. Re-snapshot after page changes since refs are invalidated.',
        parameters: {},
      },
      {
        name: 'viewport_browser_snapshot',
        description: 'Snapshot the page currently shown in the guIDE viewport browser (live preview / screencast). Use when the user asks to analyze what is open in the viewport browser.',
        parameters: {},
      },
      {
        name: 'browser_click',
        description: 'Click an element by its ref number. Handles scrolling and overlays automatically. Auto-retries with a fresh snapshot if the ref is stale.',
        parameters: {
          ref: { type: 'string', description: 'Element reference from snapshot [ref=eN] (e.g. "e5"), OR visible text of the element (e.g. "Sign In"). Also accepts: elementIndex, index, selector', required: true },
          reason: { type: 'string', description: 'One sentence explaining why you are clicking this element', required: false },
          button: { type: 'string', description: "Mouse button: 'left', 'right', or 'middle' (default 'left')", required: false },
          doubleClick: { type: 'boolean', description: 'Double click instead of single click', required: false },
          element: { type: 'string', description: 'Human-readable element description (used as fallback if ref fails)', required: false },
        },
      },
      {
        name: 'browser_type',
        description: 'Type text into an input field by ref number. Clears the field first, then types the new text. Auto-retries with fresh snapshot if ref is stale.',
        parameters: {
          ref: { type: 'string', description: 'Element reference from snapshot [ref=eN] (e.g. "e3"). Also accepts: elementIndex, index, selector', required: true },
          text: { type: 'string', description: 'Text to type', required: true },
          reason: { type: 'string', description: 'One sentence explaining what you are typing and why', required: false },
          slowly: { type: 'boolean', description: 'Type one character at a time (triggers key handlers). Default: fast fill.', required: false },
          submit: { type: 'boolean', description: 'Press Enter after typing', required: false },
        },
      },
      {
        name: 'browser_fill_form',
        description: 'Fill multiple form fields at once. Supports textbox, checkbox, radio, combobox, and slider field types.',
        parameters: {
          fields: {
            type: 'array', description: 'Array of {ref, value, type} objects. type: "textbox"|"checkbox"|"radio"|"combobox"|"slider"', required: true,
            items: {
              type: 'object',
              properties: {
                ref: { type: 'string', description: 'Element ref from snapshot' },
                value: { type: 'string', description: 'Value to fill. For checkbox: "true"/"false". For combobox: option text.' },
                type: { type: 'string', description: 'Field type: textbox, checkbox, radio, combobox, slider' },
              },
            },
          },
        },
      },
      {
        name: 'browser_select_option',
        description: 'Select one or more options from a dropdown/select element by ref.',
        parameters: {
          ref: { type: 'string', description: 'Element ref from snapshot', required: true },
          values: { type: 'array', description: 'Array of option labels or values to select', required: true },
        },
      },
      {
        name: 'browser_screenshot',
        description: 'Take a screenshot of the current browser page. If the vision system is available, the screenshot is automatically captioned with a detailed text description of visible elements. Use this when you need visual context (canvas apps, charts, image-heavy layouts) alongside the accessibility snapshot.',
        parameters: {
          fullPage: { type: 'boolean', description: 'Capture full scrollable page (default false)', required: false },
          ref: { type: 'string', description: 'Element ref to screenshot (optional, screenshots viewport by default)', required: false },
        },
      },
      {
        name: 'browser_get_content',
        description: 'Get the text content or HTML of the current browser page.',
        parameters: {
          selector: { type: 'string', description: 'CSS selector (optional, gets body by default)', required: false },
          html: { type: 'boolean', description: 'Return HTML instead of text', required: false },
        },
      },
      {
        name: 'browser_evaluate',
        description: 'Execute JavaScript code in the browser page context. The code is evaluated as a page function. Returns the result.',
        parameters: {
          code: { type: 'string', description: 'JavaScript code to evaluate (e.g. "document.title" or "() => document.querySelectorAll(\'a\').length")', required: true },
          ref: { type: 'string', description: 'Optional element ref — code receives the element as argument', required: false },
        },
      },
      {
        name: 'browser_scroll',
        description: 'Scroll the browser page up or down.',
        parameters: {
          direction: { type: 'string', description: "Direction to scroll: 'up' or 'down'", required: true },
          amount: { type: 'number', description: 'Pixels to scroll (default 500)', required: false },
        },
      },
      {
        name: 'browser_wait',
        description: 'Wait for a specified duration in milliseconds.',
        parameters: {
          ms: { type: 'number', description: 'Milliseconds to wait (default 2000, max 30000)', required: false },
        },
      },
      {
        name: 'browser_wait_for',
        description: 'Wait for text to appear or disappear on the page, or for a CSS selector to become visible.',
        parameters: {
          text: { type: 'string', description: 'Text to wait for (appears)', required: false },
          textGone: { type: 'string', description: 'Text to wait to disappear', required: false },
          time: { type: 'number', description: 'Seconds to wait', required: false },
          selector: { type: 'string', description: 'CSS selector to wait for', required: false },
        },
      },
      {
        name: 'browser_back',
        description: 'Navigate back in browser history.',
        parameters: {},
      },
      {
        name: 'browser_press_key',
        description: 'Press a keyboard key in the browser. Supports Enter, Tab, Escape, arrow keys, function keys, and more.',
        parameters: {
          key: { type: 'string', description: 'Key name: Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Space, Home, End, PageUp, PageDown, F1-F12', required: true },
        },
      },
      {
        name: 'browser_hover',
        description: 'Hover over an element on the browser page by ref.',
        parameters: {
          ref: { type: 'string', description: 'Element ref from browser_snapshot', required: true },
        },
      },
      {
        name: 'browser_drag',
        description: 'Drag and drop from one element to another.',
        parameters: {
          startRef: { type: 'string', description: 'Source element ref', required: true },
          endRef: { type: 'string', description: 'Target element ref', required: true },
        },
      },
      {
        name: 'browser_tabs',
        description: 'Manage browser tabs: list all tabs, create new tab, close a tab, or select a tab.',
        parameters: {
          action: { type: 'string', description: "'list', 'new', 'close', or 'select'", required: true },
          index: { type: 'number', description: 'Tab index (for close/select)', required: false },
        },
      },
      {
        name: 'browser_handle_dialog',
        description: 'Handle a pending alert, confirm, or prompt dialog.',
        parameters: {
          accept: { type: 'boolean', description: 'Accept (true) or dismiss (false) the dialog', required: true },
          promptText: { type: 'string', description: 'Text for prompt dialogs', required: false },
        },
      },
      {
        name: 'browser_console_messages',
        description: 'Get console messages from the browser page.',
        parameters: {
          level: { type: 'string', description: "Minimum level: 'error', 'warning', 'info', 'debug' (default 'info')", required: false },
        },
      },
      {
        name: 'browser_file_upload',
        description: 'Upload files to a file input element.',
        parameters: {
          ref: { type: 'string', description: 'File input element ref', required: true },
          paths: { type: 'array', description: 'Array of absolute file paths to upload', required: true },
        },
      },
      {
        name: 'browser_resize',
        description: 'Resize the browser viewport.',
        parameters: {
          width: { type: 'number', description: 'Width in pixels', required: true },
          height: { type: 'number', description: 'Height in pixels', required: true },
        },
      },
      {
        name: 'browser_get_url',
        description: 'Get the current URL and title of the browser page.',
        parameters: {},
      },
      {
        name: 'browser_get_links',
        description: 'Get all links from the current browser page.',
        parameters: {
          selector: { type: 'string', description: 'Scope to a container CSS selector (optional)', required: false },
        },
      },
      {
        name: 'browser_close',
        description: 'Close the browser and clean up all resources.',
        parameters: {},
      },
      // ── File & Project Tools ──
      {
        name: 'get_project_structure',
        description: 'Get an overview of the project file structure. Shows top-level files and directories with sizes.',
        parameters: {},
      },
      {
        name: 'create_directory',
        description: 'Create a new directory in the project. Creates parent directories as needed.',
        parameters: {
          path: { type: 'string', description: 'Directory path to create', required: true },
        },
      },
      {
        name: 'delete_file',
        description: 'Delete a file or directory from the project. Directories are removed recursively. This operation cannot be undone.',
        parameters: {
          filePath: { type: 'string', description: 'Path of the file or directory to delete', required: true },
        },
      },
      {
        name: 'rename_file',
        description: 'Rename or move a file or directory to a new path within the project.',
        parameters: {
          oldPath: { type: 'string', description: 'Current file path', required: true },
          newPath: { type: 'string', description: 'New file path', required: true },
        },
      },
      {
        name: 'edit_file',
        description: 'Replace specific text in a file by finding oldText and replacing it with newText. More efficient than rewriting the entire file. Use read_file first to get the exact text for replacement.',
        parameters: {
          filePath: { type: 'string', description: 'File to edit', required: true },
          reason: { type: 'string', description: 'One sentence explaining what this edit accomplishes', required: false },
          oldText: { type: 'string', description: 'Exact text to find and replace (must match exactly)', required: true },
          newText: { type: 'string', description: 'Replacement text', required: true },
        },
      },
      {
        name: 'get_file_info',
        description: 'Get file metadata including size, modified date, type, and permissions.',
        parameters: {
          filePath: { type: 'string', description: 'Path to the file', required: true },
        },
      },
      // ── Memory Tools ──
      {
        name: 'save_memory',
        description: 'Save a piece of information for future reference across chat sessions. Stores project context, decisions, or facts by key.',
        parameters: {
          key: { type: 'string', description: 'A key/label for this memory', required: true },
          value: { type: 'string', description: 'The information to remember', required: true },
        },
      },
      {
        name: 'get_memory',
        description: 'Recall previously saved information by its key.',
        parameters: {
          key: { type: 'string', description: 'The key to look up', required: true },
        },
      },
      {
        name: 'list_memories',
        description: 'List all saved memory keys and their stored values.',
        parameters: {},
      },
      // ── Git Tools ──
      {
        name: 'git_status',
        description: 'Get current git status: changed files, staged files, current branch, and untracked files.',
        parameters: {},
      },
      {
        name: 'git_commit',
        description: 'Stage all changes and create a git commit with the given message.',
        parameters: {
          message: { type: 'string', description: 'Commit message', required: true },
        },
      },
      {
        name: 'git_diff',
        description: 'Get the diff of a specific file or all uncommitted changes. Shows exactly what lines changed.',
        parameters: {
          filePath: { type: 'string', description: 'File to diff (optional, omit for all changes)', required: false },
        },
      },
      {
        name: 'git_log',
        description: 'View recent git commit history with messages, dates, and authors.',
        parameters: {
          maxCount: { type: 'number', description: 'Max commits to show (default 20)', required: false },
          filePath: { type: 'string', description: 'Filter log to a specific file (optional)', required: false },
        },
      },
      {
        name: 'git_branch',
        description: 'List, create, or switch git branches.',
        parameters: {
          action: { type: 'string', description: "'list', 'create', or 'switch'", required: true },
          name: { type: 'string', description: 'Branch name (required for create/switch)', required: false },
        },
      },
      {
        name: 'git_stash',
        description: 'Stash or restore uncommitted changes. Temporarily saves work in progress.',
        parameters: {
          action: { type: 'string', description: "'push', 'pop', 'list', or 'drop'", required: true },
          message: { type: 'string', description: 'Stash message (for push)', required: false },
        },
      },
      {
        name: 'git_reset',
        description: 'Unstage files or reset changes. Hard reset discards changes permanently.',
        parameters: {
          filePath: { type: 'string', description: 'File to unstage (omit for all)', required: false },
          hard: { type: 'boolean', description: 'Hard reset — discard changes (default false)', required: false },
        },
      },
      {
        name: 'git_push',
        description: 'Push commits to a remote repository. Requires a remote to be configured.',
        parameters: {
          remote: { type: 'string', description: "Remote name (default: 'origin')", required: false },
          branch: { type: 'string', description: 'Branch to push (default: current branch)', required: false },
          force: { type: 'boolean', description: 'Force push (use with extreme caution)', required: false },
        },
      },
      {
        name: 'git_branch_delete',
        description: 'Delete a local or remote branch. This is destructive and cannot be undone.',
        parameters: {
          branch: { type: 'string', description: 'Branch name to delete', required: true },
          remote: { type: 'boolean', description: 'Delete remote branch instead of local (default: false)', required: false },
          force: { type: 'boolean', description: 'Force delete unmerged branch (default: false)', required: false },
        },
      },
      // ── Search Tools ──
      {
        name: 'grep_search',
        description: 'Search for text or regex patterns across all project files. Returns matching lines with file paths and line numbers.',
        parameters: {
          pattern: { type: 'string', description: 'Text or regex pattern to search for', required: true },
          filePattern: { type: 'string', description: 'Glob to filter files (e.g. "*.ts", "src/**/*.js")', required: false },
          isRegex: { type: 'boolean', description: 'Treat pattern as regex (default false)', required: false },
          maxResults: { type: 'number', description: 'Max results (default 50)', required: false },
        },
      },
      {
        name: 'search_in_file',
        description: 'Search for text or regex patterns within a specific file. Returns all matching lines with line numbers.',
        parameters: {
          filePath: { type: 'string', description: 'File to search in', required: true },
          pattern: { type: 'string', description: 'Text or regex to search for', required: true },
          isRegex: { type: 'boolean', description: 'Treat as regex', required: false },
        },
      },
      // ── More File Tools ──
      {
        name: 'copy_file',
        description: 'Copy a file or directory to a new location within the project.',
        parameters: {
          source: { type: 'string', description: 'Source path', required: true },
          destination: { type: 'string', description: 'Destination path', required: true },
        },
      },
      {
        name: 'append_to_file',
        description: 'Append content to the end of an existing file without overwriting it. Creates the file if it does not exist. Use with write_file to build large files across multiple calls.',
        parameters: {
          filePath: { type: 'string', description: 'File path', required: true },
          content: { type: 'string', description: 'Content to append', required: true },
        },
      },
      {
        name: 'diff_files',
        description: 'Compare two files and show their differences line by line.',
        parameters: {
          fileA: { type: 'string', description: 'First file path', required: true },
          fileB: { type: 'string', description: 'Second file path', required: true },
        },
      },
      {
        name: 'http_request',
        description: 'Make an HTTP/HTTPS request (GET, POST, PUT, DELETE, PATCH). Returns response status, headers, and body.',
        parameters: {
          url: { type: 'string', description: 'Request URL', required: true },
          method: { type: 'string', description: "HTTP method (default 'GET')", required: false },
          headers: { type: 'object', description: 'Request headers', required: false },
          body: { type: 'string', description: 'Request body (for POST/PUT/PATCH)', required: false },
        },
      },
      {
        name: 'check_port',
        description: 'Check if a network port is in use and identify which process is using it.',
        parameters: {
          port: { type: 'number', description: 'Port number to check', required: true },
        },
      },
      {
        name: 'install_packages',
        description: 'Install packages using npm, pip, yarn, or other package managers. Auto-detects the package manager from the project.',
        parameters: {
          packages: { type: 'string', description: 'Space-separated package names', required: true },
          manager: { type: 'string', description: "'npm', 'pip', 'yarn' (default: auto-detect)", required: false },
        },
      },
      {
        name: 'undo_edit',
        description: 'Undo a file change made by a previous tool call. Restores the file to its state before the modification.',
        parameters: {
          filePath: { type: 'string', description: 'Path of the file to undo (use list_undoable to see available files)', required: false },
          all: { type: 'boolean', description: 'Undo ALL file changes at once', required: false },
        },
      },
      {
        name: 'list_undoable',
        description: 'List all files that have undo backups available from previous tool modifications.',
        parameters: {},
      },
      {
        name: 'replace_in_files',
        description: 'Find and replace text across multiple files in the project. Supports glob patterns to scope the search.',
        parameters: {
          searchText: { type: 'string', description: 'Text or regex pattern to find', required: true },
          replaceText: { type: 'string', description: 'Text to replace matches with', required: true },
          path: { type: 'string', description: 'Directory or file glob to search in (default: project root)', required: false },
          isRegex: { type: 'boolean', description: 'Treat searchText as a regex pattern', required: false },
        },
      },
      {
        name: 'open_file_in_editor',
        description: 'Open a file in the IDE editor as a new tab. Does not modify the file.',
        parameters: {
          filePath: { type: 'string', description: 'Path of the file to open', required: true },
        },
      },
      {
        name: 'generate_image',
        description: 'Generate an image from a text prompt using AI image generation. Returns base64-encoded image data and optionally saves to a file.',
        parameters: {
          prompt: { type: 'string', description: 'Description of the image to generate', required: true },
          width: { type: 'number', description: 'Image width in pixels (default 1024)', required: false },
          height: { type: 'number', description: 'Image height in pixels (default 1024)', required: false },
          savePath: { type: 'string', description: 'Optional — save the generated image to this file path in the project', required: false },
        },
      },
      // ── Planning / TODO Tools ──
      {
        name: 'write_todos',
        description: 'Create a todo list for multi-step builds only (skip for simple one-shot tasks). After write_todos, call update_todo for each item — in-progress when you start, done when you finish. Example: {"tool":"write_todos","params":{"items":["Step one","Step two"]}} or {"items":[{"text":"Step one","status":"pending"}]}. Example done: {"tool":"update_todo","params":{"id":1,"status":"done"}}',
        parameters: {
          items: { type: 'array', description: 'Array of todo strings or {text,status} objects (title/description aliases accepted)', required: true },
        },
      },
      {
        name: 'update_todo',
        description: 'Update one todo list item (only if write_todos was used). Call when starting (status in-progress) and finishing (status done) each todo. Status: pending, in-progress, done. Optional text to relabel the item.',
        parameters: {
          id: { type: 'number', description: 'Todo ID (from write_todos result)', required: true },
          status: { type: 'string', description: 'New status: pending, in-progress, or done', required: true },
          text: { type: 'string', description: 'New text (optional)', required: false },
        },
      },
      // ── Scratchpad Tools ──
      {
        name: 'write_scratchpad',
        description: 'Save intermediate data to a named scratchpad. Useful for storing large data outside the conversation context for later retrieval.',
        parameters: {
          name: { type: 'string', description: 'Scratchpad name (alphanumeric)', required: true },
          content: { type: 'string', description: 'Content to save', required: true },
        },
      },
      {
        name: 'read_scratchpad',
        description: 'Read previously saved scratchpad data by name.',
        parameters: {
          name: { type: 'string', description: 'Scratchpad name to read', required: true },
        },
      },
      {
        name: 'save_rule',
        description: 'Save a project rule or skill that persists across sessions. Rules are injected into the system prompt on every future chat. Use this when the user says "remember this", "always do X", "update your rules", or gives you a standing instruction. For large rules (>~2KB), prefer write_file to .guide/rules/<name>.md instead of a huge save_rule JSON payload.',
        parameters: {
          name: { type: 'string', description: 'Short rule name (e.g. "coding-style", "project-conventions")', required: true },
          content: { type: 'string', description: 'Rule content in markdown. Be specific and actionable.', required: true },
        },
      },
      {
        name: 'list_rules',
        description: 'List all saved project rules and skills.',
        parameters: {},
      },
      {
        name: 'ask_question',
        description: 'Ask the user a multi-part question and wait for their response. Use this when you need clarification, a decision, or user input before proceeding. The question appears in the chat input area with clickable option buttons. IMPORTANT: Options MUST be passed in the "options" array parameter as {label, description} objects to appear as clickable buttons. Options written in the question text string will NOT be clickable — they will just be plain text the user has to read.',
        parameters: {
          question: { type: 'string', description: 'The main question to ask the user (do NOT list options here — use the "options" array instead)', required: true },
          options: { type: 'array', description: 'REQUIRED for clickable options. Array of {label, description} objects (max 4). Each option becomes a clickable button the user can press. Without this array, the user sees only plain text with no buttons. Include a free-form option like {label:"Other"} if the user should be able to type their own answer.', required: false },
          allowMultiple: { type: 'boolean', description: 'If true, the user can select multiple options', required: false },
        },
      },
      // ── Process / System Tools ──
      {
        name: 'list_processes',
        description: 'List running processes on the system. Returns PID, command name, CPU%, and memory usage. Cross-platform: uses tasklist on Windows, ps on Unix.',
        parameters: {
          filter: { type: 'string', description: 'Filter processes by name (substring match, optional)', required: false },
          sortBy: { type: 'string', description: "Sort by: 'cpu', 'memory', or 'pid' (default 'cpu')", required: false },
          maxResults: { type: 'number', description: 'Max processes to return (default 30)', required: false },
        },
      },
      {
        name: 'kill_process',
        description: 'Kill a process by its PID. Use list_processes first to find the PID. This is a destructive operation — the process will be terminated immediately.',
        parameters: {
          pid: { type: 'number', description: 'Process ID to kill', required: true },
          force: { type: 'boolean', description: 'Force kill (SIGKILL on Unix, /F on Windows). Default: graceful termination.', required: false },
        },
      },
      {
        name: 'get_system_info',
        description: 'Get system information: OS, CPU cores, total/free memory, disk usage, and uptime. Useful for understanding the environment before running resource-intensive tasks.',
        parameters: {},
      },
      {
        name: 'get_env_var',
        description: 'Read the value of an environment variable. Returns the variable value or null if not set. Use this to check PATH, HOME, NODE_ENV, etc.',
        parameters: {
          name: { type: 'string', description: 'Environment variable name (e.g. "PATH", "HOME", "NODE_ENV")', required: true },
        },
      },
      {
        name: 'set_env_var',
        description: 'Set an environment variable for the current IDE session and persistent terminal. The variable persists for the lifetime of the session (not across app restarts). Use this to configure build environments, set API keys, or adjust PATH.',
        parameters: {
          name: { type: 'string', description: 'Environment variable name', required: true },
          value: { type: 'string', description: 'Variable value', required: true },
          persistent: { type: 'boolean', description: 'Also persist to shell profile (.bashrc, PowerShell profile) for future sessions. Default: false.', required: false },
        },
      },
      // ── Network Tools ──
      {
        name: 'ping_host',
        description: 'Ping a host and return latency statistics. Cross-platform: uses ping on all OSes. Returns min/avg/max latency and packet loss.',
        parameters: {
          host: { type: 'string', description: 'Hostname or IP address to ping', required: true },
          count: { type: 'number', description: 'Number of pings (default 4)', required: false },
        },
      },
      {
        name: 'dns_lookup',
        description: 'Resolve DNS records for a hostname. Returns A, AAAA, CNAME, and MX records when available. Useful for debugging network issues or verifying domain configuration.',
        parameters: {
          hostname: { type: 'string', description: 'Hostname to resolve (e.g. "example.com")', required: true },
          recordType: { type: 'string', description: "DNS record type: 'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS' (default: all available)", required: false },
        },
      },
      {
        name: 'download_file',
        description: 'Download a file from a URL to the project directory. Supports HTTP and HTTPS. Shows download progress. Use this to fetch assets, data files, or scripts.',
        parameters: {
          url: { type: 'string', description: 'URL to download from', required: true },
          savePath: { type: 'string', description: 'Relative path in the project to save the file (default: filename from URL)', required: false },
          overwrite: { type: 'boolean', description: 'Overwrite if file exists (default: false)', required: false },
        },
      },
      // ── Code Quality Tools ──
      {
        name: 'run_linter',
        description: 'Run a linter on a file or project. Auto-detects ESLint, Pylint, Ruff, Flake8, RuboCop, and other common linters from project config. Returns lint errors and warnings with file, line, and message.',
        parameters: {
          filePath: { type: 'string', description: 'File or directory to lint (default: project root)', required: false },
          fix: { type: 'boolean', description: 'Auto-fix lint errors where possible (default: false)', required: false },
          linter: { type: 'string', description: "Specific linter to use (e.g. 'eslint', 'pylint', 'ruff'). Auto-detected if omitted.", required: false },
        },
      },
      {
        name: 'run_tests',
        description: 'Run the project test suite. Auto-detects test runners: npm test, pytest, cargo test, go test, dotnet test. Returns test results with pass/fail counts and failure details.',
        parameters: {
          testPath: { type: 'string', description: 'Specific test file or directory (default: all tests)', required: false },
          testName: { type: 'string', description: 'Specific test name or pattern to run (e.g. "Auth.test")', required: false },
          runner: { type: 'string', description: "Test runner to use (e.g. 'jest', 'pytest', 'cargo'). Auto-detected if omitted.", required: false },
          coverage: { type: 'boolean', description: 'Generate coverage report (default: false)', required: false },
        },
      },
      {
        name: 'run_formatter',
        description: 'Run a code formatter on a file or project. Auto-detects Prettier, Black, rustfmt, gofmt, and other formatters from project config. Returns list of formatted files.',
        parameters: {
          filePath: { type: 'string', description: 'File or directory to format (default: project root)', required: false },
          formatter: { type: 'string', description: "Specific formatter (e.g. 'prettier', 'black', 'rustfmt'). Auto-detected if omitted.", required: false },
          check: { type: 'boolean', description: 'Check only — report unformatted files without changing them (default: false)', required: false },
        },
      },
      // ── IDE Integration Tools ──
      {
        name: 'open_terminal',
        description: 'Open a new terminal tab in the IDE. Optionally run a command in the new terminal. The terminal persists after the command completes — the user can continue interacting with it.',
        parameters: {
          command: { type: 'string', description: 'Initial command to run in the terminal (optional)', required: false },
          name: { type: 'string', description: 'Terminal tab name (optional)', required: false },
          cwd: { type: 'string', description: 'Working directory for the terminal (default: project root)', required: false },
        },
      },
      {
        name: 'switch_file',
        description: 'Open a file in the IDE editor and optionally move the cursor to a specific line. Use this to navigate the user to a relevant file or to show them where a change was made.',
        parameters: {
          filePath: { type: 'string', description: 'File to open', required: true },
          line: { type: 'number', description: 'Line number to scroll to (1-based, optional)', required: false },
          column: { type: 'number', description: 'Column number to position cursor (1-based, optional)', required: false },
        },
      },
      {
        name: 'get_diagnostics',
        description: 'Get VS Code-style diagnostics (errors, warnings, hints) for a file or the entire project. Returns the list of problems from the language server or linter that the IDE is currently showing. More reliable than running a linter manually because it uses the IDE\'s built-in analysis.',
        parameters: {
          filePath: { type: 'string', description: 'File to get diagnostics for (omit for all open files)', required: false },
          severity: { type: 'string', description: "Filter by severity: 'error', 'warning', 'info', 'hint' (default: all)", required: false },
        },
      },
      {
        name: 'get_selection',
        description: 'Get the currently selected text in the active editor, along with the file path and selection range. Use this when the user asks you to do something with "this code" or "the selected part".',
        parameters: {},
      },
      // ── Documentation Tools ──
      {
        name: 'read_doc',
        description: 'Read a documentation file (README, API docs, CHANGELOG, CONTRIBUTING, etc.) from the project. Returns the file content. Automatically looks in common doc locations if no path is specified.',
        parameters: {
          docPath: { type: 'string', description: 'Path to doc file, or a name like "README", "CHANGELOG", "CONTRIBUTING" to auto-locate', required: true },
        },
      },
      {
        name: 'search_docs',
        description: 'Search project documentation files for a keyword or pattern. Scans README, docs/, wiki/, and .md files. Returns matching files with context snippets.',
        parameters: {
          query: { type: 'string', description: 'Search query or keyword', required: true },
          maxResults: { type: 'number', description: 'Max results (default 10)', required: false },
        },
      },
      // ── Checkpoint Tools ──
      {
        name: 'list_checkpoints',
        description: 'List all available checkpoints (file snapshots from previous turns). Each checkpoint captures the original state of files before they were modified during that turn. Use this when the user asks to undo changes or go back to a previous state.',
        parameters: {},
      },
      {
        name: 'restore_checkpoint',
        description: 'Restore all files to their state before a specific turn. This reverses all file modifications made during that turn — modified files are reverted to their original content, and newly created files are deleted. Use list_checkpoints first to find the turn ID. This is a destructive operation — current file changes will be lost.',
        parameters: {
          turnId: { type: 'string', description: 'The turn ID to restore (from list_checkpoints)', required: true },
        },
      },

    ];
    // Merge tools discovered from MCP servers
    if (this.mcpClient) {
      const mcpTools = this.mcpClient.getDiscoveredTools();
      if (mcpTools.length > 0) {
        return [...this._allToolDefsCache, ...mcpTools];
      }
    }
    return this._allToolDefsCache;
  }

  // ─── Tool Execution Dispatch ──────────────────────────────────────────────

  async executeTool(toolName, params = {}) {
    const startTime = Date.now();
    let result;
    streamTrace.trace('stream', 'tool-exec-start', { toolName, params });

    const { checkPlanModeToolGate, checkGuideMetadataPathGate, isPlanFilePath, parsePlanFileContent, relativePlanPath } = require('./agentModeResolver');
    const planGate = checkPlanModeToolGate(toolName, params, this._agentContext);
    if (!planGate.allowed) {
      console.log(`[MCPToolServer] Plan mode gate blocked: ${toolName}`);
      const blocked = { success: false, error: planGate.error, planModeBlocked: true };
      streamTrace.trace('stream', 'tool-exec-blocked', { toolName, params, reason: 'planGate', result: blocked, durationMs: Date.now() - startTime });
      return blocked;
    }
    const guideGate = checkGuideMetadataPathGate(toolName, params);
    if (!guideGate.allowed) {
      console.log(`[MCPToolServer] Guide metadata path gate blocked: ${toolName}`);
      const blocked = { success: false, error: guideGate.error, guidePathBlocked: true };
      streamTrace.trace('stream', 'tool-exec-blocked', { toolName, params, reason: 'guideGate', result: blocked, durationMs: Date.now() - startTime });
      return blocked;
    }

    // Reject disabled tools. We intentionally report this as "does not exist"
    // rather than "disabled in settings" so the model treats it as an unknown
    // tool and picks a different path, instead of retrying the same call
    // expecting the user to flip a setting mid-generation.
    if (this._disabledTools.has(toolName)) {
      console.log(`[MCPToolServer] Blocked disabled tool: ${toolName}`);
      return { success: false, error: `Tool "${toolName}" does not exist. Choose a different tool.` };
    }

    if (toolName && typeof toolName === 'string') {
      params = canonicalizeToolParams(toolName, params);
    }

    // R51-Fix: Strip leading slashes from Unix-style paths — models output /path/file.js
    // meaning path/file.js relative to project root. On Windows, path.isAbsolute('/path/file.js')
    // returns true and resolves to C:\path\file.js, which escapes the project and fails.
    // Real Windows absolute paths have drive letters (C:\...) and won't match this check.
    for (const key of ['filePath', 'dirPath', 'path', 'oldPath', 'newPath']) {
      if (params[key] && typeof params[key] === 'string' && /^\//.test(params[key]) && !/^[A-Za-z]:/.test(params[key])) {
        params[key] = params[key].replace(/^\/+/, '');
      }
    }

    // Rate limit check
    const rateResult = this._checkRateLimit(toolName);
    if (!rateResult.allowed) {
      return { success: false, error: `Rate limit: too many ${toolName} calls. Wait a moment and try again. (${rateResult.count}/${rateResult.max} in last ${Math.round(rateResult.window/1000)}s)` };
    }

    // Sanitize all file path params
    try {
      for (const key of ['filePath', 'dirPath', 'path', 'oldPath', 'newPath', 'source', 'destination', 'searchPath']) {
        if (params[key]) {
          params[key] = this._sanitizeFilePath(params[key]);
        }
      }
    } catch (error) {
      return { success: false, error: error.message };
    }

    // Permission gate for destructive operations (skipped when auto-allow is enabled)
    if (this._requireToolApproval && this.onPermissionRequest && this._destructiveTools.has(toolName)) {
      const reason = `Tool "${toolName}" may modify or delete files/data.`;
      const allowed = await this.onPermissionRequest(toolName, params, reason);
      if (!allowed) {
        return { success: false, error: 'Operation denied by user', permissionDenied: true };
      }
    }

    // Execution policy for command tools (run_command, terminal_run)
    if (toolName === 'run_command' || toolName === 'terminal_run') {
      const policyResult = this._checkExecutionPolicy(toolName, params);
      if (!policyResult.allowed) {
        if (this._requireToolApproval && this.onPermissionRequest) {
          const allowed = await this.onPermissionRequest(toolName, params, policyResult.reason);
          if (!allowed) {
            return { success: false, error: 'Command requires approval', permissionDenied: true, policyReason: policyResult.reason };
          }
        } else {
          return { success: false, error: `Command blocked by execution policy: ${policyResult.reason}`, permissionDenied: true };
        }
      }
    }

    try {
      switch (toolName) {
        case 'web_search':
          result = await this._webSearch(params.query, params.maxResults);
          break;
        case 'fetch_webpage':
          result = await this._fetchWebpage(params.url);
          break;
        case 'read_file':
          result = await this._readFile(params.filePath, params.startLine, params.endLine);
          break;
        case 'write_file':
          streamTrace.traceFull('stream', 'write-file-disk-phase', params.content != null ? String(params.content) : '', {
            filePath: params.filePath,
            contentLen: params.content != null ? String(params.content).length : 0,
          });
          result = await this._writeFile(params.filePath, params.content);
          break;
        case 'search_codebase':
          result = await this._searchCodebase(params.query, params.maxResults);
          break;
        case 'run_command':
          result = await this._runCommand(params.command, params.cwd, params.timeout, params.shell);
          break;
        case 'terminal_run':
          result = await this._terminalRun(params.command, params.timeout, params.reset);
          break;
        case 'create_directory':
          result = await this._createDirectory(params.path);
          break;
        case 'list_directory':
          result = await this._listDirectory(params.dirPath, params.recursive);
          break;
        case 'find_files':
          result = await this._findFiles(params.pattern);
          break;
        case 'analyze_error':
          result = await this._analyzeError(params.errorMessage, params.stackTrace);
          break;
        // Browser tools (with timeout wrappers)
        case 'browser_navigate':
          result = await this._withTimeout(this._browserNavigate(params.url), 60000, 'browser_navigate');
          break;
        case 'browser_snapshot':
          result = await this._withTimeout(this._browserSnapshot(), 30000, 'browser_snapshot');
          break;
        case 'viewport_browser_snapshot':
          result = await this._withTimeout(this._viewportBrowserSnapshot(), 30000, 'viewport_browser_snapshot');
          break;
        case 'browser_click':
          if (!params.ref) return { success: false, error: 'Missing "ref" parameter. Use the [ref=eN] from browser_snapshot, e.g. {"ref":"e5"}' };
          result = await this._withTimeout(this._browserClick(params.ref, params), 30000, 'browser_click');
          break;
        case 'browser_type':
          if (!params.ref) return { success: false, error: 'Missing "ref" parameter. Use the [ref=eN] from browser_snapshot, e.g. {"ref":"e3","text":"hello"}' };
          if (params.text == null) return { success: false, error: 'Missing "text" parameter for browser_type.' };
          result = await this._withTimeout(this._browserType(params.ref, params.text, params), 30000, 'browser_type');
          break;
        case 'browser_fill_form':
          result = await this._withTimeout(this._browserFillForm(params.fields), 30000, 'browser_fill_form');
          break;
        case 'browser_select_option':
          result = await this._withTimeout(this._browserSelectOption(params.ref, params.values), 30000, 'browser_select_option');
          break;
        case 'browser_screenshot':
          result = await this._withTimeout(this._browserScreenshot(params), 30000, 'browser_screenshot');
          break;
        case 'browser_get_content':
          result = await this._withTimeout(this._browserGetContent(params.selector, params.html), 30000, 'browser_get_content');
          break;
        case 'browser_evaluate':
          result = await this._withTimeout(this._browserEvaluate(params.code, params.ref), 30000, 'browser_evaluate');
          break;
        case 'browser_list_elements':
          result = await this._withTimeout(this._browserSnapshot(), 30000, 'browser_list_elements');
          break;
        case 'browser_wait_for_element':
          result = await this._withTimeout(this._browserWaitFor({ selector: params.selector, timeout: params.timeout }), 60000, 'browser_wait_for_element');
          break;
        case 'get_project_structure':
          result = await this._getProjectStructure();
          break;
        case 'browser_scroll':
          result = await this._withTimeout(this._browserScroll(params.direction, params.amount), 30000, 'browser_scroll');
          break;
        case 'browser_wait':
          result = await this._withTimeout(this._browserWait(params.ms), Math.min((params.ms || 5000) + 5000, 60000), 'browser_wait');
          break;
        case 'browser_wait_for':
          result = await this._withTimeout(this._browserWaitFor(params), 60000, 'browser_wait_for');
          break;
        case 'browser_back':
          result = await this._withTimeout(this._browserBack(), 30000, 'browser_back');
          break;
        case 'browser_press_key':
          result = await this._withTimeout(this._browserPressKey(params.key), 15000, 'browser_press_key');
          break;
        case 'browser_hover':
          result = await this._withTimeout(this._browserHover(params.ref), 15000, 'browser_hover');
          break;
        case 'browser_drag':
          result = await this._withTimeout(this._browserDrag(params.startRef, params.endRef), 30000, 'browser_drag');
          break;
        case 'browser_tabs':
          result = await this._withTimeout(this._browserTabs(params.action, params.index), 15000, 'browser_tabs');
          break;
        case 'browser_handle_dialog':
          result = await this._withTimeout(this._browserHandleDialog(params.accept, params.promptText), 15000, 'browser_handle_dialog');
          break;
        case 'browser_console_messages':
          result = await this._withTimeout(this._browserConsoleMessages(params.level), 15000, 'browser_console_messages');
          break;
        case 'browser_file_upload':
          result = await this._withTimeout(this._browserFileUpload(params.ref, params.paths), 30000, 'browser_file_upload');
          break;
        case 'browser_resize':
          result = await this._withTimeout(this._browserResize(params.width, params.height), 15000, 'browser_resize');
          break;
        case 'browser_get_url':
          result = await this._withTimeout(this._browserGetUrl(), 15000, 'browser_get_url');
          break;
        case 'browser_get_links':
          result = await this._withTimeout(this._browserGetLinks(params.selector), 30000, 'browser_get_links');
          break;
        case 'browser_close':
          result = await this._withTimeout(this._browserClose(), 15000, 'browser_close');
          break;
        case 'browser_select':
          result = await this._withTimeout(this._browserSelectOption(params.ref || params.selector, params.value ? [params.value] : []), 30000, 'browser_select');
          break;
        // Memory tools
        case 'save_memory':
          result = await this._saveMemory(params.key, params.value);
          break;
        case 'get_memory':
          result = await this._getMemory(params.key);
          break;
        case 'list_memories':
          result = await this._listMemories();
          break;
        // File ops
        case 'delete_file':
          result = await this._deleteFile(params.filePath);
          break;
        case 'rename_file':
          result = await this._renameFile(params.oldPath, params.newPath);
          break;
        case 'edit_file':
          if (params.newText != null) {
            streamTrace.traceFull('stream', 'edit-file-disk-phase', String(params.newText), {
              filePath: params.filePath,
              newTextLen: String(params.newText).length,
            });
          }
          result = await this._editFile(params.filePath, params.oldText, params.newText);
          break;
        case 'get_file_info':
          result = await this._getFileInfo(params.filePath);
          break;
        // Git tools
        case 'git_status':
          result = await this._gitStatus();
          break;
        case 'git_commit':
          result = await this._gitCommit(params.message);
          break;
        case 'git_diff':
          result = await this._gitDiff(params.filePath);
          break;
        case 'git_log':
          result = await this._gitLog(params.maxCount, params.filePath);
          break;
        case 'git_branch':
          result = await this._gitBranch(params.action, params.name);
          break;
        case 'git_stash':
          result = await this._gitStash(params.action, params.message);
          break;
        case 'git_reset':
          result = await this._gitReset(params.filePath, params.hard);
          break;
        case 'git_push':
          result = await this._gitPush(params.remote, params.branch, params.force);
          break;
        case 'git_branch_delete':
          result = await this._gitBranchDelete(params.branch, params.remote, params.force);
          break;
        // Search
        case 'grep_search':
          result = await this._grepSearch(params.pattern, params.filePattern, params.isRegex, params.maxResults);
          break;
        case 'search_in_file':
          result = await this._searchInFile(params.filePath, params.pattern, params.isRegex);
          break;
        // File ops continued
        case 'copy_file':
          result = await this._copyFile(params.source, params.destination);
          break;
        case 'append_to_file':
          result = await this._appendToFile(params.filePath, params.content);
          break;
        case 'diff_files':
          result = await this._diffFiles(params.fileA, params.fileB);
          break;
        // Network
        case 'http_request':
          result = await this._httpRequest(params.url, params.method, params.headers, params.body);
          break;
        case 'check_port':
          result = await this._checkPort(params.port);
          break;
        case 'install_packages':
          result = await this._installPackages(params.packages, params.manager);
          break;
        // Undo
        case 'undo_edit':
          if (params.all) {
            result = await this.undoAllFileChanges();
          } else if (params.filePath) {
            result = await this.undoFileChange(params.filePath.includes(path.sep) ? params.filePath : path.join(this.projectPath || '', params.filePath));
          } else {
            result = { success: false, error: 'Provide filePath or set all=true. Use list_undoable to see available files.' };
          }
          break;
        case 'list_undoable':
          result = { success: true, files: await this.getUndoableFiles() };
          break;
        case 'replace_in_files':
          result = await this._replaceInFiles(params.searchText, params.replaceText, params.path, params.isRegex);
          break;
        case 'open_file_in_editor':
          result = await this._openFileInEditor(params.filePath);
          break;
        case 'generate_image':
          result = await this._generateImage(params.prompt, params.width, params.height, params.savePath);
          break;
        // TODO tools
        case 'write_todos':
          result = this._writeTodos(params);
          if (result?.success && this._agentContext.planMode && this._agentContext.agentPhase !== 'building') {
            if (this._send) {
              this._send('plan-todos-updated', {
                todos: this._todos.map((t) => ({
                  id: String(t.id),
                  content: t.text,
                  status: t.status,
                })),
              });
            }
            // Promote to plan-ready when todos written and plan file exists on disk
            this.emitExistingPlanIfFound().catch(() => {});
          }
          break;
        case 'update_todo':
          result = this._updateTodo(params);
          break;
        // Scratchpad
        case 'write_scratchpad':
          result = this._writeScratchpad(params);
          break;
        case 'read_scratchpad':
          result = this._readScratchpad(params);
          break;
        case 'save_rule':
          result = this._saveRule(params);
          break;
        case 'list_rules':
          result = this._listRules();
          break;
        case 'ask_question':
          result = await this._askQuestion(params);
          break;
        // Process / System tools
        case 'list_processes':
          result = await this._listProcesses(params.filter, params.sortBy, params.maxResults);
          break;
        case 'kill_process':
          result = await this._killProcess(params.pid, params.force);
          break;
        case 'get_system_info':
          result = await this._getSystemInfo();
          break;
        case 'get_env_var':
          result = await this._getEnvVar(params.name);
          break;
        case 'set_env_var':
          result = await this._setEnvVar(params.name, params.value, params.persistent);
          break;
        // Network tools
        case 'ping_host':
          result = await this._pingHost(params.host, params.count);
          break;
        case 'dns_lookup':
          result = await this._dnsLookup(params.hostname, params.recordType);
          break;
        case 'download_file':
          result = await this._downloadFile(params.url, params.savePath, params.overwrite);
          break;
        // Code quality tools
        case 'run_linter':
          result = await this._runLinter(params.filePath, params.fix, params.linter);
          break;
        case 'run_tests':
          result = await this._runTests(params.testPath, params.testName, params.runner, params.coverage);
          break;
        case 'run_formatter':
          result = await this._runFormatter(params.filePath, params.formatter, params.check);
          break;
        // IDE integration tools
        case 'open_terminal':
          result = await this._openTerminal(params.command, params.name, params.cwd);
          break;
        case 'switch_file':
          result = await this._switchFile(params.filePath, params.line, params.column);
          break;
        case 'get_diagnostics':
          result = await this._getDiagnostics(params.filePath, params.severity);
          break;
        case 'get_selection':
          result = await this._getSelection();
          break;
        // Documentation tools
        case 'read_doc':
          result = await this._readDoc(params.docPath);
          break;
        case 'search_docs':
          result = await this._searchDocs(params.query, params.maxResults);
          break;
        // Checkpoint tools
        case 'list_checkpoints':
          result = { success: true, checkpoints: this.getCheckpointList() };
          break;
        case 'restore_checkpoint':
          result = await this.restoreCheckpoint(params.turnId);
          break;
        default:
          // Try routing to MCP server for dynamically discovered tools
          if (this.mcpClient && this.mcpClient.isMCPTool(toolName)) {
            console.log(`[MCPToolServer] executeTool: routing "${toolName}" to MCP client`);
            result = await this.mcpClient.executeTool(toolName, params);
            // Emit for streaming display in frontend
            if (this._send) this._send('mcp-tool-results', { tool: toolName, result });
          } else {
            result = { success: false, error: `Unknown tool: ${toolName}` };
          }
      }
    } catch (error) {
      result = { success: false, error: error.message };
    }

    if (result && typeof result === 'object') {
      result = await this._attachSimilarNamesOnEnoent(toolName, params, result);
    }

    // Truncate oversized results (50KB cap)
    if (result && typeof result === 'object') {
      const resultStr = JSON.stringify(result);
      if (resultStr.length > 50000) {
        const truncKeys = ['output', 'content', 'body', 'data', 'stdout', 'message', 'text', 'html'];
        for (const key of truncKeys) {
          if (result[key] && typeof result[key] === 'string' && result[key].length > 40000) {
            result[key] = result[key].substring(0, 40000) + '\n... [truncated, total ' + result[key].length + ' chars]';
            break;
          }
        }
      }
    }

    // Record in history
    const entry = {
      tool: toolName,
      params,
      result: typeof result === 'object' ? result : { data: result },
      duration: Date.now() - startTime,
      timestamp: Date.now(),
    };
    this.toolHistory.push(entry);
    if (this.toolHistory.length > this.maxHistory) {
      this.toolHistory.shift();
    }

    const inBuildPhase = this._agentContext?.agentPhase === 'building';
    if (!inBuildPhase && toolName === 'write_file' && result?.success && isPlanFilePath(params.filePath || params.path)) {
      this._emitPlanReady(params.filePath || params.path, params.content != null ? String(params.content) : '', result.path);
    }

    if (!inBuildPhase && toolName === 'edit_file' && result?.success && isPlanFilePath(params.filePath || params.path)) {
      try {
        const fp = result.path || path.resolve(this.projectPath, params.filePath || params.path);
        const content = await fs.readFile(fp, 'utf8');
        this._emitPlanReady(params.filePath || params.path, content, fp);
      } catch (_) { /* plan-ready optional */ }
    }

    streamTrace.trace('stream', 'tool-exec-done', {
      toolName,
      params,
      result,
      durationMs: Date.now() - startTime,
    });
    return result;
  }

  _emitPlanReady(filePath, content, fullPathOverride) {
    const { parsePlanFileContent, relativePlanPath, isPlanFilePath } = require('./agentModeResolver');
    if (!isPlanFilePath(filePath)) return;
    const parsed = parsePlanFileContent(content);
    const relPath = relativePlanPath(fullPathOverride || filePath, this.projectPath);
    if (this._send) {
      this._send('plan-ready', {
        path: relPath,
        fullPath: fullPathOverride || filePath,
        content,
        title: parsed.title,
        overview: parsed.overview,
        todos: parsed.todos,
      });
    }
  }

  /** Scan disk for an existing plan file and emit plan-ready (plan mode startup / stuck planning). */
  async emitExistingPlanIfFound() {
    if (!this.projectPath) return null;
    const plansDir = path.join(this.projectPath, '.guide', 'plans');
    try {
      const entries = await fs.readdir(plansDir, { withFileTypes: true });
      const planFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.plan.md'));
      if (planFiles.length === 0) return null;
      let latest = planFiles[0];
      let latestMtime = 0;
      for (const ent of planFiles) {
        const fp = path.join(plansDir, ent.name);
        const st = await fs.stat(fp);
        if (st.mtimeMs >= latestMtime) {
          latestMtime = st.mtimeMs;
          latest = ent;
        }
      }
      const fullPath = path.join(plansDir, latest.name);
      const content = await fs.readFile(fullPath, 'utf8');
      this._emitPlanReady(fullPath, content, fullPath);
      return fullPath;
    } catch (_) {
      return null;
    }
  }

  // ─── Backup & Undo System ────────────────────────────────────────────────

  _setFileBackup(filePath, backup) {
    this._fileBackups.set(filePath, backup);
    if (this._currentTurnId && !this._currentTurnCapture.has(filePath)) {
      this._currentTurnCapture.set(filePath, { original: backup.original, isNew: backup.isNew });
    }
    if (this._fileBackups.size > this._maxFileBackups) {
      let oldestKey = null, oldestTime = Infinity;
      for (const [key, val] of this._fileBackups) {
        if (val.timestamp < oldestTime) { oldestTime = val.timestamp; oldestKey = key; }
      }
      if (oldestKey) this._fileBackups.delete(oldestKey);
    }
  }

  async getUndoableFiles() {
    const files = [];
    for (const [filePath, backup] of this._fileBackups) {
      const originalLines = backup.isNew ? 0 : (backup.original || '').split('\n').length;
      let currentLines = 0;
      try {
        const currentContent = await fs.readFile(filePath, 'utf8');
        currentLines = currentContent.split('\n').length;
      } catch {
        currentLines = 0;
      }
      files.push({
        filePath,
        fileName: path.basename(filePath),
        timestamp: backup.timestamp,
        tool: backup.tool,
        isNew: backup.isNew,
        linesAdded: Math.max(0, currentLines - originalLines),
        linesRemoved: Math.max(0, originalLines - currentLines),
      });
    }
    return files;
  }

  async undoFileChange(filePath) {
    const backup = this._fileBackups.get(filePath);
    if (!backup) return { success: false, error: 'No backup found for this file' };
    try {
      if (backup.isNew) {
        await fs.unlink(filePath);
      } else {
        await fs.writeFile(filePath, backup.original, 'utf8');
      }
      this._fileBackups.delete(filePath);
      return { success: true, action: backup.isNew ? 'deleted' : 'restored', filePath };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async undoAllFileChanges() {
    const results = [];
    for (const [filePath] of this._fileBackups) {
      results.push(await this.undoFileChange(filePath));
    }
    return results;
  }

  acceptFileChanges(filePaths) {
    if (!filePaths || filePaths.length === 0) {
      this._fileBackups.clear();
      return { success: true, cleared: 'all' };
    }
    for (const fp of filePaths) {
      this._fileBackups.delete(fp);
    }
    return { success: true, cleared: filePaths.length };
  }

  // ─── Checkpoint System ───────────────────────────────────────────────────

  startTurn(turnId) {
    this._currentTurnId = turnId;
    this._currentTurnCapture = new Map();
  }

  finalizeCurrentTurn(userMessage) {
    if (!this._currentTurnId || this._currentTurnCapture.size === 0) {
      this._currentTurnId = null;
      return null;
    }
    const files = [];
    for (const [filePath, data] of this._currentTurnCapture) {
      files.push({ filePath, fileName: path.basename(filePath), isNew: data.isNew, original: data.original });
    }
    const snapshot = {
      turnId: this._currentTurnId,
      timestamp: Date.now(),
      userMessage: (userMessage || '').substring(0, 100),
      files,
    };
    this._turnSnapshots.push(snapshot);
    if (this._turnSnapshots.length > this._maxTurnSnapshots) this._turnSnapshots.shift();
    this._currentTurnId = null;
    this._persistCheckpointsToDisk();
    return snapshot;
  }

  getCheckpointList() {
    return this._turnSnapshots.map(s => ({
      turnId: s.turnId,
      timestamp: s.timestamp,
      userMessage: s.userMessage,
      files: s.files.map(f => ({ filePath: f.filePath, fileName: f.fileName, isNew: f.isNew })),
    }));
  }

  async restoreCheckpoint(turnId) {
    const snapshot = this._turnSnapshots.find(s => s.turnId === turnId);
    if (!snapshot) return { success: false, error: 'Checkpoint not found' };
    const results = [];
    for (const file of snapshot.files) {
      try {
        if (file.isNew) {
          try { await fs.unlink(file.filePath); } catch (unlinkErr) { console.warn(`[MCPToolServer] restoreCheckpoint: failed to delete new file ${file.filePath}: ${unlinkErr.message}`); }
          results.push({ filePath: file.filePath, action: 'deleted' });
        } else {
          await fs.writeFile(file.filePath, file.original, 'utf8');
          results.push({ filePath: file.filePath, action: 'restored' });
        }
      } catch (err) {
        results.push({ filePath: file.filePath, action: 'failed', error: err.message });
      }
    }
    const idx = this._turnSnapshots.findIndex(s => s.turnId === turnId);
    if (idx !== -1) this._turnSnapshots.splice(idx);
    this._persistCheckpointsToDisk();
    return { success: true, results, restoredCount: results.filter(r => r.action !== 'failed').length };
  }

  // ─── Checkpoint Persistence ──────────────────────────────────────────────

  _checkpointFilePath() {
    if (!this._userDataPath) return null;
    return path.join(this._userDataPath, 'checkpoints.json');
  }

  _loadCheckpointsFromDisk() {
    const filePath = this._checkpointFilePath();
    if (!filePath) return;
    try {
      const data = require('fs').readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        this._turnSnapshots = parsed.slice(0, this._maxTurnSnapshots);
        console.log(`[MCPToolServer] loaded ${this._turnSnapshots.length} checkpoints from disk`);
      }
    } catch (err) {
      // File doesn't exist or is corrupt — start fresh
      this._turnSnapshots = [];
    }
  }

  _persistCheckpointsToDisk() {
    const filePath = this._checkpointFilePath();
    if (!filePath) return;
    try {
      const syncFs = require('fs');
      const data = JSON.stringify(this._turnSnapshots);
      const tmpPath = filePath + '.tmp';
      syncFs.writeFileSync(tmpPath, data, 'utf8');
      syncFs.renameSync(tmpPath, filePath);
    } catch (err) {
      console.warn(`[MCPToolServer] failed to persist checkpoints: ${err.message}`);
    }
  }

  // ─── Tool Implementations ────────────────────────────────────────────────

  async _webSearch(query, maxResults = 5) {
    if (!this.webSearch) return { success: false, error: 'Web search not available' };
    if (typeof query !== 'string' || query.trim() === '') {
      return { success: false, error: 'web_search requires a non-empty string parameter named "query" inside params. Example: {"tool":"web_search","params":{"query":"node lts release notes","maxResults":5}}' };
    }
    const raw = await this.webSearch.search(query, maxResults);
    if (raw && raw.error) return { success: false, error: raw.error };
    const results = Array.isArray(raw) ? raw : (raw?.results || []);
    if (results.length === 0) return { success: false, error: 'No results found' };
    return { success: true, results };
  }

  async _fetchWebpage(url) {
    if (!this.webSearch) return { success: false, error: 'Web fetch not available' };
    return this.webSearch.fetchPage(url);
  }

  async _readFile(filePath, startLine, endLine) {
    if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
      return { success: false, error: 'Missing required parameter: filePath (string). Provide the path of the file to read. Example: {"filePath":"src/app.js"}' };
    }
    const fullPath = this._sanitizeFilePath(path.isAbsolute(filePath) ? filePath : path.join(this.projectPath || '', filePath));
    try {
      const stats = await fs.stat(fullPath);
      if (stats.size > 10 * 1024 * 1024) {
        return { success: false, error: `File too large (${Math.round(stats.size / 1024 / 1024)}MB). Max 10MB for read_file.` };
      }
      // Reject binary/image files — reading them as utf8 produces garbage
      const ext = path.extname(fullPath).toLowerCase();
      const binaryExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.svg', '.tiff', '.tif', '.heic', '.heif',
        '.zip', '.tar', '.gz', '.rar', '.7z', '.exe', '.dll', '.so', '.dylib', '.node', '.wasm',
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.mp3', '.mp4', '.wav', '.avi', '.mkv']);
      if (binaryExts.has(ext)) {
        return { success: false, error: `Cannot read binary file (${ext}). read_file only works on text files. Image files cannot be viewed as text — ask the user to describe the image content instead.` };
      }
      let content = await fs.readFile(fullPath, 'utf8');
      const totalLines = content.split('\n').length;

      if (startLine || endLine) {
        const lines = content.split('\n');
        const start = Math.max(0, (startLine || 1) - 1);
        const end = Math.min(lines.length, endLine || lines.length);
        content = lines.slice(start, end).join('\n');
        return { success: true, content, path: fullPath, totalLines, readRange: `${start + 1}-${end}` };
      }

      return { success: true, content, path: fullPath, totalLines };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async _writeFile(filePath, content) {
    if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
      return { success: false, error: 'Missing required parameter: filePath (string). Provide the path of the file to write. Example: {"filePath":"src/app.js","content":"..."}' };
    }
    if (content === undefined || content === null) {
      return { success: false, error: `Missing required parameter: content (string). You called write_file for "${filePath}" but provided no content. Include the full file content. Example: {"filePath":"${filePath}","content":"your code here"}` };
    }
    // RC2-Fix: Auto-create temp project directory when no folder is open.
    // Without this, all file operations fail silently with "No project folder is open"
    // and the model enters a degenerate loop calling get_project_structure repeatedly.
    if (!this.projectPath) {
      const os = require('os');
      const tempDir = path.join(os.tmpdir(), `guide-project-${Date.now()}`);
      await fs.mkdir(tempDir, { recursive: true });
      this.projectPath = tempDir;
      console.log(`[MCPToolServer] RC2-Fix: Auto-created temp project dir: ${tempDir}`);
      // Emit files-changed so frontend file explorer picks it up
      if (this._send) this._send('files-changed', { projectPath: tempDir });
    }
    const fullPath = this._sanitizeFilePath(path.isAbsolute(filePath) ? filePath : path.join(this.projectPath, filePath));
    try {
      let isNew = true;
      let existingContent = null;
      try {
        existingContent = await fs.readFile(fullPath, 'utf8');
        this._setFileBackup(fullPath, { original: existingContent, timestamp: Date.now(), tool: 'write_file', isNew: false });
        isNew = false;
      } catch {
        this._setFileBackup(fullPath, { original: null, timestamp: Date.now(), tool: 'write_file', isNew: true });
      }

      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      // Unconditional unescape: handle ALL JSON double-escape sequences.
      // Models often double-escape when generating JSON content strings.
      // Order matters: protect real backslashes first, then unescape sequences.
      if (typeof content === 'string' && (content.includes('\\n') || content.includes('\\"'))) {
        content = content
          .replace(/\\\\/g, '\x00ESC_BS')
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\r/g, '\r')
          .replace(/\\"/g, '"')
          .replace(/\\\//g, '/')
          .replace(/\x00ESC_BS/g, '\\');
      }
      // R38-Fix-C: Strip stray character before <!DOCTYPE in HTML files.
      // LLM JSON encoding can produce a leading "/" (from \/ escape) or other
      // single stray character before <!DOCTYPE. No valid HTML starts this way.
      if (typeof content === 'string') {
        const htmlExt = fullPath.match(/\.(html?|xhtml)$/i);
        if (htmlExt) {
          content = content.replace(/^[^<\s](<!\s*DOCTYPE)/i, '$1');
        }
      }
      // Strip wrapping markdown code fences — model may wrap file content in ```lang...```
      // markers. A .ts/.js file ending with ``` fails structural completeness checks and
      // causes infinite retry loops. Strip them for all non-markdown/text file types.
      if (typeof content === 'string') {
        const _fenceExt = path.extname(fullPath).toLowerCase().slice(1);
        if (!['md', 'markdown', 'txt', 'rst'].includes(_fenceExt)) {
          content = content.replace(/^```[a-zA-Z0-9+#.-]*\r?\n/, '');
          content = content.replace(/\r?\n```[^\n]*$/, '');
          // Closing fence without newline before ```, or extra trailing fence (common on HTML)
          content = content.replace(/\r?\n```[a-zA-Z0-9+#.-]*\s*$/m, '');
          content = content.replace(/```[a-zA-Z0-9+#.-]*\s*$/m, '');
        }
      }
      await fs.writeFile(fullPath, content, 'utf8');

      if (this.browserManager?.parentWindow) {
        this.browserManager.parentWindow.webContents.send('files-changed');
        this.browserManager.parentWindow.webContents.send('agent-file-modified', {
          filePath: fullPath,
          newContent: content,
          isNew,
          tool: 'write_file',
        });
      }

      const result = { success: true, path: fullPath, isNew };
      // Attach linter/diagnostic feedback after a brief delay for Monaco to process
      const diagFeedback = await this._getDiagnosticFeedback(fullPath, 600);
      if (diagFeedback) result.diagnostics = diagFeedback;
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async _editFile(filePath, oldText, newText) {
    const fullPath = this._sanitizeFilePath(path.isAbsolute(filePath) ? filePath : path.join(this.projectPath || '', filePath));
    try {
      let content = await fs.readFile(fullPath, 'utf8');
      const originalContent = content;

      if (this.browserManager?.parentWindow) {
        this.browserManager.parentWindow.webContents.send('agent-file-modified', {
          filePath: fullPath,
          newContent: originalContent,
          originalContent,
          preview: true,
          isNew: false,
          tool: 'edit_file',
        });
      }

      const normLF = s => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const trimLines = s => s.split('\n').map(l => l.trimEnd()).join('\n');
      const collapseWS = s => s.replace(/\s+/g, ' ').trim();
      let matched = false;

      if (content.includes(oldText)) {
        matched = true;
      } else if (normLF(content).includes(normLF(oldText))) {
        content = normLF(content);
        oldText = normLF(oldText);
        matched = true;
      } else if (trimLines(normLF(content)).includes(trimLines(normLF(oldText)))) {
        content = trimLines(normLF(content));
        oldText = trimLines(normLF(oldText));
        matched = true;
      } else {
        const contentNorm = normLF(content);
        const oldNorm = normLF(oldText);
        const contentCollapsed = collapseWS(contentNorm);
        const oldCollapsed = collapseWS(oldNorm);
        if (contentCollapsed.includes(oldCollapsed) && oldCollapsed.length >= 20) {
          const lines = contentNorm.split('\n');
          let accumulated = '';
          let startLine = -1, endLine = -1;
          for (let i = 0; i < lines.length; i++) {
            accumulated += (accumulated ? ' ' : '') + lines[i].trim();
            if (startLine < 0 && accumulated.includes(oldCollapsed)) {
              endLine = i;
              let charCount = 0;
              for (let j = i; j >= 0; j--) {
                charCount += lines[j].trim().length + (j < i ? 1 : 0);
                if (charCount >= oldCollapsed.length) {
                  startLine = j;
                  break;
                }
              }
              break;
            }
          }
          if (startLine >= 0 && endLine >= 0) {
            const before = lines.slice(0, startLine).join('\n');
            const after = lines.slice(endLine + 1).join('\n');
            content = before + (before ? '\n' : '') + newText + (after ? '\n' : '') + after;
            matched = true;
            console.log(`[MCPToolServer] edit_file: whitespace-collapsed match at lines ${startLine + 1}-${endLine + 1}`);
          }
        }
      }

      if (!matched) {
        // Level 5: Fuzzy match via Levenshtein sliding window (allows ~15% character differences)
        const fuzzy = this._fuzzyMatchText(normLF(content), normLF(oldText), 0.85);
        if (fuzzy) {
          const contentLines = normLF(content).split('\n');
          const before = contentLines.slice(0, fuzzy.startLine).join('\n');
          const after = contentLines.slice(fuzzy.endLine + 1).join('\n');
          content = before + (before ? '\n' : '') + newText + (after ? '\n' : '') + after;
          matched = true;
          console.log(`[MCPToolServer] edit_file: fuzzy match at lines ${fuzzy.startLine + 1}-${fuzzy.endLine + 1} (similarity: ${fuzzy.similarity})`);
        }
      }

      if (!matched) {
        const contentLines = normLF(content).split('\n');
        const oldLines = normLF(oldText).split('\n');
        const firstOldLine = oldLines[0].trim();
        let closestLine = -1, closestSim = 0;
        for (let i = 0; i < contentLines.length; i++) {
          const trimmed = contentLines[i].trim();
          if (trimmed === firstOldLine) { closestLine = i + 1; closestSim = 1; break; }
          if (firstOldLine.length > 5) {
            const shorter = Math.min(trimmed.length, firstOldLine.length);
            const longer = Math.max(trimmed.length, firstOldLine.length);
            if (shorter > 0 && longer > 0) {
              let m = 0;
              for (let j = 0; j < shorter; j++) { if (trimmed[j] === firstOldLine[j]) m++; }
              const sim = m / longer;
              if (sim > closestSim) { closestSim = sim; closestLine = i + 1; }
            }
          }
        }
        let hint = 'oldText not found in file.';
        if (closestLine > 0 && closestSim > 0.5) {
          const start = Math.max(0, closestLine - 4);
          const end = Math.min(contentLines.length, closestLine + oldLines.length + 3);
          const ctx = contentLines.slice(start, end).map((l, i) => `${start + i + 1}| ${l}`).join('\n');
          hint += ` Closest match at line ${closestLine}.\nRelevant section (lines ${start + 1}-${end}):\n${ctx}`;
        } else {
          const identifiers = oldText.match(/[a-zA-Z_$][a-zA-Z0-9_$]{3,}/g) || [];
          const uniqueIds = [...new Set(identifiers)].slice(0, 5);
          const foundLines = [];
          for (const id of uniqueIds) {
            for (let i = 0; i < contentLines.length; i++) {
              if (contentLines[i].includes(id) && !foundLines.some(f => f.line === i + 1)) {
                foundLines.push({ line: i + 1, text: contentLines[i].substring(0, 120), keyword: id });
              }
            }
          }
          if (foundLines.length > 0) {
            hint += '\nKeyword matches in file:';
            for (const f of foundLines.slice(0, 8)) {
              hint += `\n  Line ${f.line} (${f.keyword}): ${f.text}`;
            }
          } else {
            hint += '\nNone of the identifiers in your oldText exist in the file. The code may not have been written yet, or was already changed.';
          }
        }
        hint += '\nCopy oldText EXACTLY from the lines above — do not retype.';
        return { success: false, error: hint };
      }

      if (!this._fileBackups.has(fullPath)) {
        this._setFileBackup(fullPath, { original: originalContent, timestamp: Date.now(), tool: 'edit_file', isNew: false });
      }
      let totalOccurrences = 0;
      if (content.includes(oldText)) {
        totalOccurrences = (content.split(oldText).length - 1);
        content = content.replace(oldText, newText);
      }
      if (this.browserManager?.parentWindow) {
        this.browserManager.parentWindow.webContents.send('agent-file-modified', {
          filePath: fullPath,
          newContent: content,
          originalContent,
          preview: true,
          isNew: false,
          tool: 'edit_file',
        });
      }
      await fs.writeFile(fullPath, content, 'utf8');

      if (this.browserManager?.parentWindow) {
        this.browserManager.parentWindow.webContents.send('files-changed');
        this.browserManager.parentWindow.webContents.send('agent-file-modified', {
          filePath: fullPath,
          newContent: content,
          originalContent,
          isNew: false,
          tool: 'edit_file',
        });
      }

      const editMsg = totalOccurrences > 1
        ? `Edited ${path.basename(fullPath)}: replaced 1 of ${totalOccurrences} occurrences (use replace_in_files for bulk replace)`
        : `Edited ${path.basename(fullPath)}: 1 replacement made`;
      const result = { success: true, path: fullPath, message: editMsg, replacements: 1 };
      // Attach linter/diagnostic feedback after a brief delay for Monaco to process
      const diagFeedback = await this._getDiagnosticFeedback(fullPath, 600);
      if (diagFeedback) result.diagnostics = diagFeedback;
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async _deleteFile(filePath) {
    const fullPath = this._sanitizeFilePath(path.isAbsolute(filePath) ? filePath : path.join(this.projectPath || '', filePath));
    try {
      const stats = await fs.stat(fullPath);
      // Backup file content before deletion for checkpoint restore
      if (!stats.isDirectory()) {
        try {
          const content = await fs.readFile(fullPath, 'utf8');
          this._setFileBackup(fullPath, { original: content, timestamp: Date.now(), tool: 'delete_file', isNew: false });
        } catch (readErr) {
          console.warn(`[MCPToolServer] _deleteFile: could not read file for backup: ${readErr.message}`);
        }
      }
      if (stats.isDirectory()) {
        // Recursively delete directory
        await fs.rm(fullPath, { recursive: true, force: true });
      } else {
        await fs.unlink(fullPath);
      }
      if (this.browserManager?.parentWindow) {
        this.browserManager.parentWindow.webContents.send('files-changed', { deletedPaths: [fullPath] });
      }
      return { success: true, path: fullPath, message: stats.isDirectory() ? `Directory deleted: ${fullPath}` : `File deleted: ${fullPath}` };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async _renameFile(oldPath, newPath) {
    const fullOld = this._sanitizeFilePath(path.isAbsolute(oldPath) ? oldPath : path.join(this.projectPath || '', oldPath));
    const fullNew = this._sanitizeFilePath(path.isAbsolute(newPath) ? newPath : path.join(this.projectPath || '', newPath));
    try {
      // Backup file content before rename for checkpoint restore
      try {
        const content = await fs.readFile(fullOld, 'utf8');
        this._setFileBackup(fullOld, { original: content, timestamp: Date.now(), tool: 'rename_file', isNew: false });
      } catch (readErr) {
        console.warn(`[MCPToolServer] _renameFile: could not read file for backup: ${readErr.message}`);
      }
      await fs.mkdir(path.dirname(fullNew), { recursive: true });
      await fs.rename(fullOld, fullNew);
      if (this.browserManager?.parentWindow) {
        this.browserManager.parentWindow.webContents.send('files-changed');
      }
      return { success: true, oldPath: fullOld, newPath: fullNew, message: `Renamed: ${path.basename(fullOld)} → ${path.basename(fullNew)}` };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async _getFileInfo(filePath) {
    const fullPath = this._sanitizeFilePath(path.isAbsolute(filePath) ? filePath : path.join(this.projectPath || '', filePath));
    try {
      const stats = await fs.stat(fullPath);
      return {
        success: true,
        path: fullPath,
        name: path.basename(fullPath),
        extension: path.extname(fullPath),
        size: stats.size,
        sizeFormatted: stats.size < 1024 ? `${stats.size}B` : stats.size < 1048576 ? `${(stats.size / 1024).toFixed(1)}KB` : `${(stats.size / 1048576).toFixed(1)}MB`,
        modified: stats.mtime.toISOString(),
        created: stats.birthtime.toISOString(),
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async _createDirectory(dirPath) {
    if (!this.projectPath) {
      return { success: false, error: 'No project folder is open. Please open a folder first.' };
    }
    const fullPath = this._sanitizeFilePath(path.isAbsolute(dirPath) ? dirPath : path.join(this.projectPath, dirPath));
    try {
      const exists = await fs.access(fullPath).then(() => true).catch(() => false);
      if (exists) {
        return { success: true, path: fullPath, created: false, message: `Directory already exists: ${fullPath}` };
      }
      await fs.mkdir(fullPath, { recursive: true });
      if (this.browserManager?.parentWindow) {
        this.browserManager.parentWindow.webContents.send('files-changed');
      }
      return { success: true, path: fullPath, created: true, message: `Directory created: ${fullPath}` };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async _searchCodebase(query, maxResults = 10) {
    if (!this.ragEngine) return { success: false, error: 'RAG engine not available' };
    const results = this.ragEngine.search(query, maxResults);
    return {
      success: true,
      results: results.map(r => ({
        file: r.relativePath,
        startLine: r.startLine + 1,
        endLine: r.endLine,
        score: r.score.toFixed(3),
        preview: r.content.substring(0, 300),
      })),
    };
  }

  async _runCommand(command, cwd, timeout, shell) {
    const dangerousPatterns = [
      /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*\s+(\/|~|\$HOME|C:\\|%USERPROFILE%)/i,
      /\bformat\s+[A-Z]:/i,
      /\bmkfs\b/i,
      /\bshutdown\b/i,
      /\breboot\b/i,
      /\bpoweroff\b/i,
      /:\(\)\s*\{\s*:\|:\s*&\s*\}/,
      /\bdd\s+.*of=\/dev\//i,
      /\bcurl\b.*\|\s*(ba)?sh/i,
      /\bwget\b.*\|\s*(ba)?sh/i,
      /\bdel\s+(\/[sS]\s+)*[A-Z]:\\/i,
    ];
    const cmdStr = (command || '').trim();
    for (const pat of dangerousPatterns) {
      if (pat.test(cmdStr)) {
        console.log(`[MCPToolServer] Blocked dangerous command: "${cmdStr.substring(0, 80)}"`);
        return { success: false, error: 'Command blocked: matches dangerous pattern. This command could cause irreversible damage.' };
      }
    }

    let workDir = this.projectPath || process.cwd();
    if (cwd) {
      // Validate cwd parameter
      const cwdStr = String(cwd).trim();
      
      // Block obvious invalid values (wildcards, single chars, empty after trim)
      if (!cwdStr || cwdStr === '*' || cwdStr === '?' || /^[*?]+$/.test(cwdStr)) {
        console.log(`[MCPToolServer] Blocked invalid cwd "${cwd}"`);
        return { success: false, error: `Invalid cwd parameter: "${cwd}". Use a valid directory path or omit cwd to use project root.` };
      }
      
      if (path.isAbsolute(cwdStr)) {
        const resolved = path.resolve(cwdStr);
        if (this._isPathAllowed && this._isPathAllowed(resolved)) {
          workDir = resolved;
        } else {
          const cwdNorm = cwdStr.replace(/\\/g, '/').toLowerCase();
          const projNorm = (this.projectPath || '').replace(/\\/g, '/').toLowerCase();
          if (projNorm && cwdNorm.startsWith(projNorm)) {
            workDir = cwdStr;
          } else {
            console.log(`[MCPToolServer] Ignoring hallucinated cwd "${cwd}", using project path`);
          }
        }
      } else {
        // Relative path — resolve relative to project
        const resolved = path.resolve(this.projectPath || process.cwd(), cwdStr);
        const resolvedNorm = resolved.replace(/\\/g, '/').toLowerCase();
        const projNorm = (this.projectPath || '').replace(/\\/g, '/').toLowerCase();
        const allowed = this._isPathAllowed && this._isPathAllowed(resolved);
        if ((projNorm && resolvedNorm.startsWith(projNorm)) || allowed) {
          // Check if directory exists
          try {
            const stats = fsSync.statSync(resolved);
            if (stats.isDirectory()) {
              workDir = resolved;
            } else if (cwdStr !== '.') {
              console.log(`[MCPToolServer] cwd "${cwd}" is not a directory, using project path`);
            }
          } catch (e) {
            if (cwdStr !== '.') console.log(`[MCPToolServer] cwd "${cwd}" does not exist, using project path`);
          }
        } else {
          console.log(`[MCPToolServer] Ignoring cwd "${cwd}" — resolves outside project`);
        }
      }
    }
    const timeoutMs = Math.min(Math.max(timeout || COMMAND_DEFAULT_TIMEOUT_MS, COMMAND_MIN_TIMEOUT_MS), COMMAND_MAX_TIMEOUT_MS);
    const softWarningMs = Math.min(COMMAND_SOFT_WARNING_MS, timeoutMs);
    const startTime = Date.now();
    let slowWarningSent = false;

    return new Promise((resolve) => {
      const isWindows = process.platform === 'win32';
      // Shell selection:
      //   Windows cmd (default): cmd.exe /d /s /c — git, npm, node, 2>nul, >nul,
      //     &&, ||, pipes all work natively.
      //   Windows powershell: powershell.exe -NoProfile -NonInteractive
      //     -EncodedCommand <Base64> — avoids all quoting issues by encoding the
      //     entire script as UTF-16LE Base64. PowerShell cmdlets work in this mode.
      //   Unix: /bin/sh -c — standard POSIX shell.
      // Default to PowerShell on Windows unless explicitly overridden to cmd.
      // This matches how users (and models) typically express Windows commands (cmdlets, pipelines).
      const shellNorm = shell ? String(shell).trim().toLowerCase() : '';
      const effectiveShell = shellNorm || (this._commandShell || 'powershell');
      const usePowerShell = isWindows && effectiveShell !== 'cmd';
      let shellBin, shellArgs;
      if (usePowerShell) {
        // Encode command as UTF-16LE Base64 for -EncodedCommand (bulletproof quoting)
        const encoded = Buffer.from(cmdStr, 'utf16le').toString('base64');
        shellBin = 'powershell.exe';
        shellArgs = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
      } else {
        shellBin = isWindows ? 'cmd.exe' : '/bin/sh';
        shellArgs = isWindows ? ['/d', '/s', '/c', command] : ['-c', command];
      }
      let child;
      try {
        child = spawn(shellBin, shellArgs, { cwd: workDir, windowsHide: true });
      } catch (e) {
        resolve({ success: false, output: e.message, stdout: '', stderr: e.message, exitCode: -1, error: e.message });
        return;
      }

      const childId = this._nextChildId++;
      this._activeChildren.set(childId, child);

      let stdoutBuf = '';
      let stderrBuf = '';
      const MAX_BUF = 5 * 1024 * 1024;
      let truncated = false;
      child.stdout?.on('data', (chunk) => {
        if (stdoutBuf.length < MAX_BUF) stdoutBuf += chunk.toString();
        else truncated = true;
      });
      child.stderr?.on('data', (chunk) => {
        if (stderrBuf.length < MAX_BUF) stderrBuf += chunk.toString();
        else truncated = true;
      });

      let settled = false;
      let forceSettleHandle = null;

      const killChildTree = () => {
        try {
          if (isWindows && child.pid) {
            try { require('child_process').execSync(`taskkill /pid ${child.pid} /T /F`, { windowsHide: true, stdio: 'ignore' }); } catch (_) {}
          } else {
            try { child.kill('SIGTERM'); } catch (_) {}
            setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 500).unref();
          }
        } catch (_) {}
      };

      const settle = (exitCode, signal, { timedOut = false } = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(softWarningHandle);
        clearTimeout(hardKillHandle);
        if (forceSettleHandle) clearTimeout(forceSettleHandle);
        this._activeChildren.delete(childId);
        const elapsedMs = Date.now() - startTime;
        const killed = timedOut || signal === 'SIGTERM' || signal === 'SIGKILL' || exitCode === null;
        const success = !killed && exitCode === 0;
        const trimmedOut = stdoutBuf.trim();
        const trimmedErr = stderrBuf.trim();
        const output = trimmedOut || trimmedErr || (killed ? `Command terminated (signal=${signal || 'cancelled'})` : `Command exited with code ${exitCode}`);
        const result = {
          success,
          output: truncated ? output + '\n[... output truncated]' : output,
          message: success ? (trimmedOut || 'Command completed') : (trimmedErr || `exit ${exitCode}${signal ? ` (${signal})` : ''}`),
          stdout: stdoutBuf,
          stderr: stderrBuf,
          exitCode: exitCode == null ? -1 : exitCode,
          signal: signal || undefined,
          truncated,
          elapsedMs,
        };
        if (timedOut) {
          result.timedOut = true;
          result.error = `Command exceeded ${timeoutMs}ms and was terminated.`;
          result.hint = RUN_COMMAND_TIMEOUT_HINT;
          result.partialStdout = stdoutBuf.slice(0, 8000);
          result.partialStderr = stderrBuf.slice(0, 8000);
        } else if (slowWarningSent || elapsedMs >= COMMAND_SOFT_WARNING_MS) {
          result.slowCommand = true;
          result.hint = `Command took ${Math.round(elapsedMs / 1000)}s. If this was unintended, avoid launching GUI/headless Chrome via run_command — use browser_navigate or fetch_webpage.`;
        }
        resolve(result);
      };

      const softWarningHandle = setTimeout(() => {
        slowWarningSent = true;
        console.log(`[MCPToolServer] run_command slow warning (${Math.round((Date.now() - startTime) / 1000)}s): ${cmdStr.substring(0, 80)}`);
        if (this._send) {
          this._send('command-slow-warning', {
            tool: 'run_command',
            elapsedMs: Date.now() - startTime,
            command: cmdStr.slice(0, 120),
          });
        }
      }, softWarningMs);

      const hardKillHandle = setTimeout(() => {
        console.warn(`[MCPToolServer] run_command hard kill after ${timeoutMs}ms: ${cmdStr.substring(0, 80)}`);
        killChildTree();
        forceSettleHandle = setTimeout(() => {
          if (!settled) settle(-1, 'SIGTERM', { timedOut: true });
        }, 2000);
        forceSettleHandle.unref?.();
      }, timeoutMs);

      child.on('error', (err) => {
        console.log(`[MCPToolServer] run_command spawn error: ${err.message}`);
        settle(-1, null);
      });
      child.on('close', (code, signal) => settle(code, signal));
    });
  }

  // ─── Execution Policy ───────────────────────────────────────────────────

  /**
   * Check whether a command tool call is allowed under the current execution policy.
   * Returns { allowed: boolean, reason: string }.
   *
   * Levels:
   *   'disabled'  — All commands require approval
   *   'allowlist' — Only allowlisted commands auto-execute; everything else needs approval
   *   'auto'      — Agent judges safety: denylisted commands always blocked, destructive
   *                  patterns always blocked, everything else auto-executes
   *   'turbo'     — All commands auto-execute except denylisted ones
   */
  _checkExecutionPolicy(toolName, params) {
    const command = (params.command || '').trim();
    const policy = this._executionPolicy;

    // Always check deny list first (all levels)
    for (const denied of this._commandDenyList) {
      if (command.includes(denied) || command.startsWith(denied)) {
        return { allowed: false, reason: `Command matches deny list entry: "${denied}"` };
      }
    }

    // Always check dangerous patterns (all levels)
    const dangerousPatterns = [
      /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*\s+(\/|~|\$HOME|C:\\|%USERPROFILE%)/i,
      /\bformat\s+[A-Z]:/i,
      /\bmkfs\b/i,
      /\bshutdown\b/i,
      /\breboot\b/i,
      /\bpoweroff\b/i,
      /\bdd\s+.*of=\/dev\//i,
      /\bcurl\b.*\|\s*(ba)?sh/i,
      /\bwget\b.*\|\s*(ba)?sh/i,
    ];
    for (const pat of dangerousPatterns) {
      if (pat.test(command)) {
        return { allowed: false, reason: 'Command matches dangerous pattern' };
      }
    }

    switch (policy) {
      case 'disabled':
        // All commands require approval
        return { allowed: false, reason: 'Execution policy is "Disabled" — all commands require approval' };

      case 'allowlist':
        // Check if command starts with an allowlisted prefix
        for (const allowed of this._commandAllowList) {
          if (command.startsWith(allowed) || command.includes(allowed)) {
            return { allowed: true, reason: '' };
          }
        }
        return { allowed: false, reason: `Execution policy is "Allowlist" — command not in allow list` };

      case 'auto':
        // Auto mode: allow by default, but destructive tools still need approval
        // (the _destructiveTools gate above handles that separately)
        return { allowed: true, reason: '' };

      case 'turbo':
        // Turbo mode: allow everything except deny list (already checked above)
        return { allowed: true, reason: '' };

      default:
        return { allowed: true, reason: '' };
    }
  }

  /** Update execution policy at runtime (called when settings change) */
  setExecutionPolicy(policy) {
    this._executionPolicy = policy || 'auto';
    console.log(`[MCPToolServer] Execution policy set to "${this._executionPolicy}"`);
  }

  /** Update allow/deny lists at runtime */
  setCommandLists(allowList, denyList) {
    this._commandAllowList = new Set(allowList || []);
    this._commandDenyList = new Set(denyList || []);
  }

  setCommandShell(shell) {
    const s = (shell || '').toString().trim().toLowerCase();
    this._commandShell = (s === 'cmd' || s === 'powershell') ? s : 'powershell';
    console.log(`[MCPToolServer] Command shell set to "${this._commandShell}"`);
  }

  // ─── Persistent Terminal (node-pty) ──────────────────────────────────────

  _ensureAgentPty() {
    if (this._agentPty && !this._agentPty._exited) return true;
    // Try to load node-pty
    let ptyModule;
    try {
      ptyModule = require('node-pty');
    } catch (_) {
      return false;
    }
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
    const cwd = this.projectPath || process.cwd();
    try {
      const ptyProcess = ptyModule.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd,
        env: { ...process.env },
      });
      ptyProcess._exited = false;
      ptyProcess.onExit(({ exitCode }) => {
        ptyProcess._exited = true;
        this._agentPty = null;
        this._agentPtyId = null;
        this._agentPtyShell = null;
        // Resolve any pending command
        if (this._agentPtyResolve) {
          this._agentPtyResolve({ success: false, output: `Terminal session exited (code=${exitCode})`, exitCode });
          this._agentPtyResolve = null;
        }
      });
      this._agentPty = ptyProcess;
      this._agentPtyId = `agent-pty-${Date.now()}`;
      this._agentPtyShell = shell;
      this._agentPtyBuffer = '';
      // Drain ongoing output (prompt, etc.) — we'll capture per-command
      ptyProcess.onData((data) => {
        this._agentPtyBuffer += data;
        // If we have a pending resolve, check for prompt marker
        if (this._agentPtyResolve) {
          this._agentPtyBuffer = this._agentPtyBuffer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''); // strip ANSI
        }
      });
      console.log(`[MCPToolServer] Agent PTY started: ${this._agentPtyId} shell=${shell}`);
      return true;
    } catch (e) {
      console.log(`[MCPToolServer] Failed to start agent PTY: ${e.message}`);
      return false;
    }
  }

  _killAgentPty() {
    if (this._agentPty) {
      try { this._agentPty.kill(); } catch (_) {}
      this._agentPty = null;
      this._agentPtyId = null;
      this._agentPtyShell = null;
      this._agentPtyBuffer = '';
      if (this._agentPtyResolve) {
        this._agentPtyResolve({ success: false, output: 'Terminal session killed', exitCode: -1 });
        this._agentPtyResolve = null;
      }
    }
  }

  async _terminalRun(command, timeout, reset) {
    const cmdStr = (command || '').trim();
    if (!cmdStr) {
      return { success: false, error: 'No command provided' };
    }

    // Reset requested — kill existing session
    if (reset) {
      this._killAgentPty();
    }

    // Ensure PTY is alive
    if (!this._ensureAgentPty()) {
      // Fallback to run_command (non-persistent)
      console.log('[MCPToolServer] terminal_run: node-pty unavailable, falling back to run_command');
      return await this._runCommand(cmdStr, null, timeout);
    }

    const timeoutMs = Math.min(Math.max(timeout || COMMAND_DEFAULT_TIMEOUT_MS, COMMAND_MIN_TIMEOUT_MS), COMMAND_MAX_TIMEOUT_MS);
    const softWarningMs = Math.min(COMMAND_SOFT_WARNING_MS, timeoutMs);
    const startTime = Date.now();
    let slowWarningSent = false;

    // Write an end-of-output marker so we can detect when the command finishes.
    // The marker is a unique string that the shell will echo after the command.
    const marker = `__GUIDE_PTY_DONE_${Date.now()}__`;
    let markerCmd;
    if (process.platform === 'win32') {
      // PowerShell: use Write-Host (goes to stdout, not stderr)
      markerCmd = `${cmdStr}\r\nWrite-Host ${marker}\r\n`;
    } else {
      markerCmd = `${cmdStr} && echo ${marker} || echo ${marker}\n`;
    }

    return new Promise((resolve) => {
      // Clear buffer and set up capture
      this._agentPtyBuffer = '';
      this._agentPtyResolve = null;

      let capturedOutput = '';
      let markerFound = false;
      const MAX_CAPTURE = 2 * 1024 * 1024;

      const dataHandler = (data) => {
        if (capturedOutput.length < MAX_CAPTURE) {
          capturedOutput += data;
        }
        // Check for marker in the raw stream
        if (!markerFound && capturedOutput.includes(marker)) {
          markerFound = true;
          finish();
        }
      };

      this._agentPty.onData(dataHandler);

      const softWarningHandle = setTimeout(() => {
        slowWarningSent = true;
        if (this._send) {
          this._send('command-slow-warning', {
            tool: 'terminal_run',
            elapsedMs: Date.now() - startTime,
            command: cmdStr.slice(0, 120),
          });
        }
      }, softWarningMs);

      const timeoutHandle = setTimeout(() => {
        if (!markerFound) finish(true);
      }, timeoutMs);

      const finish = (timedOut = false) => {
        if (finish._done) return;
        finish._done = true;
        clearTimeout(softWarningHandle);
        clearTimeout(timeoutHandle);
        try { this._agentPty.removeListener('data', dataHandler); } catch (_) {}
        const elapsedMs = Date.now() - startTime;
        // Strip ANSI escape sequences from captured output
        let cleanOutput = capturedOutput
          .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
          .replace(/\x1b\].*?\x07/g, '')
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n');

        // Remove the marker line from output
        const markerLine = marker;
        cleanOutput = cleanOutput.split('\n')
          .filter(line => !line.includes(markerLine))
          .join('\n')
          .trim();

        // Remove the echoed command (first line usually)
        // The PTY echoes the input command — strip it if it matches
        const cmdPrefix = cmdStr.split('\n')[0].trim();
        const lines = cleanOutput.split('\n');
        if (lines.length > 1 && lines[0].trim() === cmdPrefix) {
          lines.shift();
          cleanOutput = lines.join('\n').trim();
        }

        const truncated = capturedOutput.length >= MAX_CAPTURE;
        const result = {
          success: markerFound && !timedOut,
          output: truncated ? cleanOutput + '\n[... output truncated]' : cleanOutput || '(no output)',
          shell: this._agentPtyShell,
          persistent: true,
          elapsedMs,
        };
        if (timedOut) {
          result.timedOut = true;
          result.error = `Command exceeded ${timeoutMs}ms and was terminated.`;
          result.hint = RUN_COMMAND_TIMEOUT_HINT;
        } else if (slowWarningSent || elapsedMs >= COMMAND_SOFT_WARNING_MS) {
          result.slowCommand = true;
          result.hint = `Command took ${Math.round(elapsedMs / 1000)}s. If unintended, use browser_navigate instead of shell-debugging Chrome.`;
        }
        resolve(result);
      };

      // Send command to PTY
      this._agentPty.write(markerCmd);
    });
  }

  async _listDirectory(dirPath, recursive = false) {
    const resolvedDir = dirPath || this.projectPath || '.';
    const fullPath = path.isAbsolute(resolvedDir) ? resolvedDir : path.join(this.projectPath || '', resolvedDir);
    try {
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const items = entries
        .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
        .map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          path: path.join(fullPath, e.name),
        }));

      if (recursive) {
        for (const item of [...items]) {
          if (item.type === 'directory') {
            const subResult = await this._listDirectory(item.path, true);
            if (subResult.success) {
              items.push(...subResult.items.map(sub => ({
                ...sub,
                name: path.join(item.name, sub.name),
              })));
            }
          }
        }
      }

      return { success: true, items };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async _findFiles(pattern) {
    if (this.ragEngine) {
      const results = this.ragEngine.searchFiles(pattern, 20);
      return { success: true, files: results };
    }
    // Native file walk — cross-platform. The previous shell-based implementation
    // passed cmd.exe syntax ("dir /s /b ... 2>nul") through _runCommand, which
    // wraps commands in powershell.exe on Windows. PowerShell interprets "2>nul"
    // as redirecting to a device named "nul" and fails with a FileStream error.
    if (!pattern || typeof pattern !== 'string') {
      return { success: false, error: 'pattern parameter is required' };
    }
    if (!this.projectPath) {
      return { success: false, error: 'No project path set' };
    }
    const root = this.projectPath;
    const needle = pattern.toLowerCase();
    const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'out', 'coverage']);
    const matches = [];
    const MAX_MATCHES = 100;
    const MAX_ENTRIES_SCANNED = 50000;
    let scanned = 0;
    const walk = async (dir) => {
      if (matches.length >= MAX_MATCHES || scanned >= MAX_ENTRIES_SCANNED) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        scanned++;
        if (matches.length >= MAX_MATCHES || scanned >= MAX_ENTRIES_SCANNED) return;
        const name = entry.name;
        if (entry.isDirectory()) {
          if (skipDirs.has(name) || name.startsWith('.')) continue;
          await walk(path.join(dir, name));
        } else if (entry.isFile()) {
          if (name.toLowerCase().includes(needle)) {
            matches.push(path.relative(root, path.join(dir, name)));
          }
        }
      }
    };
    try {
      await walk(root);
      return { success: true, files: matches, truncated: matches.length >= MAX_MATCHES };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async _analyzeError(errorMessage, stackTrace) {
    if (!this.ragEngine) return { success: false, error: 'RAG engine not available' };
    return {
      success: true,
      analysis: this.ragEngine.findErrorContext(errorMessage, stackTrace || ''),
    };
  }

  // ─── Browser Automation Setters ──────────────────────────────────────────

  setBrowserManager(browserManager) { this.browserManager = browserManager; }
  setBrowserRouter(browserRouter) { this.browserRouter = browserRouter; }
  setPlaywrightBrowser(playwrightBrowser) { this.playwrightBrowser = playwrightBrowser; }
  setGitManager(gitManager) { this.gitManager = gitManager; }
  setImageGen(imageGen) { this.imageGen = imageGen; }

  _getBrowser() {
    if (this.browserRouter) return this.browserRouter.getActiveBackend();
    return this.playwrightBrowser || this.browserManager;
  }

  _getBrowserEngineTag() {
    if (this.browserRouter) return this.browserRouter.getEngine();
    return 'chromium';
  }

  async _ensureBrowserBackend(reason = 'tool_call') {
    if (!this.browserRouter) return { success: true };
    return this.browserRouter.ensureBackend(reason);
  }

  // Browser tools: _browserNavigate through _browserClose → tools/mcpBrowserTools.js
  // Git tools: _gitStatus through _gitReset → tools/mcpGitTools.js

  // ─── Image Generation ────────────────────────────────────────────────────

  async _generateImage(prompt, width, height, savePath) {
    if (!prompt) return { success: false, error: 'No prompt provided' };
    if (!this.imageGen) return { success: false, error: 'Image generation service not available' };
    try {
      if (this._send) this._send('media-generating', { prompt, mediaType: 'image', fromTool: true });
      const result = await this.imageGen.generate(prompt.substring(0, 2000), {
        width: width || 1024,
        height: height || 1024,
      });
      if (!result.success) {
        if (this._send) this._send('media-error', { prompt, error: result.error, fromTool: true });
        return { success: false, error: result.error || 'Image generation failed' };
      }
      if (this._send && result.imageBase64) {
        this._send('media-complete', {
          prompt,
          mimeType: result.mimeType || 'image/png',
          mediaType: result.mediaType || 'image',
          dataUrl: `data:${result.mimeType || 'image/png'};base64,${result.imageBase64}`,
          fromTool: true,
        });
      }
      if (savePath) {
        const fullPath = path.isAbsolute(savePath) ? savePath : path.join(this.projectPath || '', savePath);
        const fsSync = require('fs');
        const dir = path.dirname(fullPath);
        if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
        fsSync.writeFileSync(fullPath, Buffer.from(result.imageBase64, 'base64'));
        return {
          success: true,
          message: `Image generated and saved to ${fullPath}`,
          filePath: fullPath,
          provider: result.provider,
          model: result.model,
          mimeType: result.mimeType,
          sizeKB: Math.round(result.imageBase64.length * 0.75 / 1024),
        };
      }
      return {
        success: true,
        message: `Image generated via ${result.provider} (${result.model})`,
        imageBase64: result.imageBase64,
        mimeType: result.mimeType,
        provider: result.provider,
        model: result.model,
        sizeKB: Math.round(result.imageBase64.length * 0.75 / 1024),
      };
    } catch (err) {
      return { success: false, error: `Image generation failed: ${err.message}` };
    }
  }

  // ─── Search Tools ────────────────────────────────────────────────────────

  async _grepSearch(pattern, filePattern, isRegex = false, maxResults = 50) {
    const cwd = this.projectPath;
    if (!cwd) return { success: false, error: 'No project opened' };
    const cap = Math.min(Math.max(maxResults || 50, 1), 200);

    if (this.ragEngine && this.ragEngine._fileCache) {
      const results = [];
      const regex = isRegex ? new RegExp(pattern, 'gi') : null;
      for (const [relPath, fileData] of Object.entries(this.ragEngine._fileCache)) {
        if (filePattern) {
          const globRegex = new RegExp('^' + filePattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
          if (!globRegex.test(relPath)) continue;
        }
        const content = typeof fileData === 'string' ? fileData : fileData?.content;
        if (!content) continue;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const matches = regex ? regex.test(line) : line.includes(pattern);
          if (regex) regex.lastIndex = 0;
          if (matches) {
            results.push({ file: relPath, line: i + 1, text: line.trim().substring(0, 200) });
            if (results.length >= cap) break;
          }
        }
        if (results.length >= cap) break;
      }
      return { success: true, results, total: results.length, pattern };
    }

    const isWin = process.platform === 'win32';
    const safePattern = this._sanitizeShellArg(pattern);
    const safeFilePattern = filePattern ? this._sanitizeShellArg(filePattern) : '';
    let cmd;
    if (isWin) {
      const fileFilter = safeFilePattern ? `/include:"${safeFilePattern}"` : '';
      cmd = isRegex
        ? `findstr /S /N /R ${fileFilter} "${safePattern}" *`
        : `findstr /S /N /I ${fileFilter} "${safePattern}" *`;
    } else {
      const fileFilter = safeFilePattern ? `--include="${safeFilePattern}"` : '';
      cmd = isRegex
        ? `grep -rn ${fileFilter} -E "${safePattern}" . --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null | head -${cap}`
        : `grep -rn ${fileFilter} -i "${safePattern}" . --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null | head -${cap}`;
    }
    const result = await this._runCommand(cmd, cwd, 30000);
    const lines = (result.stdout || '').trim().split('\n').filter(Boolean).slice(0, cap);
    const matches = lines.map(l => {
      const colonIdx = l.indexOf(':');
      const secondColon = l.indexOf(':', colonIdx + 1);
      if (secondColon > colonIdx) {
        return { file: l.substring(0, colonIdx), line: parseInt(l.substring(colonIdx + 1, secondColon)) || 0, text: l.substring(secondColon + 1).trim().substring(0, 200) };
      }
      return { file: '', line: 0, text: l.substring(0, 200) };
    });
    return { success: true, results: matches, total: matches.length, pattern };
  }

  async _searchInFile(filePath, pattern, isRegex = false) {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.projectPath || '', filePath);
    try {
      const content = await fs.readFile(fullPath, 'utf8');
      const lines = content.split('\n');
      const regex = isRegex ? new RegExp(pattern, 'gi') : null;
      const matches = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const found = regex ? regex.test(line) : line.includes(pattern);
        if (regex) regex.lastIndex = 0;
        if (found) {
          matches.push({ line: i + 1, text: line.trim().substring(0, 300) });
        }
      }
      return { success: true, file: fullPath, matches, total: matches.length, pattern };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ─── Copy / Append / Diff ────────────────────────────────────────────────

  async _copyFile(source, destination) {
    const fullSrc = path.isAbsolute(source) ? source : path.join(this.projectPath || '', source);
    const fullDst = path.isAbsolute(destination) ? destination : path.join(this.projectPath || '', destination);
    try {
      await fs.mkdir(path.dirname(fullDst), { recursive: true });
      const stats = await fs.stat(fullSrc);
      if (stats.isDirectory()) {
        await this._copyDirRecursive(fullSrc, fullDst);
        return { success: true, source: fullSrc, destination: fullDst, overwritten: false, message: `Copied directory to ${fullDst}` };
      }
      const dstExists = await fs.access(fullDst).then(() => true).catch(() => false);
      // Backup destination file content before overwrite for checkpoint restore
      if (dstExists) {
        try {
          const existingContent = await fs.readFile(fullDst, 'utf8');
          this._setFileBackup(fullDst, { original: existingContent, timestamp: Date.now(), tool: 'copy_file', isNew: false });
        } catch (readErr) {
          console.warn(`[MCPToolServer] _copyFile: could not read destination for backup: ${readErr.message}`);
        }
      }
      await fs.copyFile(fullSrc, fullDst);
      return { success: true, source: fullSrc, destination: fullDst, overwritten: dstExists, message: dstExists ? `Overwritten: ${fullDst}` : `Copied to ${fullDst}` };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get diagnostic/linter feedback for a file after a brief delay.
   * Waits for Monaco to process the edit, then looks up stored diagnostics.
   * Returns null if no errors/warnings, or { errors, warnings, details[] } if issues found.
   */
  async _getDiagnosticFeedback(fullPath, delayMs = 500) {
    // Wait for Monaco to process the file change and update markers
    await new Promise(r => setTimeout(r, delayMs));
    const diagStore = this.ctx?.editorDiagnostics;
    if (!diagStore) return null;
    // Normalize path for lookup (Monaco uses URI format on Windows: /C:/...)
    const norm = fullPath.replace(/\\/g, '/').toLowerCase();
    // Try direct match, then strip leading slash (Monaco /C:/ vs C:/)
    let diag = diagStore[norm] || diagStore[norm.replace(/^\//, '')];
    if (!diag) {
      // Try matching just the filename portion
      const base = path.basename(fullPath).toLowerCase();
      for (const [key, val] of Object.entries(diagStore)) {
        if (key.endsWith('/' + base) || key.endsWith(base)) { diag = val; break; }
      }
    }
    if (!diag || (diag.errors === 0 && diag.warnings === 0)) return null;
    // Only include if diagnostics are recent (within last 5 seconds)
    if (Date.now() - diag.updatedAt > 5000) return null;
    const feedback = { errors: diag.errors, warnings: diag.warnings };
    if (diag.details?.length > 0) {
      feedback.details = diag.details.slice(0, 10).map(d =>
        `Line ${d.line}: [${d.severity}] ${d.message}`
      );
    }
    return feedback;
  }

  _normalizePathNameForSimilarity(name) {
    return String(name).toLowerCase().replace(/[\s_\-]+/g, '_');
  }

  async _suggestSimilarSiblingNames(failedFullPath, { maxSuggestions = 3, minSimilarity = 0.75 } = {}) {
    const requestedName = path.basename(failedFullPath);
    if (requestedName.length < 4) return [];

    let parentDir = path.dirname(failedFullPath);
    let entries = null;

    for (let level = 0; level < 4; level++) {
      try {
        const dirents = await fs.readdir(parentDir, { withFileTypes: true });
        entries = dirents
          .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
          .map((e) => {
            const absPath = path.join(parentDir, e.name);
            const relPath = this.projectPath
              ? path.relative(this.projectPath, absPath).replace(/\\/g, '/')
              : absPath;
            return {
              name: e.name,
              type: e.isDirectory() ? 'directory' : 'file',
              path: relPath,
            };
          });
        break;
      } catch (err) {
        if (err.code !== 'ENOENT' || level >= 3) return [];
        const parent = path.dirname(parentDir);
        if (!parent || parent === parentDir) return [];
        parentDir = parent;
      }
    }

    if (!entries?.length) return [];

    const normRequested = this._normalizePathNameForSimilarity(requestedName);
    const matches = [];
    for (const entry of entries) {
      if (entry.name === requestedName) continue;
      const norm = this._normalizePathNameForSimilarity(entry.name);
      const maxLen = Math.max(normRequested.length, norm.length);
      if (maxLen === 0) continue;
      const dist = this._levenshtein(normRequested, norm);
      const similarity = 1 - dist / maxLen;
      if (similarity >= minSimilarity) {
        matches.push({
          ...entry,
          similarity: Math.round(similarity * 100) / 100,
        });
      }
    }

    matches.sort((a, b) => b.similarity - a.similarity);
    return matches.slice(0, maxSuggestions);
  }

  async _attachSimilarNamesOnEnoent(toolName, params, result) {
    if (!result || result.success !== false) return result;
    const errText = String(result.error || '');
    if (!errText.includes('ENOENT')) return result;

    const pathKey = ENOENT_SUGGEST_PATH_TOOLS[toolName];
    if (!pathKey || !params[pathKey]) return result;

    const relPath = params[pathKey];
    const fullPath = path.isAbsolute(relPath)
      ? relPath
      : path.join(this.projectPath || '', relPath);

    const similarNames = await this._suggestSimilarSiblingNames(fullPath);
    if (!similarNames.length) return result;

    return { ...result, similarNames };
  }

  /**
   * Compute Levenshtein distance between two strings.
   * Used for fuzzy matching in edit_file when exact match fails.
   */
  _levenshtein(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        const cost = b[i - 1] === a[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,      // deletion
          matrix[i][j - 1] + 1,      // insertion
          matrix[i - 1][j - 1] + cost // substitution
        );
      }
    }
    return matrix[b.length][a.length];
  }

  /**
   * Fuzzy-match oldText against content using sliding window + Levenshtein ratio.
   * Returns { startLine, endLine, similarity } or null if no good match found.
   * Threshold: 0.85 similarity ratio (allows ~15% character differences).
   */
  _fuzzyMatchText(content, oldText, threshold = 0.85) {
    const contentLines = content.split('\n');
    const oldLines = oldText.split('\n');
    if (oldLines.length === 0 || contentLines.length === 0) return null;

    // Strategy: slide a window of oldLines.length over contentLines,
    // compute line-level similarity, then character-level Levenshtein on the best window.
    const windowSize = oldLines.length;
    let bestStart = -1, bestScore = 0;

    for (let i = 0; i <= contentLines.length - windowSize; i++) {
      const window = contentLines.slice(i, i + windowSize);
      // Quick line-level check: how many lines have high similarity?
      let lineMatches = 0;
      for (let j = 0; j < windowSize; j++) {
        const wTrim = window[j].trim();
        const oTrim = oldLines[j].trim();
        if (wTrim === oTrim) {
          lineMatches++;
        } else if (wTrim.length > 5 && oTrim.length > 5) {
          const maxLen = Math.max(wTrim.length, oTrim.length);
          const dist = this._levenshtein(wTrim, oTrim);
          if (1 - dist / maxLen > 0.7) lineMatches++;
        }
      }
      const lineScore = lineMatches / windowSize;
      if (lineScore > bestScore) {
        bestScore = lineScore;
        bestStart = i;
      }
    }

    if (bestStart < 0 || bestScore < 0.5) return null;

    // Character-level Levenshtein on the best window region
    const candidateText = contentLines.slice(bestStart, bestStart + windowSize).join('\n');
    const normCandidate = candidateText.replace(/\s+/g, ' ').trim();
    const normOld = oldText.replace(/\s+/g, ' ').trim();
    const maxLen = Math.max(normCandidate.length, normOld.length);
    if (maxLen === 0) return null;
    const dist = this._levenshtein(normCandidate, normOld);
    const similarity = 1 - dist / maxLen;

    if (similarity >= threshold) {
      return {
        startLine: bestStart,
        endLine: bestStart + windowSize - 1,
        similarity: Math.round(similarity * 100) / 100,
        matchedText: candidateText,
      };
    }
    return null;
  }

  async _copyDirRecursive(src, dst) {
    await fs.mkdir(dst, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const dstPath = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        await this._copyDirRecursive(srcPath, dstPath);
      } else {
        await fs.copyFile(srcPath, dstPath);
      }
    }
  }

  /**
   * Extract genuinely new content from a write_file call by comparing against existing file.
   * Handles three cases:
   * 1. Leading overlap — model regenerates from start + adds new lines at end
   * 2. Trailing overlap — new content's beginning matches the end of existing file (continuation pattern)
   * 3. No overlap but new content is longer — model rewrote the file with additions
   * Returns { newContent, overlapLines } or null if nothing new to append.
   */
  _extractNewContentForAutoConvert(existingContent, newContent) {
    const el = existingContent.split('\n');
    const nl = newContent.split('\n');

    // Case 1: Leading overlap — lines match from the start (model regenerated full file)
    let leadingOverlap = 0;
    for (let i = 0; i < Math.min(el.length, nl.length); i++) {
      if (el[i].trimEnd() === nl[i].trimEnd()) leadingOverlap++;
      else break;
    }
    if (leadingOverlap > 3 && nl.length > leadingOverlap) {
      const suffix = nl.slice(leadingOverlap).join('\n');
      if (suffix.trim().length > 20) {
        return { newContent: suffix, overlapLines: leadingOverlap, method: 'leading' };
      }
    }

    // Case 2: Trailing overlap — end of existing file matches start of new content
    // The model may be continuing where it left off but wrapping it in write_file instead of append_to_file
    const tailCheck = Math.min(el.length, 30); // Check last 30 lines of existing
    for (let tailSize = tailCheck; tailSize >= 3; tailSize--) {
      const existingTail = el.slice(el.length - tailSize);
      // Check if new content starts with this tail
      let match = true;
      for (let j = 0; j < tailSize && j < nl.length; j++) {
        if (existingTail[j].trimEnd() !== nl[j].trimEnd()) { match = false; break; }
      }
      if (match && tailSize <= nl.length) {
        const suffix = nl.slice(tailSize).join('\n');
        if (suffix.trim().length > 20) {
          return { newContent: suffix, overlapLines: tailSize, method: 'trailing' };
        }
      }
    }

    // Case 3: No line-level overlap but content is substantially longer — likely a full rewrite
    // with new sections appended. Use character-level comparison of the last chunk of existing content.
    if (nl.length > el.length && leadingOverlap > el.length * 0.3) {
      // Partial leading overlap (>30%) — the model mostly regenerated but diverged at some point
      // Find the divergence point and take everything after it
      const suffix = nl.slice(leadingOverlap).join('\n');
      if (suffix.trim().length > 20) {
        return { newContent: suffix, overlapLines: leadingOverlap, method: 'partial-leading' };
      }
    }

    return null;
  }

  async _appendToFile(filePath, content) {
    // RC2-Fix: Auto-create temp project directory when no folder is open.
    if (!this.projectPath) {
      const os = require('os');
      const tempDir = path.join(os.tmpdir(), `guide-project-${Date.now()}`);
      await fs.mkdir(tempDir, { recursive: true });
      this.projectPath = tempDir;
      console.log(`[MCPToolServer] RC2-Fix: Auto-created temp project dir: ${tempDir}`);
    }
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.projectPath, filePath);

    // Reject empty content — the model called append but didn't provide code.
    // Include the file's last lines so the model knows where to continue from.
    if (!content || !content.trim()) {
      let tailHint = '';
      let existingFullContent = '';
      try {
        existingFullContent = await fs.readFile(fullPath, 'utf8');
        const lines = existingFullContent.split('\n');
        const last15 = lines.slice(-15).join('\n');
        tailHint = ` The file currently has ${lines.length} lines. Here are the last 15 lines — continue from here:\n${last15}`;
      } catch (tailErr) { console.warn(`[MCPToolServer] append_to_file: failed to read tail hint: ${tailErr.message}`); }
      return { success: false, error: `Content is empty. You must provide actual code content to append.${tailHint}`, fullContent: existingFullContent || undefined, path: fullPath };
    }

    try {
      let isNew = true;
      try {
        const existingContent = await fs.readFile(fullPath, 'utf8');
        this._setFileBackup(fullPath, { original: existingContent, timestamp: Date.now(), tool: 'append_to_file', isNew: false });
        isNew = false;
      } catch {
        this._setFileBackup(fullPath, { original: null, timestamp: Date.now(), tool: 'append_to_file', isNew: true });
      }

      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      // Unconditional unescape: handle ALL JSON double-escape sequences.
      // Models often double-escape when generating JSON content strings.
      // Order matters: protect real backslashes first, then unescape sequences.
      if (typeof content === 'string' && (content.includes('\\n') || content.includes('\\"'))) {
        content = content
          .replace(/\\\\/g, '\x00ESC_BS')
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\r/g, '\r')
          .replace(/\\"/g, '"')
          .replace(/\\\//g, '/')
          .replace(/\x00ESC_BS/g, '\\');
      }
      // Strip wrapping markdown code fences — model may wrap file content in ```lang...```
      // markers. A .ts/.js file ending with ``` fails structural completeness checks and
      // causes infinite retry loops. Strip them for all non-markdown/text file types.
      if (typeof content === 'string') {
        const _fenceExt = path.extname(fullPath).toLowerCase().slice(1);
        if (!['md', 'markdown', 'txt', 'rst'].includes(_fenceExt)) {
          content = content.replace(/^```[a-zA-Z0-9+#.-]*\r?\n/, '');
          content = content.replace(/\r?\n```[^\n]*$/, '');
          // Closing fence without newline before ```, or extra trailing fence (common on HTML)
          content = content.replace(/\r?\n```[a-zA-Z0-9+#.-]*\s*$/m, '');
          content = content.replace(/```[a-zA-Z0-9+#.-]*\s*$/m, '');
        }
      }
      // Smart insert for HTML files: if file already ends with </html>, insert new content
      // BEFORE the closing tag instead of appending after it (BUG 6 — content after </html>).
      let didSmartInsert = false;
      const ext = (path.extname(fullPath) || '').toLowerCase();
      if (/\.html?$/.test(ext)) {
        try {
          const existingContent = await fs.readFile(fullPath, 'utf8');
          const htmlCloseMatch = existingContent.match(/([\s\S]*?)(<\/html\s*>\s*)$/i);
          if (htmlCloseMatch) {
            // File ends with </html> — insert new content before the closing tag
            const beforeClose = htmlCloseMatch[1];
            const closeTag = htmlCloseMatch[2];
            // Only do smart insert if the new content doesn't itself contain </html>
            if (!/<\/html\s*>/i.test(content)) {
              const merged = beforeClose + content + closeTag;
              await fs.writeFile(fullPath, merged, 'utf8');
              didSmartInsert = true;
              console.log(`[MCP] Smart HTML insert: placed ${content.length} chars before </html> in ${path.basename(fullPath)}`);
            }
          }
        } catch (smartErr) { console.warn(`[MCPToolServer] append_to_file: smart insert failed: ${smartErr.message}`); }
      }

      if (!didSmartInsert) {
        await fs.appendFile(fullPath, content, 'utf8');
      }

      let fullContent = content;
      try { fullContent = await fs.readFile(fullPath, 'utf8'); } catch (readErr) { console.warn(`[MCPToolServer] append_to_file: failed to read full content: ${readErr.message}`); }

      if (this.browserManager?.parentWindow) {
        this.browserManager.parentWindow.webContents.send('files-changed');
        this.browserManager.parentWindow.webContents.send('agent-file-modified', {
          filePath: fullPath,
          newContent: fullContent,
          isNew,
          tool: 'append_to_file',
        });
      }

      return { success: true, path: fullPath, isNew, message: `Appended ${content.length} chars to ${path.basename(fullPath)}`, fullContent };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async _diffFiles(fileA, fileB) {
    const fullA = path.isAbsolute(fileA) ? fileA : path.join(this.projectPath || '', fileA);
    const fullB = path.isAbsolute(fileB) ? fileB : path.join(this.projectPath || '', fileB);
    try {
      const contentA = await fs.readFile(fullA, 'utf8');
      const contentB = await fs.readFile(fullB, 'utf8');
      const linesA = contentA.split('\n');
      const linesB = contentB.split('\n');
      const diffs = [];
      const maxLen = Math.max(linesA.length, linesB.length);
      for (let i = 0; i < maxLen; i++) {
        const a = linesA[i];
        const b = linesB[i];
        if (a === undefined) {
          diffs.push({ line: i + 1, type: 'added', text: b });
        } else if (b === undefined) {
          diffs.push({ line: i + 1, type: 'removed', text: a });
        } else if (a !== b) {
          diffs.push({ line: i + 1, type: 'changed', from: a, to: b });
        }
      }
      return { success: true, fileA: fullA, fileB: fullB, differences: diffs, totalDiffs: diffs.length, identical: diffs.length === 0 };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ─── HTTP Request ────────────────────────────────────────────────────────

  async _httpRequest(url, method = 'GET', headers = {}, body) {
    return new Promise((resolve) => {
      try {
        const parsedUrl = new URL(url);
        // SSRF protection
        const hostname = parsedUrl.hostname.toLowerCase();
        const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', 'metadata.google.internal'];
        const blockedPrefixes = ['10.', '172.16.', '172.17.', '172.18.', '172.19.', '172.20.',
          '172.21.', '172.22.', '172.23.', '172.24.', '172.25.', '172.26.', '172.27.',
          '172.28.', '172.29.', '172.30.', '172.31.', '192.168.', '169.254.'];
        if (blockedHosts.includes(hostname) || blockedPrefixes.some(p => hostname.startsWith(p))) {
          resolve({ success: false, error: `SSRF protection: requests to internal/private addresses are blocked (${hostname})` });
          return;
        }

        const isHttps = parsedUrl.protocol === 'https:';
        const lib = isHttps ? https : http;
        const options = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (isHttps ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: (method || 'GET').toUpperCase(),
          headers: { ...headers },
        };
        if (body && !options.headers['Content-Type']) {
          options.headers['Content-Type'] = 'application/json';
        }
        const req = lib.request(options, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            let parsed = data;
            try { parsed = JSON.parse(data); } catch {}
            resolve({
              success: true,
              status: res.statusCode,
              statusText: res.statusMessage,
              headers: res.headers,
              body: parsed,
              size: data.length,
            });
          });
        });
        req.on('error', (error) => resolve({ success: false, error: error.message }));
        req.setTimeout(30000, () => { req.destroy(); resolve({ success: false, error: 'Request timed out (30s)' }); });
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
      } catch (error) {
        resolve({ success: false, error: error.message });
      }
    });
  }

  // ─── System Tools ────────────────────────────────────────────────────────

  async _checkPort(port) {
    return new Promise((resolve) => {
      const net = require('net');
      const server = net.createServer();
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          resolve({ success: true, port, inUse: true, message: `Port ${port} is in use` });
        } else {
          resolve({ success: false, error: err.message });
        }
      });
      server.once('listening', () => {
        server.close();
        resolve({ success: true, port, inUse: false, message: `Port ${port} is available` });
      });
      server.listen(port, '127.0.0.1');
    });
  }

  async _installPackages(packages, manager) {
    const cwd = this.projectPath;
    if (!cwd) return { success: false, error: 'No project opened' };
    let pm = manager;
    if (!pm) {
      try {
        await fs.access(path.join(cwd, 'package.json'));
        try { await fs.access(path.join(cwd, 'yarn.lock')); pm = 'yarn'; } catch { pm = 'npm'; }
      } catch {
        try { await fs.access(path.join(cwd, 'requirements.txt')); pm = 'pip'; } catch { pm = 'npm'; }
      }
    }
    let cmd;
    const safePackages = this._sanitizeShellArg(packages);
    switch (pm) {
      case 'npm': cmd = `npm install ${safePackages}`; break;
      case 'yarn': cmd = `yarn add ${safePackages}`; break;
      case 'pip': cmd = `pip install ${safePackages}`; break;
      default: cmd = `npm install ${safePackages}`; break;
    }
    return this._runCommand(cmd, cwd, 120000);
  }

  async _replaceInFiles(searchText, replaceText, searchPath, isRegex = false) {
    if (!searchText) return { success: false, error: 'searchText is required' };
    const basePath = this.projectPath || '';
    const targetPath = searchPath
      ? (path.isAbsolute(searchPath) ? searchPath : path.join(basePath, searchPath))
      : basePath;

    try {
      const stats = await fs.stat(targetPath);
      const files = [];

      if (stats.isDirectory()) {
        const walk = async (dir, depth = 0) => {
          if (depth > 10) return;
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (['node_modules', '.git', 'dist', 'build', '__pycache__', '.next', '.vscode'].includes(entry.name)) continue;
              await walk(fullPath, depth + 1);
            } else if (entry.isFile()) {
              const ext = path.extname(entry.name).toLowerCase();
              if (['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.gguf'].includes(ext)) continue;
              files.push(fullPath);
            }
          }
        };
        await walk(targetPath);
      } else {
        files.push(targetPath);
      }

      const regex = isRegex ? new RegExp(searchText, 'g') : null;
      const results = [];
      let totalReplacements = 0;

      for (const file of files) {
        try {
          const content = await fs.readFile(file, 'utf8');
          const matches = isRegex
            ? (content.match(regex) || []).length
            : content.split(searchText).length - 1;

          if (matches > 0) {
            if (!this._fileBackups.has(file)) {
              this._setFileBackup(file, { original: content, timestamp: Date.now(), tool: 'replace_in_files', isNew: false });
            }
            const newContent = isRegex
              ? content.replace(regex, replaceText)
              : content.split(searchText).join(replaceText);
            await fs.writeFile(file, newContent, 'utf8');
            results.push({ file: path.relative(basePath, file), replacements: matches });
            totalReplacements += matches;
          }
        } catch {}
      }

      return {
        success: true,
        filesModified: results.length,
        totalReplacements,
        files: results,
        message: `Replaced ${totalReplacements} occurrences across ${results.length} files`,
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async _openFileInEditor(filePath) {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.projectPath || '', filePath);
    try {
      await fs.access(fullPath);
      if (this.browserManager && this.browserManager.parentWindow) {
        this.browserManager.parentWindow.webContents.send('open-file', fullPath);
        return { success: true, filePath: fullPath, message: `Opened ${path.basename(fullPath)} in editor` };
      }
      return { success: false, error: 'No window available to open file in' };
    } catch {
      return { success: false, error: `File not found: ${fullPath}` };
    }
  }

  async _getProjectStructure() {
    if (this.ragEngine && this.ragEngine.projectPath) {
      return { success: true, structure: this.ragEngine.getProjectSummary() };
    }
    if (this.projectPath) {
      return this._listDirectory(this.projectPath, true);
    }
    return { success: false, error: 'No project opened' };
  }

  // ─── Memory Tools ────────────────────────────────────────────────────────

  async _saveMemory(key, value) {
    if (!key || value == null || value === '') return { success: false, error: 'Both key and value are required' };
    try {
      const memDir = path.join(this.projectPath || require('os').homedir(), '.guide-memory');
      await fs.mkdir(memDir, { recursive: true });
      const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
      const textValue = typeof value === 'object'
        ? JSON.stringify(value, null, 2)
        : String(value);
      const metadata = { key, savedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      const payload = JSON.stringify({ metadata, content: value });
      await fs.writeFile(path.join(memDir, `${safeKey}.json`), payload, 'utf8');
      // Also write plain text for backward compat
      await fs.writeFile(path.join(memDir, `${safeKey}.txt`), textValue, 'utf8');
      return { success: true, message: `Memory saved: "${key}"` };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async _getMemory(key) {
    if (!key) return { success: false, error: 'Key is required' };
    try {
      const memDir = path.join(this.projectPath || require('os').homedir(), '.guide-memory');
      const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');

      // Try exact match first (JSON then txt)
      for (const ext of ['.json', '.txt']) {
        const filePath = path.join(memDir, `${safeKey}${ext}`);
        try {
          const raw = await fs.readFile(filePath, 'utf8');
          if (ext === '.json') {
            const parsed = JSON.parse(raw);
            return { success: true, key, value: parsed.content, metadata: parsed.metadata };
          }
          return { success: true, key, value: raw };
        } catch (_) {}
      }

      // Fuzzy match: find closest key by substring
      try {
        const files = await fs.readdir(memDir);
        const lowerKey = safeKey.toLowerCase();
        const match = files.find(f => f.toLowerCase().includes(lowerKey));
        if (match) {
          const raw = await fs.readFile(path.join(memDir, match), 'utf8');
          const matchKey = match.replace(/\.(json|txt)$/, '');
          if (match.endsWith('.json')) {
            const parsed = JSON.parse(raw);
            return { success: true, key: matchKey, value: parsed.content, metadata: parsed.metadata, fuzzyMatch: true };
          }
          return { success: true, key: matchKey, value: raw, fuzzyMatch: true };
        }
      } catch (_) {}

      return { success: false, error: `No memory found for key: "${key}"` };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async _listMemories() {
    try {
      const memDir = path.join(this.projectPath || require('os').homedir(), '.guide-memory');
      try { await fs.access(memDir); } catch { return { success: true, keys: [], message: 'No memories saved yet.' }; }
      const files = await fs.readdir(memDir);
      // Prefer .json files, fall back to .txt
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      const txtOnlyFiles = files.filter(f => f.endsWith('.txt') && !jsonFiles.includes(f.replace('.txt', '.json')));

      const entries = [];
      for (const f of jsonFiles) {
        try {
          const raw = await fs.readFile(path.join(memDir, f), 'utf8');
          const parsed = JSON.parse(raw);
          entries.push({ key: f.replace('.json', '').replace(/_/g, ' '), updatedAt: parsed.metadata?.updatedAt || null });
        } catch (_) {
          entries.push({ key: f.replace('.json', '').replace(/_/g, ' '), updatedAt: null });
        }
      }
      for (const f of txtOnlyFiles) {
        try {
          const st = await fs.stat(path.join(memDir, f));
          entries.push({ key: f.replace('.txt', '').replace(/_/g, ' '), updatedAt: st.mtime.toISOString() });
        } catch (_) {
          entries.push({ key: f.replace('.txt', '').replace(/_/g, ' '), updatedAt: null });
        }
      }

      // Sort by most recently updated
      entries.sort((a, b) => {
        if (!a.updatedAt && !b.updatedAt) return 0;
        if (!a.updatedAt) return 1;
        if (!b.updatedAt) return -1;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });

      return { success: true, keys: entries.map(e => e.key), entries, message: `${entries.length} memories found` };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ─── TODO Tools ──────────────────────────────────────────────────────────

  _writeTodos(params) {
    const { items, skipAutoInProgress } = params;
    if (!Array.isArray(items) || items.length === 0) {
      return { success: false, error: 'items must be a non-empty array of strings or {text, status} objects. Example: ["Step 1: do thing", "Step 2: do other thing"]. Retry with a valid items array.' };
    }
    // Replace entire list (idempotent) — prevents duplicate accumulation across context rotations
    this._todos = [];
    this._todoNextId = 1;
    const created = [];
    for (const item of items) {
      let text, status;
      if (typeof item === 'string') {
        text = item.trim();
        status = 'pending';
      } else if (item && typeof item === 'object') {
        const title = (item.title || '').toString().trim();
        const desc = (item.description || '').toString().trim();
        const base = (item.text || item.content || title).toString().trim();
        text = desc ? (base ? `${base}: ${desc}` : desc) : base;
        status = ['pending', 'in-progress', 'done'].includes(item.status) ? item.status : 'pending';
      } else {
        continue;
      }
      if (!text) continue;
      const todo = { id: this._todoNextId++, text, status };
      this._todos.push(todo);
      created.push(todo);
    }
    // Auto-mark the first todo as in-progress. When write_todos is called the model is always
    // about to begin step 1. Small models (4B/7B) routinely skip the first update_todo call
    // entirely — this ensures the plan shows activity immediately rather than sitting at 0/N.
    // If the model also calls update_todo({status:'in-progress'}) for the first item, it's
    // idempotent. If the item was explicitly created with status 'done', don't downgrade it.
    if (created.length > 0 && created[0].status === 'pending' && !skipAutoInProgress) {
      created[0].status = 'in-progress';
      const stored = this._todos.find(t => t.id === created[0].id);
      if (stored) stored.status = 'in-progress';
    }
    if (created.length === 0) {
      return {
        success: false,
        error: 'No valid todo items after normalization. Each item needs text (string) or {text,status}. Aliases title/description/content are accepted. Example: {"items":["Step one","Step two"]}',
        created: [],
        allTodos: [],
      };
    }
    if (this.onTodoUpdate) this.onTodoUpdate([...this._todos]);
    return { success: true, created, allTodos: [...this._todos] };
  }

  /** Seed live todo list from plan frontmatter / PlanCard before Build. */
  seedTodosFromPlan(planTodos) {
    if (!Array.isArray(planTodos) || planTodos.length === 0) {
      return { success: true, created: [], allTodos: [...this._todos] };
    }
    const items = planTodos.map((t) => ({
      text: (t.content || t.text || String(t)).trim(),
      status: ['pending', 'in-progress', 'done'].includes(t.status) ? t.status : 'pending',
    })).filter((t) => t.text);
    return this._writeTodos({ items, skipAutoInProgress: true });
  }

  _updateTodo(params) {
    const { id, status, text } = params;
    const todo = this._todos.find(t => t.id === id);
    if (!todo) return { success: false, error: `TODO #${id} not found` };
    if (status) {
      // Normalize: accept 'completed' as alias for 'done'
      const normalized = status === 'completed' ? 'done' : status;
      if (['pending', 'in-progress', 'done'].includes(normalized)) {
        todo.status = normalized;
      }
    }
    if (typeof text === 'string' && text.trim()) {
      todo.text = text.trim();
    }
    if (this.onTodoUpdate) this.onTodoUpdate([...this._todos]);
    return { success: true, todo };
  }

  // ─── Scratchpad Tools ────────────────────────────────────────────────────

  _writeScratchpad(params) {
    const key = params.name || params.key;
    const { content } = params;
    if (!key || typeof key !== 'string') {
      return { success: false, error: 'name must be a non-empty string' };
    }
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    const scratchDir = this._scratchDir || path.join(this.projectRoot || '.', '.guide-scratch');
    const fsSync = require('fs');
    if (!fsSync.existsSync(scratchDir)) {
      fsSync.mkdirSync(scratchDir, { recursive: true });
    }
    const filePath = path.join(scratchDir, `${safeKey}.json`);
    const data = { key: safeKey, content, updatedAt: new Date().toISOString() };
    fsSync.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return { success: true, path: filePath, key: safeKey };
  }

  _readScratchpad(params) {
    const key = params.name || params.key;
    if (!key || typeof key !== 'string') {
      return { success: false, error: 'name must be a non-empty string' };
    }
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    const scratchDir = this._scratchDir || path.join(this.projectRoot || '.', '.guide-scratch');
    const filePath = path.join(scratchDir, `${safeKey}.json`);
    const fsSync = require('fs');
    if (!fsSync.existsSync(filePath)) {
      return { success: false, error: `Scratchpad '${safeKey}' not found` };
    }
    const raw = fsSync.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    return { success: true, ...data };
  }

  // ─── Rules/Skills Tools ──────────────────────────────────────────────────

  _saveRule(params) {
    if (!this.rulesManager) return { success: false, error: 'Rules system not initialized' };
    return this.rulesManager.saveRule(params.name, params.content);
  }

  _listRules() {
    if (!this.rulesManager) return { success: false, error: 'Rules system not initialized' };
    const rules = this.rulesManager.listRules();
    return { success: true, rules, count: rules.length };
  }

  // ─── Ask Question Tool ──────────────────────────────────────────────────

  /**
   * Ask the user a question and wait for their response.
   * Sends the question to the frontend via IPC and waits for the answer.
   */
  async _askQuestion(params) {
    const question = params.question || '';
    const rawOptions = Array.isArray(params.options) ? params.options.slice(0, 4) : [];
    const allowMultiple = !!params.allowMultiple;

    if (!question) return { success: false, error: 'Question text is required' };

    // Normalize options: models may pass plain strings, objects without label, or proper {label, description}.
    // Every option must become a {label, description?} object so the frontend never renders [object Object].
    const options = rawOptions.map(opt => {
      if (typeof opt === 'string') return { label: opt };
      if (opt && typeof opt === 'object') {
        const label = opt.label || opt.description || opt.text || opt.value || opt.name || String(opt);
        const desc = (opt.label && opt.description) ? opt.description : (opt.detail || null);
        return { label, ...(desc ? { description: desc } : {}) };
      }
      return { label: String(opt) };
    });

    // Emit question to frontend via the onAskQuestion callback (wired in electron-main)
    if (typeof this.onAskQuestion === 'function') {
      return await this.onAskQuestion({ question, options, allowMultiple });
    }

    // Fallback: no UI wired — return the question text so the model can ask in chat
    return { success: true, answer: '(User could not be reached — ask in chat instead)', asked: question };
  }

  // ─── Process / System Tools ──────────────────────────────────────────────

  async _listProcesses(filter, sortBy = 'cpu', maxResults = 30) {
    const isWin = process.platform === 'win32';
    let cmd;
    if (isWin) {
      cmd = 'powershell -NoProfile -NonInteractive -Command "Get-Process | Select-Object Id,ProcessName,CPU,WorkingSet64 | ConvertTo-Json"';
    } else {
      cmd = 'ps aux --sort=-%cpu 2>/dev/null || ps aux';
    }
    try {
      const result = await this._runCommand(cmd, undefined, 15000);
      if (!result.success) return result;
      let procs;
      if (isWin) {
        let raw = result.output.trim();
        // PowerShell may return single object instead of array
        if (raw.startsWith('{')) raw = '[' + raw + ']';
        try { procs = JSON.parse(raw); } catch { return { success: false, error: 'Failed to parse process list' }; }
        if (!Array.isArray(procs)) procs = [procs];
        procs = procs.map(p => ({
          pid: p.Id,
          name: p.ProcessName,
          cpu: (p.CPU || 0).toFixed(1),
          memoryMB: ((p.WorkingSet64 || 0) / 1048576).toFixed(1),
        }));
      } else {
        const lines = result.output.split('\n').filter(l => l.trim());
        procs = [];
        for (const line of lines.slice(1)) { // skip header
          const parts = line.split(/\s+/);
          if (parts.length < 11) continue;
          procs.push({
            pid: parseInt(parts[1]),
            name: parts[10].split('/').pop(),
            cpu: parseFloat(parts[2]).toFixed(1),
            memoryMB: (parseFloat(parts[5]) / 1024).toFixed(1),
            user: parts[0],
          });
        }
      }
      // Filter
      if (filter) {
        const f = filter.toLowerCase();
        procs = procs.filter(p => p.name.toLowerCase().includes(f));
      }
      // Sort
      if (sortBy === 'memory') procs.sort((a, b) => parseFloat(b.memoryMB) - parseFloat(a.memoryMB));
      else if (sortBy === 'pid') procs.sort((a, b) => a.pid - b.pid);
      else procs.sort((a, b) => parseFloat(b.cpu) - parseFloat(a.cpu));
      // Limit
      procs = procs.slice(0, maxResults);
      return { success: true, processes: procs, count: procs.length };
    } catch (e) {
      return { success: false, error: `Failed to list processes: ${e.message}` };
    }
  }

  async _killProcess(pid, force = false) {
    if (!pid || typeof pid !== 'number') return { success: false, error: 'PID must be a number' };
    const isWin = process.platform === 'win32';
    const cmd = isWin
      ? `taskkill /PID ${pid}${force ? ' /F' : ''}`
      : `kill ${force ? '-9' : '-15'} ${pid}`;
    try {
      const result = await this._runCommand(cmd, undefined, 10000);
      return result;
    } catch (e) {
      return { success: false, error: `Failed to kill process ${pid}: ${e.message}` };
    }
  }

  async _getSystemInfo() {
    const os = require('os');
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const info = {
      platform: os.platform(),
      arch: os.arch(),
      osRelease: os.release(),
      hostname: os.hostname(),
      cpuModel: cpus.length > 0 ? cpus[0].model : 'unknown',
      cpuCores: cpus.length,
      totalMemoryGB: (totalMem / 1073741824).toFixed(2),
      freeMemoryGB: (freeMem / 1073741824).toFixed(2),
      usedMemoryGB: ((totalMem - freeMem) / 1073741824).toFixed(2),
      memoryUsagePercent: (((totalMem - freeMem) / totalMem) * 100).toFixed(1),
      uptime: formatUptime(os.uptime()),
      loadAvg: os.loadavg().map(l => l.toFixed(2)),
      nodeVersion: process.version,
    };
    // Disk usage
    try {
      const isWin = process.platform === 'win32';
      const cmd = isWin
        ? 'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_LogicalDisk -Filter \'DriveType=3\' | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json"'
        : 'df -h / 2>/dev/null | tail -1';
      const result = await this._runCommand(cmd, undefined, 10000);
      if (result.success) {
        if (isWin) {
          let raw = result.output.trim();
          if (raw.startsWith('{')) raw = '[' + raw + ']';
          try {
            const disks = JSON.parse(raw);
            const arr = Array.isArray(disks) ? disks : [disks];
            info.disks = arr.map(d => ({
              drive: d.DeviceID,
              totalGB: (d.Size / 1073741824).toFixed(1),
              freeGB: (d.FreeSpace / 1073741824).toFixed(1),
              usedPercent: (((d.Size - d.FreeSpace) / d.Size) * 100).toFixed(1),
            }));
          } catch {}
        } else {
          const parts = result.output.trim().split(/\s+/);
          if (parts.length >= 6) {
            info.disks = [{ drive: parts[5] || '/', total: parts[1], used: parts[2], available: parts[3], usedPercent: parts[4] }];
          }
        }
      }
    } catch {}
    return { success: true, system: info };
  }

  async _getEnvVar(name) {
    if (!name) return { success: false, error: 'Variable name is required' };
    const value = process.env[name];
    return { success: true, name, value: value || null, isSet: value !== undefined };
  }

  async _setEnvVar(name, value, persistent = false) {
    if (!name) return { success: false, error: 'Variable name is required' };
    if (value === undefined || value === null) return { success: false, error: 'Variable value is required' };
    // Set for current process
    process.env[name] = String(value);
    // If persistent, also write to shell profile
    if (persistent) {
      try {
        const fs = require('fs');
        const os = require('os');
        const home = os.homedir();
        const isWin = process.platform === 'win32';
        if (isWin) {
          // Set user environment variable persistently on Windows
          await this._runCommand(`setx ${name} "${value}"`, undefined, 10000);
        } else {
          // Append to .bashrc / .zshrc
          const shell = process.env.SHELL || '/bin/bash';
          const rcFile = shell.includes('zsh') ? path.join(home, '.zshrc') : path.join(home, '.bashrc');
          const exportLine = `\nexport ${name}="${value}" # Added by guIDE\n`;
          if (fs.existsSync(rcFile)) {
            const content = fs.readFileSync(rcFile, 'utf8');
            // Remove existing export for this var
            const cleaned = content.replace(new RegExp(`\nexport ${name}=.*\n?`, 'g'), '\n');
            fs.writeFileSync(rcFile, cleaned.trimEnd() + exportLine);
          } else {
            fs.writeFileSync(rcFile, exportLine);
          }
        }
      } catch (e) {
        return { success: true, name, value: String(value), persistent: false, warning: `Set for session only — failed to persist: ${e.message}` };
      }
    }
    // Also set in the persistent terminal if available
    if (this._terminalManager && typeof this._terminalManager.setEnv === 'function') {
      this._terminalManager.setEnv(name, String(value));
    }
    return { success: true, name, value: String(value), persistent };
  }

  // ─── Network Tools ────────────────────────────────────────────────────────

  async _pingHost(host, count = 4) {
    if (!host) return { success: false, error: 'Host is required' };
    const isWin = process.platform === 'win32';
    const cmd = isWin
      ? `ping -n ${count} "${host}"`
      : `ping -c ${count} -W 5 "${host}" 2>&1`;
    try {
      const result = await this._runCommand(cmd, undefined, 30000);
      if (!result.success) return result;
      const output = result.output;
      // Parse latency from ping output
      const latencies = [];
      const timeRe = isWin ? /time[=<](\d+)/gi : /time=([\d.]+)\s*ms/gi;
      let m;
      while ((m = timeRe.exec(output)) !== null) {
        latencies.push(parseFloat(m[1]));
      }
      // Parse packet loss
      const lossMatch = output.match(/\((\d+)%\s*loss\)/i) || output.match(/(\d+)%\s*packet\s*loss/i);
      const packetLoss = lossMatch ? parseInt(lossMatch[1]) : null;
      const stats = latencies.length > 0 ? {
        min: Math.min(...latencies).toFixed(1),
        avg: (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1),
        max: Math.max(...latencies).toFixed(1),
        count: latencies.length,
      } : null;
      return { success: true, host, stats, packetLoss, raw: output.trim() };
    } catch (e) {
      return { success: false, error: `Ping failed: ${e.message}` };
    }
  }

  async _dnsLookup(hostname, recordType) {
    if (!hostname) return { success: false, error: 'Hostname is required' };
    const dns = require('dns').promises;
    const results = {};
    const types = recordType ? [recordType] : ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'];
    for (const type of types) {
      try {
        const method = `resolve${type === 'A' ? '4' : type === 'AAAA' ? '6' : type.charAt(0).toUpperCase() + type.slice(1).toLowerCase()}`;
        if (typeof dns[method] === 'function') {
          const records = await dns[method](hostname);
          results[type] = records;
        } else if (type === 'CNAME') {
          const records = await dns.resolveCname(hostname);
          results[type] = records;
        }
      } catch {
        // Record type not found — skip
      }
    }
    // Also resolve the default address
    try {
      const defaultAddr = await dns.lookup(hostname);
      results.default = defaultAddr;
    } catch {}
    return { success: true, hostname, records: results };
  }

  async _downloadFile(url, savePath, overwrite = false) {
    if (!url) return { success: false, error: 'URL is required' };
    const fs = require('fs');
    const { URL } = require('url');
    const http = require('http');
    const https = require('https');

    // Determine save path
    let targetPath;
    if (savePath) {
      targetPath = path.isAbsolute(savePath) ? savePath : path.join(this.projectPath || process.cwd(), savePath);
    } else {
      try {
        const urlObj = new URL(url);
        const filename = path.basename(urlObj.pathname) || 'download';
        targetPath = path.join(this.projectPath || process.cwd(), filename);
      } catch {
        targetPath = path.join(this.projectPath || process.cwd(), 'download');
      }
    }

    // Check overwrite
    if (!overwrite && fs.existsSync(targetPath)) {
      return { success: false, error: `File already exists: ${targetPath}. Set overwrite=true to replace.` };
    }

    // Ensure parent directory exists
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    return new Promise((resolve) => {
      const client = url.startsWith('https') ? https : http;
      const file = fs.createWriteStream(targetPath);
      let downloaded = 0;

      client.get(url, { timeout: 60000 }, (response) => {
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close();
          fs.unlinkSync(targetPath);
          this._downloadFile(response.headers.location, savePath, overwrite).then(resolve);
          return;
        }
        if (response.statusCode !== 200) {
          file.close();
          fs.unlinkSync(targetPath);
          resolve({ success: false, error: `HTTP ${response.statusCode}` });
          return;
        }
        const totalSize = parseInt(response.headers['content-length'] || '0');
        response.pipe(file);
        response.on('data', (chunk) => { downloaded += chunk.length; });
        file.on('finish', () => {
          file.close();
          resolve({
            success: true,
            savedTo: targetPath,
            sizeBytes: downloaded,
            sizeMB: (downloaded / 1048576).toFixed(2),
          });
        });
      }).on('error', (e) => {
        file.close();
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
        resolve({ success: false, error: `Download failed: ${e.message}` });
      }).on('timeout', () => {
        file.close();
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
        resolve({ success: false, error: 'Download timed out' });
      });
    });
  }

  // ─── Code Quality Tools ────────────────────────────────────────────────────

  async _runLinter(filePath, fix = false, linter) {
    const fs = require('fs');
    const projRoot = this.projectPath || process.cwd();
    const target = filePath ? (path.isAbsolute(filePath) ? filePath : path.join(projRoot, filePath)) : projRoot;

    // Auto-detect linter
    let detected = linter;
    if (!detected) {
      if (fs.existsSync(path.join(projRoot, '.eslintrc.js')) || fs.existsSync(path.join(projRoot, '.eslintrc.json')) || fs.existsSync(path.join(projRoot, '.eslintrc.yml')) || fs.existsSync(path.join(projRoot, 'eslint.config.js')) || fs.existsSync(path.join(projRoot, 'eslint.config.mjs'))) {
        detected = 'eslint';
      } else if (fs.existsSync(path.join(projRoot, 'pyproject.toml')) || fs.existsSync(path.join(projRoot, '.flake8'))) {
        // Check for ruff first (preferred over pylint)
        try {
          const whichResult = await this._runCommand(process.platform === 'win32' ? 'where ruff' : 'which ruff', undefined, 5000);
          detected = whichResult.success ? 'ruff' : 'pylint';
        } catch { detected = 'pylint'; }
      } else if (fs.existsSync(path.join(projRoot, '.rubocop.yml'))) {
        detected = 'rubocop';
      }
    }

    if (!detected) return { success: false, error: 'No linter detected. Specify linter parameter or install a linter (eslint, ruff, pylint).' };

    let cmd;
    switch (detected) {
      case 'eslint':
        cmd = `npx eslint --format json${fix ? ' --fix' : ''} "${target}"`;
        break;
      case 'ruff':
        cmd = `ruff check --output-format json${fix ? ' --fix' : ''} "${target}"`;
        break;
      case 'pylint':
        cmd = `pylint --output-format json "${target}"`;
        break;
      case 'rubocop':
        cmd = `rubocop --format json${fix ? ' --auto-correct' : ''} "${target}"`;
        break;
      default:
        return { success: false, error: `Unknown linter: ${detected}` };
    }

    try {
      const result = await this._runCommand(cmd, projRoot, 60000);
      // Linters often exit non-zero on errors — that's fine, we still parse output
      let lintResults;
      try {
        lintResults = JSON.parse(result.output || result.error || '[]');
      } catch {
        return { success: true, linter: detected, raw: result.output || result.error, note: 'Output not JSON — linter may not support json format' };
      }
      const errorCount = Array.isArray(lintResults) ? lintResults.reduce((sum, f) => sum + (f.errorCount || f.messages?.length || 0), 0) : 0;
      const warningCount = Array.isArray(lintResults) ? lintResults.reduce((sum, f) => sum + (f.warningCount || 0), 0) : 0;
      return { success: true, linter: detected, errors: errorCount, warnings: warningCount, results: lintResults, fixed: fix };
    } catch (e) {
      return { success: false, error: `Linter failed: ${e.message}` };
    }
  }

  async _runTests(testPath, testName, runner, coverage = false) {
    const fs = require('fs');
    const projRoot = this.projectPath || process.cwd();

    // Auto-detect test runner
    let detected = runner;
    if (!detected) {
      const pkgPath = path.join(projRoot, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
            detected = 'npm';
          } else if (fs.existsSync(path.join(projRoot, 'jest.config.js')) || fs.existsSync(path.join(projRoot, 'jest.config.ts')) || (pkg.devDependencies?.jest)) {
            detected = 'jest';
          } else if (fs.existsSync(path.join(projRoot, 'vitest.config.js')) || pkg.devDependencies?.vitest) {
            detected = 'vitest';
          }
        } catch {}
      }
      if (!detected) {
        if (fs.existsSync(path.join(projRoot, 'pytest.ini')) || fs.existsSync(path.join(projRoot, 'pyproject.toml')) || fs.existsSync(path.join(projRoot, 'setup.cfg'))) {
          detected = 'pytest';
        } else if (fs.existsSync(path.join(projRoot, 'Cargo.toml'))) {
          detected = 'cargo';
        } else if (fs.existsSync(path.join(projRoot, 'go.mod'))) {
          detected = 'go';
        }
      }
    }

    if (!detected) return { success: false, error: 'No test runner detected. Specify runner parameter.' };

    let cmd;
    switch (detected) {
      case 'npm':
        cmd = 'npm test';
        if (testName) cmd += ` -- --testNamePattern="${testName}"`;
        break;
      case 'jest':
        cmd = 'npx jest --verbose';
        if (testPath) cmd += ` "${testPath}"`;
        if (testName) cmd += ` -t "${testName}"`;
        if (coverage) cmd += ' --coverage';
        break;
      case 'vitest':
        cmd = 'npx vitest run --reporter=verbose';
        if (testPath) cmd += ` "${testPath}"`;
        if (testName) cmd += ` -t "${testName}"`;
        if (coverage) cmd += ' --coverage';
        break;
      case 'pytest':
        cmd = 'pytest -v';
        if (testPath) cmd += ` "${testPath}"`;
        if (testName) cmd += ` -k "${testName}"`;
        if (coverage) cmd += ' --cov';
        break;
      case 'cargo':
        cmd = 'cargo test';
        if (testName) cmd += ` "${testName}"`;
        break;
      case 'go':
        cmd = 'go test -v ./...';
        if (testPath) cmd = `go test -v "${testPath}"`;
        if (coverage) cmd = 'go test -v -cover ./...';
        break;
      default:
        return { success: false, error: `Unknown test runner: ${detected}` };
    }

    try {
      const result = await this._runCommand(cmd, projRoot, 120000);
      const output = result.output || result.error || '';
      // Parse pass/fail counts from common patterns
      const passMatch = output.match(/(\d+)\s*(?:passing|passed|PASS)/i);
      const failMatch = output.match(/(\d+)\s*(?:failing|failed|FAIL)/i);
      return {
        success: result.success,
        runner: detected,
        passed: passMatch ? parseInt(passMatch[1]) : null,
        failed: failMatch ? parseInt(failMatch[1]) : null,
        output: output.substring(0, 10000),
      };
    } catch (e) {
      return { success: false, error: `Test run failed: ${e.message}` };
    }
  }

  async _runFormatter(filePath, formatter, check = false) {
    const fs = require('fs');
    const projRoot = this.projectPath || process.cwd();
    const target = filePath ? (path.isAbsolute(filePath) ? filePath : path.join(projRoot, filePath)) : projRoot;

    // Auto-detect formatter
    let detected = formatter;
    if (!detected) {
      if (fs.existsSync(path.join(projRoot, '.prettierrc')) || fs.existsSync(path.join(projRoot, '.prettierrc.js')) || fs.existsSync(path.join(projRoot, '.prettierrc.json')) || fs.existsSync(path.join(projRoot, 'prettier.config.js'))) {
        detected = 'prettier';
      } else if (fs.existsSync(path.join(projRoot, 'pyproject.toml'))) {
        detected = 'black';
      } else if (fs.existsSync(path.join(projRoot, 'Cargo.toml'))) {
        detected = 'rustfmt';
      } else if (fs.existsSync(path.join(projRoot, 'go.mod'))) {
        detected = 'gofmt';
      }
    }

    if (!detected) return { success: false, error: 'No formatter detected. Specify formatter parameter.' };

    let cmd;
    switch (detected) {
      case 'prettier':
        cmd = `npx prettier ${check ? '--check' : '--write'} "${target}"`;
        break;
      case 'black':
        cmd = `black ${check ? '--check' : ''} "${target}"`;
        break;
      case 'rustfmt':
        cmd = `rustfmt${check ? ' --check' : ''} "${target}"`;
        break;
      case 'gofmt':
        cmd = `gofmt ${check ? '-l' : '-w'} "${target}"`;
        break;
      default:
        return { success: false, error: `Unknown formatter: ${detected}` };
    }

    try {
      const result = await this._runCommand(cmd, projRoot, 60000);
      return { success: true, formatter: detected, check, output: (result.output || '').substring(0, 5000) };
    } catch (e) {
      return { success: false, error: `Formatter failed: ${e.message}` };
    }
  }

  // ─── IDE Integration Tools ────────────────────────────────────────────────

  async _openTerminal(command, name, cwd) {
    // Send IPC to main process to create a terminal
    if (typeof this.onIPCCall === 'function') {
      return await this.onIPCCall('terminal-create', { command, name, cwd: cwd || this.projectPath });
    }
    // Fallback: use run_command as a non-persistent alternative
    if (command) {
      return await this._runCommand(command, cwd, 30000);
    }
    return { success: false, error: 'Terminal creation not available — no IPC bridge' };
  }

  async _switchFile(filePath, line, column) {
    if (!filePath) return { success: false, error: 'filePath is required' };
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(this.projectPath || process.cwd(), filePath);
    // Send IPC to main process to open file in editor
    if (typeof this.onIPCCall === 'function') {
      return await this.onIPCCall('switch-file', { filePath: resolvedPath, line, column });
    }
    // Fallback: use open_file_in_editor
    return await this._openFileInEditor(filePath);
  }

  async _getDiagnostics(filePath, severity) {
    // Send IPC to main process to get diagnostics from the editor
    if (typeof this.onIPCCall === 'function') {
      return await this.onIPCCall('get-diagnostics', { filePath, severity });
    }
    // Fallback: run linter as approximation
    if (filePath) {
      return await this._runLinter(filePath, false);
    }
    return { success: false, error: 'Diagnostics not available — no IPC bridge. Use run_linter as fallback.' };
  }

  async _getSelection() {
    // Send IPC to main process to get current editor selection
    if (typeof this.onIPCCall === 'function') {
      return await this.onIPCCall('get-selection', {});
    }
    return { success: false, error: 'Selection not available — no IPC bridge' };
  }

  // ─── Documentation Tools ──────────────────────────────────────────────────

  async _readDoc(docPath) {
    if (!docPath) return { success: false, error: 'docPath is required' };
    const fs = require('fs');
    const projRoot = this.projectPath || process.cwd();

    // Auto-locate common doc names
    const docNameMap = {
      'README': ['README.md', 'README.txt', 'README.rst', 'README'],
      'CHANGELOG': ['CHANGELOG.md', 'CHANGELOG.txt', 'CHANGES.md', 'HISTORY.md'],
      'CONTRIBUTING': ['CONTRIBUTING.md', 'CONTRIBUTING.txt'],
      'LICENSE': ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE'],
      'API': ['docs/API.md', 'API.md', 'docs/api.md'],
    };

    let resolvedPath;
    const candidates = docNameMap[docPath.toUpperCase()] || [docPath];
    for (const c of candidates) {
      const full = path.isAbsolute(c) ? c : path.join(projRoot, c);
      if (fs.existsSync(full)) {
        resolvedPath = full;
        break;
      }
    }

    if (!resolvedPath) {
      // Try as direct path
      const direct = path.isAbsolute(docPath) ? docPath : path.join(projRoot, docPath);
      if (fs.existsSync(direct)) {
        resolvedPath = direct;
      }
    }

    if (!resolvedPath) {
      return { success: false, error: `Documentation file not found: ${docPath}` };
    }

    try {
      const content = fs.readFileSync(resolvedPath, 'utf8');
      const stat = fs.statSync(resolvedPath);
      return {
        success: true,
        path: resolvedPath,
        size: stat.size,
        content: content.substring(0, 50000), // Cap at 50KB
        truncated: content.length > 50000,
      };
    } catch (e) {
      return { success: false, error: `Failed to read doc: ${e.message}` };
    }
  }

  async _searchDocs(query, maxResults = 10) {
    if (!query) return { success: false, error: 'query is required' };
    const fs = require('fs');
    const projRoot = this.projectPath || process.cwd();
    const results = [];

    // Search in common doc locations
    const docDirs = ['docs', 'wiki', 'doc', 'documentation'];
    const docFiles = [];
    const mdExt = new Set(['.md', '.mdx', '.rst', '.txt', '.adoc']);

    function walkDir(dir, depth = 0) {
      if (depth > 4 || docFiles.length > 200) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walkDir(full, depth + 1);
          } else if (mdExt.has(path.extname(entry.name).toLowerCase())) {
            docFiles.push(full);
          }
        }
      } catch {}
    }

    // Walk project root for top-level docs
    try {
      const rootEntries = fs.readdirSync(projRoot, { withFileTypes: true });
      for (const entry of rootEntries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(projRoot, entry.name);
        if (entry.isDirectory() && docDirs.includes(entry.name.toLowerCase())) {
          walkDir(full);
        } else if (entry.isFile() && mdExt.has(path.extname(entry.name).toLowerCase())) {
          docFiles.push(full);
        }
      }
    } catch {}

    // Also walk docs/ if it exists
    const docsDir = path.join(projRoot, 'docs');
    if (fs.existsSync(docsDir)) walkDir(docsDir);

    // Search query in each doc file
    const queryLower = query.toLowerCase();
    for (const docFile of docFiles) {
      if (results.length >= maxResults) break;
      try {
        const content = fs.readFileSync(docFile, 'utf8');
        const lines = content.split('\n');
        const matches = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(queryLower)) {
            matches.push({ line: i + 1, text: lines[i].trim().substring(0, 200) });
            if (matches.length >= 3) break;
          }
        }
        if (matches.length > 0) {
          results.push({
            path: path.relative(projRoot, docFile),
            matches,
          });
        }
      } catch {}
    }

    return { success: true, query, results, count: results.length };
  }

  // ─── Response Processing (parseToolCalls + processResponse) ──────────────

  parseToolCalls(responseText) {
    return standaloneParseToolCalls(responseText);
  }

  async processResponse(responseText, options = {}) {
    console.log('[MCP] processResponse called, text preview:', responseText?.substring(0, 200));

    const toolPaceMs = options.toolPaceMs || 0;
    const maxToolsPerResponse = Number.isFinite(options.maxToolsPerResponse) ? options.maxToolsPerResponse : 0;

    let toolCalls = this.parseToolCalls(responseText);

    // Normalize common tool-name aliases
    for (const call of toolCalls) {
      if (!call || typeof call.tool !== 'string') continue;
      if (call.tool === 'list_files') call.tool = 'list_directory';
    }

    // Path cleanup: strip template/placeholder prefixes
    const TEMPLATE_PATH_RE = /^(?:\$\w+\/|\/project\/[^/]*\/|\/home\/[^/]*\/[^/]*\/|\/workspace\/|~\/[^/]*\/)/;
    for (const call of toolCalls) {
      if (!call?.params) continue;
      for (const key of ['filePath', 'path', 'file_path', 'dirPath', 'directory']) {
        const v = call.params[key];
        if (typeof v === 'string' && TEMPLATE_PATH_RE.test(v)) {
          const cleaned = v.replace(TEMPLATE_PATH_RE, '');
          if (cleaned && cleaned !== v) {
            console.log(`[MCP] Path cleanup: "${v}" → "${cleaned}"`);
            call.params[key] = cleaned;
          }
        }
      }
    }

    // Param inference: fix "." or "" filePath for file operations when user message references a real file
    // NOTE: list_directory is excluded — ".", "./", and "" all resolve correctly to the project root
    // in _listDirectory via path.join(projectPath, "."). Keyword extraction from user messages
    // was removed because it's a classifier pattern that mis-triggers on common words like "build".
    if (options.userMessage) {
      for (const call of toolCalls) {
        if (!call || typeof call.tool !== 'string') continue;
        const fp = call.params?.filePath ?? call.params?.path ?? call.params?.file_path ?? '';
        const isFileOp = ['read_file', 'write_file', 'edit_file'].includes(call.tool);
        const pathIsBad = fp === '.' || fp === './' || fp === '' || fp === '..';

        if (pathIsBad && isFileOp) {
          const msg = options.userMessage;
          const fileMatch = msg.match(/\b([\w.-]+\.(?:json|js|ts|tsx|jsx|md|html|css|yml|yaml|toml|py|sh|bat|txt|xml|env|cfg|conf|ini|log|csv))\b/i);
          if (fileMatch) {
            const inferred = fileMatch[1];
            console.log(`[MCP] Param inference: "${call.tool}" filePath "${fp}" → "${inferred}" (from user message)`);
            call.params = { ...call.params, filePath: inferred };
            if (call.params.path) delete call.params.path;
            if (call.params.file_path) delete call.params.file_path;
          }
        }
      }
    }

    // Optional enforcement: rewrite browser_navigate URL
    if (options && typeof options.enforceNavigateUrl === 'string' && options.enforceNavigateUrl.trim()) {
      const expectedUrl = options.enforceNavigateUrl.trim();
      const firstNav = toolCalls.find(tc => tc && tc.tool === 'browser_navigate');
      if (firstNav) {
        const gotUrl = firstNav.params?.url;
        if (typeof gotUrl === 'string' && gotUrl.trim() && gotUrl.trim() !== expectedUrl) {
          console.log(`[MCP] Enforcing browser_navigate url: "${gotUrl.trim()}" -> "${expectedUrl}"`);
          firstNav.params = { ...(firstNav.params || {}), url: expectedUrl };
        }
        toolCalls = [firstNav];
      }
    }

    // Tool Call Repair
    let _repairDropped = [];
    if (toolCalls.length > 0) {
      const { repaired, issues, droppedFilePaths: _rd } = repairToolCalls(toolCalls, responseText);
      _repairDropped = _rd || [];
      if (issues.length > 0) {
        console.log(`[MCP] Repair dropped/fixed ${issues.length} call(s)`);
      }
      toolCalls = repaired;
    }

    // De-duplicate tool calls
    {
      const seen = new Set();
      const deduped = [];
      for (const call of toolCalls) {
        const tool = call?.tool;
        if (!tool || typeof tool !== 'string') continue;
        let sig;
        try { sig = `${tool}:${JSON.stringify(call.params || {})}`; } catch { sig = `${tool}:<unstringifiable>`; }
        if (seen.has(sig)) continue;
        seen.add(sig);
        deduped.push(call);
      }
      toolCalls = deduped;
    }

    // Cap tool burst
    let capped = false;
    let skippedCount = 0;
    if (maxToolsPerResponse > 0 && toolCalls.length > maxToolsPerResponse) {
      skippedCount = toolCalls.length - maxToolsPerResponse;
      toolCalls = toolCalls.slice(0, maxToolsPerResponse);
      capped = true;
      console.log(`[MCP] Capped tool calls: executing ${maxToolsPerResponse}, skipping ${skippedCount}`);
    }

    // No formal tool calls found — return without attempting fallback detection.
    // The model should use proper tool call format (native functions or JSON fences).
    // Removed: prose command detection and fallback file operation classification.
    if (toolCalls.length === 0) {
      console.log('[MCP] No formal tool calls found');
      return { hasToolCalls: false, results: [], formalCallCount: 0, droppedFilePaths: _repairDropped };
    }

    console.log('[MCP] Executing', toolCalls.length, 'tool calls...', toolPaceMs ? `(${toolPaceMs}ms pace)` : '');
    const results = [];
    for (const call of toolCalls) {

      if (toolPaceMs > 0 && results.length > 0) {
        await new Promise(r => setTimeout(r, toolPaceMs));
      }
      if (call && typeof call.tool === 'string') {
        call.params = canonicalizeToolParams(call.tool, call.params || {});
      }
      const result = await this.executeTool(call.tool, call.params || {});
      console.log('[MCP] Executed tool:', call.tool, 'result:', result.success ? 'success' : 'failed');
      results.push({ tool: call.tool, params: call.params, result });
    }

    return { hasToolCalls: true, results, capped: capped || false, skippedToolCalls: skippedCount, formalCallCount: toolCalls.length, droppedFilePaths: _repairDropped };
  }

  // ─── Tool Prompt Building ────────────────────────────────────────────────

  getToolPrompt() {
    if (this._toolPromptCache) return this._toolPromptCache;
    this._toolPromptCache = this._buildToolPrompt(this.getToolDefinitions());
    return this._toolPromptCache;
  }

  getToolPromptForTools(toolDefs, options = {}) {
    return this._buildToolPrompt(Array.isArray(toolDefs) ? toolDefs : [], options);
  }

  getCompactToolHint(taskType, options) {
    // Build a clean, compact tool schema from actual definitions
    // Returns an ARRAY of strings — each element is independently appendable
    // so the prompt assembler can include as many as the budget allows
    // instead of silently dropping ALL tools when the single string is too large.
    const tools = (options && options.toolDefs) || this.getToolDefinitions();
    const toolMap = {};
    for (const tool of tools) toolMap[tool.name] = tool;

    const parts = [];
    const planning = !!(options && options.planning);
    const compactDescriptions = !!(options && options.compactDescriptions);

    let header = getAgentToolPromptHeader({ planning, compact: true });
    if (this.projectPath) {
      header += `Project: ${this.projectPath}\n\n`;
    }
    parts.push(header);

    // Tier 0 categories are ALWAYS included in Agent mode (see buildBudgetProportionalToolPrompt).
    // Order matters: Browser + core file/shell tools first — never drop Browser when budget is tight.
    const categoryOrder = [
      ['Browser', ['browser_navigate', 'browser_snapshot', 'viewport_browser_snapshot', 'browser_click', 'browser_type', 'browser_screenshot']],
      ['Core Files', ['read_file', 'list_directory', 'grep_search', 'find_files', 'get_file_info']],
      ['Terminal', ['run_command', 'terminal_run', 'check_port', 'install_packages']],
      ['File Operations', ['write_file', 'edit_file', 'append_to_file', 'delete_file', 'rename_file', 'copy_file', 'create_directory', 'get_project_structure', 'open_file_in_editor', 'diff_files']],
      ['Search', ['search_in_file', 'search_codebase', 'replace_in_files']],
      ['Web', ['web_search', 'fetch_webpage', 'http_request', 'download_file']],
      ['Planning', ['write_todos', 'update_todo', 'ask_question']],
      ['Memory', ['save_memory', 'get_memory', 'list_memories']],
      ['Scratchpad', ['write_scratchpad', 'read_scratchpad']],
      ['Rules', ['save_rule', 'list_rules']],
      ['Code Analysis', ['analyze_error', 'run_linter', 'run_tests', 'run_formatter']],
      ['Undo', ['undo_edit', 'list_undoable', 'list_checkpoints', 'restore_checkpoint']],
      ['Git', ['git_status', 'git_commit', 'git_diff', 'git_log', 'git_branch', 'git_branch_delete', 'git_push', 'git_stash', 'git_reset']],
      ['System', ['list_processes', 'kill_process', 'get_system_info', 'get_env_var', 'set_env_var', 'ping_host', 'dns_lookup', 'open_terminal']],
      ['Editor', ['switch_file', 'get_diagnostics', 'get_selection', 'read_doc', 'search_docs']],
      ['Image Generation', ['generate_image']],
      ['Browser Extended', ['browser_fill_form', 'browser_select_option', 'browser_evaluate', 'browser_scroll', 'browser_back', 'browser_press_key', 'browser_hover', 'browser_drag', 'browser_get_content', 'browser_get_url', 'browser_get_links', 'browser_tabs', 'browser_handle_dialog', 'browser_console_messages', 'browser_file_upload', 'browser_resize', 'browser_wait', 'browser_wait_for', 'browser_close']],
    ];

    // For minimal mode, build a single part with just core tools
    if (options && options.minimal) {
      const minimalTools = ['read_file', 'write_file', 'edit_file', 'append_to_file', 'list_directory', 'run_command', 'web_search', 'fetch_webpage'];
      let minPart = '';
      for (const name of minimalTools) {
        const tool = toolMap[name];
        if (!tool) continue;
        const params = tool.parameters ? Object.entries(tool.parameters)
          .filter(([, info]) => info.required)
          .map(([n]) => n)
          .join(', ') : '';
        minPart += `- **${name}**(${params}) — ${tool.description}\n`;
      }
      parts.push(minPart);
      return parts;
    }

    // Each category becomes a separate part — agent mode injects all parts (no dropping).
    const listed = new Set();
    for (const [category, names] of categoryOrder) {
      const catTools = names.filter(n => toolMap[n]);
      if (catTools.length === 0) continue;
      for (const name of catTools) listed.add(name);
      let catStr = `### ${category}\n`;
      for (const name of catTools) {
        const tool = toolMap[name];
        catStr += formatCompactToolLine(tool, { compactDescriptions });
      }
      catStr += '\n';
      parts.push(catStr);
    }

    const remaining = Object.values(toolMap).filter((t) => !listed.has(t.name));
    if (remaining.length > 0) {
      let otherStr = '### Other\n';
      for (const tool of remaining) {
        otherStr += formatCompactToolLine(tool, { compactDescriptions });
      }
      otherStr += '\n';
      parts.push(otherStr);
    }

    // Rules section — last priority
    parts.push(getAgentToolCatalogRules({ planning, compact: true }));

    // header + Browser + Core Files + Terminal = tier-0 (always inject in Agent mode)
    parts._tier0PartCount = 4;
    return parts;
  }

  getToolPromptForTask(taskType) {
    if (taskType === 'chat') return '';

    const tools = this.getToolDefinitions();

    const coreTool = new Set(['web_search']);
    const browserTools = new Set([
      'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
      'browser_fill_form', 'browser_select_option', 'browser_get_content',
      'browser_scroll', 'browser_back', 'browser_hover', 'browser_get_url',
      'browser_evaluate', 'browser_screenshot', 'browser_press_key',
      'browser_wait_for', 'browser_tabs', 'browser_handle_dialog',
      'browser_drag', 'browser_console_messages', 'browser_close',
      'browser_file_upload', 'browser_resize', 'browser_get_links',
    ]);
    const codeTools = new Set([
      'read_file', 'write_file', 'edit_file', 'delete_file', 'rename_file',
      'create_directory', 'find_files', 'search_codebase', 'grep_search',
      'run_command', 'list_directory', 'get_project_structure', 'analyze_error',
      'install_packages', 'undo_edit', 'replace_in_files', 'get_file_info',
      'git_status', 'git_commit', 'git_diff', 'git_log', 'git_branch',
    ]);

    let selectedNames;
    if (taskType === 'browser') {
      selectedNames = new Set([...coreTool, ...browserTools]);
    } else if (taskType === 'code') {
      selectedNames = new Set([...coreTool, ...codeTools, 'write_todos', 'update_todo']);
    } else {
      selectedNames = new Set([...coreTool, ...browserTools, ...codeTools,
        'fetch_webpage', 'save_memory', 'get_memory', 'list_memories',
        'write_todos', 'update_todo',
      ]);
    }

    const filtered = tools.filter(t => selectedNames.has(t.name));
    return this._buildToolPrompt(filtered);
  }

  _buildToolPrompt(tools, options = {}) {
    const planning = !!options.planning;
    let prompt = getAgentToolPromptHeader({ planning, compact: false });
    if (this.projectPath) {
      prompt += `Project directory: ${this.projectPath}\nUse relative paths (e.g. "src/main.js") for project files. Absolute paths are allowed for files outside the project when under home, documents, downloads, desktop, or app data (e.g. logs in AppData).\n\n`;
    }

    const categories = {
      'File operations': [
        'read_file', 'write_file', 'edit_file', 'append_to_file', 'delete_file', 'rename_file', 'copy_file',
        'get_file_info', 'list_directory', 'find_files', 'create_directory', 'get_project_structure',
        'open_file_in_editor', 'diff_files', 'undo_edit', 'list_undoable',
      ],
      'Search': ['grep_search', 'search_in_file', 'search_codebase', 'replace_in_files'],
      'Terminal & packages': ['run_command', 'check_port', 'install_packages', 'analyze_error'],
      'Web': ['web_search', 'fetch_webpage', 'http_request'],
      'Browser': [
        'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_fill_form',
        'browser_select_option', 'browser_screenshot', 'browser_get_content', 'browser_evaluate',
        'browser_scroll', 'browser_wait', 'browser_wait_for', 'browser_back', 'browser_press_key',
        'browser_hover', 'browser_drag', 'browser_tabs', 'browser_handle_dialog', 'browser_console_messages',
        'browser_file_upload', 'browser_resize', 'browser_get_url', 'browser_get_links', 'browser_close',
      ],
      'Git': ['git_status', 'git_commit', 'git_diff', 'git_log', 'git_branch', 'git_stash', 'git_reset'],
      'Memory': ['save_memory', 'get_memory', 'list_memories'],
      'Planning & questions': ['write_todos', 'update_todo', 'ask_question'],
      'Scratchpad': ['write_scratchpad', 'read_scratchpad'],
      'Rules': ['save_rule', 'list_rules'],
      'Other': ['generate_image'],
    };

    const toolMap = {};
    for (const tool of tools) toolMap[tool.name] = tool;

    for (const [category, names] of Object.entries(categories)) {
      const catTools = names.filter(n => toolMap[n]);
      if (catTools.length === 0) continue;
      prompt += `### ${category}\n`;
      for (const name of catTools) {
        const tool = toolMap[name];
        const params = tool.parameters ? Object.entries(tool.parameters)
          .map(([n, i]) => `${n}:${i.type}${i.required ? '*' : ''}`)
          .join(', ') : '';
        prompt += `**${name}**(${params}) — ${tool.description}\n`;
        delete toolMap[name];
      }
      prompt += '\n';
    }

    const remaining = Object.values(toolMap);
    if (remaining.length > 0) {
      prompt += '### Other\n';
      for (const tool of remaining) {
        const params = tool.parameters ? Object.entries(tool.parameters)
          .map(([n, i]) => `${n}:${i.type}${i.required ? '*' : ''}`)
          .join(', ') : '';
        prompt += `**${tool.name}**(${params}) — ${tool.description}\n`;
      }
      prompt += '\n';
    }

    if (planning) {
      prompt += getAgentToolCatalogRules({ planning: true, compact: false });
    } else {
      prompt += getAgentToolCatalogRules({ planning: false, compact: false });
    }
    return prompt;
  }

  getHistory() {
    return this.toolHistory;
  }
}

// Mix in extracted tool methods onto the prototype
Object.assign(MCPToolServer.prototype, mcpBrowserTools);
Object.assign(MCPToolServer.prototype, mcpGitTools);

module.exports = { MCPToolServer };


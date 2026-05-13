# Server vs Electron Line-Level Runtime Differences

Generated: 2026-05-03T10:17:21.905Z

Workspace files scanned: 36480

Server runtime closure files: 30

Electron runtime closure files: 30

Shared runtime files: 27

Server-only runtime files: 3

Electron-only runtime files: 3

## Primary Pair Diff
Full unified diff is in `server-vs-electron-main.diff`.
## Server-Only Runtime Files (line-by-line)

### server/ipcBridge.js (lines: 215)

```diff
-    1 | /**
-    2 |  * IPC Bridge — Replaces Electron's ipcMain and BrowserWindow for non-Electron environments.
-    3 |  *
-    4 |  * The existing pipeline code (agenticChat.js, streamHandler.js, mcpToolServer.js, etc.)
-    5 |  * was written for Electron and calls:
-    6 |  *   - ipcMain.handle(channel, handler)  — to register request handlers
-    7 |  *   - mainWindow.webContents.send(event, data)  — to push events to the frontend
-    8 |  *   - mainWindow.isDestroyed()  — to check if the window is still alive
-    9 |  *
-   10 |  * This module provides drop-in replacements that route everything over WebSocket.
-   11 |  * The pipeline code does not need to know it's not running in Electron.
-   12 |  *
-   13 |  * Architecture:
-   14 |  *   Frontend → WebSocket message {type:'invoke', channel, args} → ipcBridge
-   15 |  *   ipcBridge calls the registered handler → returns result via WebSocket
-   16 |  *   Pipeline calls mainWindow.webContents.send(event, data) → ipcBridge
-   17 |  *   ipcBridge sends {type:'event', event, data} over WebSocket → Frontend
-   18 |  */
-   19 | 'use strict';
-   20 | 
-   21 | const { EventEmitter } = require('events');
-   22 | 
-   23 | /**
-   24 |  * Fake ipcMain — drop-in replacement for Electron's ipcMain.
-   25 |  * Stores handler functions registered by agenticChat.js and other modules.
-   26 |  * When a WebSocket message arrives with type:'invoke', the corresponding handler is called.
-   27 |  */
-   28 | class IpcMainBridge extends EventEmitter {
-   29 |   constructor() {
-   30 |     super();
-   31 |     this._handlers = new Map();    // channel → async handler(event, ...args)
-   32 |     this._onListeners = new Map(); // channel → [handler, ...]
-   33 |   }
-   34 | 
-   35 |   /**
-   36 |    * Register a handler for an IPC channel (replaces ipcMain.handle).
-   37 |    * The handler receives (event, ...args) and returns a result.
-   38 |    */
-   39 |   handle(channel, handler) {
-   40 |     this._handlers.set(channel, handler);
-   41 |   }
-   42 | 
-   43 |   /**
-   44 |    * Remove a handler (replaces ipcMain.removeHandler).
-   45 |    */
-   46 |   removeHandler(channel) {
-   47 |     this._handlers.delete(channel);
-   48 |   }
-   49 | 
-   50 |   /**
-   51 |    * Register a listener for an IPC channel (replaces ipcMain.on).
-   52 |    */
-   53 |   on(channel, handler) {
-   54 |     if (!this._onListeners.has(channel)) {
-   55 |       this._onListeners.set(channel, []);
-   56 |     }
-   57 |     this._onListeners.get(channel).push(handler);
-   58 |     return this;
-   59 |   }
-   60 | 
-   61 |   /**
-   62 |    * Invoke a registered handler. Called when a WebSocket message arrives.
-   63 |    * @param {string} channel — The IPC channel name (e.g. 'ai-chat')
-   64 |    * @param  {...any} args — Arguments from the frontend
-   65 |    * @returns {Promise<any>} — The handler's return value
-   66 |    */
-   67 |   async invoke(channel, ...args) {
-   68 |     const handler = this._handlers.get(channel);
-   69 |     if (!handler) {
-   70 |       throw new Error(`No handler registered for IPC channel: ${channel}`);
-   71 |     }
-   72 |     // Create a fake event object (Electron passes this as the first arg)
-   73 |     const fakeEvent = { sender: null, returnValue: undefined };
-   74 |     return handler(fakeEvent, ...args);
-   75 |   }
-   76 | 
-   77 |   /**
-   78 |    * Emit to on() listeners. Called for fire-and-forget messages.
-   79 |    */
-   80 |   send(channel, ...args) {
-   81 |     const listeners = this._onListeners.get(channel);
-   82 |     if (listeners) {
-   83 |       const fakeEvent = { sender: null };
-   84 |       for (const handler of listeners) {
-   85 |         try { handler(fakeEvent, ...args); } catch (e) {
-   86 |           console.error(`[IpcBridge] Error in on('${channel}') listener:`, e.message);
-   87 |         }
-   88 |       }
-   89 |     }
-   90 |   }
-   91 | }
-   92 | 
-   93 | /**
-   94 |  * Fake BrowserWindow.webContents — drop-in replacement for Electron's mainWindow.
-   95 |  *
-   96 |  * The pipeline calls mainWindow.webContents.send(event, data) to push streaming
-   97 |  * tokens, tool progress, context usage, and other events to the frontend.
-   98 |  * This replacement routes those calls over WebSocket.
-   99 |  */
-  100 | class MainWindowBridge {
-  101 |   constructor() {
-  102 |     this._destroyed = false;
-  103 |     this._wsSender = null; // Set by transport when a client connects
-  104 |     this._hasEverConnected = false; // Suppress warnings before first client connects
-  105 |     this.webContents = {
-  106 |       send: (event, data) => {
-  107 |         if (this._destroyed) return;
-  108 |         this._sendToFrontend(event, data);
-  109 |       },
-  110 |       isDestroyed: () => this._destroyed,
-  111 |     };
-  112 |   }
-  113 | 
-  114 |   /**
-  115 |    * Set the WebSocket sender function.
-  116 |    * Called by the transport layer when a client connects.
-  117 |    * @param {Function} sender — (event, data) => void
-  118 |    */
-  119 |   setSender(sender) {
-  120 |     this._wsSender = sender;
-  121 |     this._destroyed = false;
-  122 |     this._hasEverConnected = true;
-  123 |   }
-  124 | 
-  125 |   /**
-  126 |    * Clear the sender (client disconnected).
-  127 |    */
-  128 |   clearSender() {
-  129 |     this._wsSender = null;
-  130 |   }
-  131 | 
-  132 |   /**
-  133 |    * Check if the window is destroyed (client disconnected).
-  134 |    */
-  135 |   isDestroyed() {
-  136 |     return this._destroyed || !this._wsSender;
-  137 |   }
-  138 | 
-  139 |   /**
-  140 |    * Internal: send an event to the frontend via WebSocket.
-  141 |    */
-  142 |   _sendToFrontend(event, data) {
-  143 |     if (!this._wsSender) {
-  144 |       // Only warn if we previously had a connection (lost connection = real problem).
-  145 |       // Before first connection, this is expected (model auto-load fires before WebSocket connects).
-  146 |       if (this._hasEverConnected && event !== 'llm-token' && event !== 'llm-thinking-token' && event !== 'context-usage') {
-  147 |         console.warn(`[MainWindowBridge] _sendToFrontend: no sender for event '${event}' — dropped`);
-  148 |       }
-  149 |       return;
-  150 |     }
-  151 |     try {
-  152 |       this._wsSender(event, data);
-  153 |     } catch (e) {
-  154 |       // WebSocket may be closed — don't crash the pipeline
-  155 |       if (e.message?.includes('CLOSED') || e.message?.includes('not open')) {
-  156 |         this._wsSender = null;
-  157 |       }
-  158 |     }
-  159 |   }
-  160 | 
-  161 |   /**
-  162 |    * Destroy the window bridge (cleanup).
-  163 |    */
-  164 |   destroy() {
-  165 |     this._destroyed = true;
-  166 |     this._wsSender = null;
-  167 |   }
-  168 | }
-  169 | 
-  170 | /**
-  171 |  * Fake Electron app module — provides getPath() for pathValidator.js and other modules.
-  172 |  * Returns OS-appropriate paths without requiring Electron.
-  173 |  */
-  174 | function createAppBridge(userDataPath) {
-  175 |   const os = require('os');
-  176 |   const path = require('path');
-  177 | 
-  178 |   const homedir = os.homedir();
-  179 |   const appData = process.env.APPDATA || path.join(homedir, '.config');
-  180 |   const userData = userDataPath || path.join(appData, 'guide-ide');
-  181 |   const documents = path.join(homedir, 'Documents');
-  182 |   const desktop = path.join(homedir, 'Desktop');
-  183 |   const downloads = path.join(homedir, 'Downloads');
-  184 |   const temp = os.tmpdir();
-  185 | 
-  186 |   const pathMap = {
-  187 |     home: homedir,
-  188 |     appData: appData,
-  189 |     userData: userData,
-  190 |     documents: documents,
-  191 |     desktop: desktop,
-  192 |     downloads: downloads,
-  193 |     temp: temp,
-  194 |     logs: path.join(userData, 'logs'),
-  195 |     crashDumps: path.join(userData, 'crashes'),
-  196 |   };
-  197 | 
-  198 |   return {
-  199 |     getPath: (name) => {
-  200 |       const p = pathMap[name];
-  201 |       if (!p) {
-  202 |         console.warn(`[AppBridge] Unknown path name: ${name}, returning userData`);
-  203 |         return userData;
-  204 |       }
-  205 |       return p;
-  206 |     },
-  207 |     getName: () => 'guide-ide',
-  208 |     getVersion: () => '2.0.0',
-  209 |     isPackaged: false,
-  210 |     quit: () => process.exit(0),
-  211 |   };
-  212 | }
-  213 | 
-  214 | module.exports = { IpcMainBridge, MainWindowBridge, createAppBridge };
-  215 | 
```

### server/main.js (lines: 1590)

```diff
-    1 | /**
-    2 |  * guIDE 3.0 — Main Server Entry Point
-    3 |  *
-    4 |  * Starts the Node.js backend.
-    5 |  * Provides:
-    6 |  *   1. HTTP server serving the frontend static files
-    7 |  *   2. WebSocket server for real-time streaming (tokens, events, tool progress)
-    8 |  *   3. REST API for model management, file operations, settings
-    9 |  *   4. Basic model chat via ChatEngine
-   10 |  *
-   11 |  * This server runs in two modes:
-   12 |  *   - Standalone: accessed via browser at http://localhost:PORT
-   13 |  *   - Tauri sidecar: launched by the Rust desktop app, communicates over the same WebSocket
-   14 |  *
-   15 |  * Usage:
-   16 |  *   node server/main.js [--port PORT] [--dev]
-   17 |  */
-   18 | 'use strict';
-   19 | 
-   20 | const http = require('http');
-   21 | const path = require('path');
-   22 | const fs = require('fs');
-   23 | const os = require('os');
-   24 | const express = require('express');
-   25 | const cors = require('cors');
-   26 | const prettier = require('prettier');
-   27 | 
-   28 | const { IpcMainBridge, MainWindowBridge, createAppBridge } = require('./ipcBridge');
-   29 | const { Transport } = require('./transport');
-   30 | 
-   31 | // ─── Parse CLI args ──────────────────────────────────────
-   32 | const args = process.argv.slice(2);
-   33 | const isDev = args.includes('--dev');
-   34 | const portArg = args.find((a, i) => args[i - 1] === '--port');
-   35 | const PORT = parseInt(portArg, 10) || parseInt(process.env.GUIDE_PORT, 10) || 3000;
-   36 | 
-   37 | // ─── Paths ───────────────────────────────────────────────
-   38 | const ROOT_DIR = path.resolve(__dirname, '..');
-   39 | const FRONTEND_DIST = path.join(ROOT_DIR, 'frontend', 'dist');
-   40 | const MODELS_DIR = path.join(ROOT_DIR, 'models');
-   41 | const USER_DATA = process.env.APPDATA
-   42 |   ? path.join(process.env.APPDATA, 'guide-ide')
-   43 |   : path.join(os.homedir(), '.config', 'guide-ide');
-   44 | 
-   45 | // Ensure critical directories exist
-   46 | for (const dir of [MODELS_DIR, USER_DATA, path.join(USER_DATA, 'sessions'), path.join(USER_DATA, 'logs')]) {
-   47 |   try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
-   48 | }
-   49 | 
-   50 | // ─── Install Electron shims BEFORE loading modules ──
-   51 | // Some modules do require('electron') — we intercept with bridges.
-   52 | // We intercept this with a Module wrapper that returns our bridges.
-   53 | const ipcMain = new IpcMainBridge();
-   54 | const mainWindow = new MainWindowBridge();
-   55 | const appBridge = createAppBridge(USER_DATA);
-   56 | 
-   57 | // Shim the 'electron' module so require('electron') returns our bridges
-   58 | const Module = require('module');
-   59 | const originalResolveFilename = Module._resolveFilename;
-   60 | Module._resolveFilename = function (request, parent, isMain, options) {
-   61 |   if (request === 'electron') {
-   62 |     // Return a path to our shim module
-   63 |     return path.join(__dirname, '_electronShim.js');
-   64 |   }
-   65 |   return originalResolveFilename.call(this, request, parent, isMain, options);
-   66 | };
-   67 | 
-   68 | // Electron shim — static file included in the package (server/_electronShim.js)
-   69 | const shimPath = path.join(__dirname, '_electronShim.js');
-   70 | 
-   71 | // Set up globals so the static shim file can reference them
-   72 | global.__guideIpcMain = ipcMain;
-   73 | global.__guideMainWindow = mainWindow;
-   74 | global.__guideApp = appBridge;
-   75 | 
-   76 | // ─── Now load modules (they will get our Electron shim) ──
-   77 | console.log('[Server] Loading modules...');
-   78 | 
-   79 | const log = require(path.join(ROOT_DIR, 'logger'));
-   80 | log.installConsoleIntercepts();
-   81 | 
-   82 | const { ChatEngine, buildEngineLoadSettings } = require(path.join(ROOT_DIR, 'chatEngine'));
-   83 | const { MCPToolServer } = require(path.join(ROOT_DIR, 'mcpToolServer'));
-   84 | const { ModelManager } = require(path.join(ROOT_DIR, 'modelManager'));
-   85 | const { MemoryStore } = require(path.join(ROOT_DIR, 'memoryStore'));
-   86 | const { LongTermMemory } = require(path.join(ROOT_DIR, 'longTermMemory'));
-   87 | const { SessionStore } = require(path.join(ROOT_DIR, 'sessionStore'));
-   88 | const { CloudLLMService } = require(path.join(ROOT_DIR, 'cloudLLMService'));
-   89 | const { SettingsManager } = require(path.join(ROOT_DIR, 'settingsManager'));
-   90 | const { GitManager } = require(path.join(ROOT_DIR, 'gitManager'));
-   91 | const { BrowserManager } = require(path.join(ROOT_DIR, 'browserManager'));
-   92 | const { FirstRunSetup } = require(path.join(ROOT_DIR, 'firstRunSetup'));
-   93 | const { AutoUpdater } = require(path.join(ROOT_DIR, 'autoUpdater'));
-   94 | const { RAGEngine } = require(path.join(ROOT_DIR, 'ragEngine'));
-   95 | const { AccountManager } = require(path.join(ROOT_DIR, 'accountManager'));
-   96 | const { LicenseManager } = require(path.join(ROOT_DIR, 'licenseManager'));
-   97 | const { ExtensionManager } = require(path.join(ROOT_DIR, 'extensionManager'));
-   98 | const { DebugService } = require(path.join(ROOT_DIR, 'debugService'));
-   99 | const { ModelDownloader } = require(path.join(__dirname, 'modelDownloader'));
-  100 | const liveServer = require(path.join(__dirname, 'liveServer'));
-  101 | 
-  102 | // ─── Initialize pipeline components ──────────────────────
-  103 | console.log('[Server] Initializing pipeline components...');
-  104 | 
-  105 | const llmEngine = new ChatEngine();
-  106 | const WebSearch = require(path.join(ROOT_DIR, 'webSearch'));
-  107 | const webSearch = new WebSearch();
-  108 | const mcpToolServer = new MCPToolServer({ projectPath: null, webSearch });
-  109 | 
-  110 | // Set default disabled tools — only core tools enabled by default
-  111 | {
-  112 |   const allDefs = mcpToolServer.getAllToolDefinitions();
-  113 |   const defaultDisabled = allDefs
-  114 |     .map(t => t.name)
-  115 |     .filter(name => !ChatEngine.DEFAULT_ENABLED_TOOLS.has(name));
-  116 |   mcpToolServer.setDisabledTools(defaultDisabled);
-  117 |   console.log(`[Server] Tools: ${ChatEngine.DEFAULT_ENABLED_TOOLS.size} enabled, ${defaultDisabled.length} disabled by default`);
-  118 | }
-  119 | 
-  120 | const gitManager = new GitManager();
-  121 | mcpToolServer.setGitManager(gitManager);
-  122 | 
-  123 | const memoryStore = new MemoryStore();
-  124 | const longTermMemory = new LongTermMemory();
-  125 | const modelManager = new ModelManager(ROOT_DIR);
-  126 | const sessionStore = new SessionStore(path.join(USER_DATA, 'sessions'));
-  127 | const cloudLLM = new CloudLLMService();
-  128 | const modelDownloader = new ModelDownloader(path.join(ROOT_DIR, 'models'));
-  129 | const ragEngine = new RAGEngine();
-  130 | const browserManager = new BrowserManager({ liveServer, parentWindow: mainWindow });
-  131 | // Wire the real BrowserManager instance so browser tools have .navigate() and .parentWindow
-  132 | mcpToolServer.setBrowserManager(browserManager);
-  133 | // Forward todo updates to the frontend over WebSocket (mirrors electron-main.js)
-  134 | mcpToolServer.onTodoUpdate = (todos) => mainWindow.webContents.send('todo-update', todos);
-  135 | 
-  136 | // Settings persistence — SettingsManager handles settings.json + encrypted API keys
-  137 | const settingsManager = new SettingsManager(USER_DATA);
-  138 | 
-  139 | // Restore persisted API keys into cloudLLM on startup
-  140 | const savedKeys = settingsManager.getAllApiKeys();
-  141 | for (const [provider, key] of Object.entries(savedKeys)) {
-  142 |   if (key && key.trim()) {
-  143 |     cloudLLM.setApiKey(provider, key);
-  144 |     console.log(`[Server] Restored API key for ${provider}`);
-  145 |   }
-  146 | }
-  147 | 
-  148 | const firstRunSetup = new FirstRunSetup(settingsManager);
-  149 | 
-  150 | // Auto-updater (fallback when not running in Electron)
-  151 | const autoUpdater = new AutoUpdater(mainWindow, { autoDownload: false });
-  152 | 
-  153 | // Account/Auth manager
-  154 | const accountManager = new AccountManager(settingsManager);
-  155 | 
-  156 | // License manager — validates licenses, handles Stripe checkout
-  157 | const licenseManager = new LicenseManager(settingsManager, accountManager);
-  158 | 
-  159 | // Extension manager — community extension install, enable, disable
-  160 | const extensionManager = new ExtensionManager(USER_DATA);
-  161 | extensionManager.initialize().catch(err => console.error('[Server] Extension init error:', err.message));
-  162 | 
-  163 | // Debug service — manages debug sessions (Node.js/Python)
-  164 | const debugService = new DebugService();
-  165 | 
-  166 | let currentSettings = settingsManager.getAll();
-  167 | 
-  168 | const ctx = {
-  169 |   llmEngine,
-  170 |   mcpToolServer,
-  171 |   memoryStore,
-  172 |   longTermMemory,
-  173 |   modelManager,
-  174 |   sessionStore,
-  175 |   userDataPath: USER_DATA,
-  176 |   currentProjectPath: null,
-  177 |   agenticCancelled: false,
-  178 | 
-  179 |   getMainWindow: () => mainWindow,
-  180 | 
-  181 |   cloudLLM,
-  182 | 
-  183 |   // Browser — manages live preview + Playwright (if installed)
-  184 |   playwrightBrowser: null,
-  185 |   browserManager,
-  186 | 
-  187 |   // RAG engine — BM25 codebase search
-  188 |   ragEngine,
-  189 | 
-  190 |   // Web search — DuckDuckGo HTML scraping, no API key required
-  191 |   webSearch,
-  192 | 
-  193 |   // License/account — local-first, account optional for cloud features
-  194 |   licenseManager,
-  195 | 
-  196 |   _truncateResult: (result) => {
-  197 |     if (!result) return result;
-  198 |     const str = typeof result === 'string' ? result : JSON.stringify(result);
-  199 |     return str.length > 8000 ? str.substring(0, 8000) + '...[truncated]' : result;
-  200 |   },
-  201 | 
-  202 |   _readConfig: () => currentSettings,
-  203 | };
-  204 | 
-  205 | // Wire license manager into cloud service
-  206 | cloudLLM.setLicenseManager(ctx.licenseManager);
-  207 | 
-  208 | // Register the ai-chat handler for basic model chat
-  209 | ipcMain.handle('ai-chat', async (_event, userMessage, chatContext) => {
-  210 |   if (!llmEngine.isReady) {
-  211 |     return { error: 'No model loaded. Please load a model first.' };
-  212 |   }
-  213 |   try {
-  214 |     ctx.agenticCancelled = false;
-  215 |     const settings = chatContext?.params || chatContext?.settings || {};
-  216 | 
-  217 |     // Build tool functions from enabled tool definitions
-  218 |     const toolDefs = mcpToolServer.getToolDefinitions();
-  219 |     const functions = ChatEngine.convertToolDefs(toolDefs);
-  220 |     const toolPrompt = mcpToolServer.getToolPrompt();
-  221 | 
-  222 |     console.log(`[Chat] User: ${String(userMessage).slice(0, 300)}`);
-  223 |     const result = await llmEngine.chat(userMessage, {
-  224 |       onToken: (token) => {
-  225 |         mainWindow.webContents.send('llm-token', token);
-  226 |       },
-  227 |       onContextUsage: (data) => {
-  228 |         mainWindow.webContents.send('context-usage', data);
-  229 |       },
-  230 |       onToolCall: (data) => {
-  231 |         mainWindow.webContents.send('tool-call', data);
-  232 |       },
-  233 |       onStreamEvent: (eventName, data) => {
-  234 |         mainWindow.webContents.send(eventName, data);
-  235 |       },
-  236 |       attachments: Array.isArray(chatContext?.attachments) ? chatContext.attachments : [],
-  237 |       functions,
-  238 |       toolPrompt,
-  239 |       executeToolFn: async (toolName, params) => {
-  240 |         return await mcpToolServer.executeTool(toolName, params);
-  241 |       },
-  242 |       systemPrompt: settings.systemPrompt || undefined,
-  243 |       temperature: settings.temperature,
-  244 |       maxTokens: settings.maxTokens || -1,
-  245 |       topP: settings.topP,
-  246 |       topK: settings.topK,
-  247 |       repeatPenalty: settings.repeatPenalty,
-  248 |     });
-  249 |     return { text: result.text, toolCallCount: result.toolCallCount };
-  250 |   } catch (err) {
-  251 |     return { error: err.message };
-  252 |   }
-  253 | });
-  254 | 
-  255 | ipcMain.handle('cancel-generation', async () => {
-  256 |   llmEngine.cancelGeneration('user');
-  257 |   try { mcpToolServer.killActiveChildren('user-cancel'); } catch (_) {}
-  258 |   return { success: true };
-  259 | });
-  260 | 
-  261 | // Alias: the frontend Stop button invokes 'agent-pause'. Route to the same
-  262 | // cancellation path so generation stops immediately.
-  263 | ipcMain.handle('agent-pause', async () => {
-  264 |   llmEngine.cancelGeneration('user');
-  265 |   try { mcpToolServer.killActiveChildren('user-cancel'); } catch (_) {}
-  266 |   return { success: true };
-  267 | });
-  268 | 
-  269 | async function openProjectPath(projectPath) {
-  270 |   const resolved = path.resolve(projectPath);
-  271 |   if (!fs.existsSync(resolved)) {
-  272 |     const error = new Error('Directory not found');
-  273 |     error.statusCode = 404;
-  274 |     throw error;
-  275 |   }
-  276 | 
-  277 |   ctx.currentProjectPath = resolved;
-  278 |   mcpToolServer.projectPath = resolved;
-  279 |   gitManager.setProjectPath(resolved);
-  280 |   memoryStore.initialize(resolved);
-  281 |   longTermMemory.initialize(resolved);
-  282 |   ragEngine.indexProject(resolved).catch(e => console.warn('[Server] RAG indexing failed:', e.message));
-  283 |   mainWindow.webContents.send('project-opened', { path: resolved });
-  284 | 
-  285 |   return { path: resolved };
-  286 | }
-  287 | 
-  288 | // ─── Express HTTP Server ─────────────────────────────────
-  289 | const app = express();
-  290 | app.use(cors());
-  291 | app.use(express.json({ limit: '50mb' }));
-  292 | 
-  293 | // ─── Project Templates ───────────────────────────────────
-  294 | const { register: registerTemplates } = require(path.join(__dirname, 'templateHandlers'));
-  295 | registerTemplates(app, { openProjectPath });
-  296 | 
-  297 | // ─── Module Routes (firstRun, autoUpdater, account, license) ──
-  298 | firstRunSetup.registerRoutes(app);
-  299 | autoUpdater.registerRoutes(app);
-  300 | accountManager.registerRoutes(app);
-  301 | licenseManager.registerRoutes(app);
-  302 | 
-  303 | // ─── REST API Routes ─────────────────────────────────────
-  304 | 
-  305 | // Model management
-  306 | app.get('/api/models', async (req, res) => {
-  307 |   try {
-  308 |     const models = modelManager.availableModels;
-  309 |     const status = llmEngine.getStatus();
-  310 |     res.json({ models, status });
-  311 |   } catch (e) {
-  312 |     res.status(500).json({ error: e.message });
-  313 |   }
-  314 | });
-  315 | 
-  316 | app.post('/api/models/load', async (req, res) => {
-  317 |   const { modelPath } = req.body;
-  318 |   if (!modelPath) return res.status(400).json({ error: 'modelPath required' });
-  319 |   try {
-  320 |     try { llmEngine.cancelGeneration('model-load'); } catch (_) {}
-  321 |     // Send loading status to connected clients
-  322 |     mainWindow.webContents.send('model-loading', { path: modelPath });
-  323 |     await llmEngine.initialize(modelPath, buildEngineLoadSettings(settingsManager.getAll()));
-  324 |     const info = llmEngine.modelInfo;
-  325 |     // Persist last-used model so it auto-loads on next startup
-  326 |     settingsManager.set('lastModelPath', modelPath);
-  327 |     mainWindow.webContents.send('model-loaded', info);
-  328 |     res.json({ success: true, modelInfo: info });
-  329 |   } catch (e) {
-  330 |     mainWindow.webContents.send('model-error', { error: e.message });
-  331 |     res.status(500).json({ error: e.message });
-  332 |   }
-  333 | });
-  334 | 
-  335 | app.post('/api/models/unload', async (req, res) => {
-  336 |   try {
-  337 |     await llmEngine.dispose();
-  338 |     res.json({ success: true });
-  339 |   } catch (e) {
-  340 |     res.status(500).json({ error: e.message });
-  341 |   }
-  342 | });
-  343 | 
-  344 | app.get('/api/models/status', (req, res) => {
-  345 |   res.json(llmEngine.getStatus());
-  346 | });
-  347 | 
-  348 | app.post('/api/models/scan', async (req, res) => {
-  349 |   try {
-  350 |     const models = await modelManager.scanModels();
-  351 |     res.json({ models });
-  352 |   } catch (e) {
-  353 |     res.status(500).json({ error: e.message });
-  354 |   }
-  355 | });
-  356 | 
-  357 | app.post('/api/models/add', async (req, res) => {
-  358 |   const { filePaths } = req.body;
-  359 |   if (!filePaths || !Array.isArray(filePaths)) return res.status(400).json({ error: 'filePaths array required' });
-  360 |   try {
-  361 |     const added = await modelManager.addModels(filePaths);
-  362 |     res.json({ added });
-  363 |   } catch (e) {
-  364 |     res.status(500).json({ error: e.message });
-  365 |   }
-  366 | });
-  367 | 
-  368 | // Upload GGUF model files (browser fallback when Electron dialog unavailable)
-  369 | app.post('/api/models/upload', async (req, res) => {
-  370 |   const contentType = req.headers['content-type'] || '';
-  371 |   if (!contentType.includes('multipart/form-data')) {
-  372 |     return res.status(400).json({ error: 'multipart/form-data required' });
-  373 |   }
-  374 |   const boundaryMatch = contentType.match(/boundary=(.+)/);
-  375 |   if (!boundaryMatch) return res.status(400).json({ error: 'Missing boundary' });
-  376 |   const boundary = boundaryMatch[1];
-  377 | 
-  378 |   try {
-  379 |     const chunks = [];
-  380 |     for await (const chunk of req) chunks.push(chunk);
-  381 |     const buffer = Buffer.concat(chunks);
-  382 |     const sep = Buffer.from(`--${boundary}`);
-  383 |     const parts = [];
-  384 |     let start = 0;
-  385 |     while (true) {
-  386 |       const idx = buffer.indexOf(sep, start);
-  387 |       if (idx === -1) break;
-  388 |       if (start > 0) parts.push(buffer.slice(start, idx));
-  389 |       start = idx + sep.length;
-  390 |       // Skip CRLF after boundary
-  391 |       if (buffer[start] === 0x0D && buffer[start + 1] === 0x0A) start += 2;
-  392 |     }
-  393 | 
-  394 |     const saved = [];
-  395 |     const fsP = require('fs').promises;
-  396 |     for (const part of parts) {
-  397 |       const headerEnd = part.indexOf('\r\n\r\n');
-  398 |       if (headerEnd === -1) continue;
-  399 |       const headers = part.slice(0, headerEnd).toString('utf8');
-  400 |       const filenameMatch = headers.match(/filename="([^"]+)"/);
-  401 |       if (!filenameMatch) continue;
-  402 |       const filename = path.basename(filenameMatch[1]); // sanitize
-  403 |       if (!filename.endsWith('.gguf')) continue;
-  404 |       // Strip trailing CRLF
-  405 |       let body = part.slice(headerEnd + 4);
-  406 |       if (body[body.length - 2] === 0x0D && body[body.length - 1] === 0x0A) {
-  407 |         body = body.slice(0, -2);
-  408 |       }
-  409 |       const destPath = path.join(modelManager.modelsDir, filename);
-  410 |       await fsP.writeFile(destPath, body);
-  411 |       saved.push(filename);
-  412 |     }
-  413 | 
-  414 |     if (saved.length === 0) return res.status(400).json({ error: 'No .gguf files found in upload' });
-  415 |     await modelManager.scanModels();
-  416 |     res.json({ success: true, saved });
-  417 |   } catch (e) {
-  418 |     res.status(500).json({ error: e.message });
-  419 |   }
-  420 | });
-  421 | 
-  422 | // GPU info + system resources
-  423 | app.get('/api/gpu', async (req, res) => {
-  424 |   try {
-  425 |     const info = await llmEngine.getGPUInfo();
-  426 |     // Add CPU/RAM info
-  427 |     const totalMem = os.totalmem();
-  428 |     const freeMem = os.freemem();
-  429 |     const usedMem = totalMem - freeMem;
-  430 |     info.ramTotalGB = (totalMem / (1024 ** 3)).toFixed(1);
-  431 |     info.ramUsedGB = (usedMem / (1024 ** 3)).toFixed(1);
-  432 |     // CPU usage: average across cores (idle vs total)
-  433 |     const cpus = os.cpus();
-  434 |     let totalIdle = 0, totalTick = 0;
-  435 |     for (const cpu of cpus) {
-  436 |       for (const type in cpu.times) totalTick += cpu.times[type];
-  437 |       totalIdle += cpu.times.idle;
-  438 |     }
-  439 |     info.cpuUsage = Math.round(100 - (totalIdle / totalTick * 100));
-  440 |     if (llmEngine.modelInfo) {
-  441 |       if (typeof llmEngine.modelInfo.gpuLayers === 'number') info.gpuLayers = llmEngine.modelInfo.gpuLayers;
-  442 |       if (typeof llmEngine.modelInfo.contextSize === 'number') info.modelContextSize = llmEngine.modelInfo.contextSize;
-  443 |       if (typeof llmEngine.modelInfo.totalLayers === 'number') info.totalLayers = llmEngine.modelInfo.totalLayers;
-  444 |     }
-  445 |     res.json(info);
-  446 |   } catch (e) {
-  447 |     res.status(500).json({ error: e.message });
-  448 |   }
-  449 | });
-  450 | 
-  451 | // Project management
-  452 | app.post('/api/project/open', (req, res) => {
-  453 |   const { projectPath } = req.body;
-  454 |   if (!projectPath) return res.status(400).json({ error: 'projectPath required' });
-  455 |   try {
-  456 |     openProjectPath(projectPath)
-  457 |       .then(({ path: resolved }) => res.json({ success: true, path: resolved }))
-  458 |       .catch((e) => {
-  459 |         res.status(e.statusCode || 500).json({ error: e.message });
-  460 |       });
-  461 |   } catch (e) {
-  462 |     res.status(500).json({ error: e.message });
-  463 |   }
-  464 | });
-  465 | 
-  466 | app.get('/api/project/current', (req, res) => {
-  467 |   res.json({ projectPath: ctx.currentProjectPath });
-  468 | });
-  469 | 
-  470 | app.get('/api/system/homedir', (req, res) => {
-  471 |   res.json({ homedir: os.homedir() });
-  472 | });
-  473 | 
-  474 | // File operations (for the file explorer)
-  475 | app.get('/api/files/tree', async (req, res) => {
-  476 |   const dirPath = req.query.path || ctx.currentProjectPath;
-  477 |   if (!dirPath) return res.json({ items: [] });
-  478 |   try {
-  479 |     const items = await _readDirRecursive(dirPath, 0, 3);
-  480 |     res.json({ items, root: dirPath });
-  481 |   } catch (e) {
-  482 |     res.status(500).json({ error: e.message });
-  483 |   }
-  484 | });
-  485 | 
-  486 | app.get('/api/files/read', async (req, res) => {
-  487 |   const filePath = req.query.path;
-  488 |   if (!filePath) return res.status(400).json({ error: 'path required' });
-  489 |   try {
-  490 |     const fullPath = path.isAbsolute(filePath) ? filePath : path.join(ctx.currentProjectPath || '', filePath);
-  491 |     const content = fs.readFileSync(fullPath, 'utf8');
-  492 |     const ext = path.extname(fullPath).slice(1);
-  493 |     res.json({ content, path: fullPath, extension: ext, name: path.basename(fullPath) });
-  494 |   } catch (e) {
-  495 |     res.status(500).json({ error: e.message });
-  496 |   }
-  497 | });
-  498 | 
-  499 | app.post('/api/files/write', async (req, res) => {
-  500 |   const { filePath, content } = req.body;
-  501 |   if (!filePath) return res.status(400).json({ error: 'filePath required' });
-  502 |   try {
-  503 |     const fullPath = path.isAbsolute(filePath) ? filePath : path.join(ctx.currentProjectPath || '', filePath);
-  504 |     fs.mkdirSync(path.dirname(fullPath), { recursive: true });
-  505 |     fs.writeFileSync(fullPath, content || '', 'utf8');
-  506 |     res.json({ success: true, path: fullPath });
-  507 |   } catch (e) {
-  508 |     res.status(500).json({ error: e.message });
-  509 |   }
-  510 | });
-  511 | 
-  512 | // Settings
-  513 | app.get('/api/settings', (req, res) => {
-  514 |   res.json(settingsManager.getAll());
-  515 | });
-  516 | 
-  517 | app.post('/api/settings', (req, res) => {
-  518 |   settingsManager.setAll(req.body);
-  519 |   currentSettings = settingsManager.getAll();
-  520 |   res.json({ success: true });
-  521 | });
-  522 | 
-  523 | // ─── Cloud LLM API Routes ────────────────────────────────
-  524 | 
-  525 | app.get('/api/cloud/status', (req, res) => {
-  526 |   res.json(cloudLLM.getStatus());
-  527 | });
-  528 | 
-  529 | app.get('/api/cloud/providers', (req, res) => {
-  530 |   res.json({
-  531 |     configured: cloudLLM.getConfiguredProviders(),
-  532 |     all: cloudLLM.getAllProviders(),
-  533 |   });
-  534 | });
-  535 | 
-  536 | app.get('/api/cloud/models/:provider', async (req, res) => {
-  537 |   const { provider } = req.params;
-  538 |   if (provider === 'openrouter') {
-  539 |     try {
-  540 |       const models = await cloudLLM.fetchOpenRouterModels();
-  541 |       res.json({ models });
-  542 |     } catch (e) {
-  543 |       res.status(500).json({ error: e.message });
-  544 |     }
-  545 |   } else if (provider === 'ollama') {
-  546 |     await cloudLLM.detectOllama();
-  547 |     res.json({ models: cloudLLM.getOllamaModels() });
-  548 |   } else {
-  549 |     res.json({ models: cloudLLM._getProviderModels(provider) });
-  550 |   }
-  551 | });
-  552 | 
-  553 | app.post('/api/cloud/provider', (req, res) => {
-  554 |   const { provider, model } = req.body;
-  555 |   if (!provider) return res.status(400).json({ error: 'provider required' });
-  556 |   cloudLLM.activeProvider = provider;
-  557 |   if (model) cloudLLM.activeModel = model;
-  558 |   res.json({ success: true, activeProvider: cloudLLM.activeProvider, activeModel: cloudLLM.activeModel });
-  559 | });
-  560 | 
-  561 | app.post('/api/cloud/apikey', (req, res) => {
-  562 |   const { provider, key } = req.body;
-  563 |   if (!provider) return res.status(400).json({ error: 'provider required' });
-  564 |   cloudLLM.setApiKey(provider, key || '');
-  565 |   // Persist the key (encrypted) so it survives restarts
-  566 |   settingsManager.setApiKey(provider, key || '');
-  567 |   res.json({ success: true, hasKey: !!(key && key.trim()) });
-  568 | });
-  569 | 
-  570 | app.get('/api/cloud/pool/:provider', (req, res) => {
-  571 |   res.json(cloudLLM.getPoolStatus(req.params.provider));
-  572 | });
-  573 | 
-  574 | app.get('/api/cloud/test/:provider', async (req, res) => {
-  575 |   const { provider } = req.params;
-  576 |   if (!provider) return res.status(400).json({ error: 'provider required' });
-  577 |   try {
-  578 |     const key = cloudLLM.apiKeys[provider];
-  579 |     if (!key) return res.json({ success: false, error: 'No API key set' });
-  580 |     const models = cloudLLM._getProviderModels(provider);
-  581 |     const testModel = models[0]?.id;
-  582 |     if (!testModel) return res.json({ success: false, error: 'No models for provider' });
-  583 |     // Quick validation: set the provider temporarily and do a minimal generate
-  584 |     const prevProvider = cloudLLM.activeProvider;
-  585 |     const prevModel = cloudLLM.activeModel;
-  586 |     cloudLLM.activeProvider = provider;
-  587 |     cloudLLM.activeModel = testModel;
-  588 |     const result = await Promise.race([
-  589 |       cloudLLM.generate([{ role: 'user', content: 'Say hi' }], { maxTokens: 5, stream: false }),
-  590 |       new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout after 15s')), 15000)),
-  591 |     ]);
-  592 |     cloudLLM.activeProvider = prevProvider;
-  593 |     cloudLLM.activeModel = prevModel;
-  594 |     res.json({ success: true });
-  595 |   } catch (e) {
-  596 |     res.json({ success: false, error: e.message });
-  597 |   }
-  598 | });
-  599 | 
-  600 | app.get('/api/models/recommend', async (req, res) => {
-  601 |   try {
-  602 |     const { execSync } = require('child_process');
-  603 |     let vramMB = 0;
-  604 |     try {
-  605 |       const out = execSync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits', { timeout: 5000 }).toString().trim();
-  606 |       vramMB = parseInt(out.split('\n')[0], 10) || 0;
-  607 |     } catch { /* no GPU or nvidia-smi not available */ }
-  608 |     const maxModelGB = vramMB > 0 ? Math.floor((vramMB * 0.85) / 1024) : 4;
-  609 |     // Curated recommended models list
-  610 |     const recommended = [
-  611 |       { name: 'Qwen 3.5 0.8B', file: 'Qwen3.5-0.8B-Q8_0.gguf', size: 0.8, desc: 'Tiny, ultra-fast', downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf', tags: ['general'] },
-  612 |       { name: 'Qwen 3.5 4B', file: 'Qwen3.5-4B-Q8_0.gguf', size: 4.5, desc: 'Great balance', downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q8_0.gguf', tags: ['coding', 'general'] },
-  613 |       { name: 'Qwen 3.5 9B', file: 'Qwen3.5-9B-Q4_K_M.gguf', size: 5.7, desc: 'Strong all-rounder', downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf', tags: ['coding', 'reasoning'] },
-  614 |       { name: 'Qwen 3.5 27B', file: 'Qwen3.5-27B-Q4_K_M.gguf', size: 16.7, desc: 'High quality', downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-27B-GGUF/resolve/main/Qwen3.5-27B-Q4_K_M.gguf', tags: ['coding', 'reasoning'] },
-  615 |       { name: 'Qwen 3.5 35B-A3B (MoE)', file: 'Qwen3.5-35B-A3B-Q4_K_M.gguf', size: 22.0, desc: 'MoE, fast for size', downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-35B-A3B-GGUF/resolve/main/Qwen3.5-35B-A3B-Q4_K_M.gguf', tags: ['coding', 'reasoning'] },
-  616 |     ];
-  617 |     const fits = recommended.filter(m => m.size <= maxModelGB);
-  618 |     const other = recommended.filter(m => m.size > maxModelGB);
-  619 |     res.json({ fits, other, maxModelGB, vramMB });
-  620 |   } catch (e) {
-  621 |     res.status(500).json({ error: e.message });
-  622 |   }
-  623 | });
-  624 | 
-  625 | // ── HuggingFace model download endpoints ─────────────────────────
-  626 | app.get('/api/models/hf/search', async (req, res) => {
-  627 |   const q = req.query.q;
-  628 |   if (!q || !q.trim()) return res.json({ models: [] });
-  629 |   try {
-  630 |     const models = await modelDownloader.searchModels(q.trim());
-  631 |     res.json({ models });
-  632 |   } catch (e) {
-  633 |     res.status(500).json({ error: e.message });
-  634 |   }
-  635 | });
-  636 | 
-  637 | app.get('/api/models/hf/files/:owner/:repo', async (req, res) => {
-  638 |   const repoId = `${req.params.owner}/${req.params.repo}`;
-  639 |   try {
-  640 |     const result = await modelDownloader.getRepoFiles(repoId);
-  641 |     res.json(result);
-  642 |   } catch (e) {
-  643 |     res.status(500).json({ error: e.message });
-  644 |   }
-  645 | });
-  646 | 
-  647 | app.post('/api/models/hf/download', async (req, res) => {
-  648 |   const { url, fileName } = req.body || {};
-  649 |   if (!url || !fileName) return res.status(400).json({ error: 'url and fileName required' });
-  650 |   try {
-  651 |     const result = await modelDownloader.downloadModel(url, fileName);
-  652 |     res.json({ success: true, ...result });
-  653 |   } catch (e) {
-  654 |     res.status(400).json({ error: e.message });
-  655 |   }
-  656 | });
-  657 | 
-  658 | app.post('/api/models/hf/cancel', (req, res) => {
-  659 |   const { id } = req.body || {};
-  660 |   if (!id) return res.status(400).json({ error: 'id required' });
-  661 |   const cancelled = modelDownloader.cancelDownload(id);
-  662 |   res.json({ success: cancelled });
-  663 | });
-  664 | 
-  665 | app.get('/api/models/hf/downloads', (req, res) => {
-  666 |   res.json({ downloads: modelDownloader.getActiveDownloads() });
-  667 | });
-  668 | 
-  669 | // ── License endpoints ────────────────────────────────────────────
-  670 | app.get('/api/license/status', (req, res) => {
-  671 |   const lm = ctx.licenseManager;
-  672 |   res.json({
-  673 |     isActivated: lm.isActivated || false,
-  674 |     isAuthenticated: accountManager.isAuthenticated || false,
-  675 |     license: lm.licenseData || null,
-  676 |     machineId: lm.machineId || null,
-  677 |     user: accountManager.user || null,
-  678 |     plan: lm.getPlan(),
-  679 |   });
-  680 | });
-  681 | 
-  682 | // POST /api/license/activate — handled by licenseManager.registerRoutes()
-  683 | 
-  684 | app.post('/api/license/oauth', async (req, res) => {
-  685 |   const { provider } = req.body || {};
-  686 |   if (!provider || !['google', 'github'].includes(provider)) {
-  687 |     return res.json({ success: false, error: 'Invalid OAuth provider' });
-  688 |   }
-  689 |   const { url } = accountManager.getOAuthURL(provider);
-  690 |   res.json({ success: true, url });
-  691 | });
-  692 | 
-  693 | app.post('/api/license/deactivate', (req, res) => {
-  694 |   licenseManager.deactivate();
-  695 |   accountManager.logout();
-  696 |   res.json({ success: true });
-  697 | });
-  698 | 
-  699 | // ─── Extension Management ────────────────────────────────
-  700 | 
-  701 | app.get('/api/extensions', async (req, res) => {
-  702 |   try {
-  703 |     const extensions = extensionManager.getInstalled();
-  704 |     const categories = extensionManager.getCategories();
-  705 |     res.json({ extensions, categories });
-  706 |   } catch (e) {
-  707 |     res.status(500).json({ error: e.message });
-  708 |   }
-  709 | });
-  710 | 
-  711 | app.post('/api/extensions/install', async (req, res) => {
-  712 |   try {
-  713 |     // Multipart upload — parse the zip file from the request body
-  714 |     const contentType = req.headers['content-type'] || '';
-  715 |     if (!contentType.includes('multipart/form-data')) {
-  716 |       return res.status(400).json({ error: 'Expected multipart/form-data with a .zip or .guide-ext file' });
-  717 |     }
-  718 | 
-  719 |     const boundary = contentType.split('boundary=')[1];
-  720 |     if (!boundary) return res.status(400).json({ error: 'No boundary in multipart request' });
-  721 | 
-  722 |     const chunks = [];
-  723 |     for await (const chunk of req) { chunks.push(chunk); }
-  724 |     const body = Buffer.concat(chunks);
-  725 |     const bodyStr = body.toString('binary');
-  726 |     const parts = bodyStr.split('--' + boundary).filter(p => p.trim() && p.trim() !== '--');
-  727 | 
-  728 |     let fileBuffer = null;
-  729 |     let fileName = 'extension.zip';
-  730 | 
-  731 |     for (const part of parts) {
-  732 |       const headerEnd = part.indexOf('\r\n\r\n');
-  733 |       if (headerEnd === -1) continue;
-  734 |       const headers = part.substring(0, headerEnd);
-  735 |       if (!headers.includes('filename=')) continue;
-  736 | 
-  737 |       const fnMatch = headers.match(/filename="([^"]+)"/);
-  738 |       if (fnMatch) fileName = path.basename(fnMatch[1]);
-  739 | 
-  740 |       const fileData = part.substring(headerEnd + 4);
-  741 |       // Remove trailing \r\n
-  742 |       const trimmed = fileData.endsWith('\r\n') ? fileData.slice(0, -2) : fileData;
-  743 |       fileBuffer = Buffer.from(trimmed, 'binary');
-  744 |       break;
-  745 |     }
-  746 | 
-  747 |     if (!fileBuffer) {
-  748 |       return res.status(400).json({ error: 'No file found in upload' });
-  749 |     }
-  750 | 
-  751 |     const result = await extensionManager.installFromZip(fileBuffer, fileName);
-  752 |     res.json({ success: true, ...result });
-  753 |   } catch (e) {
-  754 |     res.status(500).json({ error: e.message });
-  755 |   }
-  756 | });
-  757 | 
-  758 | app.post('/api/extensions/uninstall', async (req, res) => {
-  759 |   try {
-  760 |     const { id } = req.body;
-  761 |     if (!id) return res.status(400).json({ error: 'Extension ID required' });
-  762 |     const result = await extensionManager.uninstall(id);
-  763 |     res.json({ success: true, ...result });
-  764 |   } catch (e) {
-  765 |     res.status(500).json({ error: e.message });
-  766 |   }
-  767 | });
-  768 | 
-  769 | app.post('/api/extensions/enable', async (req, res) => {
-  770 |   try {
-  771 |     const { id } = req.body;
-  772 |     if (!id) return res.status(400).json({ error: 'Extension ID required' });
-  773 |     const result = await extensionManager.enable(id);
-  774 |     res.json({ success: true, ...result });
-  775 |   } catch (e) {
-  776 |     res.status(500).json({ error: e.message });
-  777 |   }
-  778 | });
-  779 | 
-  780 | app.post('/api/extensions/disable', async (req, res) => {
-  781 |   try {
-  782 |     const { id } = req.body;
-  783 |     if (!id) return res.status(400).json({ error: 'Extension ID required' });
-  784 |     const result = await extensionManager.disable(id);
-  785 |     res.json({ success: true, ...result });
-  786 |   } catch (e) {
-  787 |     res.status(500).json({ error: e.message });
-  788 |   }
-  789 | });
-  790 | 
-  791 | // ─── Debug Service ───────────────────────────────────────
-  792 | 
-  793 | // Forward debug events to the frontend via the WebSocket bridge
-  794 | debugService.on('debug-event', (data) => {
-  795 |   mainWindow.webContents.send('debug-event', data);
-  796 | });
-  797 | 
-  798 | app.post('/api/debug/start', async (req, res) => {
-  799 |   try {
-  800 |     const { type, program, cwd, args } = req.body;
-  801 |     if (!program) return res.status(400).json({ error: 'Program path required' });
-  802 |     const result = await debugService.start({
-  803 |       type: type || 'node',
-  804 |       program,
-  805 |       cwd: cwd || ctx.currentProjectPath || undefined,
-  806 |       args: args || [],
-  807 |     });
-  808 |     res.json(result);
-  809 |   } catch (e) {
-  810 |     res.status(500).json({ success: false, error: e.message });
-  811 |   }
-  812 | });
-  813 | 
-  814 | app.post('/api/debug/stop', async (req, res) => {
-  815 |   try {
-  816 |     const { sessionId } = req.body;
-  817 |     if (!sessionId) return res.status(400).json({ error: 'Session ID required' });
-  818 |     const result = await debugService.stop(sessionId);
-  819 |     res.json(result);
-  820 |   } catch (e) {
-  821 |     res.status(500).json({ success: false, error: e.message });
-  822 |   }
-  823 | });
-  824 | 
-  825 | app.post('/api/debug/continue', async (req, res) => {
-  826 |   try {
-  827 |     const { sessionId } = req.body;
-  828 |     const result = await debugService.resume(sessionId);
-  829 |     res.json(result);
-  830 |   } catch (e) {
-  831 |     res.status(500).json({ success: false, error: e.message });
-  832 |   }
-  833 | });
-  834 | 
-  835 | app.post('/api/debug/stepOver', async (req, res) => {
-  836 |   try {
-  837 |     const { sessionId } = req.body;
-  838 |     const result = await debugService.stepOver(sessionId);
-  839 |     res.json(result);
-  840 |   } catch (e) {
-  841 |     res.status(500).json({ success: false, error: e.message });
-  842 |   }
-  843 | });
-  844 | 
-  845 | app.post('/api/debug/stepInto', async (req, res) => {
-  846 |   try {
-  847 |     const { sessionId } = req.body;
-  848 |     const result = await debugService.stepInto(sessionId);
-  849 |     res.json(result);
-  850 |   } catch (e) {
-  851 |     res.status(500).json({ success: false, error: e.message });
-  852 |   }
-  853 | });
-  854 | 
-  855 | app.post('/api/debug/stepOut', async (req, res) => {
-  856 |   try {
-  857 |     const { sessionId } = req.body;
-  858 |     const result = await debugService.stepOut(sessionId);
-  859 |     res.json(result);
-  860 |   } catch (e) {
-  861 |     res.status(500).json({ success: false, error: e.message });
-  862 |   }
-  863 | });
-  864 | 
-  865 | app.post('/api/debug/pause', async (req, res) => {
-  866 |   try {
-  867 |     const { sessionId } = req.body;
-  868 |     const result = await debugService.pause(sessionId);
-  869 |     res.json(result);
-  870 |   } catch (e) {
-  871 |     res.status(500).json({ success: false, error: e.message });
-  872 |   }
-  873 | });
-  874 | 
-  875 | app.get('/api/debug/stackTrace', async (req, res) => {
-  876 |   try {
-  877 |     const sessionId = parseInt(req.query.sessionId);
-  878 |     const result = await debugService.getStackTrace(sessionId);
-  879 |     res.json(result);
-  880 |   } catch (e) {
-  881 |     res.status(500).json({ success: false, error: e.message });
-  882 |   }
-  883 | });
-  884 | 
-  885 | app.get('/api/debug/scopes', async (req, res) => {
-  886 |   try {
-  887 |     const sessionId = parseInt(req.query.sessionId);
-  888 |     const frameId = parseInt(req.query.frameId || '0');
-  889 |     const result = await debugService.getScopes(sessionId, frameId);
-  890 |     res.json(result);
-  891 |   } catch (e) {
-  892 |     res.status(500).json({ success: false, error: e.message });
-  893 |   }
-  894 | });
-  895 | 
-  896 | app.get('/api/debug/variables', async (req, res) => {
-  897 |   try {
-  898 |     const sessionId = parseInt(req.query.sessionId);
-  899 |     const ref = req.query.ref;
-  900 |     const result = await debugService.getVariables(sessionId, ref);
-  901 |     res.json(result);
-  902 |   } catch (e) {
-  903 |     res.status(500).json({ success: false, error: e.message });
-  904 |   }
-  905 | });
-  906 | 
-  907 | app.post('/api/debug/evaluate', async (req, res) => {
-  908 |   try {
-  909 |     const { sessionId, expression, frameId } = req.body;
-  910 |     const result = await debugService.evaluate(sessionId, expression, frameId);
-  911 |     res.json(result);
-  912 |   } catch (e) {
-  913 |     res.status(500).json({ success: false, error: e.message });
-  914 |   }
-  915 | });
-  916 | 
-  917 | app.post('/api/debug/setBreakpoints', async (req, res) => {
-  918 |   try {
-  919 |     const { sessionId, filePath, breakpoints } = req.body;
-  920 |     const result = await debugService.setBreakpoints(sessionId, filePath, breakpoints || []);
-  921 |     res.json(result);
-  922 |   } catch (e) {
-  923 |     res.status(500).json({ success: false, error: e.message });
-  924 |   }
-  925 | });
-  926 | 
-  927 | app.get('/api/debug/sessions', (req, res) => {
-  928 |   res.json({ sessions: debugService.getActiveSessions() });
-  929 | });
-  930 | 
-  931 | // ─── Code formatting (Prettier) ─────────────────────────
-  932 | app.post('/api/format', async (req, res) => {
-  933 |   try {
-  934 |     const { content, language, filePath: fp } = req.body;
-  935 |     if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
-  936 | 
-  937 |     // Map language/extension to prettier parser
-  938 |     const parserMap = {
-  939 |       javascript: 'babel', js: 'babel', jsx: 'babel', mjs: 'babel', cjs: 'babel',
-  940 |       typescript: 'typescript', ts: 'typescript', tsx: 'typescript',
-  941 |       css: 'css', scss: 'css', less: 'less',
-  942 |       html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte',
-  943 |       json: 'json', jsonc: 'json',
-  944 |       yaml: 'yaml', yml: 'yaml',
-  945 |       markdown: 'markdown', md: 'markdown', mdx: 'mdx',
-  946 |       graphql: 'graphql', gql: 'graphql',
-  947 |       xml: 'html', svg: 'html'
-  948 |     };
-  949 | 
-  950 |     const ext = fp ? path.extname(fp).replace('.', '').toLowerCase() : '';
-  951 |     const parser = parserMap[language] || parserMap[ext] || 'babel';
-  952 | 
-  953 |     // Try to load .prettierrc from project
-  954 |     let prettierConfig = {};
-  955 |     if (ctx.projectPath) {
-  956 |       try {
-  957 |         const rcPath = path.join(ctx.projectPath, '.prettierrc');
-  958 |         if (fs.existsSync(rcPath)) {
-  959 |           prettierConfig = JSON.parse(fs.readFileSync(rcPath, 'utf-8'));
-  960 |         }
-  961 |       } catch (_) { /* ignore bad config */ }
-  962 |     }
-  963 | 
-  964 |     const formatted = await prettier.format(content, {
-  965 |       parser,
-  966 |       ...prettierConfig,
-  967 |       filepath: fp || undefined
-  968 |     });
-  969 |     res.json({ formatted });
-  970 |   } catch (e) {
-  971 |     res.status(400).json({ error: e.message });
-  972 |   }
-  973 | });
-  974 | 
-  975 | // ─── TODO / FIXME Scanner ────────────────────────────────
-  976 | app.post('/api/todos/scan', async (req, res) => {
-  977 |   try {
-  978 |     const projectPath = ctx.projectPath;
-  979 |     if (!projectPath) return res.status(400).json({ error: 'No project open' });
-  980 | 
-  981 |     const TODO_PATTERN = /\b(TODO|FIXME|HACK|NOTE|XXX|BUG|OPTIMIZE)\b[:\s]*(.*)/gi;
-  982 |     const MAX_RESULTS = 500;
-  983 |     const BINARY_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.webp','.bmp','.ico','.svg',
-  984 |       '.woff','.woff2','.ttf','.eot','.mp3','.mp4','.wav','.ogg','.zip','.tar','.gz',
-  985 |       '.rar','.7z','.pdf','.exe','.dll','.so','.dylib','.o','.pyc','.class','.gguf',
-  986 |       '.bin','.dat','.db','.sqlite','.lock']);
-  987 |     const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
-  988 |       '.venv', 'venv', '.cache', 'coverage', '.idea', '.vscode']);
-  989 | 
-  990 |     const results = [];
-  991 | 
-  992 |     function scanDir(dir) {
-  993 |       if (results.length >= MAX_RESULTS) return;
-  994 |       let entries;
-  995 |       try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
-  996 |       for (const entry of entries) {
-  997 |         if (results.length >= MAX_RESULTS) break;
-  998 |         if (entry.name.startsWith('.') && entry.name !== '.env') continue;
-  999 |         const fullPath = path.join(dir, entry.name);
- 1000 |         if (entry.isDirectory()) {
- 1001 |           if (!SKIP_DIRS.has(entry.name)) scanDir(fullPath);
- 1002 |         } else if (entry.isFile()) {
- 1003 |           const ext = path.extname(entry.name).toLowerCase();
- 1004 |           if (BINARY_EXTS.has(ext)) continue;
- 1005 |           try {
- 1006 |             const content = fs.readFileSync(fullPath, 'utf-8');
- 1007 |             const lines = content.split('\n');
- 1008 |             for (let i = 0; i < lines.length && results.length < MAX_RESULTS; i++) {
- 1009 |               let match;
- 1010 |               TODO_PATTERN.lastIndex = 0;
- 1011 |               while ((match = TODO_PATTERN.exec(lines[i])) !== null) {
- 1012 |                 results.push({
- 1013 |                   file: path.relative(projectPath, fullPath).replace(/\\/g, '/'),
- 1014 |                   line: i + 1,
- 1015 |                   type: match[1].toUpperCase(),
- 1016 |                   text: match[2].trim() || match[0].trim()
- 1017 |                 });
- 1018 |                 if (results.length >= MAX_RESULTS) break;
- 1019 |               }
- 1020 |             }
- 1021 |           } catch (_) { /* skip unreadable files */ }
- 1022 |         }
- 1023 |       }
- 1024 |     }
- 1025 | 
- 1026 |     scanDir(projectPath);
- 1027 |     res.json({ todos: results, total: results.length, capped: results.length >= MAX_RESULTS });
- 1028 |   } catch (e) {
- 1029 |     res.status(500).json({ error: e.message });
- 1030 |   }
- 1031 | });
- 1032 | 
- 1033 | // Session management
- 1034 | app.post('/api/session/clear', async (req, res) => {
- 1035 |   try {
- 1036 |     ctx.agenticCancelled = true;
- 1037 |     try { llmEngine.cancelGeneration(); } catch (_) {}
- 1038 |     await new Promise(r => setTimeout(r, 100));
- 1039 |     await llmEngine.resetSession();
- 1040 |     // R51-Fix: Clear todo state on session clear so the todo list
- 1041 |     // doesn't persist visually after the user hits the trash can button.
- 1042 |     if (ctx.mcpToolServer) {
- 1043 |       ctx.mcpToolServer._todos = [];
- 1044 |       ctx.mcpToolServer._todoNextId = 1;
- 1045 |     }
- 1046 |     ctx.agenticCancelled = false;
- 1047 |     res.json({ success: true });
- 1048 |   } catch (e) {
- 1049 |     res.status(500).json({ error: e.message });
- 1050 |   }
- 1051 | });
- 1052 | 
- 1053 | // Health check
- 1054 | app.get('/api/health', (req, res) => {
- 1055 |   res.json({
- 1056 |     status: 'running',
- 1057 |     version: '2.0.0',
- 1058 |     modelLoaded: llmEngine.isReady,
- 1059 |     modelInfo: llmEngine.modelInfo,
- 1060 |     projectPath: ctx.currentProjectPath,
- 1061 |     uptime: process.uptime(),
- 1062 |     memory: process.memoryUsage(),
- 1063 |   });
- 1064 | });
- 1065 | 
- 1066 | // File search
- 1067 | app.get('/api/files/search', async (req, res) => {
- 1068 |   const basePath = req.query.path || ctx.currentProjectPath;
- 1069 |   const query = req.query.query;
- 1070 |   if (!basePath || !query) return res.json({ results: [] });
- 1071 |   try {
- 1072 |     const results = [];
- 1073 |     const maxResults = 200;
- 1074 |     const searchDir = (dir, depth = 0) => {
- 1075 |       if (depth > 6 || results.length >= maxResults) return;
- 1076 |       let entries;
- 1077 |       try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
- 1078 |       for (const entry of entries) {
- 1079 |         if (results.length >= maxResults) break;
- 1080 |         if (entry.name.startsWith('.') && entry.name !== '.env') continue;
- 1081 |         if (['node_modules', '__pycache__', '.git', 'dist', 'build', '.next', 'target'].includes(entry.name)) continue;
- 1082 |         const fullPath = path.join(dir, entry.name);
- 1083 |         if (entry.isDirectory()) {
- 1084 |           searchDir(fullPath, depth + 1);
- 1085 |         } else if (entry.isFile()) {
- 1086 |           try {
- 1087 |             const stat = fs.statSync(fullPath);
- 1088 |             if (stat.size > 1024 * 1024) continue; // skip files > 1MB
- 1089 |             const content = fs.readFileSync(fullPath, 'utf8');
- 1090 |             const lines = content.split('\n');
- 1091 |             const lowerQuery = query.toLowerCase();
- 1092 |             for (let i = 0; i < lines.length && results.length < maxResults; i++) {
- 1093 |               if (lines[i].toLowerCase().includes(lowerQuery)) {
- 1094 |                 results.push({ file: fullPath, line: i + 1, text: lines[i].trim().substring(0, 200) });
- 1095 |               }
- 1096 |             }
- 1097 |           } catch (_) {}
- 1098 |         }
- 1099 |       }
- 1100 |     };
- 1101 |     searchDir(basePath);
- 1102 |     res.json({ results });
- 1103 |   } catch (e) {
- 1104 |     res.status(500).json({ error: e.message });
- 1105 |   }
- 1106 | });
- 1107 | 
- 1108 | // Git status
- 1109 | app.get('/api/git/status', async (req, res) => {
- 1110 |   const basePath = req.query.path || ctx.currentProjectPath;
- 1111 |   if (!basePath) return res.json({ error: 'No project path' });
- 1112 |   try {
- 1113 |     const result = gitManager.getStatus(basePath);
- 1114 |     res.json(result);
- 1115 |   } catch (e) {
- 1116 |     res.json({ error: e.message, branch: '', staged: [], modified: [], untracked: [] });
- 1117 |   }
- 1118 | });
- 1119 | 
- 1120 | // Git stage files
- 1121 | app.post('/api/git/stage', async (req, res) => {
- 1122 |   const basePath = req.body.path || ctx.currentProjectPath;
- 1123 |   if (!basePath) return res.status(400).json({ error: 'No project path' });
- 1124 |   try {
- 1125 |     if (req.body.all) {
- 1126 |       gitManager.stageAll(basePath);
- 1127 |     } else if (req.body.files && Array.isArray(req.body.files)) {
- 1128 |       gitManager.stageFiles(req.body.files, basePath);
- 1129 |     } else {
- 1130 |       return res.status(400).json({ error: 'Provide files array or all:true' });
- 1131 |     }
- 1132 |     res.json({ success: true });
- 1133 |   } catch (e) {
- 1134 |     res.status(500).json({ error: e.message });
- 1135 |   }
- 1136 | });
- 1137 | 
- 1138 | // Git unstage files
- 1139 | app.post('/api/git/unstage', async (req, res) => {
- 1140 |   const basePath = req.body.path || ctx.currentProjectPath;
- 1141 |   if (!basePath) return res.status(400).json({ error: 'No project path' });
- 1142 |   try {
- 1143 |     if (req.body.all) {
- 1144 |       gitManager.unstageAll(basePath);
- 1145 |     } else if (req.body.files && Array.isArray(req.body.files)) {
- 1146 |       gitManager.unstageFiles(req.body.files, basePath);
- 1147 |     } else {
- 1148 |       return res.status(400).json({ error: 'Provide files array or all:true' });
- 1149 |     }
- 1150 |     res.json({ success: true });
- 1151 |   } catch (e) {
- 1152 |     res.status(500).json({ error: e.message });
- 1153 |   }
- 1154 | });
- 1155 | 
- 1156 | // Git commit
- 1157 | app.post('/api/git/commit', async (req, res) => {
- 1158 |   const basePath = req.body.path || ctx.currentProjectPath;
- 1159 |   const message = req.body.message;
- 1160 |   if (!basePath) return res.status(400).json({ error: 'No project path' });
- 1161 |   if (!message || !message.trim()) return res.status(400).json({ error: 'Commit message required' });
- 1162 |   try {
- 1163 |     const result = gitManager.commit(message, basePath);
- 1164 |     res.json(result);
- 1165 |   } catch (e) {
- 1166 |     res.status(500).json({ error: e.message });
- 1167 |   }
- 1168 | });
- 1169 | 
- 1170 | // Git discard changes (checkout file from HEAD)
- 1171 | app.post('/api/git/discard', async (req, res) => {
- 1172 |   const basePath = req.body.path || ctx.currentProjectPath;
- 1173 |   if (!basePath) return res.status(400).json({ error: 'No project path' });
- 1174 |   try {
- 1175 |     if (req.body.files && Array.isArray(req.body.files)) {
- 1176 |       gitManager.discardFiles(req.body.files, basePath);
- 1177 |     } else {
- 1178 |       return res.status(400).json({ error: 'Provide files array' });
- 1179 |     }
- 1180 |     res.json({ success: true });
- 1181 |   } catch (e) {
- 1182 |     res.status(500).json({ error: e.message });
- 1183 |   }
- 1184 | });
- 1185 | 
- 1186 | // Git diff
- 1187 | app.get('/api/git/diff', async (req, res) => {
- 1188 |   const basePath = req.query.path || ctx.currentProjectPath;
- 1189 |   if (!basePath) return res.status(400).json({ error: 'No project path' });
- 1190 |   try {
- 1191 |     const result = gitManager.getDiff({ staged: req.query.staged === 'true', file: req.query.file }, basePath);
- 1192 |     res.json(result);
- 1193 |   } catch (e) {
- 1194 |     res.status(500).json({ error: e.message });
- 1195 |   }
- 1196 | });
- 1197 | 
- 1198 | // Git log
- 1199 | app.get('/api/git/log', async (req, res) => {
- 1200 |   const basePath = req.query.path || ctx.currentProjectPath;
- 1201 |   if (!basePath) return res.status(400).json({ error: 'No project path' });
- 1202 |   try {
- 1203 |     const count = parseInt(req.query.count) || 20;
- 1204 |     const result = gitManager.getLog(count, basePath);
- 1205 |     res.json(result);
- 1206 |   } catch (e) {
- 1207 |     res.status(500).json({ error: e.message });
- 1208 |   }
- 1209 | });
- 1210 | 
- 1211 | // Git branches
- 1212 | app.get('/api/git/branches', async (req, res) => {
- 1213 |   const basePath = req.query.path || ctx.currentProjectPath;
- 1214 |   if (!basePath) return res.status(400).json({ error: 'No project path' });
- 1215 |   try {
- 1216 |     const result = gitManager.getBranches(basePath);
- 1217 |     res.json(result);
- 1218 |   } catch (e) {
- 1219 |     res.status(500).json({ error: e.message });
- 1220 |   }
- 1221 | });
- 1222 | 
- 1223 | // Git checkout branch
- 1224 | app.post('/api/git/checkout', async (req, res) => {
- 1225 |   const basePath = req.body.path || ctx.currentProjectPath;
- 1226 |   const branch = req.body.branch;
- 1227 |   if (!basePath) return res.status(400).json({ error: 'No project path' });
- 1228 |   if (!branch) return res.status(400).json({ error: 'Branch name required' });
- 1229 |   try {
- 1230 |     const result = gitManager.checkout(branch, { create: !!req.body.create }, basePath);
- 1231 |     res.json(result);
- 1232 |   } catch (e) {
- 1233 |     res.status(500).json({ error: e.message });
- 1234 |   }
- 1235 | });
- 1236 | 
- 1237 | // ─── Browser Preview Routes ─────────────────────────────
- 1238 | 
- 1239 | app.post('/api/preview/start', async (req, res) => {
- 1240 |   const rootPath = req.body.rootPath || ctx.currentProjectPath;
- 1241 |   if (!rootPath) return res.status(400).json({ error: 'No project path' });
- 1242 |   try {
- 1243 |     const result = await browserManager.startPreview(rootPath);
- 1244 |     res.json(result);
- 1245 |   } catch (e) {
- 1246 |     res.status(500).json({ error: e.message });
- 1247 |   }
- 1248 | });
- 1249 | 
- 1250 | app.post('/api/preview/stop', async (req, res) => {
- 1251 |   try {
- 1252 |     const result = await browserManager.stopPreview();
- 1253 |     res.json(result);
- 1254 |   } catch (e) {
- 1255 |     res.status(500).json({ error: e.message });
- 1256 |   }
- 1257 | });
- 1258 | 
- 1259 | app.post('/api/preview/reload', (req, res) => {
- 1260 |   browserManager.reloadPreview();
- 1261 |   res.json({ success: true });
- 1262 | });
- 1263 | 
- 1264 | app.get('/api/preview/status', (req, res) => {
- 1265 |   res.json(browserManager.getPreviewStatus());
- 1266 | });
- 1267 | 
- 1268 | // File create (for SearchPanel/explorer new file)
- 1269 | app.post('/api/files/create', async (req, res) => {
- 1270 |   const { path: filePath, content } = req.body;
- 1271 |   if (!filePath) return res.status(400).json({ error: 'path required' });
- 1272 |   try {
- 1273 |     const fullPath = path.isAbsolute(filePath) ? filePath : path.join(ctx.currentProjectPath || '', filePath);
- 1274 |     fs.mkdirSync(path.dirname(fullPath), { recursive: true });
- 1275 |     if (fs.existsSync(fullPath)) return res.status(409).json({ error: 'File already exists' });
- 1276 |     fs.writeFileSync(fullPath, content || '', 'utf8');
- 1277 |     res.json({ success: true, path: fullPath });
- 1278 |   } catch (e) {
- 1279 |     res.status(500).json({ error: e.message });
- 1280 |   }
- 1281 | });
- 1282 | 
- 1283 | // File delete
- 1284 | app.post('/api/files/delete', async (req, res) => {
- 1285 |   const { path: filePath } = req.body;
- 1286 |   if (!filePath) return res.status(400).json({ error: 'path required' });
- 1287 |   try {
- 1288 |     const fullPath = path.isAbsolute(filePath) ? filePath : path.join(ctx.currentProjectPath || '', filePath);
- 1289 |     if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Not found' });
- 1290 |     const stat = fs.statSync(fullPath);
- 1291 |     if (stat.isDirectory()) {
- 1292 |       fs.rmSync(fullPath, { recursive: true, force: true });
- 1293 |     } else {
- 1294 |       fs.unlinkSync(fullPath);
- 1295 |     }
- 1296 |     // R51-Fix: Emit files-changed so the frontend file explorer updates
- 1297 |     // immediately after deletion (instead of requiring manual refresh).
- 1298 |     if (mainWindow && !mainWindow.isDestroyed()) {
- 1299 |       mainWindow.webContents.send('files-changed');
- 1300 |     }
- 1301 |     res.json({ success: true });
- 1302 |   } catch (e) {
- 1303 |     res.status(500).json({ error: e.message });
- 1304 |   }
- 1305 | });
- 1306 | 
- 1307 | // File rename
- 1308 | app.post('/api/files/rename', async (req, res) => {
- 1309 |   const { oldPath, newPath } = req.body;
- 1310 |   if (!oldPath || !newPath) return res.status(400).json({ error: 'oldPath and newPath required' });
- 1311 |   try {
- 1312 |     const fullOld = path.isAbsolute(oldPath) ? oldPath : path.join(ctx.currentProjectPath || '', oldPath);
- 1313 |     const fullNew = path.isAbsolute(newPath) ? newPath : path.join(ctx.currentProjectPath || '', newPath);
- 1314 |     if (!fs.existsSync(fullOld)) return res.status(404).json({ error: 'Source not found' });
- 1315 |     fs.renameSync(fullOld, fullNew);
- 1316 |     // R51-Fix: Emit files-changed after rename so file explorer updates live.
- 1317 |     if (mainWindow && !mainWindow.isDestroyed()) {
- 1318 |       mainWindow.webContents.send('files-changed');
- 1319 |     }
- 1320 |     res.json({ success: true, path: fullNew });
- 1321 |   } catch (e) {
- 1322 |     res.status(500).json({ error: e.message });
- 1323 |   }
- 1324 | });
- 1325 | 
- 1326 | // Terminal execute (legacy — used when PTY is not available)
- 1327 | app.post('/api/terminal/execute', async (req, res) => {
- 1328 |   const { command, cwd } = req.body;
- 1329 |   if (!command) return res.status(400).json({ error: 'command required' });
- 1330 |   try {
- 1331 |     const { execSync } = require('child_process');
- 1332 |     const output = execSync(command, {
- 1333 |       cwd: cwd || ctx.currentProjectPath || process.cwd(),
- 1334 |       encoding: 'utf8',
- 1335 |       timeout: 30000,
- 1336 |       maxBuffer: 1024 * 1024,
- 1337 |     });
- 1338 |     res.json({ success: true, output });
- 1339 |   } catch (e) {
- 1340 |     res.json({ success: false, output: e.stderr || e.stdout || e.message });
- 1341 |   }
- 1342 | });
- 1343 | 
- 1344 | // ─── Live Server (Go Live preview) ───────────────────────
- 1345 | app.post('/api/live-server/start', async (req, res) => {
- 1346 |   const rootPath = req.body.path || ctx.currentProjectPath;
- 1347 |   if (!rootPath) return res.status(400).json({ error: 'No project path' });
- 1348 |   const result = await liveServer.start(rootPath);
- 1349 |   if (result.success) {
- 1350 |     res.json(result);
- 1351 |   } else {
- 1352 |     res.status(500).json(result);
- 1353 |   }
- 1354 | });
- 1355 | 
- 1356 | app.post('/api/live-server/stop', async (req, res) => {
- 1357 |   const result = await liveServer.stop();
- 1358 |   res.json(result);
- 1359 | });
- 1360 | 
- 1361 | app.get('/api/live-server/status', (req, res) => {
- 1362 |   res.json(liveServer.getStatus());
- 1363 | });
- 1364 | 
- 1365 | // ─── Serve Frontend ──────────────────────────────────────
- 1366 | if (fs.existsSync(FRONTEND_DIST)) {
- 1367 |   app.use(express.static(FRONTEND_DIST));
- 1368 |   // SPA fallback — serve index.html for all non-API, non-file routes
- 1369 |   app.get('*', (req, res) => {
- 1370 |     if (!req.path.startsWith('/api/') && !req.path.startsWith('/ws')) {
- 1371 |       res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
- 1372 |     }
- 1373 |   });
- 1374 | } else if (isDev) {
- 1375 |   // In dev mode, Vite dev server handles the frontend — just serve API + WS
- 1376 |   app.get('/', (req, res) => {
- 1377 |     res.send('<html><body><h1>guIDE Backend Running</h1><p>Frontend dev server: <a href="http://localhost:5173">http://localhost:5173</a></p></body></html>');
- 1378 |   });
- 1379 | } else {
- 1380 |   app.get('/', (req, res) => {
- 1381 |     res.send('<html><body><h1>guIDE Backend Running</h1><p>Frontend not built. Run: npm run frontend:build</p></body></html>');
- 1382 |   });
- 1383 | }
- 1384 | 
- 1385 | // ─── Start Server ────────────────────────────────────────
- 1386 | const server = http.createServer(app);
- 1387 | const transport = new Transport({ ipcMain, mainWindow, server });
- 1388 | transport.start();
- 1389 | 
- 1390 | // ─── PTY Terminal WebSocket ──────────────────────────────
- 1391 | const WebSocket = require('ws');
- 1392 | let pty = undefined; // undefined = not yet attempted; null = attempted but unavailable
- 1393 | function _loadPty() {
- 1394 |   if (pty !== undefined) return pty;
- 1395 |   try {
- 1396 |     pty = require('node-pty');
- 1397 |     console.log('[Server] node-pty loaded — real terminal support enabled');
- 1398 |   } catch (e) {
- 1399 |     console.warn('[Server] node-pty not available — terminal will use exec fallback');
- 1400 |     pty = null;
- 1401 |   }
- 1402 |   return pty;
- 1403 | }
- 1404 | 
- 1405 | const ptyTerminals = new Map(); // terminalId -> { pty, ws }
- 1406 | 
- 1407 | const ptyWss = new WebSocket.Server({ noServer: true });
- 1408 | 
- 1409 | server.on('upgrade', (request, socket, head) => {
- 1410 |   const url = new URL(request.url, `http://${request.headers.host}`);
- 1411 |   if (url.pathname === '/ws/terminal') {
- 1412 |     ptyWss.handleUpgrade(request, socket, head, (ws) => {
- 1413 |       ptyWss.emit('connection', ws, request);
- 1414 |     });
- 1415 |   } else if (url.pathname === '/ws') {
- 1416 |     transport.handleUpgrade(request, socket, head);
- 1417 |   } else {
- 1418 |     socket.destroy();
- 1419 |   }
- 1420 | });
- 1421 | 
- 1422 | ptyWss.on('connection', (ws) => {
- 1423 |   let termId = null;
- 1424 |   let ptyProcess = null;
- 1425 | 
- 1426 |   ws.on('message', (raw) => {
- 1427 |     let msg;
- 1428 |     try { msg = JSON.parse(raw); } catch (_) { return; }
- 1429 | 
- 1430 |     if (msg.type === 'create') {
- 1431 |       termId = msg.terminalId || `pty-${Date.now()}`;
- 1432 |       const ptyModule = _loadPty(); // lazy-load native module on first terminal open
- 1433 |       if (ptyModule) {
- 1434 |         const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
- 1435 |         const cwd = ctx.currentProjectPath || process.cwd();
- 1436 |         ptyProcess = ptyModule.spawn(shell, [], {
- 1437 |           name: 'xterm-256color',
- 1438 |           cols: msg.cols || 80,
- 1439 |           rows: msg.rows || 24,
- 1440 |           cwd,
- 1441 |           env: process.env,
- 1442 |         });
- 1443 | 
- 1444 |         ptyProcess.onData((data) => {
- 1445 |           if (ws.readyState === WebSocket.OPEN) {
- 1446 |             ws.send(JSON.stringify({ type: 'output', data }));
- 1447 |           }
- 1448 |         });
- 1449 | 
- 1450 |         ptyProcess.onExit(({ exitCode }) => {
- 1451 |           if (ws.readyState === WebSocket.OPEN) {
- 1452 |             ws.send(JSON.stringify({ type: 'exit', exitCode }));
- 1453 |           }
- 1454 |           ptyTerminals.delete(termId);
- 1455 |         });
- 1456 | 
- 1457 |         ptyTerminals.set(termId, { pty: ptyProcess, ws });
- 1458 |         ws.send(JSON.stringify({ type: 'ready', terminalId: termId, shell }));
- 1459 |       } else {
- 1460 |         // No node-pty — send a message saying to use exec fallback
- 1461 |         ws.send(JSON.stringify({ type: 'no-pty' }));
- 1462 |       }
- 1463 |     } else if (msg.type === 'input' && ptyProcess) {
- 1464 |       ptyProcess.write(msg.data);
- 1465 |     } else if (msg.type === 'resize' && ptyProcess) {
- 1466 |       try { ptyProcess.resize(msg.cols || 80, msg.rows || 24); } catch (_) {}
- 1467 |     }
- 1468 |   });
- 1469 | 
- 1470 |   ws.on('close', () => {
- 1471 |     if (ptyProcess) {
- 1472 |       try { ptyProcess.kill(); } catch (_) {}
- 1473 |       if (termId) ptyTerminals.delete(termId);
- 1474 |     }
- 1475 |   });
- 1476 | });
- 1477 | 
- 1478 | // Initialize model manager
- 1479 | modelManager.initialize().then((models) => {
- 1480 |   console.log(`[Server] Found ${models.length} model(s)`);
- 1481 | 
- 1482 |   // Auto-load: prefer last-used model, then fall back to default heuristic
- 1483 |   if (!llmEngine.isReady && models.length > 0) {
- 1484 |     const lastPath = settingsManager.get('lastModelPath');
- 1485 |     const lastModel = lastPath && models.find(m => m.path === lastPath);
- 1486 |     const target = lastModel || modelManager.getDefaultModel();
- 1487 |     if (target) {
- 1488 |       console.log(`[Server] Auto-loading ${lastModel ? 'last-used' : 'default'} model: ${target.name}`);
- 1489 |       llmEngine.initialize(target.path, buildEngineLoadSettings(settingsManager.getAll())).catch(e => {
- 1490 |         console.error(`[Server] Auto-load failed: ${e.message}`);
- 1491 |       });
- 1492 |     }
- 1493 |   }
- 1494 | }).catch(e => {
- 1495 |   console.error(`[Server] Model scan failed: ${e.message}`);
- 1496 | });
- 1497 | 
- 1498 | // Forward model manager events to clients
- 1499 | modelManager.on('models-updated', (models) => {
- 1500 |   mainWindow.webContents.send('models-updated', models);
- 1501 | });
- 1502 | 
- 1503 | // Forward model download events to clients
- 1504 | for (const evt of ['download-started', 'download-progress', 'download-complete', 'download-error', 'download-cancelled']) {
- 1505 |   modelDownloader.on(evt, (data) => {
- 1506 |     mainWindow.webContents.send(evt, data);
- 1507 |   });
- 1508 | }
- 1509 | // Auto-rescan models when a download completes
- 1510 | modelDownloader.on('download-complete', () => {
- 1511 |   modelManager.scanModels().catch(() => {});
- 1512 | });
- 1513 | 
- 1514 | llmEngine.on('status', (status) => {
- 1515 |   mainWindow.webContents.send('llm-status', status);
- 1516 | });
- 1517 | 
- 1518 | server.listen(PORT, () => {
- 1519 |   console.log(`\n${'='.repeat(60)}`);
- 1520 |   console.log(`  guIDE 3.0 Server`);
- 1521 |   console.log(`  http://localhost:${PORT}`);
- 1522 |   console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
- 1523 |   console.log(`  Mode: ${isDev ? 'development' : 'production'}`);
- 1524 |   console.log(`  Models dir: ${MODELS_DIR}`);
- 1525 |   console.log(`  User data: ${USER_DATA}`);
- 1526 |   console.log(`${'='.repeat(60)}\n`);
- 1527 | });
- 1528 | 
- 1529 | // ─── Graceful Shutdown ───────────────────────────────────
- 1530 | process.on('SIGINT', async () => {
- 1531 |   console.log('\n[Server] Shutting down...');
- 1532 |   transport.shutdown();
- 1533 |   settingsManager.flush();
- 1534 |   memoryStore.dispose();
- 1535 |   sessionStore.flush();
- 1536 |   try { await browserManager.dispose(); } catch (_) {}
- 1537 |   try { await llmEngine.dispose(); } catch (_) {}
- 1538 |   modelManager.dispose();
- 1539 |   log.close();
- 1540 |   server.close(() => process.exit(0));
- 1541 |   setTimeout(() => process.exit(0), 5000); // Force exit after 5s
- 1542 | });
- 1543 | 
- 1544 | process.on('SIGTERM', () => process.emit('SIGINT'));
- 1545 | 
- 1546 | // ─── Helpers ─────────────────────────────────────────────
- 1547 | 
- 1548 | async function _readDirRecursive(dirPath, depth = 0, maxDepth = 3) {
- 1549 |   const items = [];
- 1550 |   try {
- 1551 |     const entries = fs.readdirSync(dirPath, { withFileTypes: true });
- 1552 |     for (const entry of entries) {
- 1553 |       // Skip hidden files, node_modules, .git, etc.
- 1554 |       if (entry.name.startsWith('.') && entry.name !== '.env') continue;
- 1555 |       if (['node_modules', '__pycache__', '.git', 'dist', 'build', '.next', 'target'].includes(entry.name)) continue;
- 1556 | 
- 1557 |       const fullPath = path.join(dirPath, entry.name);
- 1558 |       const item = {
- 1559 |         name: entry.name,
- 1560 |         path: fullPath,
- 1561 |         type: entry.isDirectory() ? 'directory' : 'file',
- 1562 |       };
- 1563 | 
- 1564 |       if (entry.isFile()) {
- 1565 |         try {
- 1566 |           const stats = fs.statSync(fullPath);
- 1567 |           item.size = stats.size;
- 1568 |           item.modified = stats.mtime.toISOString();
- 1569 |         } catch (_) {}
- 1570 |         item.extension = path.extname(entry.name).slice(1);
- 1571 |       }
- 1572 | 
- 1573 |       if (entry.isDirectory() && depth < maxDepth) {
- 1574 |         item.children = await _readDirRecursive(fullPath, depth + 1, maxDepth);
- 1575 |       }
- 1576 | 
- 1577 |       items.push(item);
- 1578 |     }
- 1579 | 
- 1580 |     // Sort: directories first, then files, both alphabetically
- 1581 |     items.sort((a, b) => {
- 1582 |       if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
- 1583 |       return a.name.localeCompare(b.name);
- 1584 |     });
- 1585 |   } catch (e) {
- 1586 |     // Permission denied or other errors — skip silently
- 1587 |   }
- 1588 |   return items;
- 1589 | }
- 1590 | 
```

### server/transport.js (lines: 221)

```diff
-    1 | /**
-    2 |  * WebSocket Transport — Manages WebSocket connections between the Node.js
-    3 |  * backend and frontend clients (browser or Tauri webview).
-    4 |  *
-    5 |  * Responsibilities:
-    6 |  *   1. Accept WebSocket connections from frontend clients
-    7 |  *   2. Route incoming messages to the IPC bridge (invoke handlers)
-    8 |  *   3. Route outgoing events from the pipeline to connected clients
-    9 |  *   4. Handle connection lifecycle (connect, disconnect, reconnect)
-   10 |  *   5. Message serialization/deserialization
-   11 |  *
-   12 |  * Protocol:
-   13 |  *   Client → Server:
-   14 |  *     { type: 'invoke', id: 'uuid', channel: 'ai-chat', args: [...] }
-   15 |  *     { type: 'send', channel: 'some-event', args: [...] }
-   16 |  *
-   17 |  *   Server → Client:
-   18 |  *     { type: 'response', id: 'uuid', result: {...}, error: null }
-   19 |  *     { type: 'event', event: 'llm-token', data: '...' }
-   20 |  *     { type: 'error', id: 'uuid', error: 'message' }
-   21 |  */
-   22 | 'use strict';
-   23 | 
-   24 | const WebSocket = require('ws');
-   25 | 
-   26 | class Transport {
-   27 |   /**
-   28 |    * @param {object} options
-   29 |    * @param {object} options.ipcMain — IpcMainBridge instance
-   30 |    * @param {object} options.mainWindow — MainWindowBridge instance
-   31 |    * @param {object} options.server — HTTP server to attach WebSocket to
-   32 |    */
-   33 |   constructor(options) {
-   34 |     this._ipcMain = options.ipcMain;
-   35 |     this._mainWindow = options.mainWindow;
-   36 |     this._httpServer = options.server;
-   37 |     this._wss = null;
-   38 |     this._clients = new Set();
-   39 |     this._activeClient = null;
-   40 |   }
-   41 | 
-   42 |   /**
-   43 |    * Start the WebSocket server.
-   44 |    */
-   45 |   start() {
-   46 |     // Use noServer mode so we don't register an automatic upgrade handler
-   47 |     // that would reject non-matching paths (like /ws/terminal) with HTTP 400.
-   48 |     // Upgrade routing is handled centrally in server/main.js.
-   49 |     this._wss = new WebSocket.Server({
-   50 |       noServer: true,
-   51 |       maxPayload: 50 * 1024 * 1024, // 50MB — large tool results, file contents
-   52 |     });
-   53 | 
-   54 |     this._wss.on('connection', (ws, req) => {
-   55 |       const clientIp = req.socket.remoteAddress;
-   56 |       console.log(`[Transport] Client connected from ${clientIp}`);
-   57 | 
-   58 |       this._clients.add(ws);
-   59 |       this._activeClient = ws;
-   60 | 
-   61 |       // Wire the MainWindowBridge to send events to this client
-   62 |       this._mainWindow.setSender((event, data) => {
-   63 |         this._sendToClient(ws, { type: 'event', event, data });
-   64 |       });
-   65 | 
-   66 |       ws.on('message', (raw) => {
-   67 |         this._handleMessage(ws, raw);
-   68 |       });
-   69 | 
-   70 |       ws.on('close', (code, reason) => {
-   71 |         console.log(`[Transport] Client disconnected (code=${code})`);
-   72 |         this._clients.delete(ws);
-   73 |         if (this._activeClient === ws) {
-   74 |           this._activeClient = null;
-   75 |           this._mainWindow.clearSender();
-   76 | 
-   77 |           // If another client is connected, make it active
-   78 |           for (const client of this._clients) {
-   79 |             if (client.readyState === WebSocket.OPEN) {
-   80 |               this._activeClient = client;
-   81 |               this._mainWindow.setSender((event, data) => {
-   82 |                 this._sendToClient(client, { type: 'event', event, data });
-   83 |               });
-   84 |               break;
-   85 |             }
-   86 |           }
-   87 |         }
-   88 |       });
-   89 | 
-   90 |       ws.on('error', (err) => {
-   91 |         console.error(`[Transport] WebSocket error: ${err.message}`);
-   92 |       });
-   93 | 
-   94 |       // Send initial connection acknowledgment
-   95 |       this._sendToClient(ws, {
-   96 |         type: 'event',
-   97 |         event: 'connection-ready',
-   98 |         data: { timestamp: Date.now() },
-   99 |       });
-  100 |     });
-  101 | 
-  102 |     this._wss.on('error', (err) => {
-  103 |       console.error(`[Transport] WebSocket server error: ${err.message}`);
-  104 |     });
-  105 | 
-  106 |     console.log('[Transport] WebSocket server started on /ws');
-  107 |   }
-  108 | 
-  109 |   /**
-  110 |    * Handle an incoming WebSocket message from a client.
-  111 |    */
-  112 |   async _handleMessage(ws, raw) {
-  113 |     let msg;
-  114 |     try {
-  115 |       msg = JSON.parse(raw.toString());
-  116 |     } catch (e) {
-  117 |       this._sendToClient(ws, { type: 'error', error: 'Invalid JSON' });
-  118 |       return;
-  119 |     }
-  120 | 
-  121 |     if (msg.type === 'invoke') {
-  122 |       // Invoke an IPC handler and return the result
-  123 |       const { id, channel, args } = msg;
-  124 |       console.log(`[Transport] Invoke: channel='${channel}', id=${id}, argsLen=${JSON.stringify(args || []).length}`);
-  125 |       try {
-  126 |         const result = await this._ipcMain.invoke(channel, ...(args || []));
-  127 |         console.log(`[Transport] Invoke '${channel}' completed, sending response`);
-  128 |         this._sendToClient(ws, { type: 'response', id, result, error: null });
-  129 |       } catch (err) {
-  130 |         console.error(`[Transport] Handler error for '${channel}':`, err.message);
-  131 |         this._sendToClient(ws, { type: 'response', id, result: null, error: err.message });
-  132 |       }
-  133 |     } else if (msg.type === 'send') {
-  134 |       // Fire-and-forget message to ipcMain.on() listeners
-  135 |       const { channel, args } = msg;
-  136 |       this._ipcMain.send(channel, ...(args || []));
-  137 |     } else if (msg.type === 'ping') {
-  138 |       this._sendToClient(ws, { type: 'pong', timestamp: Date.now() });
-  139 |     } else {
-  140 |       console.warn(`[Transport] Unknown message type: ${msg.type}`);
-  141 |     }
-  142 |   }
-  143 | 
-  144 |   /**
-  145 |    * Send a message to a specific WebSocket client.
-  146 |    * Handles serialization and closed-connection safety.
-  147 |    */
-  148 |   _sendToClient(ws, message) {
-  149 |     if (!ws || ws.readyState !== WebSocket.OPEN) return;
-  150 |     try {
-  151 |       const payload = JSON.stringify(message);
-  152 |       ws.send(payload);
-  153 |     } catch (e) {
-  154 |       // Serialization errors for large payloads — try truncated
-  155 |       if (e.message?.includes('circular') || e.message?.includes('Converting')) {
-  156 |         try {
-  157 |           const truncated = JSON.stringify({
-  158 |             ...message,
-  159 |             data: typeof message.data === 'string'
-  160 |               ? message.data.substring(0, 100000)
-  161 |               : '[truncated — too large to serialize]',
-  162 |           });
-  163 |           ws.send(truncated);
-  164 |         } catch (_) {
-  165 |           console.error(`[Transport] Failed to send message: ${e.message}`);
-  166 |         }
-  167 |       }
-  168 |     }
-  169 |   }
-  170 | 
-  171 |   /**
-  172 |    * Broadcast an event to ALL connected clients.
-  173 |    */
-  174 |   broadcast(event, data) {
-  175 |     const message = { type: 'event', event, data };
-  176 |     for (const ws of this._clients) {
-  177 |       this._sendToClient(ws, message);
-  178 |     }
-  179 |   }
-  180 | 
-  181 |   /**
-  182 |    * Get the number of connected clients.
-  183 |    */
-  184 |   getClientCount() {
-  185 |     return this._clients.size;
-  186 |   }
-  187 | 
-  188 |   /**
-  189 |    * Check if any client is connected.
-  190 |    */
-  191 |   hasClients() {
-  192 |     return this._clients.size > 0;
-  193 |   }
-  194 | 
-  195 |   /**
-  196 |    * Handle an HTTP upgrade request for the /ws path.
-  197 |    * Called from the centralized upgrade handler in server/main.js.
-  198 |    */
-  199 |   handleUpgrade(request, socket, head) {
-  200 |     this._wss.handleUpgrade(request, socket, head, (ws) => {
-  201 |       this._wss.emit('connection', ws, request);
-  202 |     });
-  203 |   }
-  204 | 
-  205 |   /**
-  206 |    * Shutdown the WebSocket server.
-  207 |    */
-  208 |   shutdown() {
-  209 |     if (this._wss) {
-  210 |       for (const ws of this._clients) {
-  211 |         try { ws.close(1000, 'Server shutting down'); } catch (_) {}
-  212 |       }
-  213 |       this._clients.clear();
-  214 |       this._wss.close();
-  215 |       this._wss = null;
-  216 |     }
-  217 |   }
-  218 | }
-  219 | 
-  220 | module.exports = { Transport };
-  221 | 
```

## Electron-Only Runtime Files (line-by-line)

### appMenu.js (lines: 120)

```diff
+    1 | /**
+    2 |  * guIDE 2.0 — Application Menu (Electron native menu)
+    3 |  *
+    4 |  * Mirrors the custom TitleBar.jsx menus. Shows on Alt key press
+    5 |  * (autoHideMenuBar = true). Sends 'menu-action' IPC to renderer
+    6 |  * which dispatches to the same executeMenuAction handler.
+    7 |  */
+    8 | 'use strict';
+    9 | 
+   10 | const { Menu, shell } = require('electron');
+   11 | 
+   12 | /**
+   13 |  * Build and set the application menu.
+   14 |  * @param {BrowserWindow} mainWindow
+   15 |  */
+   16 | function buildAppMenu(mainWindow) {
+   17 |   const send = (action) => {
+   18 |     if (mainWindow && !mainWindow.isDestroyed()) {
+   19 |       mainWindow.webContents.send('menu-action', action);
+   20 |     }
+   21 |   };
+   22 | 
+   23 |   const template = [
+   24 |     {
+   25 |       label: 'File',
+   26 |       submenu: [
+   27 |         { label: 'New File', accelerator: 'CmdOrCtrl+N', click: () => send('newFile') },
+   28 |         { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('newWindow') },
+   29 |         { label: 'Open Folder...', accelerator: 'CmdOrCtrl+K CmdOrCtrl+O', click: () => send('openFolder') },
+   30 |         { type: 'separator' },
+   31 |         { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
+   32 |         { label: 'Save All', accelerator: 'CmdOrCtrl+K S', click: () => send('saveAll') },
+   33 |         { type: 'separator' },
+   34 |         { label: 'Close Editor', accelerator: 'CmdOrCtrl+W', click: () => send('closeTab') },
+   35 |         { label: 'Close All Editors', click: () => send('closeAllTabs') },
+   36 |         { type: 'separator' },
+   37 |         { role: 'quit', label: 'Exit' },
+   38 |       ],
+   39 |     },
+   40 |     {
+   41 |       label: 'Edit',
+   42 |       submenu: [
+   43 |         { role: 'undo' },
+   44 |         { role: 'redo' },
+   45 |         { type: 'separator' },
+   46 |         { role: 'cut' },
+   47 |         { role: 'copy' },
+   48 |         { role: 'paste' },
+   49 |         { type: 'separator' },
+   50 |         { label: 'Find', accelerator: 'CmdOrCtrl+F', click: () => send('find') },
+   51 |         { label: 'Replace', accelerator: 'CmdOrCtrl+H', click: () => send('replace') },
+   52 |         { label: 'Find in Files', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('findInFiles') },
+   53 |       ],
+   54 |     },
+   55 |     {
+   56 |       label: 'Selection',
+   57 |       submenu: [
+   58 |         { role: 'selectAll' },
+   59 |       ],
+   60 |     },
+   61 |     {
+   62 |       label: 'View',
+   63 |       submenu: [
+   64 |         { label: 'Command Palette...', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('commandPalette') },
+   65 |         { type: 'separator' },
+   66 |         { label: 'Explorer', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('showExplorer') },
+   67 |         { label: 'Search', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('findInFiles') },
+   68 |         { label: 'Source Control', accelerator: 'CmdOrCtrl+Shift+G', click: () => send('showGit') },
+   69 |         { label: 'AI Chat', accelerator: 'CmdOrCtrl+Shift+A', click: () => send('showChat') },
+   70 |         { type: 'separator' },
+   71 |         { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => send('toggleSidebar') },
+   72 |         { label: 'Toggle Panel', accelerator: 'CmdOrCtrl+J', click: () => send('togglePanel') },
+   73 |         { label: 'Toggle Chat Panel', click: () => send('toggleChat') },
+   74 |         { type: 'separator' },
+   75 |         { label: 'Toggle Minimap', click: () => send('toggleMinimap') },
+   76 |         { label: 'Toggle Word Wrap', click: () => send('toggleWordWrap') },
+   77 |         { type: 'separator' },
+   78 |         { role: 'zoomIn' },
+   79 |         { role: 'zoomOut' },
+   80 |         { role: 'resetZoom' },
+   81 |         { type: 'separator' },
+   82 |         { role: 'toggleDevTools' },
+   83 |       ],
+   84 |     },
+   85 |     {
+   86 |       label: 'Go',
+   87 |       submenu: [
+   88 |         { label: 'Go to File...', accelerator: 'CmdOrCtrl+P', click: () => send('goToFile') },
+   89 |         { label: 'Go to Line...', accelerator: 'CmdOrCtrl+G', click: () => send('goToLine') },
+   90 |       ],
+   91 |     },
+   92 |     {
+   93 |       label: 'Terminal',
+   94 |       submenu: [
+   95 |         { label: 'New Terminal', accelerator: 'Ctrl+`', click: () => send('newTerminal') },
+   96 |         { label: 'Toggle Terminal', accelerator: 'CmdOrCtrl+J', click: () => send('togglePanel') },
+   97 |       ],
+   98 |     },
+   99 |     {
+  100 |       label: 'Help',
+  101 |       submenu: [
+  102 |         { label: 'Welcome', click: () => send('showWelcome') },
+  103 |         { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+K CmdOrCtrl+S', click: () => send('showShortcuts') },
+  104 |         { type: 'separator' },
+  105 |         {
+  106 |           label: 'guIDE on GitHub',
+  107 |           click: () => shell.openExternal('https://github.com/graysoft-dev/guide-ide'),
+  108 |         },
+  109 |         { type: 'separator' },
+  110 |         { label: 'About guIDE', click: () => send('about') },
+  111 |       ],
+  112 |     },
+  113 |   ];
+  114 | 
+  115 |   const menu = Menu.buildFromTemplate(template);
+  116 |   Menu.setApplicationMenu(menu);
+  117 | }
+  118 | 
+  119 | module.exports = { buildAppMenu };
+  120 | 
```

### electron-main.js (lines: 1317)

```diff
+    1 | /**
+    2 |  * guIDE 2.0 — Electron Main Process (IPC Architecture)
+    3 |  *
+    4 |  * All services run in-process. All communication via Electron IPC.
+    5 |  * No child process fork, no HTTP server, no WebSocket.
+    6 |  *
+    7 |  * This replaces the old electron-main.js that forked server/main.js.
+    8 |  */
+    9 | 'use strict';
+   10 | 
+   11 | const { app, BrowserWindow, shell, ipcMain, dialog, safeStorage } = require('electron');
+   12 | const path = require('path');
+   13 | const fs = require('fs');
+   14 | const fsP = require('fs').promises;
+   15 | const os = require('os');
+   16 | const http = require('http');
+   17 | const { buildAppMenu } = require('./appMenu');
+   18 | const { AutoUpdater } = require('./autoUpdater');
+   19 | 
+   20 | // ─── GPU / V8 flags ─────────────────────────────────────────────────
+   21 | app.commandLine.appendSwitch('disable-gpu-sandbox');
+   22 | app.commandLine.appendSwitch('ignore-gpu-blocklist');
+   23 | app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');
+   24 | 
+   25 | let mainWindow = null;
+   26 | 
+   27 | // ─── Paths ───────────────────────────────────────────────────────────
+   28 | const ROOT_DIR = __dirname;
+   29 | const MODELS_DIR = path.join(ROOT_DIR, 'models');
+   30 | const FRONTEND_DIST = path.join(ROOT_DIR, 'frontend', 'dist');
+   31 | 
+   32 | // ─── Loading screen ──────────────────────────────────────────────────
+   33 | const LOADING_HTML = `<!DOCTYPE html>
+   34 | <html><head><meta charset="UTF-8">
+   35 | <link rel="preconnect" href="https://fonts.googleapis.com">
+   36 | <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
+   37 | <link href="https://fonts.googleapis.com/css2?family=Audiowide&display=swap" rel="stylesheet">
+   38 | <style>
+   39 | * { margin: 0; padding: 0; box-sizing: border-box; }
+   40 | html, body {
+   41 |   height: 100%; background: #0d0d0d; color: #e5e7eb;
+   42 |   font-family: 'Audiowide', 'Courier New', monospace;
+   43 |   display: flex; align-items: center; justify-content: center;
+   44 |   flex-direction: column; gap: 20px;
+   45 |   -webkit-app-region: drag; user-select: none;
+   46 | }
+   47 | .logo { font-size: 26px; font-weight: 400; letter-spacing: 2px; color: #fff; }
+   48 | .logo span { color: #4f9cf9; }
+   49 | .spinner {
+   50 |   width: 28px; height: 28px;
+   51 |   border: 3px solid #2a2a2a; border-top-color: #4f9cf9;
+   52 |   border-radius: 50%; animation: spin 0.75s linear infinite;
+   53 | }
+   54 | @keyframes spin { to { transform: rotate(360deg); } }
+   55 | .sub { font-size: 12px; color: #4b5563; font-family: -apple-system, sans-serif; }
+   56 | </style></head><body>
+   57 |   <div class="logo">gu<span>IDE</span></div>
+   58 |   <div class="spinner"></div>
+   59 |   <div class="sub">Loading...</div>
+   60 | </body></html>`;
+   61 | 
+   62 | // ─── Create window ───────────────────────────────────────────────────
+   63 | 
+   64 | function createWindow() {
+   65 |   mainWindow = new BrowserWindow({
+   66 |     width: 1400,
+   67 |     height: 900,
+   68 |     minWidth: 900,
+   69 |     minHeight: 600,
+   70 |     title: 'guIDE',
+   71 |     icon: path.join(__dirname, 'build', 'icon.ico'),
+   72 |     backgroundColor: '#0d0d0d',
+   73 |     frame: false,
+   74 |     titleBarStyle: 'hidden',
+   75 |     autoHideMenuBar: true,
+   76 |     show: false,
+   77 |     webPreferences: {
+   78 |       contextIsolation: true,
+   79 |       nodeIntegration: false,
+   80 |       sandbox: false,
+   81 |       preload: path.join(app.getAppPath(), 'preload.js'),
+   82 |     },
+   83 |   });
+   84 | 
+   85 |   // Show loading screen while services initialize
+   86 |   mainWindow.loadURL('data:text/html,' + encodeURIComponent(LOADING_HTML));
+   87 | 
+   88 |   mainWindow.once('ready-to-show', () => {
+   89 |     mainWindow.show();
+   90 |     mainWindow.focus();
+   91 |   });
+   92 | 
+   93 |   mainWindow.on('closed', () => { mainWindow = null; });
+   94 | 
+   95 |   mainWindow.webContents.setWindowOpenHandler(({ url }) => {
+   96 |     if (url.startsWith('file://')) return { action: 'allow' };
+   97 |     shell.openExternal(url);
+   98 |     return { action: 'deny' };
+   99 |   });
+  100 | }
+  101 | 
+  102 | // ─── Window control IPC ─────────────────────────────────────────────
+  103 | ipcMain.handle('win-minimize', () => { mainWindow?.minimize(); });
+  104 | ipcMain.handle('win-maximize', () => {
+  105 |   if (mainWindow?.isMaximized()) mainWindow.unmaximize();
+  106 |   else mainWindow?.maximize();
+  107 | });
+  108 | ipcMain.handle('win-close', () => { mainWindow?.close(); });
+  109 | ipcMain.handle('win-is-maximized', () => mainWindow?.isMaximized() ?? false);
+  110 | 
+  111 | // ─── New window ──────────────────────────────────────────────────────
+  112 | ipcMain.handle('new-window', () => {
+  113 |   const { spawn } = require('child_process');
+  114 |   spawn(process.execPath, process.argv.slice(1), {
+  115 |     detached: true,
+  116 |     stdio: 'ignore',
+  117 |     env: { ...process.env },
+  118 |   }).unref();
+  119 | });
+  120 | 
+  121 | // ─── Dialog IPC ─────────────────────────────────────────────────────
+  122 | ipcMain.handle('dialog-open-folder', async () => {
+  123 |   const result = await dialog.showOpenDialog(mainWindow, {
+  124 |     properties: ['openDirectory'],
+  125 |     title: 'Open Folder',
+  126 |   });
+  127 |   if (result.canceled || !result.filePaths.length) return null;
+  128 |   return result.filePaths[0];
+  129 | });
+  130 | 
+  131 | ipcMain.handle('dialog-models-add', async () => {
+  132 |   const result = await dialog.showOpenDialog(mainWindow, {
+  133 |     properties: ['openFile', 'multiSelections'],
+  134 |     title: 'Select Model Files',
+  135 |     filters: [
+  136 |       { name: 'GGUF Models', extensions: ['gguf'] },
+  137 |       { name: 'All Files', extensions: ['*'] },
+  138 |     ],
+  139 |   });
+  140 |   if (result.canceled || !result.filePaths.length) return { success: false };
+  141 |   try {
+  142 |     await modelManager.addModels(result.filePaths);
+  143 |     return { success: true, filePaths: result.filePaths };
+  144 |   } catch (e) {
+  145 |     return { success: false, error: e.message };
+  146 |   }
+  147 | });
+  148 | 
+  149 | ipcMain.handle('shell-show-item', (_event, fullPath) => {
+  150 |   if (typeof fullPath === 'string' && fullPath.length > 0) {
+  151 |     shell.showItemInFolder(fullPath);
+  152 |   }
+  153 | });
+  154 | 
+  155 | ipcMain.handle('shell-open-external', (_event, url) => {
+  156 |   if (typeof url === 'string' && url.startsWith('http')) {
+  157 |     shell.openExternal(url);
+  158 |   }
+  159 | });
+  160 | 
+  161 | // ─── Load modules ──────────────────────────────────────────
+  162 | 
+  163 | const userDataPath = app.getPath('userData');
+  164 | const modelsBasePath = app.isPackaged ? userDataPath : ROOT_DIR;
+  165 | 
+  166 | // Ensure directories
+  167 | for (const dir of [MODELS_DIR, userDataPath, path.join(userDataPath, 'sessions'), path.join(userDataPath, 'logs')]) {
+  168 |   try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
+  169 | }
+  170 | 
+  171 | const log = require('./logger');
+  172 | log.installConsoleIntercepts();
+  173 | 
+  174 | const { ChatEngine, buildEngineLoadSettings } = require('./chatEngine');
+  175 | const { MCPToolServer } = require('./mcpToolServer');
+  176 | const { ModelManager } = require('./modelManager');
+  177 | const { MemoryStore } = require('./memoryStore');
+  178 | const { LongTermMemory } = require('./longTermMemory');
+  179 | const { RulesManager } = require('./rulesManager');
+  180 | const { SessionStore } = require('./sessionStore');
+  181 | const { CloudLLMService } = require('./cloudLLMService');
+  182 | const { SettingsManager } = require('./settingsManager');
+  183 | const { GitManager } = require('./gitManager');
+  184 | const { BrowserManager } = require('./browserManager');
+  185 | const { FirstRunSetup } = require('./firstRunSetup');
+  186 | const { RAGEngine } = require('./ragEngine');
+  187 | const { AccountManager } = require('./accountManager');
+  188 | const { LicenseManager } = require('./licenseManager');
+  189 | const { ExtensionManager } = require('./extensionManager');
+  190 | const { DebugService } = require('./debugService');
+  191 | const { ModelDownloader } = require('./server/modelDownloader');
+  192 | const liveServer = require('./server/liveServer');
+  193 | const WebSearch = require('./webSearch');
+  194 | const { TEMPLATES } = require('./server/templateHandlers');
+  195 | 
+  196 | // ─── Initialize services ────────────────────────────────────────────
+  197 | const llmEngine = new ChatEngine();
+  198 | const webSearch = new WebSearch();
+  199 | const mcpToolServer = new MCPToolServer({ projectPath: null, webSearch });
+  200 | const gitManager = new GitManager();
+  201 | const memoryStore = new MemoryStore();
+  202 | const longTermMemory = new LongTermMemory();
+  203 | const rulesManager = new RulesManager();
+  204 | const modelManager = new ModelManager(modelsBasePath);
+  205 | const sessionStore = new SessionStore(path.join(userDataPath, 'sessions'));
+  206 | const cloudLLM = new CloudLLMService();
+  207 | const modelDownloader = new ModelDownloader(path.join(ROOT_DIR, 'models'));
+  208 | const ragEngine = new RAGEngine();
+  209 | const settingsManager = new SettingsManager(userDataPath);
+  210 | const firstRunSetup = new FirstRunSetup(settingsManager);
+  211 | const accountManager = new AccountManager(settingsManager);
+  212 | const licenseManager = new LicenseManager(settingsManager, accountManager);
+  213 | const extensionManager = new ExtensionManager(userDataPath);
+  214 | const debugService = new DebugService();
+  215 | 
+  216 | // BrowserManager needs mainWindow reference for event forwarding
+  217 | const browserManager = new BrowserManager({
+  218 |   liveServer,
+  219 |   parentWindow: { webContents: { send: (e, d) => _send(e, d) }, isDestroyed: () => !mainWindow },
+  220 | });
+  221 | 
+  222 | // Wire service cross-references
+  223 | mcpToolServer.setBrowserManager({ parentWindow: { webContents: { send: (e, d) => _send(e, d) }, isDestroyed: () => !mainWindow } });
+  224 | mcpToolServer.setGitManager(gitManager);
+  225 | mcpToolServer.rulesManager = rulesManager;
+  226 | mcpToolServer.onTodoUpdate = (todos) => _send('todo-update', todos);
+  227 | cloudLLM.setLicenseManager(licenseManager);
+  228 | 
+  229 | // Restore persisted API keys
+  230 | const savedKeys = settingsManager.getAllApiKeys();
+  231 | for (const [provider, key] of Object.entries(savedKeys)) {
+  232 |   if (key && key.trim()) {
+  233 |     cloudLLM.setApiKey(provider, key);
+  234 |   }
+  235 | }
+  236 | 
+  237 | // License state already restored in LicenseManager constructor
+  238 | 
+  239 | // Initialize extensions (async, non-blocking)
+  240 | extensionManager.initialize().catch(err => console.error('[Main] Extension init error:', err.message));
+  241 | 
+  242 | let currentSettings = settingsManager.getAll();
+  243 | let currentProjectPath = null;
+  244 | let agenticCancelled = false;
+  245 | let autoUpdater = null;
+  246 | 
+  247 | async function openProjectPath(projectPath) {
+  248 |   const resolved = path.resolve(projectPath);
+  249 |   if (!fs.existsSync(resolved)) {
+  250 |     const error = new Error('Directory not found');
+  251 |     error.statusCode = 404;
+  252 |     throw error;
+  253 |   }
+  254 | 
+  255 |   currentProjectPath = resolved;
+  256 |   ctx.currentProjectPath = resolved;
+  257 |   mcpToolServer.projectPath = resolved;
+  258 |   gitManager.setProjectPath(resolved);
+  259 |   memoryStore.initialize(resolved);
+  260 |   longTermMemory.initialize(resolved);
+  261 |   rulesManager.initialize(resolved);
+  262 |   ragEngine.indexProject(resolved).catch(e => console.warn('[Main] RAG indexing failed:', e.message));
+  263 |   _send('project-opened', { path: resolved });
+  264 | 
+  265 |   return { path: resolved };
+  266 | }
+  267 | 
+  268 | // Helper to send events to renderer
+  269 | function _send(event, data) {
+  270 |   if (mainWindow && !mainWindow.isDestroyed()) {
+  271 |     mainWindow.webContents.send(event, data);
+  272 |   }
+  273 | }
+  274 | 
+  275 | const ctx = {
+  276 |   llmEngine,
+  277 |   mcpToolServer,
+  278 |   memoryStore,
+  279 |   longTermMemory,
+  280 |   modelManager,
+  281 |   sessionStore,
+  282 |   userDataPath,
+  283 |   get currentProjectPath() { return currentProjectPath; },
+  284 |   set currentProjectPath(v) { currentProjectPath = v; },
+  285 |   get agenticCancelled() { return agenticCancelled; },
+  286 |   set agenticCancelled(v) { agenticCancelled = v; },
+  287 |   getMainWindow: () => mainWindow,
+  288 |   cloudLLM,
+  289 |   playwrightBrowser: null,
+  290 |   browserManager,
+  291 |   ragEngine,
+  292 |   webSearch,
+  293 |   licenseManager,
+  294 |   _truncateResult: (result) => {
+  295 |     if (!result) return result;
+  296 |     const str = typeof result === 'string' ? result : JSON.stringify(result);
+  297 |     return str.length > 8000 ? str.substring(0, 8000) + '...[truncated]' : result;
+  298 |   },
+  299 |   _readConfig: () => currentSettings,
+  300 | };
+  301 | 
+  302 | // ─── Rules/Skills API ───────────────────────────────────────────────
+  303 | ipcMain.handle('rules-list', () => rulesManager.listRules());
+  304 | ipcMain.handle('rules-save', (_e, name, content) => rulesManager.saveRule(name, content));
+  305 | ipcMain.handle('rules-delete', (_e, name) => rulesManager.deleteRule(name));
+  306 | 
+  307 | // Register ai-chat handler for basic model chat
+  308 | ipcMain.handle('ai-chat', async (_event, userMessage, chatContext) => {
+  309 |   if (!llmEngine.isReady) {
+  310 |     return { error: 'No model loaded. Please load a model first.' };
+  311 |   }
+  312 |   try {
+  313 |     agenticCancelled = false;
+  314 |     const settings = chatContext?.params || chatContext?.settings || {};
+  315 | 
+  316 |     // Build tool functions from enabled tool definitions
+  317 |     const toolDefs = mcpToolServer.getToolDefinitions();
+  318 |     const functions = ChatEngine.convertToolDefs(toolDefs);
+  319 |     const toolPrompt = mcpToolServer.getToolPrompt();
+  320 |     const compactHints = mcpToolServer.getCompactToolHint('full', { minimal: true });
+  321 |     const compactToolPrompt = Array.isArray(compactHints) ? compactHints.join('\n') : (compactHints || '');
+  322 | 
+  323 |     const result = await llmEngine.chat(userMessage, {
+  324 |       onToken: (token) => _send('llm-token', token),
+  325 |       onContextUsage: (data) => _send('context-usage', data),
+  326 |       onToolCall: (data) => _send('tool-call', data),
+  327 |       onStreamEvent: (eventName, data) => _send(eventName, data),
+  328 |       attachments: Array.isArray(chatContext?.attachments) ? chatContext.attachments : [],
+  329 |       functions,
+  330 |       toolPrompt,
+  331 |       compactToolPrompt,
+  332 |       executeToolFn: async (toolName, params) => {
+  333 |         return await mcpToolServer.executeTool(toolName, params);
+  334 |       },
+  335 |       systemPrompt: (settings.systemPrompt || '') + rulesManager.getRulesPrompt() || undefined,
+  336 |       temperature: settings.temperature,
+  337 |       maxTokens: settings.maxTokens || -1,
+  338 |       topP: settings.topP,
+  339 |       topK: settings.topK,
+  340 |       repeatPenalty: settings.repeatPenalty,
+  341 |       thinkingBudget: settings.thinkingBudget ?? 2048,
+  342 |       generationTimeoutSec: settings.generationTimeoutSec ?? 0,
+  343 |     });
+  344 |     return { text: result.text, toolCallCount: result.toolCallCount };
+  345 |   } catch (err) {
+  346 |     return { error: err.message };
+  347 |   }
+  348 | });
+  349 | 
+  350 | ipcMain.handle('cancel-generation', async () => {
+  351 |   llmEngine.cancelGeneration('user');
+  352 |   return { success: true };
+  353 | });
+  354 | 
+  355 | ipcMain.handle('agent-pause', async () => {
+  356 |   llmEngine.cancelGeneration('user');
+  357 |   return { success: true };
+  358 | });
+  359 | 
+  360 | // ─── Generic API-fetch IPC handler ──────────────────────────────────
+  361 | // The frontend's fetch('/api/...') calls are intercepted and routed here.
+  362 | // This replaces the entire Express REST API from server/main.js.
+  363 | 
+  364 | ipcMain.handle('api-fetch', async (_event, url, options) => {
+  365 |   const method = (options?.method || 'GET').toUpperCase();
+  366 |   let body = {};
+  367 |   if (options?.body) {
+  368 |     try { body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body; } catch (_) {}
+  369 |   }
+  370 | 
+  371 |   // Parse URL
+  372 |   const urlObj = new URL(url, 'http://localhost');
+  373 |   const p = urlObj.pathname;
+  374 |   const q = Object.fromEntries(urlObj.searchParams);
+  375 | 
+  376 |   try {
+  377 |     // ── Models ──────────────────────────────────────────
+  378 |     if (p === '/api/models' && method === 'GET') {
+  379 |       return { models: modelManager.availableModels, status: llmEngine.getStatus() };
+  380 |     }
+  381 |     if (p === '/api/models/load' && method === 'POST') {
+  382 |       const { modelPath } = body;
+  383 |       if (!modelPath) return { _status: 400, error: 'modelPath required' };
+  384 |       try { llmEngine.cancelGeneration('model-load'); } catch (_) {}
+  385 |       _send('model-loading', { path: modelPath });
+  386 |       await llmEngine.initialize(modelPath, buildEngineLoadSettings(settingsManager.getAll()));
+  387 |       const info = llmEngine.modelInfo;
+  388 |       settingsManager.set('lastModelPath', modelPath);
+  389 |       _send('model-loaded', info);
+  390 |       return { success: true, modelInfo: info };
+  391 |     }
+  392 |     if (p === '/api/models/unload' && method === 'POST') {
+  393 |       await llmEngine.dispose();
+  394 |       return { success: true };
+  395 |     }
+  396 |     if (p === '/api/models/status' && method === 'GET') {
+  397 |       return llmEngine.getStatus();
+  398 |     }
+  399 |     if (p === '/api/models/scan' && method === 'POST') {
+  400 |       const models = await modelManager.scanModels();
+  401 |       return { models };
+  402 |     }
+  403 |     if (p === '/api/models/add' && method === 'POST') {
+  404 |       const { filePaths } = body;
+  405 |       if (!filePaths || !Array.isArray(filePaths)) return { _status: 400, error: 'filePaths array required' };
+  406 |       const added = await modelManager.addModels(filePaths);
+  407 |       return { added };
+  408 |     }
+  409 |     if (p === '/api/models/upload' && method === 'POST') {
+  410 |       // IPC file upload: expects body._files = [{ name, buffer }]
+  411 |       const files = body._files;
+  412 |       if (!files || !Array.isArray(files) || files.length === 0) {
+  413 |         return { _status: 400, error: 'No files provided' };
+  414 |       }
+  415 |       const saved = [];
+  416 |       for (const file of files) {
+  417 |         const filename = path.basename(file.name);
+  418 |         if (!filename.endsWith('.gguf')) continue;
+  419 |         const destPath = path.join(MODELS_DIR, filename);
+  420 |         await fsP.writeFile(destPath, Buffer.from(file.buffer));
+  421 |         saved.push(filename);
+  422 |       }
+  423 |       if (saved.length === 0) return { _status: 400, error: 'No .gguf files found in upload' };
+  424 |       await modelManager.scanModels();
+  425 |       return { success: true, saved };
+  426 |     }
+  427 |     if (p === '/api/models/recommend' && method === 'GET') {
+  428 |       let vramMB = 0;
+  429 |       try {
+  430 |         const { execSync } = require('child_process');
+  431 |         const out = execSync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits', { timeout: 5000 }).toString().trim();
+  432 |         vramMB = parseInt(out.split('\n')[0], 10) || 0;
+  433 |       } catch { /* no GPU */ }
+  434 |       const maxModelGB = vramMB > 0 ? Math.floor((vramMB * 0.85) / 1024) : 4;
+  435 |       const recommended = [
+  436 |         { name: 'Qwen 3.5 0.8B', file: 'Qwen3.5-0.8B-Q8_0.gguf', size: 0.8, desc: 'Tiny, ultra-fast', downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf', tags: ['general'] },
+  437 |         { name: 'Qwen 3.5 4B', file: 'Qwen3.5-4B-Q8_0.gguf', size: 4.5, desc: 'Great balance', downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q8_0.gguf', tags: ['coding', 'general'] },
+  438 |         { name: 'Qwen 3.5 9B', file: 'Qwen3.5-9B-Q4_K_M.gguf', size: 5.7, desc: 'Strong all-rounder', downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf', tags: ['coding', 'reasoning'] },
+  439 |         { name: 'Qwen 3.5 27B', file: 'Qwen3.5-27B-Q4_K_M.gguf', size: 16.7, desc: 'High quality', downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-27B-GGUF/resolve/main/Qwen3.5-27B-Q4_K_M.gguf', tags: ['coding', 'reasoning'] },
+  440 |         { name: 'Qwen 3.5 35B-A3B (MoE)', file: 'Qwen3.5-35B-A3B-Q4_K_M.gguf', size: 22.0, desc: 'MoE, fast for size', downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-35B-A3B-GGUF/resolve/main/Qwen3.5-35B-A3B-Q4_K_M.gguf', tags: ['coding', 'reasoning'] },
+  441 |       ];
+  442 |       const fits = recommended.filter(m => m.size <= maxModelGB);
+  443 |       const other = recommended.filter(m => m.size > maxModelGB);
+  444 |       return { fits, other, maxModelGB, vramMB };
+  445 |     }
+  446 | 
+  447 |     // ── HuggingFace model downloads ─────────────────────
+  448 |     if (p === '/api/models/hf/search' && method === 'GET') {
+  449 |       const query = q.q;
+  450 |       if (!query || !query.trim()) return { models: [] };
+  451 |       const models = await modelDownloader.searchModels(query.trim());
+  452 |       return { models };
+  453 |     }
+  454 |     if (p.startsWith('/api/models/hf/files/') && method === 'GET') {
+  455 |       const parts = p.replace('/api/models/hf/files/', '').split('/');
+  456 |       const repoId = parts.slice(0, 2).join('/');
+  457 |       const result = await modelDownloader.getRepoFiles(repoId);
+  458 |       return result;
+  459 |     }
+  460 |     if (p === '/api/models/hf/download' && method === 'POST') {
+  461 |       const { url: dlUrl, fileName } = body;
+  462 |       if (!dlUrl || !fileName) return { _status: 400, error: 'url and fileName required' };
+  463 |       const result = await modelDownloader.downloadModel(dlUrl, fileName);
+  464 |       return { success: true, ...result };
+  465 |     }
+  466 |     if (p === '/api/models/hf/cancel' && method === 'POST') {
+  467 |       const { id } = body;
+  468 |       if (!id) return { _status: 400, error: 'id required' };
+  469 |       return { success: modelDownloader.cancelDownload(id) };
+  470 |     }
+  471 |     if (p === '/api/models/hf/downloads' && method === 'GET') {
+  472 |       return { downloads: modelDownloader.getActiveDownloads() };
+  473 |     }
+  474 | 
+  475 |     // ── GPU ─────────────────────────────────────────────
+  476 |     if (p === '/api/gpu' && method === 'GET') {
+  477 |       const info = await llmEngine.getGPUInfo();
+  478 |       const totalMem = os.totalmem();
+  479 |       const freeMem = os.freemem();
+  480 |       info.ramTotalGB = (totalMem / (1024 ** 3)).toFixed(1);
+  481 |       info.ramUsedGB = ((totalMem - freeMem) / (1024 ** 3)).toFixed(1);
+  482 |       const cpus = os.cpus();
+  483 |       let totalIdle = 0, totalTick = 0;
+  484 |       for (const cpu of cpus) {
+  485 |         for (const type in cpu.times) totalTick += cpu.times[type];
+  486 |         totalIdle += cpu.times.idle;
+  487 |       }
+  488 |       info.cpuUsage = Math.round(100 - (totalIdle / totalTick * 100));
+  489 |       if (llmEngine.modelInfo) {
+  490 |         if (typeof llmEngine.modelInfo.gpuLayers === 'number') {
+  491 |           info.gpuLayers = llmEngine.modelInfo.gpuLayers;
+  492 |         }
+  493 |         if (typeof llmEngine.modelInfo.contextSize === 'number') {
+  494 |           info.modelContextSize = llmEngine.modelInfo.contextSize;
+  495 |         }
+  496 |         if (typeof llmEngine.modelInfo.totalLayers === 'number') {
+  497 |           info.totalLayers = llmEngine.modelInfo.totalLayers;
+  498 |         }
+  499 |       }
+  500 |       return info;
+  501 |     }
+  502 | 
+  503 |     // ── Project ─────────────────────────────────────────
+  504 |     if (p === '/api/project/open' && method === 'POST') {
+  505 |       const { projectPath } = body;
+  506 |       if (!projectPath) return { _status: 400, error: 'projectPath required' };
+  507 |       const openedProject = await openProjectPath(projectPath);
+  508 |       return { success: true, path: openedProject.path };
+  509 |     }
+  510 |     if (p === '/api/project/current' && method === 'GET') {
+  511 |       return { projectPath: currentProjectPath };
+  512 |     }
+  513 | 
+  514 |     // ── Files ───────────────────────────────────────────
+  515 |     if (p === '/api/files/tree' && method === 'GET') {
+  516 |       const dirPath = q.path || currentProjectPath;
+  517 |       if (!dirPath) return { items: [] };
+  518 |       const items = await _readDirRecursive(dirPath, 0, 3);
+  519 |       return { items, root: dirPath };
+  520 |     }
+  521 |     if (p === '/api/files/read' && method === 'GET') {
+  522 |       const filePath = q.path;
+  523 |       if (!filePath) return { _status: 400, error: 'path required' };
+  524 |       const fullPath = path.isAbsolute(filePath) ? filePath : path.join(currentProjectPath || '', filePath);
+  525 |       const content = fs.readFileSync(fullPath, 'utf8');
+  526 |       const ext = path.extname(fullPath).slice(1);
+  527 |       return { content, path: fullPath, extension: ext, name: path.basename(fullPath) };
+  528 |     }
+  529 |     if (p === '/api/files/write' && method === 'POST') {
+  530 |       const { filePath, content } = body;
+  531 |       if (!filePath) return { _status: 400, error: 'filePath required' };
+  532 |       const fullPath = path.isAbsolute(filePath) ? filePath : path.join(currentProjectPath || '', filePath);
+  533 |       fs.mkdirSync(path.dirname(fullPath), { recursive: true });
+  534 |       fs.writeFileSync(fullPath, content || '', 'utf8');
+  535 |       return { success: true, path: fullPath };
+  536 |     }
+  537 |     if (p === '/api/files/create' && method === 'POST') {
+  538 |       const { path: fp, content } = body;
+  539 |       if (!fp) return { _status: 400, error: 'path required' };
+  540 |       const fullPath = path.isAbsolute(fp) ? fp : path.join(currentProjectPath || '', fp);
+  541 |       fs.mkdirSync(path.dirname(fullPath), { recursive: true });
+  542 |       if (fs.existsSync(fullPath)) return { _status: 409, error: 'File already exists' };
+  543 |       fs.writeFileSync(fullPath, content || '', 'utf8');
+  544 |       if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('files-changed');
+  545 |       return { success: true, path: fullPath };
+  546 |     }
+  547 |     if (p === '/api/files/delete' && method === 'POST') {
+  548 |       const { path: fp } = body;
+  549 |       if (!fp) return { _status: 400, error: 'path required' };
+  550 |       const fullPath = path.isAbsolute(fp) ? fp : path.join(currentProjectPath || '', fp);
+  551 |       if (!fs.existsSync(fullPath)) return { _status: 404, error: 'Not found' };
+  552 |       const stat = fs.statSync(fullPath);
+  553 |       if (stat.isDirectory()) {
+  554 |         fs.rmSync(fullPath, { recursive: true, force: true });
+  555 |       } else {
+  556 |         fs.unlinkSync(fullPath);
+  557 |       }
+  558 |       if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('files-changed');
+  559 |       return { success: true };
+  560 |     }
+  561 |     if (p === '/api/files/rename' && method === 'POST') {
+  562 |       const { oldPath, newPath } = body;
+  563 |       if (!oldPath || !newPath) return { _status: 400, error: 'oldPath and newPath required' };
+  564 |       const fullOld = path.isAbsolute(oldPath) ? oldPath : path.join(currentProjectPath || '', oldPath);
+  565 |       const fullNew = path.isAbsolute(newPath) ? newPath : path.join(currentProjectPath || '', newPath);
+  566 |       if (!fs.existsSync(fullOld)) return { _status: 404, error: 'Source not found' };
+  567 |       fs.renameSync(fullOld, fullNew);
+  568 |       if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('files-changed');
+  569 |       return { success: true, path: fullNew };
+  570 |     }
+  571 |     if (p === '/api/files/search' && method === 'GET') {
+  572 |       const basePath = q.path || currentProjectPath;
+  573 |       const query = q.query;
+  574 |       if (!basePath || !query) return { results: [] };
+  575 |       const results = [];
+  576 |       const maxResults = 200;
+  577 |       const searchDir = (dir, depth = 0) => {
+  578 |         if (depth > 6 || results.length >= maxResults) return;
+  579 |         let entries;
+  580 |         try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
+  581 |         for (const entry of entries) {
+  582 |           if (results.length >= maxResults) break;
+  583 |           if (entry.name.startsWith('.') && entry.name !== '.env') continue;
+  584 |           if (['node_modules', '__pycache__', '.git', 'dist', 'build', '.next', 'target'].includes(entry.name)) continue;
+  585 |           const fullPath = path.join(dir, entry.name);
+  586 |           if (entry.isDirectory()) {
+  587 |             searchDir(fullPath, depth + 1);
+  588 |           } else if (entry.isFile()) {
+  589 |             try {
+  590 |               const stat = fs.statSync(fullPath);
+  591 |               if (stat.size > 1024 * 1024) continue;
+  592 |               const content = fs.readFileSync(fullPath, 'utf8');
+  593 |               const lines = content.split('\n');
+  594 |               const lowerQuery = query.toLowerCase();
+  595 |               for (let i = 0; i < lines.length && results.length < maxResults; i++) {
+  596 |                 if (lines[i].toLowerCase().includes(lowerQuery)) {
+  597 |                   results.push({ file: fullPath, line: i + 1, text: lines[i].trim().substring(0, 200) });
+  598 |                 }
+  599 |               }
+  600 |             } catch (_) {}
+  601 |           }
+  602 |         }
+  603 |       };
+  604 |       searchDir(basePath);
+  605 |       return { results };
+  606 |     }
+  607 | 
+  608 |     // ── Settings ────────────────────────────────────────
+  609 |     if (p === '/api/settings' && method === 'GET') {
+  610 |       return settingsManager.getAll();
+  611 |     }
+  612 |     if (p === '/api/settings' && method === 'POST') {
+  613 |       settingsManager.setAll(body);
+  614 |       currentSettings = settingsManager.getAll();
+  615 |       return { success: true };
+  616 |     }
+  617 | 
+  618 |     // ── Cloud LLM ───────────────────────────────────────
+  619 |     if (p === '/api/cloud/status' && method === 'GET') {
+  620 |       return cloudLLM.getStatus();
+  621 |     }
+  622 |     if (p === '/api/cloud/providers' && method === 'GET') {
+  623 |       return { configured: cloudLLM.getConfiguredProviders(), all: cloudLLM.getAllProviders() };
+  624 |     }
+  625 |     if (p.startsWith('/api/cloud/models/') && method === 'GET') {
+  626 |       const provider = p.replace('/api/cloud/models/', '');
+  627 |       if (provider === 'openrouter') {
+  628 |         const models = await cloudLLM.fetchOpenRouterModels();
+  629 |         return { models };
+  630 |       } else if (provider === 'ollama') {
+  631 |         await cloudLLM.detectOllama();
+  632 |         return { models: cloudLLM.getOllamaModels() };
+  633 |       } else {
+  634 |         return { models: cloudLLM._getProviderModels(provider) };
+  635 |       }
+  636 |     }
+  637 |     if (p === '/api/cloud/provider' && method === 'POST') {
+  638 |       const { provider, model } = body;
+  639 |       if (!provider) return { _status: 400, error: 'provider required' };
+  640 |       cloudLLM.activeProvider = provider;
+  641 |       if (model) cloudLLM.activeModel = model;
+  642 |       return { success: true, activeProvider: cloudLLM.activeProvider, activeModel: cloudLLM.activeModel };
+  643 |     }
+  644 |     if (p === '/api/cloud/apikey' && method === 'POST') {
+  645 |       const { provider, key } = body;
+  646 |       if (!provider) return { _status: 400, error: 'provider required' };
+  647 |       cloudLLM.setApiKey(provider, key || '');
+  648 |       settingsManager.setApiKey(provider, key || '');
+  649 |       return { success: true, hasKey: !!(key && key.trim()) };
+  650 |     }
+  651 |     if (p.startsWith('/api/cloud/pool/') && method === 'GET') {
+  652 |       const provider = p.replace('/api/cloud/pool/', '');
+  653 |       return cloudLLM.getPoolStatus(provider);
+  654 |     }
+  655 |     if (p.startsWith('/api/cloud/test/') && method === 'GET') {
+  656 |       const provider = p.replace('/api/cloud/test/', '');
+  657 |       if (!provider) return { success: false, error: 'provider required' };
+  658 |       const key = cloudLLM.apiKeys[provider];
+  659 |       if (!key) return { success: false, error: 'No API key set' };
+  660 |       const models = cloudLLM._getProviderModels(provider);
+  661 |       const testModel = models[0]?.id;
+  662 |       if (!testModel) return { success: false, error: 'No models for provider' };
+  663 |       const prevProvider = cloudLLM.activeProvider;
+  664 |       const prevModel = cloudLLM.activeModel;
+  665 |       cloudLLM.activeProvider = provider;
+  666 |       cloudLLM.activeModel = testModel;
+  667 |       try {
+  668 |         await Promise.race([
+  669 |           cloudLLM.generate([{ role: 'user', content: 'Say hi' }], { maxTokens: 5, stream: false }),
+  670 |           new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout after 15s')), 15000)),
+  671 |         ]);
+  672 |         return { success: true };
+  673 |       } catch (e) {
+  674 |         return { success: false, error: e.message };
+  675 |       } finally {
+  676 |         cloudLLM.activeProvider = prevProvider;
+  677 |         cloudLLM.activeModel = prevModel;
+  678 |       }
+  679 |     }
+  680 | 
+  681 |     // ── Git ──────────────────────────────────────────────
+  682 |     if (p === '/api/git/status' && method === 'GET') {
+  683 |       const basePath = q.path || currentProjectPath;
+  684 |       if (!basePath) return { error: 'No project path' };
+  685 |       try {
+  686 |         return gitManager.getStatus(basePath);
+  687 |       } catch (e) {
+  688 |         return { error: e.message, branch: '', staged: [], modified: [], untracked: [] };
+  689 |       }
+  690 |     }
+  691 |     if (p === '/api/git/stage' && method === 'POST') {
+  692 |       const basePath = body.path || currentProjectPath;
+  693 |       if (!basePath) return { _status: 400, error: 'No project path' };
+  694 |       if (body.all) {
+  695 |         gitManager.stageAll(basePath);
+  696 |       } else if (body.files && Array.isArray(body.files)) {
+  697 |         gitManager.stageFiles(body.files, basePath);
+  698 |       } else {
+  699 |         return { _status: 400, error: 'Provide files array or all:true' };
+  700 |       }
+  701 |       return { success: true };
+  702 |     }
+  703 |     if (p === '/api/git/unstage' && method === 'POST') {
+  704 |       const basePath = body.path || currentProjectPath;
+  705 |       if (!basePath) return { _status: 400, error: 'No project path' };
+  706 |       if (body.all) {
+  707 |         gitManager.unstageAll(basePath);
+  708 |       } else if (body.files && Array.isArray(body.files)) {
+  709 |         gitManager.unstageFiles(body.files, basePath);
+  710 |       } else {
+  711 |         return { _status: 400, error: 'Provide files array or all:true' };
+  712 |       }
+  713 |       return { success: true };
+  714 |     }
+  715 |     if (p === '/api/git/commit' && method === 'POST') {
+  716 |       const basePath = body.path || currentProjectPath;
+  717 |       const message = body.message;
+  718 |       if (!basePath) return { _status: 400, error: 'No project path' };
+  719 |       if (!message || !message.trim()) return { _status: 400, error: 'Commit message required' };
+  720 |       return gitManager.commit(message, basePath);
+  721 |     }
+  722 |     if (p === '/api/git/discard' && method === 'POST') {
+  723 |       const basePath = body.path || currentProjectPath;
+  724 |       if (!basePath) return { _status: 400, error: 'No project path' };
+  725 |       if (body.files && Array.isArray(body.files)) {
+  726 |         gitManager.discardFiles(body.files, basePath);
+  727 |       } else {
+  728 |         return { _status: 400, error: 'Provide files array' };
+  729 |       }
+  730 |       return { success: true };
+  731 |     }
+  732 |     if (p === '/api/git/diff' && method === 'GET') {
+  733 |       const basePath = q.path || currentProjectPath;
+  734 |       if (!basePath) return { _status: 400, error: 'No project path' };
+  735 |       return gitManager.getDiff({ staged: q.staged === 'true', file: q.file }, basePath);
+  736 |     }
+  737 |     if (p === '/api/git/log' && method === 'GET') {
+  738 |       const basePath = q.path || currentProjectPath;
+  739 |       if (!basePath) return { _status: 400, error: 'No project path' };
+  740 |       const count = parseInt(q.count) || 20;
+  741 |       return gitManager.getLog(count, basePath);
+  742 |     }
+  743 |     if (p === '/api/git/branches' && method === 'GET') {
+  744 |       const basePath = q.path || currentProjectPath;
+  745 |       if (!basePath) return { _status: 400, error: 'No project path' };
+  746 |       return gitManager.getBranches(basePath);
+  747 |     }
+  748 |     if (p === '/api/git/checkout' && method === 'POST') {
+  749 |       const basePath = body.path || currentProjectPath;
+  750 |       const branch = body.branch;
+  751 |       if (!basePath) return { _status: 400, error: 'No project path' };
+  752 |       if (!branch) return { _status: 400, error: 'Branch name required' };
+  753 |       return gitManager.checkout(branch, { create: !!body.create }, basePath);
+  754 |     }
+  755 | 
+  756 |     // ── License ─────────────────────────────────────────
+  757 |     if (p === '/api/license/status' && method === 'GET') {
+  758 |       return {
+  759 |         isActivated: licenseManager.isActivated || false,
+  760 |         isAuthenticated: accountManager.isAuthenticated || false,
+  761 |         license: licenseManager.licenseData || null,
+  762 |         machineId: licenseManager.machineId || null,
+  763 |         user: accountManager.user || null,
+  764 |         plan: licenseManager.getPlan(),
+  765 |       };
+  766 |     }
+  767 |     if (p === '/api/license/activate' && method === 'POST') {
+  768 |       const { method: activationMethod, key, email, password } = body;
+  769 |       if (activationMethod === 'key') {
+  770 |         return await licenseManager.activateKey(key);
+  771 |       } else if (activationMethod === 'account') {
+  772 |         if (email && password) {
+  773 |           const loginResult = await accountManager.loginWithEmail(email, password);
+  774 |           if (!loginResult.success) return loginResult;
+  775 |         }
+  776 |         return await licenseManager.activateAccount();
+  777 |       } else {
+  778 |         return { success: false, error: 'Invalid activation method. Use "key" or "account".' };
+  779 |       }
+  780 |     }
+  781 |     if (p === '/api/license/oauth' && method === 'POST') {
+  782 |       const { provider } = body;
+  783 |       if (!provider || !['google', 'github'].includes(provider)) {
+  784 |         return { success: false, error: 'Invalid OAuth provider' };
+  785 |       }
+  786 |       const { url: oauthUrl } = accountManager.getOAuthURL(provider);
+  787 |       return { success: true, url: oauthUrl };
+  788 |     }
+  789 |     if (p === '/api/license/deactivate' && method === 'POST') {
+  790 |       licenseManager.deactivate();
+  791 |       accountManager.logout();
+  792 |       return { success: true };
+  793 |     }
+  794 |     if (p === '/api/license/plans' && method === 'GET') {
+  795 |       return { plans: licenseManager.getPlans ? licenseManager.getPlans() : [] };
+  796 |     }
+  797 |     if (p === '/api/stripe/checkout' && method === 'POST') {
+  798 |       const { plan } = body;
+  799 |       return await licenseManager.createCheckoutSession(plan);
+  800 |     }
+  801 |     if (p === '/api/stripe/subscription' && method === 'GET') {
+  802 |       return await licenseManager.checkSubscription();
+  803 |     }
+  804 | 
+  805 |     // ── Account ─────────────────────────────────────────
+  806 |     if (p === '/api/account/status' && method === 'GET') {
+  807 |       return {
+  808 |         isAuthenticated: accountManager._isAuthenticated,
+  809 |         user: accountManager._user,
+  810 |         machineId: accountManager._machineId,
+  811 |       };
+  812 |     }
+  813 |     if (p === '/api/account/login' && method === 'POST') {
+  814 |       const { email, password } = body;
+  815 |       return await accountManager.loginWithEmail(email, password);
+  816 |     }
+  817 |     if (p === '/api/account/register' && method === 'POST') {
+  818 |       const { email, password, name } = body;
+  819 |       return await accountManager.register(email, password, name);
+  820 |     }
+  821 |     if (p === '/api/account/oauth/start' && method === 'POST') {
+  822 |       const { provider } = body;
+  823 |       if (!provider || !['google', 'github'].includes(provider)) {
+  824 |         return { success: false, error: 'Invalid OAuth provider' };
+  825 |       }
+  826 |       const { url: oauthUrl, state } = accountManager.getOAuthURL(provider);
+  827 |       return { success: true, url: oauthUrl, state };
+  828 |     }
+  829 |     if (p === '/api/account/oauth/callback' && method === 'POST') {
+  830 |       const { code, state } = body;
+  831 |       return await accountManager.completeOAuth(code, state);
+  832 |     }
+  833 |     if (p === '/api/account/logout' && method === 'POST') {
+  834 |       accountManager.logout();
+  835 |       return { success: true };
+  836 |     }
+  837 |     if (p === '/api/account/refresh' && method === 'POST') {
+  838 |       return await accountManager.refreshSession();
+  839 |     }
+  840 | 
+  841 |     // ── Setup (first run) ───────────────────────────────
+  842 |     if (p === '/api/setup/status' && method === 'GET') {
+  843 |       return {
+  844 |         isFirstRun: firstRunSetup.isFirstRun(),
+  845 |         systemInfo: firstRunSetup.getSystemInfo(),
+  846 |         recommended: firstRunSetup.recommendSettings(),
+  847 |       };
+  848 |     }
+  849 |     if (p === '/api/setup/complete' && method === 'POST') {
+  850 |       const { applyRecommended, settings } = body;
+  851 |       if (applyRecommended) firstRunSetup.applyRecommended();
+  852 |       if (settings && typeof settings === 'object') {
+  853 |         for (const [key, value] of Object.entries(settings)) {
+  854 |           if (key in settingsManager.getAll()) {
+  855 |             settingsManager.set(key, value);
+  856 |           }
+  857 |         }
+  858 |       }
+  859 |       firstRunSetup.markComplete();
+  860 |       return { success: true };
+  861 |     }
+  862 | 
+  863 |     // ── Extensions ──────────────────────────────────────
+  864 |     if (p === '/api/extensions' && method === 'GET') {
+  865 |       return { extensions: extensionManager.getInstalled(), categories: extensionManager.getCategories() };
+  866 |     }
+  867 |     if (p === '/api/extensions/install' && method === 'POST') {
+  868 |       // File upload — handle binary data passed from frontend
+  869 |       if (body._fileBuffer && body._fileName) {
+  870 |         const result = await extensionManager.installFromZip(Buffer.from(body._fileBuffer), body._fileName);
+  871 |         return { success: true, ...result };
+  872 |       }
+  873 |       return { _status: 400, error: 'File upload required' };
+  874 |     }
+  875 |     if (p === '/api/extensions/uninstall' && method === 'POST') {
+  876 |       const { id } = body;
+  877 |       if (!id) return { _status: 400, error: 'Extension ID required' };
+  878 |       return { success: true, ...(await extensionManager.uninstall(id)) };
+  879 |     }
+  880 |     if (p === '/api/extensions/enable' && method === 'POST') {
+  881 |       const { id } = body;
+  882 |       if (!id) return { _status: 400, error: 'Extension ID required' };
+  883 |       return { success: true, ...(await extensionManager.enable(id)) };
+  884 |     }
+  885 |     if (p === '/api/extensions/disable' && method === 'POST') {
+  886 |       const { id } = body;
+  887 |       if (!id) return { _status: 400, error: 'Extension ID required' };
+  888 |       return { success: true, ...(await extensionManager.disable(id)) };
+  889 |     }
+  890 | 
+  891 |     // ── Debug ───────────────────────────────────────────
+  892 |     if (p === '/api/debug/start' && method === 'POST') {
+  893 |       const { type, program, cwd, args: debugArgs } = body;
+  894 |       if (!program) return { _status: 400, error: 'Program path required' };
+  895 |       return await debugService.start({
+  896 |         type: type || 'node', program,
+  897 |         cwd: cwd || currentProjectPath || undefined,
+  898 |         args: debugArgs || [],
+  899 |       });
+  900 |     }
+  901 |     if (p === '/api/debug/stop' && method === 'POST') {
+  902 |       const { sessionId } = body;
+  903 |       if (!sessionId) return { _status: 400, error: 'Session ID required' };
+  904 |       return await debugService.stop(sessionId);
+  905 |     }
+  906 |     if (p === '/api/debug/continue' && method === 'POST') {
+  907 |       return await debugService.resume(body.sessionId);
+  908 |     }
+  909 |     if (p === '/api/debug/stepOver' && method === 'POST') {
+  910 |       return await debugService.stepOver(body.sessionId);
+  911 |     }
+  912 |     if (p === '/api/debug/stepInto' && method === 'POST') {
+  913 |       return await debugService.stepInto(body.sessionId);
+  914 |     }
+  915 |     if (p === '/api/debug/stepOut' && method === 'POST') {
+  916 |       return await debugService.stepOut(body.sessionId);
+  917 |     }
+  918 |     if (p === '/api/debug/pause' && method === 'POST') {
+  919 |       return await debugService.pause(body.sessionId);
+  920 |     }
+  921 |     if (p === '/api/debug/stackTrace' && method === 'GET') {
+  922 |       return await debugService.getStackTrace(parseInt(q.sessionId));
+  923 |     }
+  924 |     if (p === '/api/debug/scopes' && method === 'GET') {
+  925 |       return await debugService.getScopes(parseInt(q.sessionId), parseInt(q.frameId || '0'));
+  926 |     }
+  927 |     if (p === '/api/debug/variables' && method === 'GET') {
+  928 |       return await debugService.getVariables(parseInt(q.sessionId), q.ref);
+  929 |     }
+  930 |     if (p === '/api/debug/evaluate' && method === 'POST') {
+  931 |       return await debugService.evaluate(body.sessionId, body.expression, body.frameId);
+  932 |     }
+  933 |     if (p === '/api/debug/setBreakpoints' && method === 'POST') {
+  934 |       return await debugService.setBreakpoints(body.sessionId, body.filePath, body.breakpoints || []);
+  935 |     }
+  936 |     if (p === '/api/debug/sessions' && method === 'GET') {
+  937 |       return { sessions: debugService.getActiveSessions() };
+  938 |     }
+  939 | 
+  940 |     // ── Code formatting (Prettier) ──────────────────────
+  941 |     if (p === '/api/format' && method === 'POST') {
+  942 |       const prettier = require('prettier');
+  943 |       const { content, language, filePath: fp } = body;
+  944 |       if (typeof content !== 'string') return { _status: 400, error: 'content required' };
+  945 |       const parserMap = {
+  946 |         javascript: 'babel', js: 'babel', jsx: 'babel', mjs: 'babel', cjs: 'babel',
+  947 |         typescript: 'typescript', ts: 'typescript', tsx: 'typescript',
+  948 |         css: 'css', scss: 'css', less: 'less',
+  949 |         html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte',
+  950 |         json: 'json', jsonc: 'json',
+  951 |         yaml: 'yaml', yml: 'yaml',
+  952 |         markdown: 'markdown', md: 'markdown', mdx: 'mdx',
+  953 |         graphql: 'graphql', gql: 'graphql',
+  954 |         xml: 'html', svg: 'html',
+  955 |       };
+  956 |       const ext = fp ? path.extname(fp).replace('.', '').toLowerCase() : '';
+  957 |       const parser = parserMap[language] || parserMap[ext] || 'babel';
+  958 |       let prettierConfig = {};
+  959 |       if (currentProjectPath) {
+  960 |         try {
+  961 |           const rcPath = path.join(currentProjectPath, '.prettierrc');
+  962 |           if (fs.existsSync(rcPath)) prettierConfig = JSON.parse(fs.readFileSync(rcPath, 'utf-8'));
+  963 |         } catch (_) {}
+  964 |       }
+  965 |       const formatted = await prettier.format(content, { parser, ...prettierConfig, filepath: fp || undefined });
+  966 |       return { formatted };
+  967 |     }
+  968 | 
+  969 |     // ── TODO Scanner ────────────────────────────────────
+  970 |     if (p === '/api/todos/scan' && method === 'POST') {
+  971 |       if (!currentProjectPath) return { _status: 400, error: 'No project open' };
+  972 |       const TODO_PATTERN = /\b(TODO|FIXME|HACK|NOTE|XXX|BUG|OPTIMIZE)\b[:\s]*(.*)/gi;
+  973 |       const MAX_RESULTS = 500;
+  974 |       const BINARY_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.webp','.bmp','.ico','.svg','.woff','.woff2','.ttf','.eot','.mp3','.mp4','.wav','.ogg','.zip','.tar','.gz','.rar','.7z','.pdf','.exe','.dll','.so','.dylib','.o','.pyc','.class','.gguf','.bin','.dat','.db','.sqlite','.lock']);
+  975 |       const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', '.cache', 'coverage', '.idea', '.vscode']);
+  976 |       const results = [];
+  977 |       function scanDir(dir) {
+  978 |         if (results.length >= MAX_RESULTS) return;
+  979 |         let entries;
+  980 |         try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
+  981 |         for (const entry of entries) {
+  982 |           if (results.length >= MAX_RESULTS) break;
+  983 |           if (entry.name.startsWith('.') && entry.name !== '.env') continue;
+  984 |           const fullPath = path.join(dir, entry.name);
+  985 |           if (entry.isDirectory()) {
+  986 |             if (!SKIP_DIRS.has(entry.name)) scanDir(fullPath);
+  987 |           } else if (entry.isFile()) {
+  988 |             const ext = path.extname(entry.name).toLowerCase();
+  989 |             if (BINARY_EXTS.has(ext)) continue;
+  990 |             try {
+  991 |               const content = fs.readFileSync(fullPath, 'utf-8');
+  992 |               const lines = content.split('\n');
+  993 |               for (let i = 0; i < lines.length && results.length < MAX_RESULTS; i++) {
+  994 |                 let match;
+  995 |                 TODO_PATTERN.lastIndex = 0;
+  996 |                 while ((match = TODO_PATTERN.exec(lines[i])) !== null) {
+  997 |                   results.push({ file: path.relative(currentProjectPath, fullPath).replace(/\\/g, '/'), line: i + 1, type: match[1].toUpperCase(), text: match[2].trim() || match[0].trim() });
+  998 |                   if (results.length >= MAX_RESULTS) break;
+  999 |                 }
+ 1000 |               }
+ 1001 |             } catch (_) {}
+ 1002 |           }
+ 1003 |         }
+ 1004 |       }
+ 1005 |       scanDir(currentProjectPath);
+ 1006 |       return { todos: results, total: results.length, capped: results.length >= MAX_RESULTS };
+ 1007 |     }
+ 1008 | 
+ 1009 |     // ── Session ─────────────────────────────────────────
+ 1010 |     if (p === '/api/session/clear' && method === 'POST') {
+ 1011 |       console.log('[Main] session/clear: resetting all state');
+ 1012 |       agenticCancelled = true;
+ 1013 |       ctx.agenticCancelled = true;
+ 1014 |       if (ctx.resetPause) ctx.resetPause();
+ 1015 |       try { llmEngine.cancelGeneration(); } catch (_) {}
+ 1016 |       await new Promise(r => setTimeout(r, 100));
+ 1017 |       await llmEngine.resetSession();
+ 1018 |       agenticCancelled = false;
+ 1019 |       ctx.agenticCancelled = false;
+ 1020 |       console.log('[Main] session/clear: complete');
+ 1021 |       return { success: true };
+ 1022 |     }
+ 1023 | 
+ 1024 |     // ── Health ───────────────────────────────────────────
+ 1025 |     if (p === '/api/health' && method === 'GET') {
+ 1026 |       return {
+ 1027 |         status: 'running',
+ 1028 |         version: '2.0.0',
+ 1029 |         modelLoaded: llmEngine.isReady,
+ 1030 |         modelInfo: llmEngine.modelInfo,
+ 1031 |         projectPath: currentProjectPath,
+ 1032 |         uptime: process.uptime(),
+ 1033 |         memory: process.memoryUsage(),
+ 1034 |       };
+ 1035 |     }
+ 1036 | 
+ 1037 |     // ── Browser Preview ─────────────────────────────────
+ 1038 |     if (p === '/api/preview/start' && method === 'POST') {
+ 1039 |       const rootPath = body.rootPath || currentProjectPath;
+ 1040 |       if (!rootPath) return { _status: 400, error: 'No project path' };
+ 1041 |       return await browserManager.startPreview(rootPath);
+ 1042 |     }
+ 1043 |     if (p === '/api/preview/stop' && method === 'POST') {
+ 1044 |       return await browserManager.stopPreview();
+ 1045 |     }
+ 1046 |     if (p === '/api/preview/reload' && method === 'POST') {
+ 1047 |       browserManager.reloadPreview();
+ 1048 |       return { success: true };
+ 1049 |     }
+ 1050 |     if (p === '/api/preview/status' && method === 'GET') {
+ 1051 |       return browserManager.getPreviewStatus();
+ 1052 |     }
+ 1053 | 
+ 1054 |     // ── Live Server ─────────────────────────────────────
+ 1055 |     if (p === '/api/live-server/start' && method === 'POST') {
+ 1056 |       const rootPath = body.path || currentProjectPath;
+ 1057 |       if (!rootPath) return { _status: 400, error: 'No project path' };
+ 1058 |       return await liveServer.start(rootPath);
+ 1059 |     }
+ 1060 |     if (p === '/api/live-server/stop' && method === 'POST') {
+ 1061 |       return await liveServer.stop();
+ 1062 |     }
+ 1063 |     if (p === '/api/live-server/status' && method === 'GET') {
+ 1064 |       return liveServer.getStatus();
+ 1065 |     }
+ 1066 | 
+ 1067 |     // ── Terminal execute (legacy fallback) ───────────────
+ 1068 |     if (p === '/api/terminal/execute' && method === 'POST') {
+ 1069 |       const { command, cwd } = body;
+ 1070 |       if (!command) return { _status: 400, error: 'command required' };
+ 1071 |       try {
+ 1072 |         const { execSync } = require('child_process');
+ 1073 |         const output = execSync(command, {
+ 1074 |           cwd: cwd || currentProjectPath || process.cwd(),
+ 1075 |           encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
+ 1076 |         });
+ 1077 |         return { success: true, output };
+ 1078 |       } catch (e) {
+ 1079 |         return { success: false, output: e.stderr || e.stdout || e.message };
+ 1080 |       }
+ 1081 |     }
+ 1082 | 
+ 1083 |     // ── Templates ───────────────────────────────────────
+ 1084 |     if (p === '/api/templates' && method === 'GET') {
+ 1085 |       return TEMPLATES.map(t => ({ id: t.id, name: t.name, description: t.description, icon: t.icon, category: t.category, tags: t.tags }));
+ 1086 |     }
+ 1087 |     if (p.startsWith('/api/templates/') && p !== '/api/templates/create' && method === 'GET') {
+ 1088 |       const tid = p.replace('/api/templates/', '');
+ 1089 |       const template = TEMPLATES.find(t => t.id === tid);
+ 1090 |       if (!template) return { _status: 404, error: 'Template not found' };
+ 1091 |       return { ...template, files: undefined, fileList: Object.keys(template.files) };
+ 1092 |     }
+ 1093 |     if (p === '/api/templates/create' && method === 'POST') {
+ 1094 |       const { templateId, projectName, parentDir } = body;
+ 1095 |       if (!templateId || !projectName || !parentDir) return { _status: 400, error: 'templateId, projectName, and parentDir are required' };
+ 1096 |       const template = TEMPLATES.find(t => t.id === templateId);
+ 1097 |       if (!template) return { _status: 404, error: `Template "${templateId}" not found` };
+ 1098 |       const safeName = projectName.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, '-').toLowerCase();
+ 1099 |       const projectDir = path.join(parentDir, safeName);
+ 1100 |       try { await fsP.access(projectDir); return { _status: 409, error: `Directory "${safeName}" already exists` }; } catch { /* good */ }
+ 1101 |       await fsP.mkdir(projectDir, { recursive: true });
+ 1102 |       const createdFiles = [];
+ 1103 |       for (const [relativePath, content] of Object.entries(template.files)) {
+ 1104 |         const filePath = path.join(projectDir, relativePath);
+ 1105 |         await fsP.mkdir(path.dirname(filePath), { recursive: true });
+ 1106 |         await fsP.writeFile(filePath, content.replace(/\{\{PROJECT_NAME\}\}/g, projectName), 'utf8');
+ 1107 |         createdFiles.push(relativePath);
+ 1108 |       }
+ 1109 |       const openedProject = await openProjectPath(projectDir);
+ 1110 |       return {
+ 1111 |         success: true,
+ 1112 |         projectDir,
+ 1113 |         path: openedProject.path,
+ 1114 |         projectName: safeName,
+ 1115 |         filesCreated: createdFiles,
+ 1116 |       };
+ 1117 |     }
+ 1118 | 
+ 1119 |     // ── Updater ─────────────────────────────────────────
+ 1120 |     if (p === '/api/updater/status' && method === 'GET') {
+ 1121 |       return autoUpdater.getStatus();
+ 1122 |     }
+ 1123 |     if (p === '/api/updater/check' && method === 'POST') {
+ 1124 |       autoUpdater.checkForUpdates();
+ 1125 |       return { success: true };
+ 1126 |     }
+ 1127 |     if (p === '/api/updater/download' && method === 'POST') {
+ 1128 |       autoUpdater.downloadUpdate();
+ 1129 |       return { success: true };
+ 1130 |     }
+ 1131 |     if (p === '/api/updater/install' && method === 'POST') {
+ 1132 |       autoUpdater.installUpdate();
+ 1133 |       return { success: true };
+ 1134 |     }
+ 1135 | 
+ 1136 |     // ── Unknown route ───────────────────────────────────
+ 1137 |     console.warn(`[Main] Unknown API route: ${method} ${p}`);
+ 1138 |     return { _status: 404, error: `Unknown route: ${method} ${p}` };
+ 1139 | 
+ 1140 |   } catch (e) {
+ 1141 |     console.error(`[Main] API error (${method} ${p}):`, e.message);
+ 1142 |     return { _status: 500, error: e.message };
+ 1143 |   }
+ 1144 | });
+ 1145 | 
+ 1146 | // ─── PTY Terminal over IPC ──────────────────────────────────────────
+ 1147 | let pty = undefined;
+ 1148 | const ptyTerminals = new Map();
+ 1149 | 
+ 1150 | function _loadPty() {
+ 1151 |   if (pty !== undefined) return pty;
+ 1152 |   try {
+ 1153 |     pty = require('node-pty');
+ 1154 |     console.log('[Main] node-pty loaded');
+ 1155 |   } catch (e) {
+ 1156 |     console.warn('[Main] node-pty not available — terminal will use exec fallback');
+ 1157 |     pty = null;
+ 1158 |   }
+ 1159 |   return pty;
+ 1160 | }
+ 1161 | 
+ 1162 | ipcMain.handle('terminal-create', (_event, opts) => {
+ 1163 |   const ptyModule = _loadPty();
+ 1164 |   if (!ptyModule) return { success: false, error: 'node-pty not available' };
+ 1165 | 
+ 1166 |   const termId = opts?.terminalId || `pty-${Date.now()}`;
+ 1167 |   const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
+ 1168 |   const cwd = currentProjectPath || process.cwd();
+ 1169 | 
+ 1170 |   const ptyProcess = ptyModule.spawn(shell, [], {
+ 1171 |     name: 'xterm-256color',
+ 1172 |     cols: opts?.cols || 80,
+ 1173 |     rows: opts?.rows || 24,
+ 1174 |     cwd,
+ 1175 |     env: process.env,
+ 1176 |   });
+ 1177 | 
+ 1178 |   ptyProcess.onData((data) => {
+ 1179 |     _send('terminal-data', { terminalId: termId, data });
+ 1180 |   });
+ 1181 | 
+ 1182 |   ptyProcess.onExit(({ exitCode }) => {
+ 1183 |     _send('terminal-exit', { terminalId: termId, exitCode });
+ 1184 |     ptyTerminals.delete(termId);
+ 1185 |   });
+ 1186 | 
+ 1187 |   ptyTerminals.set(termId, ptyProcess);
+ 1188 |   return { success: true, terminalId: termId, shell };
+ 1189 | });
+ 1190 | 
+ 1191 | ipcMain.handle('terminal-write', (_event, termId, data) => {
+ 1192 |   const proc = ptyTerminals.get(termId);
+ 1193 |   if (proc) proc.write(data);
+ 1194 | });
+ 1195 | 
+ 1196 | ipcMain.handle('terminal-resize', (_event, termId, cols, rows) => {
+ 1197 |   const proc = ptyTerminals.get(termId);
+ 1198 |   if (proc) try { proc.resize(cols || 80, rows || 24); } catch (_) {}
+ 1199 | });
+ 1200 | 
+ 1201 | ipcMain.handle('terminal-destroy', (_event, termId) => {
+ 1202 |   const proc = ptyTerminals.get(termId);
+ 1203 |   if (proc) {
+ 1204 |     try { proc.kill(); } catch (_) {}
+ 1205 |     ptyTerminals.delete(termId);
+ 1206 |   }
+ 1207 | });
+ 1208 | 
+ 1209 | // ─── Debug event forwarding ─────────────────────────────────────────
+ 1210 | debugService.on('debug-event', (data) => _send('debug-event', data));
+ 1211 | 
+ 1212 | // ─── App lifecycle ───────────────────────────────────────────────────
+ 1213 | 
+ 1214 | app.whenReady().then(async () => {
+ 1215 |   createWindow();
+ 1216 |   buildAppMenu(mainWindow);
+ 1217 | 
+ 1218 |   // Auto-updater with real Electron IPC
+ 1219 |   autoUpdater = new AutoUpdater(mainWindow, { autoDownload: false });
+ 1220 |   autoUpdater.registerIPC(ipcMain);
+ 1221 |   setTimeout(() => autoUpdater.checkForUpdates(), 5000);
+ 1222 | 
+ 1223 |   // Initialize models
+ 1224 |   modelManager.initialize().then((models) => {
+ 1225 |     console.log(`[Main] Found ${models.length} model(s)`);
+ 1226 |     if (!llmEngine.isReady && models.length > 0) {
+ 1227 |       const lastPath = settingsManager.get('lastModelPath');
+ 1228 |       const lastModel = lastPath && models.find(m => m.path === lastPath);
+ 1229 |       const target = lastModel || modelManager.getDefaultModel();
+ 1230 |       if (target) {
+ 1231 |         console.log(`[Main] Auto-loading ${lastModel ? 'last-used' : 'default'} model: ${target.name}`);
+ 1232 |         llmEngine.initialize(target.path, buildEngineLoadSettings(settingsManager.getAll())).catch(e => console.error(`[Main] Auto-load failed: ${e.message}`));
+ 1233 |       }
+ 1234 |     }
+ 1235 |   }).catch(e => console.error(`[Main] Model scan failed: ${e.message}`));
+ 1236 | 
+ 1237 |   // Forward model events
+ 1238 |   modelManager.on('models-updated', (models) => _send('models-updated', models));
+ 1239 |   for (const evt of ['download-started', 'download-progress', 'download-complete', 'download-error', 'download-cancelled']) {
+ 1240 |     modelDownloader.on(evt, (data) => _send(evt, data));
+ 1241 |   }
+ 1242 |   modelDownloader.on('download-complete', () => modelManager.scanModels().catch(() => {}));
+ 1243 |   llmEngine.on('status', (status) => _send('llm-status', status));
+ 1244 | 
+ 1245 |   // Load frontend — use dist/index.html in production, Vite dev server in dev
+ 1246 |   const isDev = !app.isPackaged && process.env.NODE_ENV === 'development';
+ 1247 |   if (isDev) {
+ 1248 |     // In dev, Vite runs at localhost:5173
+ 1249 |     mainWindow.loadURL('http://localhost:5173');
+ 1250 |   } else if (fs.existsSync(path.join(FRONTEND_DIST, 'index.html'))) {
+ 1251 |     mainWindow.loadFile(path.join(FRONTEND_DIST, 'index.html'));
+ 1252 |   } else {
+ 1253 |     console.error('[Main] Frontend dist not found! Run: cd frontend && npm run build');
+ 1254 |     mainWindow.loadURL('data:text/html,' + encodeURIComponent('<h1>Frontend not built</h1><p>Run: cd frontend && npm run build</p>'));
+ 1255 |   }
+ 1256 | });
+ 1257 | 
+ 1258 | app.on('second-instance', () => {
+ 1259 |   if (mainWindow) {
+ 1260 |     if (mainWindow.isMinimized()) mainWindow.restore();
+ 1261 |     mainWindow.focus();
+ 1262 |   }
+ 1263 | });
+ 1264 | 
+ 1265 | app.on('window-all-closed', () => {
+ 1266 |   _shutdown();
+ 1267 |   app.quit();
+ 1268 | });
+ 1269 | 
+ 1270 | app.on('before-quit', () => _shutdown());
+ 1271 | 
+ 1272 | function _shutdown() {
+ 1273 |   settingsManager.flush();
+ 1274 |   memoryStore.dispose();
+ 1275 |   sessionStore.flush();
+ 1276 |   try { browserManager.dispose(); } catch (_) {}
+ 1277 |   try { llmEngine.dispose(); } catch (_) {}
+ 1278 |   modelManager.dispose();
+ 1279 |   for (const [id, proc] of ptyTerminals) {
+ 1280 |     try { proc.kill(); } catch (_) {}
+ 1281 |   }
+ 1282 |   ptyTerminals.clear();
+ 1283 |   log.close();
+ 1284 | }
+ 1285 | 
+ 1286 | // ─── Helpers ─────────────────────────────────────────────────────────
+ 1287 | 
+ 1288 | async function _readDirRecursive(dirPath, depth = 0, maxDepth = 3) {
+ 1289 |   const items = [];
+ 1290 |   try {
+ 1291 |     const entries = fs.readdirSync(dirPath, { withFileTypes: true });
+ 1292 |     for (const entry of entries) {
+ 1293 |       if (entry.name.startsWith('.') && entry.name !== '.env') continue;
+ 1294 |       if (['node_modules', '__pycache__', '.git', 'dist', 'build', '.next', 'target'].includes(entry.name)) continue;
+ 1295 |       const fullPath = path.join(dirPath, entry.name);
+ 1296 |       const item = { name: entry.name, path: fullPath, type: entry.isDirectory() ? 'directory' : 'file' };
+ 1297 |       if (entry.isFile()) {
+ 1298 |         try {
+ 1299 |           const stats = fs.statSync(fullPath);
+ 1300 |           item.size = stats.size;
+ 1301 |           item.modified = stats.mtime.toISOString();
+ 1302 |         } catch (_) {}
+ 1303 |         item.extension = path.extname(entry.name).slice(1);
+ 1304 |       }
+ 1305 |       if (entry.isDirectory() && depth < maxDepth) {
+ 1306 |         item.children = await _readDirRecursive(fullPath, depth + 1, maxDepth);
+ 1307 |       }
+ 1308 |       items.push(item);
+ 1309 |     }
+ 1310 |     items.sort((a, b) => {
+ 1311 |       if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
+ 1312 |       return a.name.localeCompare(b.name);
+ 1313 |     });
+ 1314 |   } catch (_) {}
+ 1315 |   return items;
+ 1316 | }
+ 1317 | 
```

### rulesManager.js (lines: 158)

```diff
+    1 | /**
+    2 |  * rulesManager.js — Project-level rules/skills for the AI agent.
+    3 |  *
+    4 |  * Reads rules from:
+    5 |  *   1. <projectRoot>/.guide/rules/*.md   (individual rule files)
+    6 |  *   2. <projectRoot>/AGENTS.md           (project-wide agent instructions)
+    7 |  *
+    8 |  * Rules are injected into the system prompt at chat start.
+    9 |  * The agent can create/update rules via the save_rule tool.
+   10 |  */
+   11 | 'use strict';
+   12 | 
+   13 | const fs = require('fs');
+   14 | const path = require('path');
+   15 | const log = require('./logger');
+   16 | 
+   17 | class RulesManager {
+   18 |   constructor() {
+   19 |     this._projectPath = null;
+   20 |     this._rulesDir = null;
+   21 |     this._cache = null;
+   22 |     this._cacheTime = 0;
+   23 |   }
+   24 | 
+   25 |   initialize(projectPath) {
+   26 |     this._projectPath = projectPath;
+   27 |     this._rulesDir = projectPath ? path.join(projectPath, '.guide', 'rules') : null;
+   28 |     this._cache = null;
+   29 |     this._cacheTime = 0;
+   30 |   }
+   31 | 
+   32 |   /**
+   33 |    * Load all rules and return as a single prompt string.
+   34 |    * Cached for 10 seconds to avoid repeated disk reads.
+   35 |    */
+   36 |   getRulesPrompt() {
+   37 |     if (!this._projectPath) return '';
+   38 |     if (this._cache && Date.now() - this._cacheTime < 10000) return this._cache;
+   39 | 
+   40 |     const sections = [];
+   41 | 
+   42 |     // 1. Read AGENTS.md from project root
+   43 |     const agentsMd = path.join(this._projectPath, 'AGENTS.md');
+   44 |     try {
+   45 |       if (fs.existsSync(agentsMd)) {
+   46 |         const content = fs.readFileSync(agentsMd, 'utf-8').trim();
+   47 |         if (content) sections.push(`## Project Instructions (AGENTS.md)\n${content}`);
+   48 |       }
+   49 |     } catch (e) {
+   50 |       log.warn('Rules', `Failed to read AGENTS.md: ${e.message}`);
+   51 |     }
+   52 | 
+   53 |     // 2. Read .guide/rules/*.md
+   54 |     if (this._rulesDir) {
+   55 |       try {
+   56 |         if (fs.existsSync(this._rulesDir)) {
+   57 |           const files = fs.readdirSync(this._rulesDir)
+   58 |             .filter(f => f.endsWith('.md'))
+   59 |             .sort();
+   60 |           for (const file of files) {
+   61 |             try {
+   62 |               const content = fs.readFileSync(path.join(this._rulesDir, file), 'utf-8').trim();
+   63 |               if (content) {
+   64 |                 const name = file.replace(/\.md$/, '');
+   65 |                 sections.push(`## Rule: ${name}\n${content}`);
+   66 |               }
+   67 |             } catch (e) {
+   68 |               log.warn('Rules', `Failed to read rule ${file}: ${e.message}`);
+   69 |             }
+   70 |           }
+   71 |         }
+   72 |       } catch (e) {
+   73 |         log.warn('Rules', `Failed to scan rules directory: ${e.message}`);
+   74 |       }
+   75 |     }
+   76 | 
+   77 |     if (sections.length === 0) {
+   78 |       this._cache = '';
+   79 |       this._cacheTime = Date.now();
+   80 |       return '';
+   81 |     }
+   82 | 
+   83 |     this._cache = `\n\n# Project Rules & Skills\nThe following rules and instructions have been set for this project. Follow them.\n\n${sections.join('\n\n')}\n`;
+   84 |     this._cacheTime = Date.now();
+   85 |     return this._cache;
+   86 |   }
+   87 | 
+   88 |   /**
+   89 |    * Save or update a rule file.
+   90 |    * @param {string} name - Rule name (used as filename, .md appended)
+   91 |    * @param {string} content - Rule content (markdown)
+   92 |    * @returns {{ success: boolean, path?: string, error?: string }}
+   93 |    */
+   94 |   saveRule(name, content) {
+   95 |     if (!this._projectPath) return { success: false, error: 'No project open' };
+   96 |     if (!name || !content) return { success: false, error: 'Name and content are required' };
+   97 | 
+   98 |     const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
+   99 |     const rulesDir = path.join(this._projectPath, '.guide', 'rules');
+  100 |     const filePath = path.join(rulesDir, `${safeName}.md`);
+  101 | 
+  102 |     try {
+  103 |       fs.mkdirSync(rulesDir, { recursive: true });
+  104 |       fs.writeFileSync(filePath, content.trim() + '\n', 'utf-8');
+  105 |       this._cache = null;
+  106 |       log.info('Rules', `Saved rule: ${safeName}`);
+  107 |       return { success: true, path: filePath };
+  108 |     } catch (e) {
+  109 |       return { success: false, error: `Failed to save rule: ${e.message}` };
+  110 |     }
+  111 |   }
+  112 | 
+  113 |   /**
+  114 |    * Delete a rule file.
+  115 |    */
+  116 |   deleteRule(name) {
+  117 |     if (!this._projectPath) return { success: false, error: 'No project open' };
+  118 |     const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
+  119 |     const filePath = path.join(this._projectPath, '.guide', 'rules', `${safeName}.md`);
+  120 |     try {
+  121 |       if (fs.existsSync(filePath)) {
+  122 |         fs.unlinkSync(filePath);
+  123 |         this._cache = null;
+  124 |         return { success: true };
+  125 |       }
+  126 |       return { success: false, error: 'Rule not found' };
+  127 |     } catch (e) {
+  128 |       return { success: false, error: e.message };
+  129 |     }
+  130 |   }
+  131 | 
+  132 |   /**
+  133 |    * List all rule names.
+  134 |    */
+  135 |   listRules() {
+  136 |     const rules = [];
+  137 |     if (!this._projectPath) return rules;
+  138 | 
+  139 |     const agentsMd = path.join(this._projectPath, 'AGENTS.md');
+  140 |     if (fs.existsSync(agentsMd)) {
+  141 |       rules.push({ name: 'AGENTS.md', type: 'project', path: agentsMd });
+  142 |     }
+  143 | 
+  144 |     if (this._rulesDir && fs.existsSync(this._rulesDir)) {
+  145 |       try {
+  146 |         const files = fs.readdirSync(this._rulesDir).filter(f => f.endsWith('.md')).sort();
+  147 |         for (const f of files) {
+  148 |           rules.push({ name: f.replace(/\.md$/, ''), type: 'rule', path: path.join(this._rulesDir, f) });
+  149 |         }
+  150 |       } catch { /* ignore */ }
+  151 |     }
+  152 | 
+  153 |     return rules;
+  154 |   }
+  155 | }
+  156 | 
+  157 | module.exports = { RulesManager };
+  158 | 
```

## Shared Runtime Files
These are identical by path (same source file used by both runtimes):
- accountManager.js
- autoUpdater.js
- browserManager.js
- chatEngine.js
- cloudLLMService.js
- debugService.js
- extensionManager.js
- firstRunSetup.js
- gitManager.js
- licenseManager.js
- logger.js
- longTermMemory.js
- mcpToolServer.js
- memoryStore.js
- modelDetection.js
- modelManager.js
- package.json
- ragEngine.js
- server/liveServer.js
- server/modelDownloader.js
- server/templateHandlers.js
- sessionStore.js
- settingsManager.js
- tools/mcpBrowserTools.js
- tools/mcpGitTools.js
- tools/toolParser.js
- webSearch.js

## Version Drift Evidence
```json
{
  "packageVersion": "3.0.14",
  "distLatestVersion": "3.0.12",
  "frontendAppLiteral": "2.3.15",
  "frontendStatusLiteral": "2.3.15",
  "installerScriptVersion": "2.3.15",
  "serverHealthVersion": "2.0.0",
  "electronHealthVersion": "2.0.0"
}
```

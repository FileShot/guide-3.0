/**
 * guIDE 2.0 — Electron Main Process (IPC Architecture)
 *
 * All services run in-process. All communication via Electron IPC.
 * No child process fork, no HTTP server, no WebSocket.
 *
 * This replaces the old electron-main.js that forked server/main.js.
 */
'use strict';

const { app, BrowserWindow, shell, ipcMain, dialog, safeStorage, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const fsP = require('fs').promises;
const os = require('os');
const http = require('http');
const { pathToFileURL } = require('url');
const { buildAppMenu } = require('./appMenu');
const { AutoUpdater } = require('./autoUpdater');

// ─── GPU / V8 flags ─────────────────────────────────────────────────
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'guide-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);

let mainWindow = null;

// ─── Paths ───────────────────────────────────────────────────────────
const ROOT_DIR = __dirname;
const MODELS_DIR = path.join(ROOT_DIR, 'models');
const FRONTEND_DIST = path.join(ROOT_DIR, 'frontend', 'dist');

function _configureBundledPlaywrightBrowsers() {
  try {
    const bundled = path.join(process.resourcesPath, 'playwright-browsers');
    if (app.isPackaged && fs.existsSync(bundled)) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = bundled;
      console.log(`[Main] Playwright browsers path: ${bundled}`);
    }
  } catch (e) {
    console.warn('[Main] Playwright browsers path not configured:', e.message);
  }
}

// ─── Loading screen ──────────────────────────────────────────────────
const LOADING_HTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Audiowide&display=swap" rel="stylesheet">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body {
  height: 100%; background: #0d0d0d; color: #e5e7eb;
  font-family: 'Audiowide', 'Courier New', monospace;
  display: flex; align-items: center; justify-content: center;
  flex-direction: column; gap: 20px;
  -webkit-app-region: drag; user-select: none;
}
.logo { font-size: 26px; font-weight: 400; letter-spacing: 2px; color: #fff; }
.logo span { color: #4f9cf9; }
.spinner {
  width: 28px; height: 28px;
  border: 3px solid #2a2a2a; border-top-color: #4f9cf9;
  border-radius: 50%; animation: spin 0.75s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.sub { font-size: 12px; color: #4b5563; font-family: -apple-system, sans-serif; }
</style></head><body>
  <div class="logo">gu<span>IDE</span></div>
  <div class="spinner"></div>
  <div class="sub">Loading...</div>
</body></html>`;

// ─── Create window ───────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'guIDE',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    backgroundColor: '#121212',
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    transparent: false,
    roundedCorners: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(app.getAppPath(), 'preload.js'),
    },
  });

  // Show loading screen while services initialize
  mainWindow.loadURL('data:text/html,' + encodeURIComponent(LOADING_HTML));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Forward maximize/unmaximize state to the renderer as an event so the
  // TitleBar can subscribe instead of polling isMaximized() every 500ms.
  const _emitWinState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const maximized = mainWindow.isMaximized();
    try { mainWindow.webContents.send('win-state', { maximized }); } catch (_) {}
  };
  mainWindow.on('maximize', _emitWinState);
  mainWindow.on('unmaximize', _emitWinState);
  mainWindow.on('enter-full-screen', _emitWinState);
  mainWindow.on('leave-full-screen', _emitWinState);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('file://')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ─── Window control IPC ─────────────────────────────────────────────
ipcMain.handle('win-minimize', () => { mainWindow?.minimize(); });
ipcMain.handle('win-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.handle('win-close', () => { mainWindow?.close(); });
ipcMain.handle('win-is-maximized', () => mainWindow?.isMaximized() ?? false);

// ─── New window ──────────────────────────────────────────────────────
ipcMain.handle('new-window', () => {
  const { spawn } = require('child_process');
  spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  }).unref();
});

// ─── Dialog IPC ─────────────────────────────────────────────────────
ipcMain.handle('dialog-open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Open Folder',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog-new-file', async (_e, { defaultDir, defaultName } = {}) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'New File',
    defaultPath: defaultDir && defaultName ? path.join(defaultDir, defaultName) : defaultDir || undefined,
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

ipcMain.handle('dialog-new-folder', async (_e, { defaultDir } = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Create New Folder',
    defaultPath: defaultDir || undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog-rename', async (_e, { currentPath } = {}) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Rename',
    defaultPath: currentPath || undefined,
    buttonLabel: 'Rename',
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

ipcMain.handle('dialog-models-add', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    title: 'Select Model Files',
    filters: [
      { name: 'GGUF Models', extensions: ['gguf'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return { success: false };
  try {
    await modelManager.addModels(result.filePaths);
    return { success: true, filePaths: result.filePaths };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('dialog-media-aux', async (_e, { kind } = {}) => {
  const filters = kind === 'vae' || kind === 'tae'
    ? [{ name: kind === 'tae' ? 'TAE (tiny VAE)' : 'VAE', extensions: ['safetensors'] }]
    : kind === 't5'
      ? [{ name: 'T5 / Text Encoder', extensions: ['gguf', 'safetensors'] }]
      : [{ name: 'CLIP / LLM Encoder', extensions: ['gguf', 'safetensors'] }];
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: 'Select auxiliary model file',
    filters: [...filters, { name: 'All Files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('shell-show-item', (_event, fullPath) => {
  if (typeof fullPath === 'string' && fullPath.length > 0) {
    shell.showItemInFolder(fullPath);
  }
});

ipcMain.handle('shell-open-external', (_event, url) => {
  if (typeof url === 'string' && url.startsWith('http')) {
    shell.openExternal(url);
  }
});

// ─── Load modules ──────────────────────────────────────────

const userDataPath = app.getPath('userData');
const modelsBasePath = app.isPackaged ? userDataPath : ROOT_DIR;

// Ensure directories
for (const dir of [MODELS_DIR, userDataPath, path.join(userDataPath, 'sessions'), path.join(userDataPath, 'logs')]) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

const log = require('./logger');
log.installConsoleIntercepts();

const streamTrace = require('./streamTrace');

const { ChatEngine, buildEngineLoadSettings } = require('./chatEngine');
const { resolveRuntimeDefaultsForModel } = require('./modelRuntimeDefaults');

/** Apply per-model runtime defaults (e.g. GLM-4.6V → thinking off) before load. */
function applyModelRuntimeDefaults(modelPath) {
  const { thinkingMode, reason } = resolveRuntimeDefaultsForModel(modelPath);
  const prev = settingsManager.get('thinkingMode');
  if (thinkingMode !== prev) {
    settingsManager.set('thinkingMode', thinkingMode);
    settingsManager.flush();
    console.log(`[Settings] model runtime default: thinkingMode "${prev}" -> "${thinkingMode}" (${reason}) file=${path.basename(modelPath)}`);
  }
}
const { MCPToolServer } = require('./mcpToolServer');
const { MCPClient } = require('./mcpClient');
const { ModelManager } = require('./modelManager');
const { MediaEngine } = require('./mediaEngine');
const { readGgufMetadata, detectModelTypeFromGguf } = require('./modelDetection');
const { MemoryStore } = require('./memoryStore');
const { LongTermMemory } = require('./longTermMemory');
const { RulesManager } = require('./rulesManager');
const { SessionStore } = require('./sessionStore');
const { CloudLLMService } = require('./cloudLLMService');
const { runCloudAgenticChat } = require('./cloudAgenticChat');
const { resolveAgentMode, filterToolDefinitions } = require('./agentModeResolver');
const { runOAuthInWindow } = require('./oauthFlow');
const { SettingsManager } = require('./settingsManager');
const { GitManager } = require('./gitManager');
const { BrowserManager } = require('./browserManager');
const { BrowserRouter } = require('./browserBackends/BrowserRouter');
const { FirstRunSetup } = require('./firstRunSetup');
const { RAGEngine } = require('./ragEngine');
const { BackgroundAgentQueue } = require('./backgroundAgentQueue');
const { DocsIndexService } = require('./docsIndexService');
const { resolveMentions } = require('./mentionContext');
const { AccountManager } = require('./accountManager');
const { LicenseManager } = require('./licenseManager');
const { ExtensionManager } = require('./extensionManager');
const { LanguageServerManager } = require('./languageServerManager');
const { LspBundleManager } = require('./lspBundleManager');
const { FimCompletionService } = require('./fimCompletionService');
const { VoiceService } = require('./voiceService');
const { ExtensionHost } = require('./extensionHost');
const { DebugService } = require('./debugService');
const { formatOnSave } = require('./formatOnSave');
const { fetchCatalog } = require('./extensionMarketplace');
const { MultiRootWorkspace } = require('./multiRootWorkspace');
const { exportSettings, importSettings } = require('./settingsSync');
const { RemoteManager } = require('./remoteManager');
const { DevContainerManager } = require('./devContainerManager');
const { loadVsix } = require('./vsixLoader');
const { exportTeamBundle, importTeamBundle } = require('./teamSharing');
const prIntegration = require('./prIntegration');
const { ModelDownloader } = require('./server/modelDownloader');
const liveServer = require('./server/liveServer');
const WebSearch = require('./webSearch');
const { TEMPLATES } = require('./server/templateHandlers');

// ─── Initialize services ────────────────────────────────────────────
const settingsManager = new SettingsManager(userDataPath);
const llmEngine = new ChatEngine();
const webSearch = new WebSearch();
const ragEngine = new RAGEngine();
const docsIndexService = new DocsIndexService();
const backgroundAgentQueue = new BackgroundAgentQueue({
  llmEngine,
  settingsManager,
  sendEvent: (event, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(event, data);
  },
});
const { createPathValidator } = require('./pathValidator');

let currentProjectPath = null;
const isPathAllowed = createPathValidator(ROOT_DIR, modelsBasePath, () => currentProjectPath);

const mcpToolServer = new MCPToolServer({
  projectPath: null, webSearch, ragEngine,
  executionPolicy: settingsManager.get('executionPolicy'),
  commandShell: settingsManager.get('commandShell'),
  commandAllowList: settingsManager.get('commandAllowList'),
  commandDenyList: settingsManager.get('commandDenyList'),
  requireToolApproval: settingsManager.get('requireToolApproval'),
  userDataPath,
  isPathAllowed,
});

// ── MCP Client: manages external MCP servers (stdio transport) ──
const mcpClient = new MCPClient({
  projectPath: null,
  onLog: (msg) => console.log(`[MCP] ${msg}`),
  onToolsChanged: () => {
    // Invalidate tool defs cache so next getToolDefinitions() picks up new tools
    mcpToolServer._allToolDefsCache = null;
    const discovered = mcpClient.getDiscoveredTools();
    // Add dynamically discovered tool names to VALID_TOOLS so the parser accepts them
    const { addValidTool } = require('./tools/toolParser');
    for (const t of discovered) addValidTool(t.name);
    _send('mcp-tools-changed', { tools: discovered.map(t => t.name) });
    console.log(`[MCP] tools changed: ${discovered.length} tools available`);
  },
});
mcpToolServer.mcpClient = mcpClient;
const gitManager = new GitManager();
const memoryStore = new MemoryStore();
const longTermMemory = new LongTermMemory();
const rulesManager = new RulesManager();
const modelManager = new ModelManager(modelsBasePath);
const { MediaAuxResolver } = require('./mediaAuxResolver');
const mediaAuxResolver = new MediaAuxResolver({ userDataPath });
const { getInstallVariant } = require('./updateVariant');
const mediaEngine = new MediaEngine({
  userDataPath,
  rootDir: ROOT_DIR,
  getSettings: () => settingsManager.getAll(),
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  installVariant: getInstallVariant(),
  auxResolver: mediaAuxResolver,
  onAuxProgress: (p) => _send('media-aux-progress', p),
});
const sessionStore = new SessionStore(path.join(userDataPath, 'sessions'));
const cloudLLM = new CloudLLMService();
const modelDownloader = new ModelDownloader(path.join(ROOT_DIR, 'models'));
const firstRunSetup = new FirstRunSetup(settingsManager);
const accountManager = new AccountManager(settingsManager);
const licenseManager = new LicenseManager(settingsManager, accountManager);
const extensionManager = new ExtensionManager(userDataPath);
const languageServerManager = new LanguageServerManager();
const lspBundleManager = new LspBundleManager(userDataPath);
languageServerManager.setBundleManager(lspBundleManager);
const fimCompletionService = new FimCompletionService(llmEngine);
const voiceService = new VoiceService(userDataPath, settingsManager);
const extensionHost = new ExtensionHost(extensionManager);
const debugService = new DebugService();
const multiRootWorkspace = new MultiRootWorkspace(userDataPath);
const remoteManager = new RemoteManager();
const devContainerManager = new DevContainerManager();

// BrowserManager needs mainWindow reference for event forwarding
const browserManager = new BrowserManager({
  liveServer,
  parentWindow: { webContents: { send: (e, d) => _send(e, d) }, isDestroyed: () => !mainWindow },
});

const browserRouter = new BrowserRouter({
  browserManager,
  userDataPath,
  parentWindow: { webContents: { send: (e, d) => _send(e, d) }, isDestroyed: () => !mainWindow },
});

function syncBrowserRouterFromSettings() {
  browserRouter.updateConfig({
    browserEngine: settingsManager.get('browserEngine') || 'chromium',
    torBrowserPath: settingsManager.get('torBrowserPath') || '',
    geckodriverPath: settingsManager.get('geckodriverPath') || '',
    debugTorBrowser: !!settingsManager.get('debugTorBrowser'),
  });
  if (settingsManager.get('browserEngine') === 'tor') {
    browserRouter.prewarmTor?.().catch((e) => {
      console.warn(`[electron-main] Tor prewarm: ${e.message}`);
    });
  }
}
syncBrowserRouterFromSettings();

ipcMain.handle('dialog-tor-browser-exe', async () => {
  const isWin = process.platform === 'win32';
  const result = await dialog.showOpenDialog(mainWindow, {
    title: isWin ? 'Select Tor Browser firefox.exe' : 'Select Tor Browser Firefox binary',
    properties: ['openFile'],
    filters: isWin
      ? [{ name: 'Firefox', extensions: ['exe'] }, { name: 'All Files', extensions: ['*'] }]
      : [{ name: 'All Files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('tor-browser-status', async () => {
  syncBrowserRouterFromSettings();
  return browserRouter.validateTorStatus();
});

// Wire service cross-references
mcpToolServer.setBrowserManager(browserManager);
mcpToolServer.setBrowserRouter(browserRouter);
mcpToolServer.setGitManager(gitManager);
mcpToolServer.rulesManager = rulesManager;
mcpToolServer.setImageGen(mediaEngine);
mcpToolServer.onTodoUpdate = (todos) => _send('todo-update', todos);
mcpToolServer.onAskQuestion = (questionData) => {
  return new Promise((resolve) => {
    // Send question to frontend
    _send('ask-question', questionData);
    // Store the resolver so the answer IPC can pick it up
    mcpToolServer._pendingQuestionResolve = resolve;
  });
};

function cancelPendingQuestion(reason = '(skipped by user)') {
  if (mcpToolServer._pendingQuestionResolve) {
    const resolve = mcpToolServer._pendingQuestionResolve;
    mcpToolServer._pendingQuestionResolve = null;
    resolve({ success: true, answer: reason });
  }
}
mcpToolServer.onPermissionRequest = (toolName, params, reason) => {
  return new Promise((resolve) => {
    const reqId = `perm-${Date.now()}`;
    _send('permission-request', { id: reqId, toolName, params, reason });
    mcpToolServer._pendingPermissionResolvers = mcpToolServer._pendingPermissionResolvers || {};
    mcpToolServer._pendingPermissionResolvers[reqId] = resolve;
  });
};
// IPC bridge for IDE integration tools (switch_file, get_diagnostics, get_selection, open_terminal)
mcpToolServer.onIPCCall = async (channel, data) => {
  try {
    const result = await ipcMain.handle(channel, data);
    return result;
  } catch {
    // IPC handlers may not exist for some channels — use direct approach
    if (channel === 'switch-file') {
      _send('switch-file', data);
      return { success: true };
    }
    if (channel === 'terminal-create') {
      // Reuse existing terminal-create IPC
      const ptyModule = _loadPty ? _loadPty() : null;
      if (!ptyModule) return { success: false, error: 'node-pty not available' };
      return { success: true, note: 'Terminal creation requested' };
    }
    if (channel === 'get-diagnostics') {
      _send('get-diagnostics', data);
      return { success: true, note: 'Diagnostics request sent to frontend' };
    }
    if (channel === 'get-selection') {
      _send('get-selection', data);
      return { success: true, note: 'Selection request sent to frontend' };
    }
    return { success: false, error: `IPC channel ${channel} not available` };
  }
};
cloudLLM.setLicenseManager(licenseManager);

// Restore persisted API keys
const savedKeys = settingsManager.getAllApiKeys();
for (const [provider, key] of Object.entries(savedKeys)) {
  if (key && key.trim()) {
    cloudLLM.setApiKey(provider, key);
  }
}

// License state already restored in LicenseManager constructor

// Initialize extensions (async, non-blocking)
extensionManager.initialize().then(() => {
  extensionHost.activateAll();
}).catch(err => console.error('[Main] Extension init error:', err.message));

languageServerManager.on('message', ({ serverId, msg }) => {
  _send('lsp-message', { serverId, msg });
});
languageServerManager.on('diagnostics', (data) => {
  _send('lsp-diagnostics', data);
});
languageServerManager.on('log', ({ serverId, stderr }) => {
  if (stderr) _send('output-log', { level: 'warn', message: `[LSP ${serverId}] ${stderr}`, timestamp: Date.now() });
});

let currentSettings = settingsManager.getAll();
streamTrace.syncFromSettings(currentSettings);
let agenticCancelled = false;
let autoUpdater = null;

async function openProjectPath(projectPath) {
  console.log(`[electron-main] openProjectPath START: ${projectPath}`);
  const resolved = path.resolve(projectPath);
  if (currentProjectPath && path.resolve(currentProjectPath) === resolved) {
    console.log(`[electron-main] openProjectPath: already open — skipping duplicate init`);
    return { path: resolved };
  }
  if (!fs.existsSync(resolved)) {
    console.error(`[electron-main] openProjectPath: directory not found ${resolved}`);
    const error = new Error('Directory not found');
    error.statusCode = 404;
    throw error;
  }

  currentProjectPath = resolved;
  ctx.currentProjectPath = resolved;
  multiRootWorkspace.syncWithProject(resolved);
  mcpToolServer.projectPath = resolved;
  mcpClient.projectPath = resolved;
  gitManager.setProjectPath(resolved);
  memoryStore.initialize(resolved);
  longTermMemory.initialize(resolved);
  rulesManager.initialize(resolved);
  // Load MCP server config and start autoStart servers for this project
  try {
    mcpClient.loadConfig();
    for (const [name, server] of mcpClient._servers) {
      if (server.config?.autoStart !== false) {
        mcpClient.startServer(name, server.config).catch(e => console.error(`[MCP] Failed to start ${name}:`, e.message));
      }
    }
  } catch (e) { console.warn(`[MCP] Config load failed: ${e.message}`); }
  ragEngine.indexProject(resolved).catch(e => console.warn('[Main] RAG indexing failed:', e.message));
  docsIndexService.index(resolved).catch(e => console.warn('[Main] Docs indexing failed:', e.message));
  // Auto-start LSP servers based on project marker files (typescript, python, rust, go)
  try {
    const results = await languageServerManager.autoStartForProject(resolved);
    for (const r of results) {
      if (r.success && !r.alreadyRunning) {
        console.log(`[Main] LSP started: ${r.language} (${r.serverId})`);
      } else if (!r.success) {
        console.warn(`[Main] LSP start skipped (${r.language}):`, r.error);
      }
    }
  } catch (e) {
    console.warn('[Main] LSP auto-start skipped:', e.message);
  }
  _send('project-opened', { path: resolved });
  console.log(`[electron-main] openProjectPath DONE: ${resolved}`);
  return { path: resolved };
}

// Helper to send events to renderer
function _send(event, data) {
  if (streamTrace.isEnabled() && event !== 'output-log') {
    streamTrace.trace('ipc', 'ipc-send', { channel: event, data });
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(event, data);
  }
  // Drop silently during shutdown — window destroyed is expected, not an error.
}
mcpToolServer._send = _send;

async function runWithMediaVramPolicy(fn) {
  const settings = settingsManager.getAll();
  let unloadedLlm = false;
  const lastPath = settings.lastModelPath;
  if (settings.unloadLlmForMedia !== false && llmEngine.isReady) {
    try { llmEngine.cancelGeneration('media-gen'); } catch (_) {}
    await llmEngine.dispose();
    unloadedLlm = true;
    _send('model-unloaded', {});
  }
  try {
    return await fn();
  } finally {
    if (
      unloadedLlm
      && settings.reloadLlmAfterMedia !== false
      && lastPath
      && fs.existsSync(lastPath)
      && !mediaEngine.modelPath
    ) {
      applyModelRuntimeDefaults(lastPath);
      llmEngine.initialize(lastPath, buildEngineLoadSettings(settingsManager.getAll()))
        .then(() => { if (llmEngine.modelInfo) _send('model-loaded', llmEngine.modelInfo); })
        .catch((e) => console.warn(`[Media] LLM reload after media failed: ${e.message}`));
    }
  }
}

// Forward main-process console output to renderer Output panel (IPC event pattern)
const _origConsoleLog = console.log.bind(console);
const _origConsoleWarn = console.warn.bind(console);
const _origConsoleError = console.error.bind(console);
function _formatLogArgs(args) {
  return args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch (_) { return String(a); }
  }).join(' ');
}
function _forwardOutputLog(level, args) {
  _send('output-log', { level, message: _formatLogArgs(args), timestamp: Date.now() });
}
console.log = (...args) => { _origConsoleLog(...args); _forwardOutputLog('log', args); };
console.warn = (...args) => { _origConsoleWarn(...args); _forwardOutputLog('warn', args); };
console.error = (...args) => { _origConsoleError(...args); _forwardOutputLog('error', args); };

const ctx = {
  llmEngine,
  mcpToolServer,
  memoryStore,
  longTermMemory,
  modelManager,
  sessionStore,
  userDataPath,
  get currentProjectPath() { return currentProjectPath; },
  set currentProjectPath(v) { currentProjectPath = v; },
  get agenticCancelled() { return agenticCancelled; },
  set agenticCancelled(v) { agenticCancelled = v; },
  getMainWindow: () => mainWindow,
  cloudLLM,
  playwrightBrowser: null,
  browserManager,
  ragEngine,
  webSearch,
  licenseManager,
  _truncateResult: (result) => {
    if (!result) return result;
    const str = typeof result === 'string' ? result : JSON.stringify(result);
    return str.length > 8000 ? str.substring(0, 8000) + '...[truncated]' : result;
  },
  _readConfig: () => currentSettings,
};

// ─── App metadata ───────────────────────────────────────────────────
ipcMain.handle('get-app-version', () => app.getVersion());

// ─── Rules/Skills API ───────────────────────────────────────────────
ipcMain.handle('rules-list', () => rulesManager.listRules());
ipcMain.handle('rules-save', (_e, name, content) => rulesManager.saveRule(name, content));
ipcMain.handle('rules-delete', (_e, name) => rulesManager.deleteRule(name));

// Register ai-chat handler for basic model chat
function buildAgentModeTooling(mcpToolServer, settings, enableSubAgents) {
  const mode = resolveAgentMode({
    askOnly: settings.askOnly,
    planMode: settings.planMode,
    chatMode: settings.chatMode,
    agentPhase: settings.agentPhase || 'planning',
    toolsEnabled: settings.toolsEnabled !== false,
    planReady: !!settings.planReady,
    planFileExists: !!settings.planFileExists,
  });
  mcpToolServer.setAgentContext({ planMode: mode.planMode, agentPhase: mode.agentPhase });
  const allDefs = mcpToolServer.getToolDefinitions();
  const filteredDefs = filterToolDefinitions(allDefs, mode.allowedTools);
  const toolPromptOpts = { planning: mode.planning };
  let toolPrompt = mode.toolsActive ? mcpToolServer.getToolPromptForTools(filteredDefs, toolPromptOpts) : '';
  const compactToolParts = mode.toolsActive
    ? mcpToolServer.getCompactToolHint('default', { toolDefs: filteredDefs, planning: mode.planning })
    : [];
  let compactToolPrompt = compactToolParts.join('');
  if (enableSubAgents && toolPrompt) {
    const subAgentTool = '\n- **spawn_subagent** — Delegate a focused sub-task to an isolated sub-agent that shares the same loaded model but runs in a fresh context. Use for long research tasks, code analysis, or any work that should not pollute the main context. Params: task (string, required) — description of what the sub-agent should do; contextSize (number, optional) — token budget for sub-agent.';
    toolPrompt += subAgentTool;
    compactToolPrompt += '\n- spawn_subagent(task): run focused sub-task in fresh context\n';
    compactToolParts.push('\n- spawn_subagent(task): run focused sub-task in fresh context\n');
  }
  const functions = mode.askOnly ? {} : ChatEngine.convertToolDefs(filteredDefs);
  return { mode, toolPrompt, compactToolParts, compactToolPrompt, functions };
}

function buildCloudChatErrorResponse(cloudLLM, cloudProvider, err) {
  const detail = err?.message || 'Cloud request failed';
  let errorCode = err?.status || err?.statusCode || null;
  if (!errorCode) {
    const codeMatch = detail.match(/API error (\d+)/i) || detail.match(/\b(429|402|403|401)\b/);
    if (codeMatch) errorCode = parseInt(codeMatch[1], 10);
  }

  const isRateLimit = errorCode === 429 || /rate limit/i.test(detail);
  const isStreamStall = /stream stalled/i.test(detail) || /idle timeout/i.test(detail) || /no data for/i.test(detail);

  let error = detail;
  let errorSuggestion = '';
  let cooldownUntil = null;

  if (isRateLimit) {
    cooldownUntil = cloudLLM.getRateLimitCooldownUntil(cloudProvider);
    error = 'guIDE Cloud AI is rate limited. Slow down and try again.';
    errorSuggestion = cooldownUntil
      ? 'Wait for the countdown below before sending another message.'
      : 'Please wait about a minute before trying again.';
  } else if (isStreamStall) {
    error = 'guIDE Cloud AI is retrying keys (rate limited). Try again in a moment.';
    errorSuggestion = 'The previous request timed out while switching API keys. You can send a new message.';
  } else if (errorCode === 402 || /payment method/i.test(detail)) {
    error = 'Cloud provider requires payment (402). Try again later or switch providers.';
    errorSuggestion = 'This usually happens when the fallback provider needs a paid account.';
  }

  return {
    success: false,
    error,
    errorDetail: detail,
    errorCode,
    errorSuggestion,
    cooldownUntil,
  };
}

ipcMain.handle('ai-chat', async (_event, userMessage, chatContext) => {
  console.log(`[electron-main] ai-chat START: userMessageLen=${String(userMessage).length}, cloudProvider=${chatContext?.cloudProvider || 'none'}`);
  cancelPendingQuestion('(user sent a new message)');
  const cloudProvider = chatContext?.cloudProvider;
  const cloudModel = chatContext?.cloudModel;

  // ── Checkpoint: begin turn capture before generation ──
  const turnId = `turn-${Date.now()}`;
  streamTrace.setTurnId(turnId);
  mcpToolServer.startTurn(turnId);
  console.log(`[electron-main] checkpoint: startTurn(${turnId})`);
  streamTrace.trace('stream', 'ai-chat-start', {
    userMessage,
    cloudProvider: chatContext?.cloudProvider || null,
    chatContext,
  });

  // ── Cloud provider path (agentic tools + same system/tool prompt as local) ──
  if (cloudProvider) {
    try {
      console.log(`[electron-main] ai-chat: cloud path provider=${cloudProvider}`);
      agenticCancelled = false;
      // Prefer persisted settings as source of truth; allow chatContext to override
      // ephemeral/per-request flags (askOnly/planMode/etc).
      const settings = { ...(currentSettings || {}), ...(chatContext?.params || chatContext?.settings || {}) };
      const attachments = Array.isArray(chatContext?.attachments) ? chatContext.attachments : [];
      const images = attachments.filter(a => (a.mimeType || a.type || '').startsWith('image/'));

      const conversationHistory = [];
      const chatMsgs = chatContext?.chatMessages || [];
      const userText = String(userMessage).trim();
      for (let i = 0; i < chatMsgs.length; i++) {
        const m = chatMsgs[i];
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const isLast = i === chatMsgs.length - 1;
        if (isLast && m.role === 'user' && String(m.content || '').trim() === userText) continue;
        const content = String(m.content || '').trim();
        if (!content) continue;
        conversationHistory.push({ role: m.role, content: m.content });
      }
      console.log(
        `[electron-main] cloud conversationHistory: ${conversationHistory.length} msgs from ${chatMsgs.length} chat bubbles`
      );

      const currentFile = chatContext?.currentFile;
      let effectiveMessage = userMessage;
      if (currentFile?.path && currentFile?.content != null) {
        const MAX_FILE_CONTEXT = 4000;
        const truncated = currentFile.content.length > MAX_FILE_CONTEXT
          ? currentFile.content.slice(0, MAX_FILE_CONTEXT) + '\n… [truncated — use read_file to see the full file]'
          : currentFile.content;
        effectiveMessage = userMessage + `\n\n[Current file: ${currentFile.path}]\n${truncated}`;
      }

      const askOnly = !!(settings.askOnly);
      const planMode = !!(settings.planMode);
      const enableSubAgents = settings.enableSubAgents !== false;
      if (settings.planContext && settings.agentPhase === 'building') {
        effectiveMessage = `[Build approved]\n\n--- APPROVED PLAN ---\n${settings.planContext}\n--- END PLAN ---`;
      }
      const executeToolFn = async (toolName, params) => {
        if (toolName === 'spawn_subagent') {
          return { success: false, error: 'Sub-agents require a loaded local model. Switch to local or disable sub-agents.' };
        }
        return await mcpToolServer.executeTool(toolName, params);
      };

      const paceDisplay = cloudProvider === 'cerebras'
        && cloudLLM._isBundledProvider(cloudProvider)
        && !cloudLLM.isUsingOwnKey(cloudProvider);
      _send('llm-stream-config', { paceDisplay, paceTokensPerSec: 50 });

      const result = await runCloudAgenticChat({
        cloudLLM,
        mcpToolServer,
        ChatEngine,
        userMessage: effectiveMessage,
        cloudProvider,
        cloudModel,
        settings: {
          ...settings,
          askOnly,
          planMode,
          enableSubAgents,
          toolsEnabled: settings.toolsEnabled !== false,
          chatMode: settings.chatMode,
          agentPhase: settings.agentPhase || 'planning',
          projectPath: currentProjectPath || undefined,
          editorContext: llmEngine._ctx?.editorContext,
          editorDiagnostics: llmEngine._ctx?.editorDiagnostics,
        },
        conversationHistory,
        images,
        executeToolFn,
        onToken: (token) => _send('llm-token', token),
        onThinkingToken: (token) => _send('llm-thinking-token', token),
        onStreamEvent: (eventName, data) => _send(eventName, data),
        getCancelled: () => agenticCancelled,
        getActiveTodos: () => (mcpToolServer?._todos ? [...mcpToolServer._todos] : []),
      });

      if (result?.isQuotaError) {
        const cooldownUntil = cloudLLM.getRateLimitCooldownUntil(cloudProvider);
        _send('llm-stream-end', null);
        return {
          success: false,
          isQuotaError: true,
          error: 'guIDE Cloud AI quota exceeded. Slow down and try again.',
          errorSuggestion: cooldownUntil
            ? 'Wait for the countdown before sending another message.'
            : 'Please wait about a minute before trying again.',
          cooldownUntil,
        };
      }

      // ── Checkpoint: finalize turn after cloud generation ──
      const snapshot = mcpToolServer.finalizeCurrentTurn(String(userMessage).substring(0, 100));
      if (snapshot) {
        console.log(`[electron-main] checkpoint: finalizeCurrentTurn → ${snapshot.files.length} files captured`);
        _send('tool-checkpoint', { turnId: snapshot.turnId, timestamp: snapshot.timestamp, userMessage: snapshot.userMessage, fileCount: snapshot.files.length });
      } else {
        console.log('[electron-main] checkpoint: finalizeCurrentTurn → no files modified this turn');
      }

      console.log(`[electron-main] ai-chat DONE: toolCallCount=${result.toolCallCount || 0}`);
      _send('llm-stream-end', null);
      return {
        success: true,
        text: result.text || '',
        toolCallCount: result.toolCallCount || 0,
        checkpoint: snapshot ? { turnId: snapshot.turnId, timestamp: snapshot.timestamp, fileCount: snapshot.files.length } : null,
      };
    } catch (err) {
      console.error(`[electron-main] ai-chat cloud ERROR: ${err.message}`);
      // Reset checkpoint state on error to prevent stale captures
      mcpToolServer.startTurn(null);
      _send('llm-stream-end', null);
      if (err.isQuotaError) {
        const cooldownUntil = cloudLLM.getRateLimitCooldownUntil(cloudProvider);
        return {
          success: false,
          isQuotaError: true,
          error: 'guIDE Cloud AI quota exceeded. Slow down and try again.',
          errorSuggestion: cooldownUntil
            ? 'Wait for the countdown before sending another message.'
            : 'Please wait about a minute before trying again.',
          cooldownUntil,
        };
      }
      return buildCloudChatErrorResponse(cloudLLM, cloudProvider, err);
    }
  }

  // ── Local model path ─────────────────────────────────────────────────
  if (llmEngine.isLoading || llmEngine.getStatus().loadState === 'loading' || llmEngine.getStatus().loadState === 'disposing') {
    console.warn('[electron-main] ai-chat: model load in progress');
    return { error: 'Model is loading — please wait and try again.' };
  }
  if (!llmEngine.isReady) {
    console.warn('[electron-main] ai-chat: no model loaded');
    return { error: 'No model loaded. Please load a model first.' };
  }
  try {
    console.log('[electron-main] ai-chat: local model path');
    agenticCancelled = false;
    // Prefer persisted settings as source of truth; allow chatContext to override
    // ephemeral/per-request flags (askOnly/planMode/etc).
    const settings = { ...(currentSettings || {}), ...(chatContext?.params || chatContext?.settings || {}) };

    const askOnly = !!(settings.askOnly);
    const planMode = !!(settings.planMode);
    const enableSubAgents = settings.enableSubAgents !== false;
    const autoLintFix = settings.autoLintFix !== false; // default true

    const { mode, toolPrompt, compactToolParts, compactToolPrompt, functions } = buildAgentModeTooling(
      mcpToolServer,
      settings,
      enableSubAgents,
    );

    // Inject current file context into the user message so the model can see the active file
    // Truncate to avoid consuming all context — model can use read_file for the full content
    const currentFile = chatContext?.currentFile;
    let effectiveMessage = userMessage;
    if (currentFile?.path && currentFile?.content != null) {
      const MAX_FILE_CONTEXT = 4000;
      const truncated = currentFile.content.length > MAX_FILE_CONTEXT
        ? currentFile.content.slice(0, MAX_FILE_CONTEXT) + `\n… [truncated — use read_file to see the full file]`
        : currentFile.content;
      effectiveMessage = userMessage + `\n\n[Current file: ${currentFile.path}]\n${truncated}`;
    }

    const mentionResolved = await resolveMentions(effectiveMessage, {
      projectPath: currentProjectPath,
      ragEngine,
      docsIndexService,
      selection: chatContext?.selection?.text || chatContext?.editorSelection,
    });
    effectiveMessage = mentionResolved.message;

    if (settings.planContext && settings.agentPhase === 'building') {
      effectiveMessage = `[Build approved]\n\n--- APPROVED PLAN ---\n${settings.planContext}\n--- END PLAN ---`;
    }

    _send('llm-stream-config', { paceDisplay: false, paceTokensPerSec: 50 });
    let localTokenSendCount = 0;
    const debugStreamDiag = !!settings.debugStreamDiag;
    console.log(`[electron-main] ai-chat: calling llmEngine.chat, effectiveMessageLen=${effectiveMessage.length}, mode=${mode.planning ? 'plan' : mode.askOnly ? 'ask' : 'agent'}`);
    const result = await llmEngine.chat(effectiveMessage, {
      getActiveTodos: () => (mcpToolServer?._todos ? [...mcpToolServer._todos] : []),
      onToken: (token) => {
        localTokenSendCount += 1;
        if (debugStreamDiag && (localTokenSendCount === 1 || localTokenSendCount % 100 === 0)) {
          console.log(`[electron-main] local llm-token #${localTokenSendCount} len=${String(token).length}`);
        }
        _send('llm-token', token);
      },
      onContextUsage: (data) => _send('context-usage', data),
      onToolCall: (data) => _send('tool-call', data),
      onStreamEvent: (eventName, data) => _send(eventName, data),
      getCancelled: () => agenticCancelled || llmEngine.isCancelled(),
      attachments: Array.isArray(chatContext?.attachments) ? chatContext.attachments : [],
      functions,
      toolPrompt,
      compactToolPrompt,
      compactToolParts,
      executeToolFn: async (toolName, params) => {
        if (toolName === 'spawn_subagent') {
          if (!enableSubAgents) return { success: false, error: 'Sub-agents are disabled. Enable in Settings > Agentic Behavior.' };
          const subTask = String(params?.task || '');
          const subId = `sub-${Date.now()}`;
          _send('sub-agent-spawned', { id: subId, task: subTask });
          try {
            const subResult = await llmEngine.spawnSubAgent(subTask, {
              contextSize: params?.contextSize,
              temperature: settings.temperature,
            });
            _send('sub-agent-completed', { id: subId, task: subTask, success: subResult.success, error: subResult.error });
            return subResult;
          } catch (subErr) {
            _send('sub-agent-completed', { id: subId, task: subTask, success: false, error: subErr.message });
            throw subErr;
          }
        }
        return await mcpToolServer.executeTool(toolName, params);
      },
      systemPrompt: settings.systemPrompt || undefined,
      customInstructions: settings.customInstructions || undefined,
      guideInstructionsPath: settings.guideInstructionsPath || undefined,
      temperature: settings.temperature,
      temperatureIsDefault: settings.temperature === settings._defaultTemperature,
      // UI setting is maxResponseTokens (0 = auto). Pass through as maxTokens for ChatEngine.
      maxTokens: settings.maxResponseTokens || -1,
      topP: settings.topP,
      topK: settings.topK,
      repeatPenalty: settings.repeatPenalty,
      repeatPenaltyIsDefault: settings.repeatPenalty === settings._defaultRepeatPenalty,
      seed: settings.seed >= 0 ? settings.seed : undefined,
      thinkingBudget: settings.thinkingBudget,
      enableThinkingFilter: settings.enableThinkingFilter,
      toolsEnabled: settings.toolsEnabled !== false,
      enableGrammar: settings.enableGrammar,
      enableNativeFC: settings.enableNativeFC !== false,
      enableContextSummarizer: settings.enableContextSummarizer !== false,
      debugStreamDiag: !!settings.debugStreamDiag || settings.streamTraceEnabled !== false,
      streamTraceEnabled: settings.streamTraceEnabled !== false,
      maxIterations: settings.maxIterations || 0,
      generationTimeoutSec: settings.generationTimeoutSec || 0,
      reasoningEffort: settings.reasoningEffort || 'medium',
      askOnly,
      planMode,
      agentPhase: settings.agentPhase || 'planning',
      planReady: !!settings.planReady,
      planFileExists: !!settings.planFileExists,
      planPhase: mode.planPhase,
      autoLintFix,
    });

    // Sync guide instructions path to rulesManager so list_rules includes it
    if (settings.guideInstructionsPath) {
      rulesManager.setGuideInstructionsPath(settings.guideInstructionsPath);
    }
    // ── Checkpoint: finalize turn after local generation ──
    const snapshot = mcpToolServer.finalizeCurrentTurn(String(userMessage).substring(0, 100));
    if (snapshot) {
      console.log(`[electron-main] checkpoint: finalizeCurrentTurn → ${snapshot.files.length} files captured`);
      _send('tool-checkpoint', { turnId: snapshot.turnId, timestamp: snapshot.timestamp, userMessage: snapshot.userMessage, fileCount: snapshot.files.length });
    } else {
      console.log('[electron-main] checkpoint: finalizeCurrentTurn → no files modified this turn');
    }

    console.log(`[electron-main] ai-chat DONE: toolCallCount=${result.toolCallCount}, localTokensSent=${localTokenSendCount}`);
    _send('llm-stream-end', null);
    return { text: result.text, toolCallCount: result.toolCallCount, checkpoint: snapshot ? { turnId: snapshot.turnId, timestamp: snapshot.timestamp, fileCount: snapshot.files.length } : null };
  } catch (err) {
    const errMsg = String(err?.message ?? err ?? 'Unknown generation error');
    console.error(`[electron-main] ai-chat local ERROR: ${errMsg}`);
    // Reset checkpoint state on error to prevent stale captures
    mcpToolServer.startTurn(null);
    _send('llm-stream-end', null);
    return { error: errMsg };
  }
});

// Plan B: Revert backend context to match a truncated frontend message array.
// Called by pencil-edit submit and checkpoint-restore in ChatPanel.jsx.
ipcMain.handle('revert-context', async (_e, messages) => {
  await llmEngine.waitForIdle({ timeoutMs: 5000 });
  llmEngine.revertContext(Array.isArray(messages) ? messages : []);
  return { success: true };
});

// Restore file contents to a checkpoint (called from ChatPanel checkpoint button + restore_checkpoint tool)
ipcMain.handle('restore-checkpoint', async (_e, turnId) => {
  if (!mcpToolServer) return { success: false, error: 'MCPToolServer not initialized' };
  return await mcpToolServer.restoreCheckpoint(turnId);
});

// ── MCP Server Management IPC ──────────────────────────────────────
ipcMain.handle('mcp-add-server', async (_e, serverConfig) => {
  if (!mcpClient) return { success: false, error: 'MCPClient not initialized' };
  try {
    const { name, command, args, env } = serverConfig;
    if (!name || !command) return { success: false, error: 'name and command are required' };
    const config = { command, args: args || [], env: env || {} };
    mcpClient.initFromConfig({ [name]: config });
    await mcpClient.startServer(name, config);
    console.log(`[MCP] server added and started: ${name}`);
    return { success: true, name };
  } catch (err) {
    console.error(`[MCP] add-server error: ${err.message}`);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('mcp-remove-server', async (_e, name) => {
  if (!mcpClient) return { success: false, error: 'MCPClient not initialized' };
  try {
    await mcpClient.stopServer(name);
    mcpClient._servers.delete(name);
    mcpClient._rebuildDiscoveredTools();
    console.log(`[MCP] server removed: ${name}`);
    return { success: true };
  } catch (err) {
    console.error(`[MCP] remove-server error: ${err.message}`);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('mcp-toggle-server', async (_e, name) => {
  if (!mcpClient) return { success: false, error: 'MCPClient not initialized' };
  try {
    const server = mcpClient._servers.get(name);
    if (!server) return { success: false, error: `Server "${name}" not found` };
    if (server.status === 'running') {
      await mcpClient.stopServer(name);
      console.log(`[MCP] server stopped: ${name}`);
      return { success: true, status: 'stopped' };
    } else {
      await mcpClient.startServer(name, server.config);
      console.log(`[MCP] server started: ${name}`);
      return { success: true, status: 'running' };
    }
  } catch (err) {
    console.error(`[MCP] toggle-server error: ${err.message}`);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('mcp-server-status', () => {
  if (!mcpClient) return { servers: [] };
  return { servers: mcpClient.getServerStatus() };
});

ipcMain.handle('mcp-start-server', async (_e, name) => {
  if (!mcpClient) return { success: false, error: 'MCPClient not initialized' };
  try {
    const server = mcpClient._servers.get(name);
    if (!server) return { success: false, error: `Server "${name}" not found` };
    await mcpClient.startServer(name, server.config);
    console.log(`[MCP] server started: ${name}`);
    return { success: true };
  } catch (err) {
    console.error(`[MCP] start-server error: ${err.message}`);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('mcp-stop-server', async (_e, name) => {
  if (!mcpClient) return { success: false, error: 'MCPClient not initialized' };
  try {
    await mcpClient.stopServer(name);
    console.log(`[MCP] server stopped: ${name}`);
    return { success: true };
  } catch (err) {
    console.error(`[MCP] stop-server error: ${err.message}`);
    return { success: false, error: err.message };
  }
});

// Swap chat wrapper mode on the fly without reloading the model.
// Resets conversation. Modes: 'C' (ThinkingOpen), 'B' (Jinja no prefix), 'auto', 'off'
ipcMain.handle('set-thinking-mode', async (_e, mode) => {
  console.log(`[Settings] set-thinking-mode IPC START mode=${mode}`);
  try {
    const result = await llmEngine.setWrapperMode(mode);
    console.log(`[Settings] set-thinking-mode IPC DONE mode=${mode} success=${!!result?.success}`);
    return result;
  } catch (err) {
    console.error(`[Settings] set-thinking-mode IPC ERROR: ${err.message}`);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('ui-log', (_e, msg) => {
  const text = String(msg ?? '');
  if (text.startsWith('[TraceUI]')) {
    try {
      const payload = JSON.parse(text.slice('[TraceUI]'.length));
      streamTrace.trace('ui', payload.evt || 'ui', payload);
    } catch (_) {
      streamTrace.traceFull('ui', 'ui-log', text);
    }
    return;
  }
  console.log(`[UI] ${text}`);
});

function clearAllLogs() {
  log.clearAll();
  streamTrace.clearAll();
  console.log('[Main] All diagnostic logs cleared');
  return { success: true, logDir: streamTrace.LOG_DIR };
}

ipcMain.handle('clear-logs', () => clearAllLogs());

// Handle answer from frontend for ask_question tool
ipcMain.handle('answer-question', (_e, answer) => {
  if (mcpToolServer._pendingQuestionResolve) {
    const resolve = mcpToolServer._pendingQuestionResolve;
    mcpToolServer._pendingQuestionResolve = null;
    resolve({ success: true, answer });
  }
  return { received: true };
});

ipcMain.handle('cancel-pending-question', () => {
  cancelPendingQuestion('(skipped by user)');
  return { success: true };
});

ipcMain.handle('voice-transcribe', async (_e, audioBuffer, opts = {}) => {
  try {
    const buf = Buffer.from(audioBuffer);
    return await voiceService.transcribe(buf, opts || {});
  } catch (e) {
    return { success: false, error: e.message, useWebSpeech: true };
  }
});

ipcMain.handle('extension-install-file', async (_e, { buffer, fileName } = {}) => {
  if (!buffer || !fileName) return { success: false, error: 'buffer and fileName required' };
  try {
    const data = Buffer.from(buffer);
    let result;
    if (fileName.toLowerCase().endsWith('.vsix')) {
      result = await loadVsix(data, extensionManager);
    } else {
      result = await extensionManager.installFromZip(data, fileName);
    }
    if (result.success && result.id) {
      extensionHost.activate(result.id, extensionManager.getExtension(result.id));
    }
    return result;
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Handle permission response from frontend (approve/deny command execution)
ipcMain.handle('permission-response', (_e, reqId, approved) => {
  const resolvers = mcpToolServer._pendingPermissionResolvers;
  if (resolvers && resolvers[reqId]) {
    const resolve = resolvers[reqId];
    delete resolvers[reqId];
    resolve(approved);
  }
  return { received: true };
});

ipcMain.handle('cancel-generation', async () => {
  console.log('[electron-main] cancel-generation');
  agenticCancelled = true;
  ctx.agenticCancelled = true;
  llmEngine.cancelGeneration('user');
  try { mcpToolServer.killActiveChildren('user-cancel'); } catch (_) {}
  await llmEngine.waitForIdle({ timeoutMs: 5000 });
  _send('llm-stream-end', null);
  return { success: true };
});

ipcMain.handle('agent-pause', async () => {
  console.log('[electron-main] agent-pause');
  streamTrace.trace('stream', 'lifecycle-agent-pause', {});
  agenticCancelled = true;
  ctx.agenticCancelled = true;
  llmEngine.cancelGeneration('user');
  try { mcpToolServer.killActiveChildren('user-cancel'); } catch (_) {}
  await llmEngine.waitForIdle({ timeoutMs: 5000 });
  _send('llm-stream-end', null);
  return { success: true };
});

ipcMain.handle('force-send-queued', async () => {
  console.log('[electron-main] force-send-queued');
  agenticCancelled = true;
  ctx.agenticCancelled = true;
  llmEngine.cancelGeneration('user');
  try { mcpToolServer.killActiveChildren('user-cancel'); } catch (_) {}
  await llmEngine.waitForIdle({ timeoutMs: 5000 });
  _send('llm-stream-end', null);
  return { success: true };
});

ipcMain.handle('inject-user-message', (_e, payload) => {
  const text = typeof payload === 'string' ? payload : payload?.text;
  console.log(`[electron-main] inject-user-message: len=${String(text ?? '').length}`);
  if (!llmEngine._abortController) {
    console.warn('[electron-main] inject-user-message rejected: no active generation');
    return { success: false, delivered: false };
  }
  const injectResult = llmEngine.injectUserMessage(text);
  const delivered = injectResult?.delivered !== false;
  return { success: delivered, delivered };
});

// ─── File read helpers (binary preview) ─────────────────────────────
const BINARY_PREVIEW_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'pdf',
  'mp4', 'webm', 'mov', 'mkv', 'avi',
  'mp3', 'wav', 'ogg', 'm4a', 'flac',
]);

function listListeningPorts() {
  const { execSync } = require('child_process');
  const portSet = new Set();
  try {
    if (process.platform === 'win32') {
      const out = execSync('netstat -ano', { encoding: 'utf8', timeout: 8000 });
      for (const line of out.split('\n')) {
        const m = line.match(/TCP\s+[\d.:]+:(\d+)\s+[\d.:]+:0\s+LISTENING/i);
        if (m) {
          const port = parseInt(m[1], 10);
          if (port > 0 && port < 65536) portSet.add(port);
        }
      }
    } else {
      let out = '';
      try { out = execSync('ss -tln', { encoding: 'utf8', timeout: 8000 }); } catch (_) {
        out = execSync('netstat -tln', { encoding: 'utf8', timeout: 8000 });
      }
      for (const line of out.split('\n')) {
        const m = line.match(/:(\d+)\s/);
        if (m) {
          const port = parseInt(m[1], 10);
          if (port > 0 && port < 65536) portSet.add(port);
        }
      }
    }
  } catch (err) {
    console.warn('[Main] listListeningPorts failed:', err.message);
  }
  return Array.from(portSet).sort((a, b) => a - b).map((port) => ({
    port,
    label: `localhost:${port}`,
    url: `http://localhost:${port}`,
  }));
}

function getMimeForExtension(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  const map = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    pdf: 'application/pdf',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
  };
  return map[e] || 'application/octet-stream';
}

function isBinaryPreviewExtension(ext) {
  return BINARY_PREVIEW_EXTENSIONS.has(String(ext || '').toLowerCase().replace(/^\./, ''));
}

const BINARY_READ_INLINE_MAX = 10 * 1024 * 1024;

function isPathUnderWorkspaceRoots(absPath) {
  const resolved = path.resolve(absPath);
  const { roots } = multiRootWorkspace.getRoots();
  const candidates = roots.length ? roots : (currentProjectPath ? [currentProjectPath] : []);
  return candidates.some((root) => {
    const r = path.resolve(root);
    return resolved === r || resolved.startsWith(r + path.sep);
  });
}

// ─── Generic API-fetch IPC handler ──────────────────────────────────
// The frontend's fetch('/api/...') calls are intercepted and routed here.
// This replaces the entire Express REST API from server/main.js.

ipcMain.handle('api-fetch', async (_event, url, options) => {
  const _apiT0 = Date.now();
  const method = (options?.method || 'GET').toUpperCase();
  let body = {};
  if (options?.body) {
    try { body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body; } catch (_) {}
  }

  // Parse URL
  const urlObj = new URL(url, 'http://localhost');
  const p = urlObj.pathname;
  const q = Object.fromEntries(urlObj.searchParams);
  const _bodyLen = options?.body ? String(options.body).length : 0;
  const _apiRawBody = options?.body != null ? String(options.body) : '';
  console.log(`[api-fetch] ENTRY ${method} ${p} bodyLen=${_bodyLen}`);
  streamTrace.trace('api', 'api-req', { method, path: p, body: _apiRawBody });
  const apiReturn = (result) => {
    streamTrace.trace('api', 'api-res', {
      method,
      path: p,
      status: result?._status ?? 200,
      body: result,
      ms: Date.now() - _apiT0,
    });
    return result;
  };

  try {
    // ── Models ──────────────────────────────────────────
    if (p === '/api/models' && method === 'GET') {
      return apiReturn({ models: modelManager.availableModels, status: llmEngine.getStatus() });
    }
    if (p === '/api/models/load' && method === 'POST') {
      const { modelPath } = body;
      if (!modelPath) return { _status: 400, error: 'modelPath required' };
      streamTrace.trace('stream', 'lifecycle-model-load-start', { modelPath, body });
      const meta = await readGgufMetadata(modelPath);
      const ggufType = meta ? detectModelTypeFromGguf(meta) : 'unknown';
      if (ggufType === 'diffusion' || ggufType === 'video') {
        try {
          if (llmEngine.isReady) {
            try { llmEngine.cancelGeneration('media-load'); } catch (_) {}
            await llmEngine.dispose();
            _send('model-unloaded', {});
            console.log('[MediaEngine] unloaded LLM — media-only mode');
          }
          const status = await mediaEngine.load(modelPath);
          settingsManager.set('lastImageModelPath', modelPath);
          const info = { ...status, modelType: ggufType, path: modelPath };
          _send('media-model-loaded', info);
          console.log(`[MediaEngine] loaded arch=${status.ggufArchitecture} type=${ggufType}`);
          return apiReturn({ success: true, modelInfo: info, media: true });
        } catch (e) {
          return apiReturn({ _status: 400, error: e.message });
        }
      }
      if (ggufType === 'unknown') {
        const arch = meta?.general?.architecture || '(missing)';
        return apiReturn({
          _status: 400,
          error: meta
            ? `Unknown GGUF architecture "${arch}" — cannot load as LLM or media model`
            : 'Could not read GGUF metadata — cannot determine model type',
        });
      }
      if (mediaEngine.modelPath) {
        await mediaEngine.unload();
        settingsManager.set('lastImageModelPath', null);
        _send('media-model-unloaded', {});
        console.log('[MediaEngine] unloaded media model — LLM load');
      }
      cloudLLM.activeProvider = null;
      cloudLLM.activeModel = null;
      settingsManager.set('lastCloudProvider', null);
      settingsManager.set('lastCloudModel', null);
      applyModelRuntimeDefaults(modelPath);
      const loadSettings = buildEngineLoadSettings(settingsManager.getAll());
      console.log(`[Settings] model-load START path=${modelPath} thinkingMode=${loadSettings.thinkingMode} toolsEnabled=${settingsManager.get('toolsEnabled')} enableThinking=${loadSettings.enableThinking}`);
      try { llmEngine.cancelGeneration('model-load'); } catch (_) {}
      _send('model-loading', { path: modelPath });
      await llmEngine.initialize(modelPath, loadSettings);
      const info = llmEngine.modelInfo;
      if (info) info.runtimeThinkingMode = settingsManager.get('thinkingMode');
      settingsManager.set('lastModelPath', modelPath);
      _send('model-loaded', info);
      console.log(`[Settings] model-load DONE path=${modelPath} thinkingMode=${settingsManager.get('thinkingMode')}`);
      console.log(`[api-fetch] DONE POST /api/models/load ms=${Date.now() - _apiT0}`);
      return apiReturn({ success: true, modelInfo: info });
    }
    if (p === '/api/media/generate' && method === 'POST') {
      const { prompt, width, height, steps, seed, videoFrames, messageId, mediaType } = body || {};
      const resolvedMediaType = mediaType
        || (mediaEngine.modelType === 'video' ? 'video' : 'image');
      _send('media-generating', { prompt, messageId, mediaType: resolvedMediaType });
      const { queryGpuVramMB, resolveMediaMemoryFlags } = require('./mediaEngine');
      const settings = settingsManager.getAll();
      const vramMB = queryGpuVramMB();
      const memoryFlags = resolveMediaMemoryFlags(settings, vramMB);
      if (memoryFlags.offloadToCpu) {
        console.log(`[MediaEngine] low-VRAM policy vram=${vramMB}MB offload=${memoryFlags.offloadToCpu} vaeCpu=${memoryFlags.vaeOnCpu} t5Cpu=${memoryFlags.clipOnCpu}`);
      }
      const result = await runWithMediaVramPolicy(() => mediaEngine.generate(prompt, {
        width, height, steps, seed, videoFrames, vramMB, memoryFlags,
      }));
      if (result.success) {
        const b64 = result.videoBase64 || result.imageBase64;
        console.log(`[MediaEngine] media-complete ${result.mediaType || resolvedMediaType} path=${result.path} mime=${result.mimeType}`);
        _send('media-complete', {
          prompt,
          messageId,
          mimeType: result.mimeType,
          mediaType: result.mediaType || 'image',
          path: result.path,
          dataUrl: `data:${result.mimeType};base64,${b64}`,
        });
      } else {
        console.log(`[MediaEngine] media-error: ${result.error || 'unknown'}`);
        _send('media-error', { prompt, messageId, error: result.error, missing: result.missing });
      }
      return apiReturn(result);
    }
    if (p === '/api/media/status' && method === 'GET') {
      return apiReturn(mediaEngine.getStatus());
    }
    if (p === '/api/models/unload' && method === 'POST') {
      await llmEngine.dispose();
      return apiReturn({ success: true });
    }
    if (p === '/api/models/status' && method === 'GET') {
      return apiReturn(llmEngine.getStatus());
    }
    if (p === '/api/models/scan' && method === 'POST') {
      const models = await modelManager.scanModels();
      return apiReturn({ models });
    }
    if (p === '/api/models/add' && method === 'POST') {
      const { filePaths } = body;
      if (!filePaths || !Array.isArray(filePaths)) return { _status: 400, error: 'filePaths array required' };
      const added = await modelManager.addModels(filePaths);
      return apiReturn({ added });
    }
    if (p === '/api/models/upload' && method === 'POST') {
      // IPC file upload: expects body._files = [{ name, buffer }]
      const files = body._files;
      if (!files || !Array.isArray(files) || files.length === 0) {
        return apiReturn({ _status: 400, error: 'No files provided' });
      }
      const saved = [];
      for (const file of files) {
        const filename = path.basename(file.name);
        if (!filename.endsWith('.gguf')) continue;
        const destPath = path.join(MODELS_DIR, filename);
        await fsP.writeFile(destPath, Buffer.from(file.buffer));
        saved.push(filename);
      }
      if (saved.length === 0) return { _status: 400, error: 'No .gguf files found in upload' };
      await modelManager.scanModels();
      return apiReturn({ success: true, saved });
    }
    if (p === '/api/models/recommend' && method === 'GET') {
      let vramMB = 0;
      try {
        const { execSync } = require('child_process');
        const out = execSync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits', { timeout: 5000 }).toString().trim();
        vramMB = parseInt(out.split('\n')[0], 10) || 0;
      } catch { /* no GPU */ }
      const maxModelGB = vramMB > 0 ? Math.floor((vramMB * 0.85) / 1024) : 4;
      const recommended = [
        { name: 'Qwen 3.5 0.8B', file: 'Qwen3.5-0.8B-Q8_0.gguf', size: 0.8, desc: 'Tiny, ultra-fast', downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf', tags: ['general'] },
        { name: 'Qwen 3.5 4B', file: 'Qwen3.5-4B-Q8_0.gguf', size: 4.5, desc: 'Great balance', downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q8_0.gguf', tags: ['coding', 'general'] },
        { name: 'Qwen 3.5 9B', file: 'Qwen3.5-9B-Q4_K_M.gguf', size: 5.7, desc: 'Strong all-rounder', downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf', tags: ['coding', 'reasoning'] },
        { name: 'Qwen 3.5 27B', file: 'Qwen3.5-27B-Q4_K_M.gguf', size: 16.7, desc: 'High quality', downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-27B-GGUF/resolve/main/Qwen3.5-27B-Q4_K_M.gguf', tags: ['coding', 'reasoning'] },
        { name: 'Qwen 3.5 35B-A3B (MoE)', file: 'Qwen3.5-35B-A3B-Q4_K_M.gguf', size: 22.0, desc: 'MoE, fast for size', downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-35B-A3B-GGUF/resolve/main/Qwen3.5-35B-A3B-Q4_K_M.gguf', tags: ['coding', 'reasoning'] },
      ];
      const fits = recommended.filter(m => m.size <= maxModelGB);
      const other = recommended.filter(m => m.size > maxModelGB);
      return apiReturn({ fits, other, maxModelGB, vramMB });
    }

    // ── HuggingFace model downloads ─────────────────────
    if (p === '/api/models/hf/search' && method === 'GET') {
      const query = q.q;
      if (!query || !query.trim()) return { models: [] };
      const models = await modelDownloader.searchModels(query.trim());
      return apiReturn({ models });
    }
    if (p.startsWith('/api/models/hf/files/') && method === 'GET') {
      const parts = p.replace('/api/models/hf/files/', '').split('/');
      const repoId = parts.slice(0, 2).join('/');
      const result = await modelDownloader.getRepoFiles(repoId);
      return apiReturn(result);
    }
    if (p === '/api/models/hf/download' && method === 'POST') {
      const { url: dlUrl, fileName } = body;
      if (!dlUrl || !fileName) return { _status: 400, error: 'url and fileName required' };
      const result = await modelDownloader.downloadModel(dlUrl, fileName);
      return apiReturn({ success: true, ...result });
    }
    if (p === '/api/models/hf/cancel' && method === 'POST') {
      const { id } = body;
      if (!id) return { _status: 400, error: 'id required' };
      return apiReturn({ success: modelDownloader.cancelDownload(id) });
    }
    if (p === '/api/models/hf/downloads' && method === 'GET') {
      return apiReturn({ downloads: modelDownloader.getActiveDownloads() });
    }

    // ── GPU ─────────────────────────────────────────────
    if (p === '/api/gpu' && method === 'GET') {
      // Plan 8 instrumentation — track frequency of /api/gpu so we can identify
      // any caller that polls more often than the StatusBar's 60s schedule.
      // Logs once per call with the elapsed time since the previous call. The
      // upstream caller stack lives in chatEngine.getGPUInfo (also instrumented).
      try {
        const _now = Date.now();
        if (!global.__guideGpuApiLast) global.__guideGpuApiLast = 0;
        const _delta = global.__guideGpuApiLast ? (_now - global.__guideGpuApiLast) : 0;
        global.__guideGpuApiLast = _now;
        console.log(`[Main] /api/gpu hit (delta=${_delta}ms since last)`);
      } catch (_) {}
      const info = await llmEngine.getGPUInfo();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      info.ramTotalGB = (totalMem / (1024 ** 3)).toFixed(1);
      info.ramUsedGB = ((totalMem - freeMem) / (1024 ** 3)).toFixed(1);
      const cpus = os.cpus();
      let totalIdle = 0, totalTick = 0;
      for (const cpu of cpus) {
        for (const type in cpu.times) totalTick += cpu.times[type];
        totalIdle += cpu.times.idle;
      }
      info.cpuUsage = Math.round(100 - (totalIdle / totalTick * 100));
      if (llmEngine.modelInfo) {
        if (typeof llmEngine.modelInfo.gpuLayers === 'number') {
          info.gpuLayers = llmEngine.modelInfo.gpuLayers;
        }
        if (typeof llmEngine.modelInfo.contextSize === 'number') {
          info.modelContextSize = llmEngine.modelInfo.contextSize;
        }
        if (typeof llmEngine.modelInfo.totalLayers === 'number') {
          info.totalLayers = llmEngine.modelInfo.totalLayers;
        }
      }
      return apiReturn(info);
    }

    // ── Project ─────────────────────────────────────────
    if (p === '/api/project/open' && method === 'POST') {
      const { projectPath } = body;
      if (!projectPath) return { _status: 400, error: 'projectPath required' };
      const openedProject = await openProjectPath(projectPath);
      return apiReturn({ success: true, path: openedProject.path });
    }
    if (p === '/api/project/current' && method === 'GET') {
      return apiReturn({ projectPath: currentProjectPath });
    }

    // ── Files ───────────────────────────────────────────
    if (p === '/api/files/tree' && method === 'GET') {
      const dirPath = q.path || currentProjectPath;
      if (!dirPath) return { items: [] };
      const items = await _readDirRecursive(dirPath, 0, 3);
      return apiReturn({ items, root: dirPath });
    }
    if (p === '/api/files/import' && method === 'POST') {
      const { sources, destDir } = body;
      if (!Array.isArray(sources) || !destDir) {
        return apiReturn({ _status: 400, error: 'sources (array) and destDir required' });
      }
      const destResolved = path.resolve(destDir);
      if (!isPathUnderWorkspaceRoots(destResolved)) {
        return apiReturn({ _status: 403, error: 'Destination not in workspace' });
      }
      fs.mkdirSync(destResolved, { recursive: true });
      const copied = [];
      for (const src of sources) {
        if (!src || typeof src !== 'string') continue;
        const srcResolved = path.resolve(src);
        if (!fs.existsSync(srcResolved)) {
          return apiReturn({ _status: 404, error: `Source not found: ${srcResolved}` });
        }
        const destPath = path.join(destResolved, path.basename(srcResolved));
        fs.cpSync(srcResolved, destPath, { recursive: true, force: true });
        copied.push(destPath);
      }
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('files-changed');
      return apiReturn({ success: true, copied });
    }
    if (p === '/api/files/read' && method === 'GET') {
      const filePath = q.path;
      if (!filePath) return { _status: 400, error: 'path required' };
      const fullPath = path.isAbsolute(filePath) ? filePath : path.join(currentProjectPath || '', filePath);
      try {
        const ext = path.extname(fullPath).slice(1);
        const name = path.basename(fullPath);
        if (isBinaryPreviewExtension(ext)) {
          const stat = fs.statSync(fullPath);
          const mimeType = getMimeForExtension(ext);
          if (stat.size > BINARY_READ_INLINE_MAX) {
            return apiReturn({ path: fullPath, extension: ext, name, binary: true, mimeType, lazy: true });
          }
          const buf = fs.readFileSync(fullPath);
          const dataUrl = `data:${mimeType};base64,${buf.toString('base64')}`;
          return apiReturn({ path: fullPath, extension: ext, name, binary: true, mimeType, dataUrl });
        }
        const content = fs.readFileSync(fullPath, 'utf8');
        return apiReturn({ content, path: fullPath, extension: ext, name });
      } catch (err) {
        if (err.code === 'ENOENT') {
          return apiReturn({ content: null, path: fullPath, missing: true, name: path.basename(fullPath) });
        }
        throw err;
      }
    }
    if (p === '/api/files/write' && method === 'POST') {
      const { filePath, content, formatOnSave: doFormat, encoding } = body;
      if (!filePath) return { _status: 400, error: 'filePath required' };
      const fullPath = path.isAbsolute(filePath) ? filePath : path.join(currentProjectPath || '', filePath);
      let finalContent = content || '';
      let formatResult = null;
      if (encoding === 'base64') {
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, Buffer.from(finalContent, 'base64'));
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('files-changed');
        return apiReturn({ success: true, path: fullPath, binary: true });
      }
      if (doFormat !== false && settingsManager.get('formatOnSave') !== false) {
        formatResult = await formatOnSave({
          content: finalContent,
          filePath: fullPath,
          projectPath: currentProjectPath,
          formatEnabled: true,
          lintEnabled: settingsManager.get('lintOnSave') !== false,
        });
        finalContent = formatResult.content;
        if (formatResult.problems?.length) {
          _send('format-problems', { filePath: fullPath, problems: formatResult.problems });
        }
      }
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, finalContent, 'utf8');
      return apiReturn({ success: true, path: fullPath, content: finalContent, formatted: formatResult?.formatted || false, problems: formatResult?.problems || [] });
    }
    if (p === '/api/files/create' && method === 'POST') {
      const { path: fp, content } = body;
      if (!fp) return { _status: 400, error: 'path required' };
      const fullPath = path.isAbsolute(fp) ? fp : path.join(currentProjectPath || '', fp);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      if (fs.existsSync(fullPath)) return { _status: 409, error: 'File already exists' };
      fs.writeFileSync(fullPath, content || '', 'utf8');
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('files-changed');
      return apiReturn({ success: true, path: fullPath });
    }
    if (p === '/api/files/mkdir' && method === 'POST') {
      const { path: fp } = body;
      if (!fp) return { _status: 400, error: 'path required' };
      const fullPath = path.isAbsolute(fp) ? fp : path.join(currentProjectPath || '', fp);
      if (fs.existsSync(fullPath)) return { _status: 409, error: 'Already exists' };
      fs.mkdirSync(fullPath, { recursive: true });
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('files-changed');
      return apiReturn({ success: true, path: fullPath });
    }
    if (p === '/api/files/delete' && method === 'POST') {
      const { path: fp } = body;
      if (!fp) return { _status: 400, error: 'path required' };
      const fullPath = path.isAbsolute(fp) ? fp : path.join(currentProjectPath || '', fp);
      if (!fs.existsSync(fullPath)) return { _status: 404, error: 'Not found' };
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(fullPath);
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('files-changed', { deletedPaths: [fullPath] });
      }
      return apiReturn({ success: true });
    }
    if (p === '/api/files/rename' && method === 'POST') {
      const { oldPath, newPath } = body;
      if (!oldPath || !newPath) return { _status: 400, error: 'oldPath and newPath required' };
      const fullOld = path.isAbsolute(oldPath) ? oldPath : path.join(currentProjectPath || '', oldPath);
      const fullNew = path.isAbsolute(newPath) ? newPath : path.join(currentProjectPath || '', newPath);
      if (!fs.existsSync(fullOld)) return { _status: 404, error: 'Source not found' };
      fs.renameSync(fullOld, fullNew);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('files-changed');
      return apiReturn({ success: true, path: fullNew });
    }
    if (p === '/api/files/search' && method === 'GET') {
      const basePath = q.path || currentProjectPath;
      const query = q.query;
      const semantic = q.semantic === 'true';
      if (!basePath || !query) return { results: [] };
      const results = [];
      const maxResults = 200;
      const searchDir = (dir, depth = 0) => {
        if (depth > 6 || results.length >= maxResults) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const entry of entries) {
          if (results.length >= maxResults) break;
          if (entry.name.startsWith('.') && entry.name !== '.env') continue;
          if (['node_modules', '__pycache__', '.git', 'dist', 'build', '.next', 'target'].includes(entry.name)) continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            searchDir(fullPath, depth + 1);
          } else if (entry.isFile()) {
            try {
              const stat = fs.statSync(fullPath);
              if (stat.size > 1024 * 1024) continue;
              const content = fs.readFileSync(fullPath, 'utf8');
              const lines = content.split('\n');
              const lowerQuery = query.toLowerCase();
              // Collect all matching lines with context
              const matches = [];
              for (let i = 0; i < lines.length && matches.length < 50; i++) {
                if (lines[i].toLowerCase().includes(lowerQuery)) {
                  matches.push({ line: i + 1, text: lines[i].trim().substring(0, 200), lineText: lines[i] });
                }
              }
              if (matches.length > 0) {
                // Compute semantic score for the file
                let semanticScore = matches.length; // base: more matches = more relevant
                if (semantic) {
                  const lowerContent = content.toLowerCase();
                  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
                  // TF-IDF-ish: boost if query terms appear in identifiers/definitions
                  for (const term of queryTerms) {
                    // Boost: function/class/method definitions containing the term
                    const defPattern = new RegExp(`(?:function|class|def|const|let|var|interface|type|enum)\\s+\\w*${term}\\w*`, 'gi');
                    const defMatches = lowerContent.match(defPattern);
                    if (defMatches) semanticScore += defMatches.length * 3;
                    // Boost: comments/docstrings containing the term
                    const commentPattern = new RegExp(`(?:\\/\\/|#|\\/\\*|\\*|"""|''')\\s*.*${term}`, 'gi');
                    const commentMatches = lowerContent.match(commentPattern);
                    if (commentMatches) semanticScore += commentMatches.length * 1.5;
                    // Boost: export/public API containing the term
                    const exportPattern = new RegExp(`(?:export|public|module\\.exports)\\s+\\w*${term}\\w*`, 'gi');
                    const exportMatches = lowerContent.match(exportPattern);
                    if (exportMatches) semanticScore += exportMatches.length * 2;
                  }
                  // Penalize very large files (diluted relevance)
                  if (lines.length > 500) semanticScore *= 0.7;
                }
                for (const m of matches) {
                  results.push({ file: fullPath, line: m.line, text: m.text, score: semanticScore });
                }
              }
            } catch (_) {}
          }
        }
      };
      searchDir(basePath);
      // Sort by semantic score (descending) if semantic mode, otherwise keep file order
      if (semantic) {
        results.sort((a, b) => (b.score || 0) - (a.score || 0));
      }
      return apiReturn({ results: results.slice(0, maxResults) });
    }
    if (p === '/api/files/replace' && method === 'POST') {
      const basePath = body.path || currentProjectPath;
      const query = body.query;
      const replace = body.replace ?? '';
      const replaceAll = !!body.replaceAll;
      if (!basePath || query == null || query === '') return { _status: 400, error: 'path and query required' };
      let filesChanged = 0;
      let replacements = 0;
      const replaceDir = (dir, depth = 0) => {
        if (depth > 6) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const entry of entries) {
          if (entry.name.startsWith('.') && entry.name !== '.env') continue;
          if (['node_modules', '__pycache__', '.git', 'dist', 'build', '.next', 'target'].includes(entry.name)) continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            replaceDir(fullPath, depth + 1);
          } else if (entry.isFile()) {
            try {
              const stat = fs.statSync(fullPath);
              if (stat.size > 1024 * 1024) continue;
              const content = fs.readFileSync(fullPath, 'utf8');
              let newContent = content;
              let fileReplacements = 0;
              if (replaceAll) {
                let idx = 0;
                while ((idx = newContent.indexOf(query, idx)) !== -1) {
                  fileReplacements++;
                  newContent = newContent.slice(0, idx) + replace + newContent.slice(idx + query.length);
                  idx += replace.length;
                }
              } else {
                const lines = content.split('\n');
                let changed = false;
                for (let i = 0; i < lines.length; i++) {
                  const idx = lines[i].indexOf(query);
                  if (idx !== -1) {
                    lines[i] = lines[i].slice(0, idx) + replace + lines[i].slice(idx + query.length);
                    fileReplacements++;
                    changed = true;
                  }
                }
                if (changed) newContent = lines.join('\n');
              }
              if (fileReplacements > 0) {
                fs.writeFileSync(fullPath, newContent, 'utf8');
                filesChanged++;
                replacements += fileReplacements;
              }
            } catch (_) {}
          }
        }
      };
      replaceDir(basePath);
      if (filesChanged > 0 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('files-changed');
      }
      return apiReturn({ success: true, filesChanged, replacements });
    }

    // ── Logs ────────────────────────────────────────────
    if (p === '/api/logs/clear' && method === 'POST') {
      return apiReturn(clearAllLogs());
    }

    // ── Settings ────────────────────────────────────────
    if (p === '/api/settings' && method === 'GET') {
      return apiReturn(settingsManager.getAll());
    }
    if (p === '/api/settings' && method === 'POST') {
      console.log(`[Settings] POST /api/settings HANDLER START thinkingMode=${body?.thinkingMode} toolsEnabled=${body?.toolsEnabled} browserEngine=${body?.browserEngine}`);
      settingsManager.setAll(body);
      if (body?.streamTraceEnabled !== false) {
        settingsManager.set('debugStreamDiag', true);
      }
      settingsManager.flush();
      currentSettings = settingsManager.getAll();
      streamTrace.syncFromSettings(currentSettings);
      syncBrowserRouterFromSettings();
      console.log(`[Settings] POST /api/settings HANDLER DONE thinkingMode=${settingsManager.get('thinkingMode')} browserEngine=${settingsManager.get('browserEngine')}`);
      console.log(`[api-fetch] DONE POST /api/settings ms=${Date.now() - _apiT0}`);
      return apiReturn({ success: true });
    }

    // ── Cloud LLM ───────────────────────────────────────
    if (p === '/api/cloud/status' && method === 'GET') {
      return apiReturn(cloudLLM.getStatus());
    }
    if (p === '/api/cloud/providers' && method === 'GET') {
      return apiReturn({ configured: cloudLLM.getConfiguredProviders(), all: cloudLLM.getAllProviders() });
    }
    if (p.startsWith('/api/cloud/models/') && method === 'GET') {
      const provider = p.replace('/api/cloud/models/', '');
      if (provider === 'openrouter') {
        const models = await cloudLLM.fetchOpenRouterModels();
        return apiReturn({ models });
      } else if (provider === 'ollama') {
        await cloudLLM.detectOllama();
        return apiReturn({ models: cloudLLM.getOllamaModels() });
      } else {
        return apiReturn({ models: cloudLLM._getProviderModels(provider) });
      }
    }
    if (p === '/api/cloud/provider' && method === 'POST') {
      const { provider, model } = body;
      if (!provider || provider === 'none') {
        cloudLLM.activeProvider = null;
        cloudLLM.activeModel = null;
        settingsManager.set('lastCloudProvider', null);
        settingsManager.set('lastCloudModel', null);
        return apiReturn({ success: true, activeProvider: null, activeModel: null });
      }
      try { llmEngine.cancelGeneration('cloud-select'); } catch (_) {}
      if (llmEngine.isReady || llmEngine.getStatus().loadState === 'loading') {
        console.log('[Main] Unloading local model — cloud provider selected');
        await llmEngine.dispose();
        _send('model-unloaded', {});
      }
      cloudLLM.activeProvider = provider;
      if (model) cloudLLM.activeModel = model;
      settingsManager.set('lastCloudProvider', provider);
      settingsManager.set('lastCloudModel', model || null);
      return apiReturn({ success: true, activeProvider: cloudLLM.activeProvider, activeModel: cloudLLM.activeModel });
    }
    if (p === '/api/tools/strip-prose' && method === 'POST') {
      const { stripToolCallText } = require('./tools/toolParser');
      const text = body?.text != null ? String(body.text) : '';
      return apiReturn({ text: stripToolCallText(text) });
    }
    if (p === '/api/cloud/apikey' && method === 'POST') {
      const { provider, key } = body;
      if (!provider) return { _status: 400, error: 'provider required' };
      cloudLLM.setApiKey(provider, key || '');
      settingsManager.setApiKey(provider, key || '');
      return apiReturn({ success: true, hasKey: !!(key && key.trim()) });
    }
    if (p.startsWith('/api/cloud/pool/') && method === 'GET') {
      const provider = p.replace('/api/cloud/pool/', '');
      return apiReturn(cloudLLM.getPoolStatus(provider));
    }
    if (p.startsWith('/api/cloud/test/') && method === 'GET') {
      const provider = p.replace('/api/cloud/test/', '');
      if (!provider) return { success: false, error: 'provider required' };
      const key = cloudLLM.apiKeys[provider];
      if (!key) return { success: false, error: 'No API key set' };
      const models = cloudLLM._getProviderModels(provider);
      const testModel = models[0]?.id;
      if (!testModel) return { success: false, error: 'No models for provider' };
      const prevProvider = cloudLLM.activeProvider;
      const prevModel = cloudLLM.activeModel;
      cloudLLM.activeProvider = provider;
      cloudLLM.activeModel = testModel;
      try {
        await Promise.race([
          cloudLLM.generate([{ role: 'user', content: 'Say hi' }], { maxTokens: 5, stream: false }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout after 15s')), 15000)),
        ]);
        return apiReturn({ success: true });
      } catch (e) {
        return apiReturn({ success: false, error: e.message });
      } finally {
        cloudLLM.activeProvider = prevProvider;
        cloudLLM.activeModel = prevModel;
      }
    }

    // ── Git ──────────────────────────────────────────────
    if (p === '/api/git/status' && method === 'GET') {
      const basePath = q.path || currentProjectPath;
      if (!basePath) return { error: 'No project path' };
      try {
        return apiReturn(gitManager.getStatus(basePath));
      } catch (e) {
        return apiReturn({ error: e.message, branch: '', staged: [], modified: [], untracked: [] });
      }
    }
    if (p === '/api/git/stage' && method === 'POST') {
      const basePath = body.path || currentProjectPath;
      if (!basePath) return { _status: 400, error: 'No project path' };
      if (body.all) {
        gitManager.stageAll(basePath);
      } else if (body.files && Array.isArray(body.files)) {
        gitManager.stageFiles(body.files, basePath);
      } else {
        return apiReturn({ _status: 400, error: 'Provide files array or all:true' });
      }
      return apiReturn({ success: true });
    }
    if (p === '/api/git/unstage' && method === 'POST') {
      const basePath = body.path || currentProjectPath;
      if (!basePath) return { _status: 400, error: 'No project path' };
      if (body.all) {
        gitManager.unstageAll(basePath);
      } else if (body.files && Array.isArray(body.files)) {
        gitManager.unstageFiles(body.files, basePath);
      } else {
        return apiReturn({ _status: 400, error: 'Provide files array or all:true' });
      }
      return apiReturn({ success: true });
    }
    if (p === '/api/git/commit' && method === 'POST') {
      const basePath = body.path || currentProjectPath;
      const message = body.message;
      if (!basePath) return { _status: 400, error: 'No project path' };
      if (!message || !message.trim()) return { _status: 400, error: 'Commit message required' };
      return apiReturn(gitManager.commit(message, basePath));
    }
    if (p === '/api/git/discard' && method === 'POST') {
      const basePath = body.path || currentProjectPath;
      if (!basePath) return { _status: 400, error: 'No project path' };
      if (body.files && Array.isArray(body.files)) {
        gitManager.discardFiles(body.files, basePath);
      } else {
        return apiReturn({ _status: 400, error: 'Provide files array' });
      }
      return apiReturn({ success: true });
    }
    if (p === '/api/git/diff' && method === 'GET') {
      const basePath = q.path || currentProjectPath;
      if (!basePath) return { _status: 400, error: 'No project path' };
      return apiReturn(gitManager.getDiff({ staged: q.staged === 'true', file: q.file }, basePath));
    }
    if (p === '/api/git/log' && method === 'GET') {
      const basePath = q.path || currentProjectPath;
      if (!basePath) return { _status: 400, error: 'No project path' };
      const count = parseInt(q.count) || 20;
      return apiReturn(gitManager.getLog(count, basePath));
    }
    if (p === '/api/git/branches' && method === 'GET') {
      const basePath = q.path || currentProjectPath;
      if (!basePath) return { _status: 400, error: 'No project path' };
      return apiReturn(gitManager.getBranches(basePath));
    }
    if (p === '/api/git/checkout' && method === 'POST') {
      const basePath = body.path || currentProjectPath;
      const branch = body.branch;
      if (!basePath) return { _status: 400, error: 'No project path' };
      if (!branch) return { _status: 400, error: 'Branch name required' };
      return apiReturn(gitManager.checkout(branch, { create: !!body.create }, basePath));
    }
    if (p === '/api/git/blame' && method === 'GET') {
      const basePath = q.path || currentProjectPath;
      if (!basePath) return { _status: 400, error: 'No project path' };
      if (!q.file) return { _status: 400, error: 'File path required' };
      try {
        return apiReturn(gitManager.blame(q.file, basePath));
      } catch (e) {
        return apiReturn({ success: false, error: e.message });
      }
    }
    if (p === '/api/git/stage-all-commit' && method === 'POST') {
      const basePath = body.path || currentProjectPath;
      const message = body.message;
      if (!basePath) return { _status: 400, error: 'No project path' };
      if (!message || !message.trim()) return { _status: 400, error: 'Commit message required' };
      try {
        return apiReturn(gitManager.stageAllAndCommit(message, basePath));
      } catch (e) {
        return apiReturn({ success: false, error: e.message });
      }
    }
    if (p === '/api/git/push' && method === 'POST') {
      const basePath = body.path || currentProjectPath;
      if (!basePath) return { _status: 400, error: 'No project path' };
      const remote = body.remote || 'origin';
      try {
        return apiReturn(gitManager.push(remote, body.branch, basePath));
      } catch (e) {
        return apiReturn({ success: false, error: e.message });
      }
    }
    if (p === '/api/git/pull' && method === 'POST') {
      const basePath = body.path || currentProjectPath;
      if (!basePath) return { _status: 400, error: 'No project path' };
      const remote = body.remote || 'origin';
      try {
        return apiReturn(gitManager.pull(remote, body.branch, basePath));
      } catch (e) {
        return apiReturn({ success: false, error: e.message });
      }
    }

    // ── License ─────────────────────────────────────────
    if (p === '/api/license/status' && method === 'GET') {
      return apiReturn({
        isActivated: licenseManager.isActivated || false,
        isAuthenticated: accountManager.isAuthenticated || false,
        license: licenseManager.licenseData || null,
        machineId: licenseManager.machineId || null,
        user: accountManager.user || null,
        plan: licenseManager.getPlan(),
      });
    }
    if (p === '/api/license/activate' && method === 'POST') {
      const { method: activationMethod, key, email, password } = body;
      if (activationMethod === 'key') {
        return apiReturn(await licenseManager.activateKey(key));
      } else if (activationMethod === 'account') {
        if (email && password) {
          const loginResult = await accountManager.loginWithEmail(email, password);
          if (!loginResult.success) return loginResult;
        }
        return apiReturn(await licenseManager.activateAccount());
      } else {
        return apiReturn({ success: false, error: 'Invalid activation method. Use "key" or "account".' });
      }
    }
    if (p === '/api/license/oauth' && method === 'POST') {
      const { provider } = body;
      if (!provider || !['google', 'github'].includes(provider)) {
        return apiReturn({ success: false, error: 'Invalid OAuth provider' });
      }
      const { url: oauthUrl } = accountManager.getOAuthURL(provider);
      const nav = await runOAuthInWindow({ parent: mainWindow, oauthUrl });
      if (!nav.success) {
        return apiReturn({ success: false, error: nav.error || 'Sign-in cancelled' });
      }
      const oauthResult = nav.guideToken
        ? await accountManager.completeOAuthWithToken(nav.guideToken)
        : { success: false, error: 'Sign-in did not return a session token. Update graysoft.dev and try again.' };
      if (!oauthResult.success) {
        return apiReturn(oauthResult);
      }
      const activateResult = await licenseManager.activateAccount();
      if (!activateResult.success) {
        console.warn('[OAuth] signed in but license bind:', activateResult.error);
      } else if (activateResult.warning) {
        console.log('[OAuth] signed in (cloud free tier):', activateResult.warning);
      }
      return apiReturn({
        success: true,
        user: oauthResult.user,
        licenseActivated: activateResult.success && !activateResult.cloudOnly,
        licenseError: activateResult.success ? activateResult.warning : activateResult.error,
      });
    }
    if (p === '/api/license/deactivate' && method === 'POST') {
      licenseManager.deactivate();
      accountManager.logout();
      return apiReturn({ success: true });
    }
    if (p === '/api/license/plans' && method === 'GET') {
      return apiReturn({ plans: licenseManager.getPlans() });
    }
    if (p === '/api/stripe/checkout' && method === 'POST') {
      const { plan } = body;
      return apiReturn(await licenseManager.createCheckoutSession(plan));
    }
    if (p === '/api/stripe/subscription' && method === 'GET') {
      return apiReturn(await licenseManager.checkSubscription());
    }

    // ── Account ─────────────────────────────────────────
    if (p === '/api/account/status' && method === 'GET') {
      return apiReturn({
        isAuthenticated: accountManager._isAuthenticated,
        user: accountManager._user,
        machineId: accountManager._machineId,
      });
    }
    if (p === '/api/account/login' && method === 'POST') {
      const { email, password } = body;
      return apiReturn(await accountManager.loginWithEmail(email, password));
    }
    if (p === '/api/account/register' && method === 'POST') {
      const { email, password, name } = body;
      return apiReturn(await accountManager.register(email, password, name));
    }
    if (p === '/api/account/oauth/start' && method === 'POST') {
      const { provider } = body;
      if (!provider || !['google', 'github'].includes(provider)) {
        return apiReturn({ success: false, error: 'Invalid OAuth provider' });
      }
      const { url: oauthUrl } = accountManager.getOAuthURL(provider);
      const nav = await runOAuthInWindow({ parent: mainWindow, oauthUrl });
      if (!nav.success) {
        return apiReturn({ success: false, error: nav.error || 'Sign-in cancelled' });
      }
      if (nav.guideToken) {
        return apiReturn(await accountManager.completeOAuthWithToken(nav.guideToken));
      }
      return apiReturn({ success: false, error: 'Sign-in did not return a session token' });
    }
    if (p === '/api/account/logout' && method === 'POST') {
      accountManager.logout();
      return apiReturn({ success: true });
    }
    if (p === '/api/account/refresh' && method === 'POST') {
      return apiReturn(await accountManager.refreshSession());
    }

    // ── Setup (first run) ───────────────────────────────
    if (p === '/api/setup/status' && method === 'GET') {
      return apiReturn({
        isFirstRun: firstRunSetup.isFirstRun(),
        systemInfo: firstRunSetup.getSystemInfo(),
        recommended: firstRunSetup.recommendSettings(),
      });
    }
    if (p === '/api/setup/complete' && method === 'POST') {
      const { applyRecommended, settings } = body;
      if (applyRecommended) firstRunSetup.applyRecommended();
      if (settings && typeof settings === 'object') {
        for (const [key, value] of Object.entries(settings)) {
          if (key in settingsManager.getAll()) {
            settingsManager.set(key, value);
          }
        }
      }
      firstRunSetup.markComplete();
      return apiReturn({ success: true });
    }

    // ── LSP ─────────────────────────────────────────────
    if (p === '/api/lsp/start' && method === 'POST') {
      const { language, cwd } = body;
      const basePath = cwd || currentProjectPath;
      if (!basePath) return { _status: 400, error: 'No project path' };
      return apiReturn(await languageServerManager.start(language || 'typescript', basePath));
    }
    if (p === '/api/lsp/status' && method === 'GET') {
      return apiReturn({ success: true, status: lspBundleManager.getStatus(), running: languageServerManager.listRunning() });
    }
    if (p === '/api/lsp/install' && method === 'POST') {
      const { language } = body;
      if (!language) return { _status: 400, error: 'language required' };
      try {
        const cmd = await lspBundleManager.ensureLanguage(language);
        return apiReturn({ success: true, ...cmd, status: lspBundleManager.getStatus() });
      } catch (e) {
        return apiReturn({ success: false, error: e.message });
      }
    }
    if (p === '/api/lsp/stop' && method === 'POST') {
      const { serverId } = body;
      if (serverId) languageServerManager.stop(serverId);
      else languageServerManager.stopAll();
      return apiReturn({ success: true });
    }
    if (p === '/api/lsp/list' && method === 'GET') {
      return apiReturn({ success: true, servers: languageServerManager.listRunning() });
    }
    if (p === '/api/lsp/send' && method === 'POST') {
      const { serverId, method: lspMethod, params, language, cwd } = body;
      if (!lspMethod) return { _status: 400, error: 'method required' };
      const basePath = cwd || currentProjectPath;
      let sid = serverId;
      if (!sid) {
        const lang = language || params?.textDocument?.uri?.split('.').pop() || 'typescript';
        const ensured = await languageServerManager.ensureServer(lang, basePath);
        if (!ensured.success) return { _status: 503, error: ensured.error || 'No LSP server' };
        sid = ensured.serverId;
      }
      // Notifications (didOpen/didChange/didClose) — fire and forget
      if (lspMethod.startsWith('textDocument/did') || lspMethod.startsWith('$/')) {
        languageServerManager.sendNotification(sid, lspMethod, params || {});
        return apiReturn({ success: true });
      }
      try {
        const result = await languageServerManager.sendRequest(sid, lspMethod, params || {});
        return apiReturn({ success: true, result });
      } catch (e) {
        return apiReturn({ _status: 502, error: e.message });
      }
    }
    if (p === '/api/lsp/completion' && method === 'POST') {
      const { uri, line, character, language, cwd } = body;
      if (!uri) return { _status: 400, error: 'uri required' };
      const basePath = cwd || currentProjectPath;
      const ensured = await languageServerManager.ensureServer(language || 'typescript', basePath);
      if (!ensured.success) return { _status: 503, error: ensured.error || 'No LSP server' };
      try {
        const result = await languageServerManager.sendRequest(ensured.serverId, 'textDocument/completion', {
          textDocument: { uri },
          position: { line, character },
        });
        return apiReturn({ success: true, result });
      } catch (e) {
        return apiReturn({ _status: 502, error: e.message });
      }
    }
    if (p === '/api/lsp/hover' && method === 'POST') {
      const { uri, line, character, language, cwd } = body;
      if (!uri) return { _status: 400, error: 'uri required' };
      const basePath = cwd || currentProjectPath;
      const ensured = await languageServerManager.ensureServer(language || 'typescript', basePath);
      if (!ensured.success) return { _status: 503, error: ensured.error || 'No LSP server' };
      try {
        const result = await languageServerManager.sendRequest(ensured.serverId, 'textDocument/hover', {
          textDocument: { uri },
          position: { line, character },
        });
        return apiReturn({ success: true, result });
      } catch (e) {
        return apiReturn({ _status: 502, error: e.message });
      }
    }
    if (p === '/api/lsp/definition' && method === 'POST') {
      const { uri, line, character, language, cwd } = body;
      if (!uri) return { _status: 400, error: 'uri required' };
      const basePath = cwd || currentProjectPath;
      const ensured = await languageServerManager.ensureServer(language || 'typescript', basePath);
      if (!ensured.success) return { _status: 503, error: ensured.error || 'No LSP server' };
      try {
        const result = await languageServerManager.sendRequest(ensured.serverId, 'textDocument/definition', {
          textDocument: { uri },
          position: { line, character },
        });
        return apiReturn({ success: true, result });
      } catch (e) {
        return apiReturn({ _status: 502, error: e.message });
      }
    }
    if (p === '/api/lsp/documentSymbol' && method === 'POST') {
      const { uri, language, cwd } = body;
      if (!uri) return { _status: 400, error: 'uri required' };
      const basePath = cwd || currentProjectPath;
      const ensured = await languageServerManager.ensureServer(language || 'typescript', basePath);
      if (!ensured.success) return { _status: 503, error: ensured.error || 'No LSP server' };
      try {
        const result = await languageServerManager.sendRequest(ensured.serverId, 'textDocument/documentSymbol', {
          textDocument: { uri },
        });
        return apiReturn({ success: true, result });
      } catch (e) {
        return apiReturn({ _status: 502, error: e.message });
      }
    }

    if (p === '/api/lsp/rename' && method === 'POST') {
      const { uri, line, character, newName, language, cwd } = body;
      if (!uri || !newName) return { _status: 400, error: 'uri and newName required' };
      const basePath = cwd || currentProjectPath;
      const ensured = await languageServerManager.ensureServer(language || 'typescript', basePath);
      if (!ensured.success) return { _status: 503, error: ensured.error || 'No LSP server' };
      try {
        const result = await languageServerManager.sendRequest(ensured.serverId, 'textDocument/rename', {
          textDocument: { uri },
          position: { line, character },
          newName,
        });
        return apiReturn({ success: true, result });
      } catch (e) {
        return apiReturn({ _status: 502, error: e.message });
      }
    }

    // ── Inline completion (FIM) ─────────────────────────
    if (p === '/api/complete' && method === 'POST') {
      const result = await fimCompletionService.complete(body);
      return apiReturn({ success: true, text: result?.text || '' });
    }

    if (p === '/api/voice/status' && method === 'GET') {
      return apiReturn({ success: true, ...voiceService.getStatus() });
    }
    if (p === '/api/voice/transcribe' && method === 'POST') {
      if (body._audioBuffer) {
        const buf = Buffer.from(body._audioBuffer);
        return apiReturn(await voiceService.transcribe(buf, { format: body.format || 'wav' }));
      }
      return apiReturn({ success: false, error: 'audio buffer required', useWebSpeech: true });
    }

    // ── Extension host commands ─────────────────────────
    if (p === '/api/extensions/commands' && method === 'GET') {
      return apiReturn({ success: true, commands: extensionHost.listCommands() });
    }
    if (p === '/api/extensions/runCommand' && method === 'POST') {
      const { commandId, args } = body;
      if (!commandId) return { _status: 400, error: 'commandId required' };
      return apiReturn(extensionHost.executeCommand(commandId, ...(args || [])));
    }

    // ── Extensions marketplace ──────────────────────────
    if (p === '/api/extensions/catalog' && method === 'GET') {
      return apiReturn(await fetchCatalog());
    }

    // ── Extensions ──────────────────────────────────────
    if (p === '/api/extensions' && method === 'GET') {
      return apiReturn({ extensions: extensionManager.getInstalled(), categories: extensionManager.getCategories() });
    }
    if (p === '/api/extensions/install' && method === 'POST') {
      if (body.downloadUrl) {
        const result = await extensionManager.installFromUrl(body.downloadUrl);
        extensionHost.activate(result.id, extensionManager.getExtension(result.id));
        return apiReturn({ success: true, ...result });
      }
      if (body._vsixBuffer && body._fileName) {
        const result = await loadVsix(Buffer.from(body._vsixBuffer), extensionManager);
        if (result.success && result.id) {
          extensionHost.activate(result.id, extensionManager.getExtension(result.id));
        }
        return apiReturn(result);
      }
      // File upload — handle binary data passed from frontend
      if (body._fileBuffer && body._fileName) {
        const result = await extensionManager.installFromZip(Buffer.from(body._fileBuffer), body._fileName);
        extensionHost.activate(result.id, extensionManager.getExtension(result.id));
        return apiReturn({ success: true, ...result });
      }
      return apiReturn({ _status: 400, error: 'File upload or downloadUrl required' });
    }
    if (p === '/api/extensions/enable' && method === 'POST') {
      const { id } = body;
      if (!id) return { _status: 400, error: 'Extension ID required' };
      const result = await extensionManager.enable(id);
      const ext = extensionManager.getExtension(id);
      if (ext) extensionHost.activate(id, ext);
      return apiReturn({ success: true, ...result });
    }
    if (p === '/api/extensions/disable' && method === 'POST') {
      const { id } = body;
      if (!id) return { _status: 400, error: 'Extension ID required' };
      extensionHost.deactivate(id);
      const result = await extensionManager.disable(id);
      return apiReturn({ success: true, ...result });
    }
    if (p === '/api/extensions/uninstall' && method === 'POST') {
      const { id } = body;
      if (!id) return { _status: 400, error: 'Extension ID required' };
      extensionHost.deactivate(id);
      return apiReturn({ success: true, ...(await extensionManager.uninstall(id)) });
    }

    // ── Debug ───────────────────────────────────────────
    if (p === '/api/debug/start' && method === 'POST') {
      const { type, program, cwd, args: debugArgs } = body;
      if (!program) return { _status: 400, error: 'Program path required' };
      return apiReturn(await debugService.start({
        type: type || 'node', program,
        cwd: cwd || currentProjectPath || undefined,
        args: debugArgs || [],
      }));
    }
    if (p === '/api/debug/stop' && method === 'POST') {
      const { sessionId } = body;
      if (!sessionId) return { _status: 400, error: 'Session ID required' };
      return apiReturn(await debugService.stop(sessionId));
    }
    if (p === '/api/debug/continue' && method === 'POST') {
      return apiReturn(await debugService.resume(body.sessionId));
    }
    if (p === '/api/debug/stepOver' && method === 'POST') {
      return apiReturn(await debugService.stepOver(body.sessionId));
    }
    if (p === '/api/debug/stepInto' && method === 'POST') {
      return apiReturn(await debugService.stepInto(body.sessionId));
    }
    if (p === '/api/debug/stepOut' && method === 'POST') {
      return apiReturn(await debugService.stepOut(body.sessionId));
    }
    if (p === '/api/debug/pause' && method === 'POST') {
      return apiReturn(await debugService.pause(body.sessionId));
    }
    if (p === '/api/debug/stackTrace' && method === 'GET') {
      return apiReturn(await debugService.getStackTrace(parseInt(q.sessionId)));
    }
    if (p === '/api/debug/scopes' && method === 'GET') {
      return apiReturn(await debugService.getScopes(parseInt(q.sessionId), parseInt(q.frameId || '0')));
    }
    if (p === '/api/debug/variables' && method === 'GET') {
      return apiReturn(await debugService.getVariables(parseInt(q.sessionId), q.ref));
    }
    if (p === '/api/debug/evaluate' && method === 'POST') {
      return apiReturn(await debugService.evaluate(body.sessionId, body.expression, body.frameId));
    }
    if (p === '/api/debug/setBreakpoints' && method === 'POST') {
      return apiReturn(await debugService.setBreakpoints(body.sessionId, body.filePath, body.breakpoints || []));
    }
    if (p === '/api/debug/sessions' && method === 'GET') {
      return apiReturn({ sessions: debugService.getActiveSessions() });
    }

    // ── Background agents ─────────────────────────────
    if (p === '/api/agent/background' && method === 'POST') {
      try {
        const job = backgroundAgentQueue.enqueue({ task: body?.task, context: body?.context });
        return apiReturn({ success: true, job });
      } catch (err) {
        return apiReturn({ _status: 400, error: err.message });
      }
    }
    if (p === '/api/agent/background' && method === 'GET') {
      return apiReturn({ jobs: backgroundAgentQueue.list() });
    }

    // ── Docs index / search ─────────────────────────────
    if (p === '/api/docs/index' && method === 'POST') {
      if (!currentProjectPath) return { _status: 400, error: 'No project open' };
      const result = await docsIndexService.index(currentProjectPath);
      return apiReturn({ success: true, ...result });
    }
    if (p === '/api/docs/search' && method === 'GET') {
      const results = docsIndexService.search(q.q || q.query || '', parseInt(q.limit || '12', 10));
      return apiReturn({ results });
    }

    // ── Listening ports ─────────────────────────────────
    if (p === '/api/ports/list' && method === 'GET') {
      return apiReturn({ ports: listListeningPorts() });
    }

    // ── Code formatting (Prettier) ──────────────────────
    if (p === '/api/format' && method === 'POST') {
      const prettier = require('prettier');
      const { content, language, filePath: fp } = body;
      if (typeof content !== 'string') return { _status: 400, error: 'content required' };
      const parserMap = {
        javascript: 'babel', js: 'babel', jsx: 'babel', mjs: 'babel', cjs: 'babel',
        typescript: 'typescript', ts: 'typescript', tsx: 'typescript',
        css: 'css', scss: 'css', less: 'less',
        html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte',
        json: 'json', jsonc: 'json',
        yaml: 'yaml', yml: 'yaml',
        markdown: 'markdown', md: 'markdown', mdx: 'mdx',
        graphql: 'graphql', gql: 'graphql',
        xml: 'html', svg: 'html',
      };
      const ext = fp ? path.extname(fp).replace('.', '').toLowerCase() : '';
      const parser = parserMap[language] || parserMap[ext] || 'babel';
      let prettierConfig = {};
      if (currentProjectPath) {
        try {
          const rcPath = path.join(currentProjectPath, '.prettierrc');
          if (fs.existsSync(rcPath)) prettierConfig = JSON.parse(fs.readFileSync(rcPath, 'utf-8'));
        } catch (_) {}
      }
      const formatted = await prettier.format(content, { parser, ...prettierConfig, filepath: fp || undefined });
      return apiReturn({ formatted });
    }

    // ── Format on save ──────────────────────────────────
    if (p === '/api/format-on-save' && method === 'POST') {
      const { content, filePath, formatEnabled, lintEnabled } = body;
      return apiReturn(await formatOnSave({
        content,
        filePath,
        projectPath: currentProjectPath,
        formatEnabled: formatEnabled !== false,
        lintEnabled: lintEnabled !== false,
      }));
    }

    // ── Multi-root workspace ────────────────────────────
    if (p === '/api/workspace/roots' && method === 'GET') {
      return apiReturn(multiRootWorkspace.getRoots());
    }
    if (p === '/api/workspace/roots' && method === 'POST') {
      const { path: rootPath, action, primary } = body;
      if (action === 'remove') return multiRootWorkspace.removeRoot(rootPath);
      if (action === 'setPrimary') return multiRootWorkspace.setPrimary(primary || rootPath);
      if (!rootPath) return { _status: 400, error: 'path required' };
      return apiReturn(multiRootWorkspace.addRoot(rootPath));
    }

    // ── Settings sync ───────────────────────────────────
    if (p === '/api/sync/export' && method === 'POST') {
      const { passphrase } = body;
      return apiReturn(exportSettings(settingsManager, passphrase));
    }
    if (p === '/api/sync/import' && method === 'POST') {
      const { bundle, passphrase } = body;
      if (!bundle) return { _status: 400, error: 'bundle required' };
      return apiReturn(importSettings(settingsManager, bundle, passphrase));
    }

    // ── Remote SSH ──────────────────────────────────────
    if (p === '/api/remote/connect' && method === 'POST') {
      return apiReturn(remoteManager.connect(body));
    }
    if (p === '/api/remote/disconnect' && method === 'POST') {
      return apiReturn(remoteManager.disconnect(body.id));
    }
    if (p === '/api/remote/list' && method === 'GET') {
      return apiReturn({ connections: remoteManager.listConnections() });
    }
    if (p === '/api/remote/read' && method === 'POST') {
      const { id, path: remotePath } = body;
      if (!id || !remotePath) return { _status: 400, error: 'id and path required' };
      return apiReturn(await remoteManager.readFile(id, remotePath));
    }
    if (p === '/api/remote/write' && method === 'POST') {
      const { id, path: remotePath, content } = body;
      if (!id || !remotePath) return { _status: 400, error: 'id and path required' };
      return apiReturn(await remoteManager.writeFile(id, remotePath, content));
    }
    if (p === '/api/remote/listdir' && method === 'POST') {
      const { id, path: remotePath } = body;
      if (!id || !remotePath) return { _status: 400, error: 'id and path required' };
      return apiReturn(await remoteManager.listDir(id, remotePath));
    }

    // ── Dev container ───────────────────────────────────
    if (p === '/api/devcontainer/parse' && method === 'GET') {
      const root = q.path || currentProjectPath;
      if (!root) return { _status: 400, error: 'No project path' };
      return apiReturn(devContainerManager.parse(root));
    }
    if (p === '/api/devcontainer/start' && method === 'POST') {
      const root = body.path || currentProjectPath;
      if (!root) return { _status: 400, error: 'No project path' };
      return apiReturn(devContainerManager.start(root));
    }
    if (p === '/api/devcontainer/stop' && method === 'POST') {
      return apiReturn(devContainerManager.stop(body.sessionId));
    }
    if (p === '/api/devcontainer/status' && method === 'GET') {
      return apiReturn(devContainerManager.status());
    }

    // ── Team sharing ────────────────────────────────────
    if (p === '/api/team/export' && method === 'POST') {
      const { passphrase } = body;
      return apiReturn(exportTeamBundle({ rulesManager, memoryStore, longTermMemory, passphrase }));
    }
    if (p === '/api/team/import' && method === 'POST') {
      const { bundle, passphrase, merge } = body;
      if (!bundle) return { _status: 400, error: 'bundle required' };
      return apiReturn(importTeamBundle({ rulesManager, memoryStore, longTermMemory, bundle, passphrase, merge }));
    }

    // ── PR integration ──────────────────────────────────
    if (p === '/api/pr/review' && method === 'POST') {
      const basePath = body.path || currentProjectPath;
      if (!basePath) return { _status: 400, error: 'No project path' };
      return apiReturn(prIntegration.submitReview(basePath, body));
    }
    if (p === '/api/pr/info' && method === 'GET') {
      const basePath = q.path || currentProjectPath;
      if (!basePath) return { _status: 400, error: 'No project path' };
      return apiReturn(prIntegration.getPrInfo(basePath, parseInt(q.number)));
    }
    if (p === '/api/pr/comments' && method === 'GET') {
      const basePath = q.path || currentProjectPath;
      if (!basePath) return { _status: 400, error: 'No project path' };
      return apiReturn(prIntegration.listPrComments(basePath, parseInt(q.number)));
    }

    // ── RAG embed search ────────────────────────────────
    if (p === '/api/rag/embed-search' && method === 'POST') {
      const { query, maxResults } = body;
      if (!query) return { _status: 400, error: 'query required' };
      return apiReturn({ results: ragEngine.embedSearch(query, maxResults || 10) });
    }

    // ── TODO Scanner ────────────────────────────────────
    if (p === '/api/todos/scan' && method === 'POST') {
      if (!currentProjectPath) return { _status: 400, error: 'No project open' };
      const TODO_PATTERN = /\b(TODO|FIXME|HACK|NOTE|XXX|BUG|OPTIMIZE)\b[:\s]*(.*)/gi;
      const MAX_RESULTS = 500;
      const BINARY_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.webp','.bmp','.ico','.svg','.woff','.woff2','.ttf','.eot','.mp3','.mp4','.wav','.ogg','.zip','.tar','.gz','.rar','.7z','.pdf','.exe','.dll','.so','.dylib','.o','.pyc','.class','.gguf','.bin','.dat','.db','.sqlite','.lock']);
      const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', '.cache', 'coverage', '.idea', '.vscode']);
      const results = [];
      function scanDir(dir) {
        if (results.length >= MAX_RESULTS) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const entry of entries) {
          if (results.length >= MAX_RESULTS) break;
          if (entry.name.startsWith('.') && entry.name !== '.env') continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) scanDir(fullPath);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (BINARY_EXTS.has(ext)) continue;
            try {
              const content = fs.readFileSync(fullPath, 'utf-8');
              const lines = content.split('\n');
              for (let i = 0; i < lines.length && results.length < MAX_RESULTS; i++) {
                let match;
                TODO_PATTERN.lastIndex = 0;
                while ((match = TODO_PATTERN.exec(lines[i])) !== null) {
                  results.push({ file: path.relative(currentProjectPath, fullPath).replace(/\\/g, '/'), line: i + 1, type: match[1].toUpperCase(), text: match[2].trim() || match[0].trim() });
                  if (results.length >= MAX_RESULTS) break;
                }
              }
            } catch (_) {}
          }
        }
      }
      scanDir(currentProjectPath);
      return apiReturn({ todos: results, total: results.length, capped: results.length >= MAX_RESULTS });
    }

    // ── Session ─────────────────────────────────────────
    if (p === '/api/session/clear' && method === 'POST') {
      console.log('[Main] session/clear: resetting all state');
      streamTrace.trace('stream', 'lifecycle-session-clear', {});
      agenticCancelled = true;
      ctx.agenticCancelled = true;
      if (ctx.resetPause) ctx.resetPause();
      try { llmEngine.cancelGeneration(); } catch (_) {}
      await llmEngine.waitForReady();
      await new Promise(r => setTimeout(r, 100));
      await llmEngine.resetSession();
      if (ctx.mcpToolServer) {
        ctx.mcpToolServer._todos = [];
        ctx.mcpToolServer._todoNextId = 1;
      }
      agenticCancelled = false;
      ctx.agenticCancelled = false;
      console.log('[Main] session/clear: complete');
      return apiReturn({ success: true });
    }

    // ── Health ───────────────────────────────────────────
    if (p === '/api/health' && method === 'GET') {
      return apiReturn({
        status: 'running',
        version: require('./package.json').version,
        modelLoaded: llmEngine.isReady,
        modelInfo: llmEngine.modelInfo,
        projectPath: currentProjectPath,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
      });
    }

    // ── Browser Preview ─────────────────────────────────
    if (p === '/api/preview/start' && method === 'POST') {
      const rootPath = body.rootPath || currentProjectPath;
      if (!rootPath) return { _status: 400, error: 'No project path' };
      return apiReturn(await browserManager.startPreview(rootPath));
    }
    if (p === '/api/preview/stop' && method === 'POST') {
      return apiReturn(await browserManager.stopPreview());
    }
    if (p === '/api/preview/reload' && method === 'POST') {
      browserManager.reloadPreview();
      return apiReturn({ success: true });
    }
    if (p === '/api/preview/status' && method === 'GET') {
      return apiReturn(browserManager.getPreviewStatus());
    }

    // ── Live Server ─────────────────────────────────────
    if (p === '/api/live-server/start' && method === 'POST') {
      const rootPath = body.path || currentProjectPath;
      if (!rootPath) return { _status: 400, error: 'No project path' };
      return apiReturn(await liveServer.start(rootPath));
    }
    if (p === '/api/live-server/stop' && method === 'POST') {
      return apiReturn(await liveServer.stop());
    }
    if (p === '/api/live-server/status' && method === 'GET') {
      return apiReturn(liveServer.getStatus());
    }

    // ── Terminal execute (legacy fallback) ───────────────
    if (p === '/api/terminal/execute' && method === 'POST') {
      const { command, cwd } = body;
      if (!command) return { _status: 400, error: 'command required' };
      try {
        const { execSync } = require('child_process');
        const output = execSync(command, {
          cwd: cwd || currentProjectPath || process.cwd(),
          encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
        });
        return apiReturn({ success: true, output });
      } catch (e) {
        return apiReturn({ success: false, output: e.stderr || e.stdout || e.message });
      }
    }

    // ── Templates ───────────────────────────────────────
    if (p === '/api/templates' && method === 'GET') {
      return apiReturn(TEMPLATES.map(t => ({ id: t.id, name: t.name, description: t.description, icon: t.icon, category: t.category, tags: t.tags })));
    }
    if (p.startsWith('/api/templates/') && p !== '/api/templates/create' && method === 'GET') {
      const tid = p.replace('/api/templates/', '');
      const template = TEMPLATES.find(t => t.id === tid);
      if (!template) return { _status: 404, error: 'Template not found' };
      return apiReturn({ ...template, files: undefined, fileList: Object.keys(template.files) });
    }
    if (p === '/api/templates/create' && method === 'POST') {
      const { templateId, projectName, parentDir } = body;
      if (!templateId || !projectName || !parentDir) return { _status: 400, error: 'templateId, projectName, and parentDir are required' };
      const template = TEMPLATES.find(t => t.id === templateId);
      if (!template) return { _status: 404, error: `Template "${templateId}" not found` };
      const safeName = projectName.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, '-').toLowerCase();
      const projectDir = path.join(parentDir, safeName);
      try { await fsP.access(projectDir); return { _status: 409, error: `Directory "${safeName}" already exists` }; } catch { /* good */ }
      await fsP.mkdir(projectDir, { recursive: true });
      const createdFiles = [];
      for (const [relativePath, content] of Object.entries(template.files)) {
        const filePath = path.join(projectDir, relativePath);
        await fsP.mkdir(path.dirname(filePath), { recursive: true });
        await fsP.writeFile(filePath, content.replace(/\{\{PROJECT_NAME\}\}/g, projectName), 'utf8');
        createdFiles.push(relativePath);
      }
      const openedProject = await openProjectPath(projectDir);
      return apiReturn({
        success: true,
        projectDir,
        path: openedProject.path,
        projectName: safeName,
        filesCreated: createdFiles,
      });
    }

    // ── Updater ─────────────────────────────────────────
    if (p === '/api/updater/status' && method === 'GET') {
      return apiReturn(autoUpdater.getStatus());
    }
    if (p === '/api/updater/check' && method === 'POST') {
      autoUpdater.checkForUpdates();
      return apiReturn({ success: true });
    }
    if (p === '/api/updater/download' && method === 'POST') {
      autoUpdater.downloadUpdate();
      return apiReturn({ success: true });
    }
    if (p === '/api/updater/install' && method === 'POST') {
      autoUpdater.quitAndInstall();
      return apiReturn({ success: true });
    }

    // ── Unknown route ───────────────────────────────────
    console.warn(`[Main] Unknown API route: ${method} ${p}`);
    console.log(`[api-fetch] DONE ${method} ${p} status=404 ms=${Date.now() - _apiT0}`);
    return apiReturn({ _status: 404, error: `Unknown route: ${method} ${p}` });

  } catch (e) {
    console.error(`[Main] API error (${method} ${p}):`, e.message);
    console.log(`[api-fetch] ERROR ${method} ${p} ms=${Date.now() - _apiT0} err=${e.message}`);
    return apiReturn({ _status: 500, error: e.message });
  }
});

// ─── PTY Terminal over IPC ──────────────────────────────────────────
let pty = undefined;
const ptyTerminals = new Map();

function _registerPtyTerminal(termId, ptyProcess) {
  ptyProcess.onData((data) => {
    _send('terminal-data', { terminalId: termId, data });
  });
  ptyProcess.onExit(({ exitCode }) => {
    console.log(`[Main] terminal-exit id=${termId} code=${exitCode}`);
    // Ignore stale exits from killed shells (e.g. terminal-recreate race).
    if (ptyTerminals.get(termId) !== ptyProcess) {
      console.log(`[Main] terminal-exit id=${termId} ignored (stale process)`);
      return;
    }
    ptyTerminals.delete(termId);
    _send('terminal-exit', { terminalId: termId, exitCode });
  });
  ptyTerminals.set(termId, ptyProcess);
}

function _spawnPtyTerminal(ptyModule, termId, opts = {}) {
  const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
  const cwd = opts.cwd || currentProjectPath || os.homedir();
  const cols = Math.max(opts.cols || 80, 10);
  const rows = Math.max(opts.rows || 24, 3);
  const ptyProcess = ptyModule.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: process.env,
  });
  _registerPtyTerminal(termId, ptyProcess);
  return { success: true, terminalId: termId, shell, cwd };
}

function _loadPty() {
  if (pty !== undefined) return pty;
  try {
    pty = require('node-pty');
    console.log('[Main] node-pty loaded');
  } catch (e) {
    console.warn('[Main] node-pty not available — terminal will use exec fallback');
    pty = null;
  }
  return pty;
}

ipcMain.handle('terminal-create', (_event, opts) => {
  const ptyModule = _loadPty();
  if (!ptyModule) return { success: false, error: 'node-pty not available' };

  const termId = opts?.terminalId || `pty-${Date.now()}`;
  const cols = Math.max(opts?.cols || 80, 10);
  const rows = Math.max(opts?.rows || 24, 3);
  const cwd = opts?.cwd || currentProjectPath || os.homedir();
  console.log(`[Main] terminal-create id=${termId} cols=${cols} rows=${rows} cwd=${cwd}`);

  return _spawnPtyTerminal(ptyModule, termId, { cwd, cols, rows });
});

ipcMain.handle('terminal-write', (_event, termId, data) => {
  const proc = ptyTerminals.get(termId);
  if (proc) proc.write(data);
});

ipcMain.handle('terminal-resize', (_event, termId, cols, rows) => {
  const proc = ptyTerminals.get(termId);
  if (proc) try { proc.resize(cols || 80, rows || 24); } catch (_) {}
});

ipcMain.handle('terminal-destroy', (_event, termId) => {
  const proc = ptyTerminals.get(termId);
  if (proc) {
    try { proc.kill(); } catch (_) {}
    ptyTerminals.delete(termId);
  }
});

ipcMain.handle('terminal-recreate', (_event, opts) => {
  const termId = opts?.terminalId || `pty-${Date.now()}`;
  const existing = ptyTerminals.get(termId);
  if (existing) {
    try { existing.kill(); } catch (_) {}
  }
  const ptyModule = _loadPty();
  if (!ptyModule) return { success: false, error: 'node-pty not available' };
  const cols = Math.max(opts?.cols || 80, 10);
  const rows = Math.max(opts?.rows || 24, 3);
  const cwd = opts?.cwd || currentProjectPath || os.homedir();
  console.log(`[Main] terminal-recreate id=${termId} cols=${cols} rows=${rows} cwd=${cwd}`);
  return _spawnPtyTerminal(ptyModule, termId, { cwd, cols, rows });
});

ipcMain.handle('seed-todos', (_event, planTodos) => {
  try {
    return mcpToolServer.seedTodosFromPlan(planTodos);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── Debug event forwarding ─────────────────────────────────────────
debugService.on('debug-event', (data) => _send('debug-event', data));

// ─── App lifecycle ───────────────────────────────────────────────────

app.whenReady().then(async () => {
  protocol.handle('guide-media', (request) => {
    try {
      const u = new URL(request.url);
      const filePath = u.searchParams.get('path');
      if (!filePath) return new Response('Bad request', { status: 400 });
      const resolved = path.resolve(decodeURIComponent(filePath));
      if (!isPathUnderWorkspaceRoots(resolved)) {
        return new Response('Forbidden', { status: 403 });
      }
      if (!fs.existsSync(resolved)) {
        return new Response('Not found', { status: 404 });
      }
      return net.fetch(pathToFileURL(resolved).href);
    } catch (err) {
      console.warn('[Main] guide-media protocol error:', err.message);
      return new Response('Error', { status: 500 });
    }
  });

  _configureBundledPlaywrightBrowsers();

  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media') return callback(true);
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    if (permission === 'media') return true;
    return false;
  });

  createWindow();
  buildAppMenu(mainWindow);

  // Auto-updater: checks on startup, auto-downloads, footer prompts restart when ready.
  autoUpdater = new AutoUpdater(mainWindow, {
    autoDownload: true,
    autoInstallOnAppQuit: false,
  });
  autoUpdater.registerIPC(ipcMain);
  setTimeout(() => autoUpdater.checkForUpdates(), 5000);
  const _initialAutoUpdateHours = Number(settingsManager.get('autoUpdateCheckHours')) || 0;
  if (_initialAutoUpdateHours > 0) autoUpdater.startPeriodicCheck(_initialAutoUpdateHours);
  settingsManager.on('change', (key, value) => {
    // React to the user changing the periodic-check cadence at runtime.
    // When key is null, the whole settings object was replaced (setAll/reset).
    if (key === 'autoUpdateCheckHours' || key === null) {
      const hours = Number(settingsManager.get('autoUpdateCheckHours')) || 0;
      if (hours > 0) autoUpdater.startPeriodicCheck(hours);
      else autoUpdater.stopPeriodicCheck();
    }
    // React to execution policy changes at runtime
    if (key === 'executionPolicy' || key === 'commandShell' || key === 'commandAllowList' || key === 'commandDenyList' || key === null) {
      mcpToolServer.setExecutionPolicy(settingsManager.get('executionPolicy'));
      mcpToolServer.setCommandShell(settingsManager.get('commandShell'));
      mcpToolServer.setCommandLists(settingsManager.get('commandAllowList'), settingsManager.get('commandDenyList'));
    }
    if (key === 'browserEngine' || key === 'torBrowserPath' || key === 'geckodriverPath' || key === 'debugTorBrowser' || key === null) {
      syncBrowserRouterFromSettings();
    }
  });

  // Initialize models
  modelManager.initialize().then((models) => {
    console.log(`[Main] Found ${models.length} model(s)`);
    const lastCloud = settingsManager.get('lastCloudProvider');
    if (lastCloud) {
      cloudLLM.activeProvider = lastCloud;
      cloudLLM.activeModel = settingsManager.get('lastCloudModel') || null;
      console.log(`[Main] Skipping local auto-load — last session used cloud (${lastCloud})`);
      return;
    }
    const lastImagePath = settingsManager.get('lastImageModelPath');
    const lastMediaEntry = lastImagePath && models.find((m) => m.path === lastImagePath);
    if (lastMediaEntry && (lastMediaEntry.modelType === 'diffusion' || lastMediaEntry.modelType === 'video')) {
      mediaEngine.load(lastImagePath).then((status) => {
        _send('media-model-loaded', {
          ...status,
          modelType: lastMediaEntry.modelType,
          path: lastImagePath,
        });
        console.log(`[Main] Restored media-only model: ${path.basename(lastImagePath)} arch=${status.ggufArchitecture}`);
      }).catch((e) => console.warn(`[Main] Media model restore failed: ${e.message}`));
      return;
    }
    if (!llmEngine.isReady && models.length > 0) {
      const lastPath = settingsManager.get('lastModelPath');
      const lastModel = lastPath && models.find(m => m.path === lastPath);
      const target = lastModel || modelManager.getDefaultModel();
      if (target) {
        console.log(`[Main] Auto-loading ${lastModel ? 'last-used' : 'default'} model: ${target.name}`);
        applyModelRuntimeDefaults(target.path);
        llmEngine.initialize(target.path, buildEngineLoadSettings(settingsManager.getAll())).catch(e => console.error(`[Main] Auto-load failed: ${e.message}`));
      }
    }
  }).catch(e => console.error(`[Main] Model scan failed: ${e.message}`));

  // Forward model events
  modelManager.on('models-updated', (models) => _send('models-updated', models));
  for (const evt of ['download-started', 'download-progress', 'download-complete', 'download-error', 'download-cancelled']) {
    modelDownloader.on(evt, (data) => _send(evt, data));
  }
  modelDownloader.on('download-complete', () => modelManager.scanModels().catch(() => {}));
  llmEngine.on('status', (status) => _send('llm-status', status));

  // Load frontend — use dist/index.html in production, Vite dev server in dev
  const isDev = !app.isPackaged && process.env.NODE_ENV === 'development';
  if (isDev) {
    // In dev, Vite runs at localhost:5173
    mainWindow.loadURL('http://localhost:5173');
  } else if (fs.existsSync(path.join(FRONTEND_DIST, 'index.html'))) {
    mainWindow.loadFile(path.join(FRONTEND_DIST, 'index.html'));
  } else {
    console.error('[Main] Frontend dist not found! Run: cd frontend && npm run build');
    mainWindow.loadURL('data:text/html,' + encodeURIComponent('<h1>Frontend not built</h1><p>Run: cd frontend && npm run build</p>'));
  }
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  _shutdown();
  app.quit();
});

app.on('before-quit', () => _shutdown());

function _shutdown() {
  settingsManager.flush();
  memoryStore.dispose();
  sessionStore.flush();
  try { mcpClient.stopAll(); } catch (_) {}
  try { browserRouter.closeAll(); } catch (_) {}
  try { browserManager.dispose(); } catch (_) {}
  try { llmEngine.dispose(); } catch (_) {}
  modelManager.dispose();
  for (const [id, proc] of ptyTerminals) {
    try { proc.kill(); } catch (_) {}
  }
  ptyTerminals.clear();
  log.close();
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function _readDirRecursive(dirPath, depth = 0, maxDepth = 3) {
  const items = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env') continue;
      if (['node_modules', '__pycache__', '.git', 'dist', 'build', '.next', 'target'].includes(entry.name)) continue;
      const fullPath = path.join(dirPath, entry.name);
      const item = { name: entry.name, path: fullPath, type: entry.isDirectory() ? 'directory' : 'file' };
      if (entry.isFile()) {
        try {
          const stats = fs.statSync(fullPath);
          item.size = stats.size;
          item.modified = stats.mtime.toISOString();
        } catch (_) {}
        item.extension = path.extname(entry.name).slice(1);
      }
      if (entry.isDirectory() && depth < maxDepth) {
        item.children = await _readDirRecursive(fullPath, depth + 1, maxDepth);
      }
      items.push(item);
    }
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch (_) {}
  return items;
}

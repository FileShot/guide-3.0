/**
 * guIDE 2.0 — Electron Main Process (IPC Architecture)
 *
 * All services run in-process. All communication via Electron IPC.
 * No child process fork, no HTTP server, no WebSocket.
 *
 * This replaces the old electron-main.js that forked server/main.js.
 */
'use strict';

const { app, BrowserWindow, shell, ipcMain, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsP = require('fs').promises;
const os = require('os');
const http = require('http');
const { buildAppMenu } = require('./appMenu');
const { AutoUpdater } = require('./autoUpdater');

// ─── GPU / V8 flags ─────────────────────────────────────────────────
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');

let mainWindow = null;

// ─── Paths ───────────────────────────────────────────────────────────
const ROOT_DIR = __dirname;
const MODELS_DIR = path.join(ROOT_DIR, 'models');
const FRONTEND_DIST = path.join(ROOT_DIR, 'frontend', 'dist');

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
    backgroundColor: '#00000000',
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    transparent: true,
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
    try { mainWindow.setBackgroundColor('#00000000'); } catch (_) {}
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
const { MemoryStore } = require('./memoryStore');
const { LongTermMemory } = require('./longTermMemory');
const { RulesManager } = require('./rulesManager');
const { SessionStore } = require('./sessionStore');
const { CloudLLMService } = require('./cloudLLMService');
const { runCloudAgenticChat } = require('./cloudAgenticChat');
const { runOAuthInWindow } = require('./oauthFlow');
const { SettingsManager } = require('./settingsManager');
const { GitManager } = require('./gitManager');
const { BrowserManager } = require('./browserManager');
const { FirstRunSetup } = require('./firstRunSetup');
const { RAGEngine } = require('./ragEngine');
const { AccountManager } = require('./accountManager');
const { LicenseManager } = require('./licenseManager');
const { ExtensionManager } = require('./extensionManager');
const { DebugService } = require('./debugService');
const { ModelDownloader } = require('./server/modelDownloader');
const liveServer = require('./server/liveServer');
const WebSearch = require('./webSearch');
const { TEMPLATES } = require('./server/templateHandlers');

// ─── Initialize services ────────────────────────────────────────────
const settingsManager = new SettingsManager(userDataPath);
const llmEngine = new ChatEngine();
const webSearch = new WebSearch();
const ragEngine = new RAGEngine();
const mcpToolServer = new MCPToolServer({
  projectPath: null, webSearch, ragEngine,
  executionPolicy: settingsManager.get('executionPolicy'),
  commandShell: settingsManager.get('commandShell'),
  commandAllowList: settingsManager.get('commandAllowList'),
  commandDenyList: settingsManager.get('commandDenyList'),
  requireToolApproval: settingsManager.get('requireToolApproval'),
  userDataPath,
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
const sessionStore = new SessionStore(path.join(userDataPath, 'sessions'));
const cloudLLM = new CloudLLMService();
const modelDownloader = new ModelDownloader(path.join(ROOT_DIR, 'models'));
const firstRunSetup = new FirstRunSetup(settingsManager);
const accountManager = new AccountManager(settingsManager);
const licenseManager = new LicenseManager(settingsManager, accountManager);
const extensionManager = new ExtensionManager(userDataPath);
const debugService = new DebugService();

// BrowserManager needs mainWindow reference for event forwarding
const browserManager = new BrowserManager({
  liveServer,
  parentWindow: { webContents: { send: (e, d) => _send(e, d) }, isDestroyed: () => !mainWindow },
});

// Wire service cross-references
mcpToolServer.setBrowserManager(browserManager);
mcpToolServer.setGitManager(gitManager);
mcpToolServer.rulesManager = rulesManager;
mcpToolServer.onTodoUpdate = (todos) => _send('todo-update', todos);
mcpToolServer.onAskQuestion = (questionData) => {
  return new Promise((resolve) => {
    // Send question to frontend
    _send('ask-question', questionData);
    // Store the resolver so the answer IPC can pick it up
    mcpToolServer._pendingQuestionResolve = resolve;
  });
};
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
extensionManager.initialize().catch(err => console.error('[Main] Extension init error:', err.message));

let currentSettings = settingsManager.getAll();
let currentProjectPath = null;
let agenticCancelled = false;
let autoUpdater = null;

async function openProjectPath(projectPath) {
  console.log(`[electron-main] openProjectPath START: ${projectPath}`);
  const resolved = path.resolve(projectPath);
  if (!fs.existsSync(resolved)) {
    console.error(`[electron-main] openProjectPath: directory not found ${resolved}`);
    const error = new Error('Directory not found');
    error.statusCode = 404;
    throw error;
  }

  currentProjectPath = resolved;
  ctx.currentProjectPath = resolved;
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
  _send('project-opened', { path: resolved });
  console.log(`[electron-main] openProjectPath DONE: ${resolved}`);
  return { path: resolved };
}

// Helper to send events to renderer
function _send(event, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(event, data);
  }
  // Drop silently during shutdown — window destroyed is expected, not an error.
}

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
ipcMain.handle('ai-chat', async (_event, userMessage, chatContext) => {
  console.log(`[electron-main] ai-chat START: userMessageLen=${String(userMessage).length}, cloudProvider=${chatContext?.cloudProvider || 'none'}`);
  const cloudProvider = chatContext?.cloudProvider;
  const cloudModel = chatContext?.cloudModel;

  // ── Checkpoint: begin turn capture before generation ──
  const turnId = `turn-${Date.now()}`;
  mcpToolServer.startTurn(turnId);
  console.log(`[electron-main] checkpoint: startTurn(${turnId})`);

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
      const enableSubAgents = !!(settings.enableSubAgents);
      const executeToolFn = async (toolName, params) => {
        if (toolName === 'spawn_subagent') {
          return { success: false, error: 'Sub-agents require a loaded local model. Switch to local or disable sub-agents.' };
        }
        return await mcpToolServer.executeTool(toolName, params);
      };

      const result = await runCloudAgenticChat({
        cloudLLM,
        mcpToolServer,
        ChatEngine,
        userMessage: effectiveMessage,
        cloudProvider,
        cloudModel,
        settings: { ...settings, askOnly, planMode, enableSubAgents, toolsEnabled: settings.toolsEnabled !== false },
        conversationHistory,
        images,
        executeToolFn,
        onToken: (token) => _send('llm-token', token),
        onThinkingToken: (token) => _send('llm-thinking-token', token),
        onStreamEvent: (eventName, data) => _send(eventName, data),
        getCancelled: () => agenticCancelled,
      });

      if (result?.isQuotaError) {
        return { isQuotaError: true, error: '__QUOTA_EXCEEDED__' };
      }

      // ── Checkpoint: finalize turn after cloud generation ──
      const snapshot = mcpToolServer.finalizeCurrentTurn(String(userMessage).substring(0, 100));
      if (snapshot) {
        console.log(`[electron-main] checkpoint: finalizeCurrentTurn → ${snapshot.files.length} files captured`);
        _send('tool-checkpoint', { turnId: snapshot.turnId, timestamp: snapshot.timestamp, userMessage: snapshot.userMessage, fileCount: snapshot.files.length });
      } else {
        console.log('[electron-main] checkpoint: finalizeCurrentTurn → no files modified this turn');
      }

      return { text: result.text || '', toolCallCount: result.toolCallCount || 0, checkpoint: snapshot ? { turnId: snapshot.turnId, timestamp: snapshot.timestamp, fileCount: snapshot.files.length } : null };
    } catch (err) {
      console.error(`[electron-main] ai-chat cloud ERROR: ${err.message}`);
      // Reset checkpoint state on error to prevent stale captures
      mcpToolServer.startTurn(null);
      if (err.isQuotaError) return { isQuotaError: true, error: '__QUOTA_EXCEEDED__' };
      return { error: err.message };
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
    const enableSubAgents = !!(settings.enableSubAgents);
    const autoLintFix = settings.autoLintFix !== false; // default true

    // Build tool functions from enabled tool definitions
    const toolDefs = mcpToolServer.getToolDefinitions();
    const functions = askOnly ? {} : ChatEngine.convertToolDefs(toolDefs);
    let toolPrompt = askOnly ? '' : mcpToolServer.getToolPrompt();
    const compactToolParts = askOnly ? [] : mcpToolServer.getCompactToolHint('default');
    let compactToolPrompt = compactToolParts.join('');

    // Sub-agents: append spawn_subagent tool definition when enabled
    if (enableSubAgents && toolPrompt) {
      const subAgentTool = '\n- **spawn_subagent** — Delegate a focused sub-task to an isolated sub-agent that shares the same loaded model but runs in a fresh context. Use for long research tasks, code analysis, or any work that should not pollute the main context. Params: task (string, required) — description of what the sub-agent should do; contextSize (number, optional) — token budget for sub-agent.';
      toolPrompt += subAgentTool;
      compactToolPrompt += '\n- spawn_subagent(task): run focused sub-task in fresh context';
      compactToolParts.push('\n- spawn_subagent(task): run focused sub-task in fresh context\n');
    }

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

    console.log(`[electron-main] ai-chat: calling llmEngine.chat, effectiveMessageLen=${effectiveMessage.length}`);
    const result = await llmEngine.chat(effectiveMessage, {
      onToken: (token) => _send('llm-token', token),
      onContextUsage: (data) => _send('context-usage', data),
      onToolCall: (data) => _send('tool-call', data),
      onStreamEvent: (eventName, data) => _send(eventName, data),
      attachments: Array.isArray(chatContext?.attachments) ? chatContext.attachments : [],
      functions,
      toolPrompt,
      compactToolPrompt,
      compactToolParts,
      executeToolFn: async (toolName, params) => {
        if (toolName === 'spawn_subagent') {
          if (!enableSubAgents) return { success: false, error: 'Sub-agents are disabled. Enable in Settings > Agentic Behavior.' };
          return await llmEngine.spawnSubAgent(String(params?.task || ''), {
            contextSize: params?.contextSize,
            temperature: settings.temperature,
          });
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
      maxIterations: settings.maxIterations || 0,
      generationTimeoutSec: settings.generationTimeoutSec || 0,
      reasoningEffort: settings.reasoningEffort || 'medium',
      askOnly,
      planMode,
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

    console.log(`[electron-main] ai-chat DONE: toolCallCount=${result.toolCallCount}`);
    return { text: result.text, toolCallCount: result.toolCallCount, checkpoint: snapshot ? { turnId: snapshot.turnId, timestamp: snapshot.timestamp, fileCount: snapshot.files.length } : null };
  } catch (err) {
    console.error(`[electron-main] ai-chat local ERROR: ${err.message}`);
    // Reset checkpoint state on error to prevent stale captures
    mcpToolServer.startTurn(null);
    return { error: err.message };
  }
});

// Plan B: Revert backend context to match a truncated frontend message array.
// Called by pencil-edit submit and checkpoint-restore in ChatPanel.jsx.
ipcMain.handle('revert-context', (_e, messages) => {
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
  console.log(`[UI] ${String(msg ?? '')}`);
});

// Handle answer from frontend for ask_question tool
ipcMain.handle('answer-question', (_e, answer) => {
  if (mcpToolServer._pendingQuestionResolve) {
    const resolve = mcpToolServer._pendingQuestionResolve;
    mcpToolServer._pendingQuestionResolve = null;
    resolve({ success: true, answer });
  }
  return { received: true };
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
  llmEngine.cancelGeneration('user');
  try { mcpToolServer.killActiveChildren('user-cancel'); } catch (_) {}
  return { success: true };
});

ipcMain.handle('agent-pause', async () => {
  console.log('[electron-main] agent-pause');
  llmEngine.cancelGeneration('user');
  try { mcpToolServer.killActiveChildren('user-cancel'); } catch (_) {}
  return { success: true };
});

ipcMain.handle('force-send-queued', async () => {
  console.log('[electron-main] force-send-queued');
  llmEngine.cancelGeneration('user');
  try { mcpToolServer.killActiveChildren('user-cancel'); } catch (_) {}
  return { success: true };
});

ipcMain.handle('inject-user-message', (_e, payload) => {
  const text = typeof payload === 'string' ? payload : payload?.text;
  console.log(`[electron-main] inject-user-message: len=${String(text ?? '').length}`);
  llmEngine.injectUserMessage(text);
  return { success: true };
});

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
  console.log(`[api-fetch] ENTRY ${method} ${p} bodyLen=${_bodyLen}`);

  try {
    // ── Models ──────────────────────────────────────────
    if (p === '/api/models' && method === 'GET') {
      return { models: modelManager.availableModels, status: llmEngine.getStatus() };
    }
    if (p === '/api/models/load' && method === 'POST') {
      const { modelPath } = body;
      if (!modelPath) return { _status: 400, error: 'modelPath required' };
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
      return { success: true, modelInfo: info };
    }
    if (p === '/api/models/unload' && method === 'POST') {
      await llmEngine.dispose();
      return { success: true };
    }
    if (p === '/api/models/status' && method === 'GET') {
      return llmEngine.getStatus();
    }
    if (p === '/api/models/scan' && method === 'POST') {
      const models = await modelManager.scanModels();
      return { models };
    }
    if (p === '/api/models/add' && method === 'POST') {
      const { filePaths } = body;
      if (!filePaths || !Array.isArray(filePaths)) return { _status: 400, error: 'filePaths array required' };
      const added = await modelManager.addModels(filePaths);
      return { added };
    }
    if (p === '/api/models/upload' && method === 'POST') {
      // IPC file upload: expects body._files = [{ name, buffer }]
      const files = body._files;
      if (!files || !Array.isArray(files) || files.length === 0) {
        return { _status: 400, error: 'No files provided' };
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
      return { success: true, saved };
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
      return { fits, other, maxModelGB, vramMB };
    }

    // ── HuggingFace model downloads ─────────────────────
    if (p === '/api/models/hf/search' && method === 'GET') {
      const query = q.q;
      if (!query || !query.trim()) return { models: [] };
      const models = await modelDownloader.searchModels(query.trim());
      return { models };
    }
    if (p.startsWith('/api/models/hf/files/') && method === 'GET') {
      const parts = p.replace('/api/models/hf/files/', '').split('/');
      const repoId = parts.slice(0, 2).join('/');
      const result = await modelDownloader.getRepoFiles(repoId);
      return result;
    }
    if (p === '/api/models/hf/download' && method === 'POST') {
      const { url: dlUrl, fileName } = body;
      if (!dlUrl || !fileName) return { _status: 400, error: 'url and fileName required' };
      const result = await modelDownloader.downloadModel(dlUrl, fileName);
      return { success: true, ...result };
    }
    if (p === '/api/models/hf/cancel' && method === 'POST') {
      const { id } = body;
      if (!id) return { _status: 400, error: 'id required' };
      return { success: modelDownloader.cancelDownload(id) };
    }
    if (p === '/api/models/hf/downloads' && method === 'GET') {
      return { downloads: modelDownloader.getActiveDownloads() };
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
      return info;
    }

    // ── Project ─────────────────────────────────────────
    if (p === '/api/project/open' && method === 'POST') {
      const { projectPath } = body;
      if (!projectPath) return { _status: 400, error: 'projectPath required' };
      const openedProject = await openProjectPath(projectPath);
      return { success: true, path: openedProject.path };
    }
    if (p === '/api/project/current' && method === 'GET') {
      return { projectPath: currentProjectPath };
    }

    // ── Files ───────────────────────────────────────────
    if (p === '/api/files/tree' && method === 'GET') {
      const dirPath = q.path || currentProjectPath;
      if (!dirPath) return { items: [] };
      const items = await _readDirRecursive(dirPath, 0, 3);
      return { items, root: dirPath };
    }
    if (p === '/api/files/read' && method === 'GET') {
      const filePath = q.path;
      if (!filePath) return { _status: 400, error: 'path required' };
      const fullPath = path.isAbsolute(filePath) ? filePath : path.join(currentProjectPath || '', filePath);
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const ext = path.extname(fullPath).slice(1);
        return { content, path: fullPath, extension: ext, name: path.basename(fullPath) };
      } catch (err) {
        if (err.code === 'ENOENT') {
          return { content: null, path: fullPath, missing: true, name: path.basename(fullPath) };
        }
        throw err;
      }
    }
    if (p === '/api/files/write' && method === 'POST') {
      const { filePath, content } = body;
      if (!filePath) return { _status: 400, error: 'filePath required' };
      const fullPath = path.isAbsolute(filePath) ? filePath : path.join(currentProjectPath || '', filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content || '', 'utf8');
      return { success: true, path: fullPath };
    }
    if (p === '/api/files/create' && method === 'POST') {
      const { path: fp, content } = body;
      if (!fp) return { _status: 400, error: 'path required' };
      const fullPath = path.isAbsolute(fp) ? fp : path.join(currentProjectPath || '', fp);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      if (fs.existsSync(fullPath)) return { _status: 409, error: 'File already exists' };
      fs.writeFileSync(fullPath, content || '', 'utf8');
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('files-changed');
      return { success: true, path: fullPath };
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
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('files-changed');
      return { success: true };
    }
    if (p === '/api/files/rename' && method === 'POST') {
      const { oldPath, newPath } = body;
      if (!oldPath || !newPath) return { _status: 400, error: 'oldPath and newPath required' };
      const fullOld = path.isAbsolute(oldPath) ? oldPath : path.join(currentProjectPath || '', oldPath);
      const fullNew = path.isAbsolute(newPath) ? newPath : path.join(currentProjectPath || '', newPath);
      if (!fs.existsSync(fullOld)) return { _status: 404, error: 'Source not found' };
      fs.renameSync(fullOld, fullNew);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('files-changed');
      return { success: true, path: fullNew };
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
      return { results: results.slice(0, maxResults) };
    }

    // ── Settings ────────────────────────────────────────
    if (p === '/api/settings' && method === 'GET') {
      return settingsManager.getAll();
    }
    if (p === '/api/settings' && method === 'POST') {
      console.log(`[Settings] POST /api/settings HANDLER START thinkingMode=${body?.thinkingMode} toolsEnabled=${body?.toolsEnabled}`);
      settingsManager.setAll(body);
      settingsManager.flush();
      currentSettings = settingsManager.getAll();
      console.log(`[Settings] POST /api/settings HANDLER DONE thinkingMode=${settingsManager.get('thinkingMode')}`);
      console.log(`[api-fetch] DONE POST /api/settings ms=${Date.now() - _apiT0}`);
      return { success: true };
    }

    // ── Cloud LLM ───────────────────────────────────────
    if (p === '/api/cloud/status' && method === 'GET') {
      return cloudLLM.getStatus();
    }
    if (p === '/api/cloud/providers' && method === 'GET') {
      return { configured: cloudLLM.getConfiguredProviders(), all: cloudLLM.getAllProviders() };
    }
    if (p.startsWith('/api/cloud/models/') && method === 'GET') {
      const provider = p.replace('/api/cloud/models/', '');
      if (provider === 'openrouter') {
        const models = await cloudLLM.fetchOpenRouterModels();
        return { models };
      } else if (provider === 'ollama') {
        await cloudLLM.detectOllama();
        return { models: cloudLLM.getOllamaModels() };
      } else {
        return { models: cloudLLM._getProviderModels(provider) };
      }
    }
    if (p === '/api/cloud/provider' && method === 'POST') {
      const { provider, model } = body;
      if (!provider) return { _status: 400, error: 'provider required' };
      cloudLLM.activeProvider = provider;
      if (model) cloudLLM.activeModel = model;
      return { success: true, activeProvider: cloudLLM.activeProvider, activeModel: cloudLLM.activeModel };
    }
    if (p === '/api/cloud/apikey' && method === 'POST') {
      const { provider, key } = body;
      if (!provider) return { _status: 400, error: 'provider required' };
      cloudLLM.setApiKey(provider, key || '');
      settingsManager.setApiKey(provider, key || '');
      return { success: true, hasKey: !!(key && key.trim()) };
    }
    if (p.startsWith('/api/cloud/pool/') && method === 'GET') {
      const provider = p.replace('/api/cloud/pool/', '');
      return cloudLLM.getPoolStatus(provider);
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
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
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
        return gitManager.getStatus(basePath);
      } catch (e) {
        return { error: e.message, branch: '', staged: [], modified: [], untracked: [] };
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
        return { _status: 400, error: 'Provide files array or all:true' };
      }
      return { success: true };
    }
    if (p === '/api/git/unstage' && method === 'POST') {
      const basePath = body.path || currentProjectPath;
      if (!basePath) return { _status: 400, error: 'No project path' };
      if (body.all) {
        gitManager.unstageAll(basePath);
      } else if (body.files && Array.isArray(body.files)) {
        gitManager.unstageFiles(body.files, basePath);
      } else {
        return { _status: 400, error: 'Provide files array or all:true' };
      }
      return { success: true };
    }
    if (p === '/api/git/commit' && method === 'POST') {
      const basePath = body.path || currentProjectPath;
      const message = body.message;
      if (!basePath) return { _status: 400, error: 'No project path' };
      if (!message || !message.trim()) return { _status: 400, error: 'Commit message required' };
      return gitManager.commit(message, basePath);
    }
    if (p === '/api/git/discard' && method === 'POST') {
      const basePath = body.path || currentProjectPath;
      if (!basePath) return { _status: 400, error: 'No project path' };
      if (body.files && Array.isArray(body.files)) {
        gitManager.discardFiles(body.files, basePath);
      } else {
        return { _status: 400, error: 'Provide files array' };
      }
      return { success: true };
    }
    if (p === '/api/git/diff' && method === 'GET') {
      const basePath = q.path || currentProjectPath;
      if (!basePath) return { _status: 400, error: 'No project path' };
      return gitManager.getDiff({ staged: q.staged === 'true', file: q.file }, basePath);
    }
    if (p === '/api/git/log' && method === 'GET') {
      const basePath = q.path || currentProjectPath;
      if (!basePath) return { _status: 400, error: 'No project path' };
      const count = parseInt(q.count) || 20;
      return gitManager.getLog(count, basePath);
    }
    if (p === '/api/git/branches' && method === 'GET') {
      const basePath = q.path || currentProjectPath;
      if (!basePath) return { _status: 400, error: 'No project path' };
      return gitManager.getBranches(basePath);
    }
    if (p === '/api/git/checkout' && method === 'POST') {
      const basePath = body.path || currentProjectPath;
      const branch = body.branch;
      if (!basePath) return { _status: 400, error: 'No project path' };
      if (!branch) return { _status: 400, error: 'Branch name required' };
      return gitManager.checkout(branch, { create: !!body.create }, basePath);
    }
    if (p === '/api/git/blame' && method === 'GET') {
      const basePath = q.path || currentProjectPath;
      if (!basePath) return { _status: 400, error: 'No project path' };
      if (!q.file) return { _status: 400, error: 'File path required' };
      try {
        return gitManager.blame(q.file, basePath);
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    if (p === '/api/git/stage-all-commit' && method === 'POST') {
      const basePath = body.path || currentProjectPath;
      const message = body.message;
      if (!basePath) return { _status: 400, error: 'No project path' };
      if (!message || !message.trim()) return { _status: 400, error: 'Commit message required' };
      try {
        return gitManager.stageAllAndCommit(message, basePath);
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    // ── License ─────────────────────────────────────────
    if (p === '/api/license/status' && method === 'GET') {
      return {
        isActivated: licenseManager.isActivated || false,
        isAuthenticated: accountManager.isAuthenticated || false,
        license: licenseManager.licenseData || null,
        machineId: licenseManager.machineId || null,
        user: accountManager.user || null,
        plan: licenseManager.getPlan(),
      };
    }
    if (p === '/api/license/activate' && method === 'POST') {
      const { method: activationMethod, key, email, password } = body;
      if (activationMethod === 'key') {
        return await licenseManager.activateKey(key);
      } else if (activationMethod === 'account') {
        if (email && password) {
          const loginResult = await accountManager.loginWithEmail(email, password);
          if (!loginResult.success) return loginResult;
        }
        return await licenseManager.activateAccount();
      } else {
        return { success: false, error: 'Invalid activation method. Use "key" or "account".' };
      }
    }
    if (p === '/api/license/oauth' && method === 'POST') {
      const { provider } = body;
      if (!provider || !['google', 'github'].includes(provider)) {
        return { success: false, error: 'Invalid OAuth provider' };
      }
      const { url: oauthUrl } = accountManager.getOAuthURL(provider);
      const nav = await runOAuthInWindow({ parent: mainWindow, oauthUrl });
      if (!nav.success) {
        return { success: false, error: nav.error || 'Sign-in cancelled' };
      }
      const oauthResult = nav.guideToken
        ? await accountManager.completeOAuthWithToken(nav.guideToken)
        : { success: false, error: 'Sign-in did not return a session token. Update graysoft.dev and try again.' };
      if (!oauthResult.success) {
        return oauthResult;
      }
      const activateResult = await licenseManager.activateAccount();
      if (!activateResult.success) {
        console.warn('[OAuth] signed in but license bind:', activateResult.error);
      } else if (activateResult.warning) {
        console.log('[OAuth] signed in (cloud free tier):', activateResult.warning);
      }
      return {
        success: true,
        user: oauthResult.user,
        licenseActivated: activateResult.success && !activateResult.cloudOnly,
        licenseError: activateResult.success ? activateResult.warning : activateResult.error,
      };
    }
    if (p === '/api/license/deactivate' && method === 'POST') {
      licenseManager.deactivate();
      accountManager.logout();
      return { success: true };
    }
    if (p === '/api/license/plans' && method === 'GET') {
      return { plans: licenseManager.getPlans() };
    }
    if (p === '/api/stripe/checkout' && method === 'POST') {
      const { plan } = body;
      return await licenseManager.createCheckoutSession(plan);
    }
    if (p === '/api/stripe/subscription' && method === 'GET') {
      return await licenseManager.checkSubscription();
    }

    // ── Account ─────────────────────────────────────────
    if (p === '/api/account/status' && method === 'GET') {
      return {
        isAuthenticated: accountManager._isAuthenticated,
        user: accountManager._user,
        machineId: accountManager._machineId,
      };
    }
    if (p === '/api/account/login' && method === 'POST') {
      const { email, password } = body;
      return await accountManager.loginWithEmail(email, password);
    }
    if (p === '/api/account/register' && method === 'POST') {
      const { email, password, name } = body;
      return await accountManager.register(email, password, name);
    }
    if (p === '/api/account/oauth/start' && method === 'POST') {
      const { provider } = body;
      if (!provider || !['google', 'github'].includes(provider)) {
        return { success: false, error: 'Invalid OAuth provider' };
      }
      const { url: oauthUrl } = accountManager.getOAuthURL(provider);
      const nav = await runOAuthInWindow({ parent: mainWindow, oauthUrl });
      if (!nav.success) {
        return { success: false, error: nav.error || 'Sign-in cancelled' };
      }
      if (nav.guideToken) {
        return await accountManager.completeOAuthWithToken(nav.guideToken);
      }
      return { success: false, error: 'Sign-in did not return a session token' };
    }
    if (p === '/api/account/logout' && method === 'POST') {
      accountManager.logout();
      return { success: true };
    }
    if (p === '/api/account/refresh' && method === 'POST') {
      return await accountManager.refreshSession();
    }

    // ── Setup (first run) ───────────────────────────────
    if (p === '/api/setup/status' && method === 'GET') {
      return {
        isFirstRun: firstRunSetup.isFirstRun(),
        systemInfo: firstRunSetup.getSystemInfo(),
        recommended: firstRunSetup.recommendSettings(),
      };
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
      return { success: true };
    }

    // ── Extensions ──────────────────────────────────────
    if (p === '/api/extensions' && method === 'GET') {
      return { extensions: extensionManager.getInstalled(), categories: extensionManager.getCategories() };
    }
    if (p === '/api/extensions/install' && method === 'POST') {
      // File upload — handle binary data passed from frontend
      if (body._fileBuffer && body._fileName) {
        const result = await extensionManager.installFromZip(Buffer.from(body._fileBuffer), body._fileName);
        return { success: true, ...result };
      }
      return { _status: 400, error: 'File upload required' };
    }
    if (p === '/api/extensions/uninstall' && method === 'POST') {
      const { id } = body;
      if (!id) return { _status: 400, error: 'Extension ID required' };
      return { success: true, ...(await extensionManager.uninstall(id)) };
    }
    if (p === '/api/extensions/enable' && method === 'POST') {
      const { id } = body;
      if (!id) return { _status: 400, error: 'Extension ID required' };
      return { success: true, ...(await extensionManager.enable(id)) };
    }
    if (p === '/api/extensions/disable' && method === 'POST') {
      const { id } = body;
      if (!id) return { _status: 400, error: 'Extension ID required' };
      return { success: true, ...(await extensionManager.disable(id)) };
    }

    // ── Debug ───────────────────────────────────────────
    if (p === '/api/debug/start' && method === 'POST') {
      const { type, program, cwd, args: debugArgs } = body;
      if (!program) return { _status: 400, error: 'Program path required' };
      return await debugService.start({
        type: type || 'node', program,
        cwd: cwd || currentProjectPath || undefined,
        args: debugArgs || [],
      });
    }
    if (p === '/api/debug/stop' && method === 'POST') {
      const { sessionId } = body;
      if (!sessionId) return { _status: 400, error: 'Session ID required' };
      return await debugService.stop(sessionId);
    }
    if (p === '/api/debug/continue' && method === 'POST') {
      return await debugService.resume(body.sessionId);
    }
    if (p === '/api/debug/stepOver' && method === 'POST') {
      return await debugService.stepOver(body.sessionId);
    }
    if (p === '/api/debug/stepInto' && method === 'POST') {
      return await debugService.stepInto(body.sessionId);
    }
    if (p === '/api/debug/stepOut' && method === 'POST') {
      return await debugService.stepOut(body.sessionId);
    }
    if (p === '/api/debug/pause' && method === 'POST') {
      return await debugService.pause(body.sessionId);
    }
    if (p === '/api/debug/stackTrace' && method === 'GET') {
      return await debugService.getStackTrace(parseInt(q.sessionId));
    }
    if (p === '/api/debug/scopes' && method === 'GET') {
      return await debugService.getScopes(parseInt(q.sessionId), parseInt(q.frameId || '0'));
    }
    if (p === '/api/debug/variables' && method === 'GET') {
      return await debugService.getVariables(parseInt(q.sessionId), q.ref);
    }
    if (p === '/api/debug/evaluate' && method === 'POST') {
      return await debugService.evaluate(body.sessionId, body.expression, body.frameId);
    }
    if (p === '/api/debug/setBreakpoints' && method === 'POST') {
      return await debugService.setBreakpoints(body.sessionId, body.filePath, body.breakpoints || []);
    }
    if (p === '/api/debug/sessions' && method === 'GET') {
      return { sessions: debugService.getActiveSessions() };
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
      return { formatted };
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
      return { todos: results, total: results.length, capped: results.length >= MAX_RESULTS };
    }

    // ── Session ─────────────────────────────────────────
    if (p === '/api/session/clear' && method === 'POST') {
      console.log('[Main] session/clear: resetting all state');
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
      return { success: true };
    }

    // ── Health ───────────────────────────────────────────
    if (p === '/api/health' && method === 'GET') {
      return {
        status: 'running',
        version: require('./package.json').version,
        modelLoaded: llmEngine.isReady,
        modelInfo: llmEngine.modelInfo,
        projectPath: currentProjectPath,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
      };
    }

    // ── Browser Preview ─────────────────────────────────
    if (p === '/api/preview/start' && method === 'POST') {
      const rootPath = body.rootPath || currentProjectPath;
      if (!rootPath) return { _status: 400, error: 'No project path' };
      return await browserManager.startPreview(rootPath);
    }
    if (p === '/api/preview/stop' && method === 'POST') {
      return await browserManager.stopPreview();
    }
    if (p === '/api/preview/reload' && method === 'POST') {
      browserManager.reloadPreview();
      return { success: true };
    }
    if (p === '/api/preview/status' && method === 'GET') {
      return browserManager.getPreviewStatus();
    }

    // ── Live Server ─────────────────────────────────────
    if (p === '/api/live-server/start' && method === 'POST') {
      const rootPath = body.path || currentProjectPath;
      if (!rootPath) return { _status: 400, error: 'No project path' };
      return await liveServer.start(rootPath);
    }
    if (p === '/api/live-server/stop' && method === 'POST') {
      return await liveServer.stop();
    }
    if (p === '/api/live-server/status' && method === 'GET') {
      return liveServer.getStatus();
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
        return { success: true, output };
      } catch (e) {
        return { success: false, output: e.stderr || e.stdout || e.message };
      }
    }

    // ── Templates ───────────────────────────────────────
    if (p === '/api/templates' && method === 'GET') {
      return TEMPLATES.map(t => ({ id: t.id, name: t.name, description: t.description, icon: t.icon, category: t.category, tags: t.tags }));
    }
    if (p.startsWith('/api/templates/') && p !== '/api/templates/create' && method === 'GET') {
      const tid = p.replace('/api/templates/', '');
      const template = TEMPLATES.find(t => t.id === tid);
      if (!template) return { _status: 404, error: 'Template not found' };
      return { ...template, files: undefined, fileList: Object.keys(template.files) };
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
      return {
        success: true,
        projectDir,
        path: openedProject.path,
        projectName: safeName,
        filesCreated: createdFiles,
      };
    }

    // ── Updater ─────────────────────────────────────────
    if (p === '/api/updater/status' && method === 'GET') {
      return autoUpdater.getStatus();
    }
    if (p === '/api/updater/check' && method === 'POST') {
      autoUpdater.checkForUpdates();
      return { success: true };
    }
    if (p === '/api/updater/download' && method === 'POST') {
      autoUpdater.downloadUpdate();
      return { success: true };
    }
    if (p === '/api/updater/install' && method === 'POST') {
      autoUpdater.quitAndInstall();
      return { success: true };
    }

    // ── Unknown route ───────────────────────────────────
    console.warn(`[Main] Unknown API route: ${method} ${p}`);
    console.log(`[api-fetch] DONE ${method} ${p} status=404 ms=${Date.now() - _apiT0}`);
    return { _status: 404, error: `Unknown route: ${method} ${p}` };

  } catch (e) {
    console.error(`[Main] API error (${method} ${p}):`, e.message);
    console.log(`[api-fetch] ERROR ${method} ${p} ms=${Date.now() - _apiT0} err=${e.message}`);
    return { _status: 500, error: e.message };
  }
});

// ─── PTY Terminal over IPC ──────────────────────────────────────────
let pty = undefined;
const ptyTerminals = new Map();

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
  const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
  const cwd = opts?.cwd || currentProjectPath || os.homedir();

  const ptyProcess = ptyModule.spawn(shell, [], {
    name: 'xterm-256color',
    cols: opts?.cols || 80,
    rows: opts?.rows || 24,
    cwd,
    env: process.env,
  });

  ptyProcess.onData((data) => {
    _send('terminal-data', { terminalId: termId, data });
  });

  ptyProcess.onExit(({ exitCode }) => {
    _send('terminal-exit', { terminalId: termId, exitCode });
    ptyTerminals.delete(termId);
  });

  ptyTerminals.set(termId, ptyProcess);
  return { success: true, terminalId: termId, shell };
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

// ─── Debug event forwarding ─────────────────────────────────────────
debugService.on('debug-event', (data) => _send('debug-event', data));

// ─── App lifecycle ───────────────────────────────────────────────────

app.whenReady().then(async () => {
  createWindow();
  buildAppMenu(mainWindow);

  // Auto-updater with real Electron IPC.
  // Manual check is fired once 5 seconds after startup. Periodic background checking
  // is opt-in via settingsManager.autoUpdateCheckHours (0 = off, default). Users
  // change the cadence from Settings; the listener below reschedules immediately.
  autoUpdater = new AutoUpdater(mainWindow, { autoDownload: false });
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
  });

  // Initialize models
  modelManager.initialize().then((models) => {
    console.log(`[Main] Found ${models.length} model(s)`);
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

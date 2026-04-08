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

// ─── Single instance lock ────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) { app.quit(); }

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
    backgroundColor: '#0d0d0d',
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
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

const { ChatEngine } = require('./chatEngine');
const { MCPToolServer } = require('./mcpToolServer');
const { ModelManager } = require('./modelManager');
const { MemoryStore } = require('./memoryStore');
const { LongTermMemory } = require('./longTermMemory');
const { SessionStore } = require('./sessionStore');
const { CloudLLMService } = require('./cloudLLMService');
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
const llmEngine = new ChatEngine();
const webSearch = new WebSearch();
const mcpToolServer = new MCPToolServer({ projectPath: null, webSearch });
const gitManager = new GitManager();
const memoryStore = new MemoryStore();
const longTermMemory = new LongTermMemory();
const modelManager = new ModelManager(modelsBasePath);
const sessionStore = new SessionStore(path.join(userDataPath, 'sessions'));
const cloudLLM = new CloudLLMService();
const modelDownloader = new ModelDownloader(path.join(ROOT_DIR, 'models'));
const ragEngine = new RAGEngine();
const settingsManager = new SettingsManager(userDataPath);
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
mcpToolServer.setBrowserManager({ parentWindow: { webContents: { send: (e, d) => _send(e, d) }, isDestroyed: () => !mainWindow } });
mcpToolServer.setGitManager(gitManager);
mcpToolServer.onTodoUpdate = (todos) => _send('todo-update', todos);
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
  const resolved = path.resolve(projectPath);
  if (!fs.existsSync(resolved)) {
    const error = new Error('Directory not found');
    error.statusCode = 404;
    throw error;
  }

  currentProjectPath = resolved;
  ctx.currentProjectPath = resolved;
  mcpToolServer.projectPath = resolved;
  gitManager.setProjectPath(resolved);
  memoryStore.initialize(resolved);
  longTermMemory.initialize(resolved);
  ragEngine.indexProject(resolved).catch(e => console.warn('[Main] RAG indexing failed:', e.message));
  _send('project-opened', { path: resolved });

  return { path: resolved };
}

// Helper to send events to renderer
function _send(event, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(event, data);
  }
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

// Register ai-chat handler for basic model chat
ipcMain.handle('ai-chat', async (_event, userMessage, chatContext) => {
  if (!llmEngine.isReady) {
    return { error: 'No model loaded. Please load a model first.' };
  }
  try {
    agenticCancelled = false;
    const settings = chatContext?.settings || {};
    const result = await llmEngine.chat(userMessage, {
      onToken: (token) => _send('llm-token', token),
      systemPrompt: settings.systemPrompt || undefined,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens || -1,
      topP: settings.topP,
      topK: settings.topK,
      repeatPenalty: settings.repeatPenalty,
    });
    return { text: result.text };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('cancel-generation', async () => {
  llmEngine.cancelGeneration('user');
  return { success: true };
});

// ─── Generic API-fetch IPC handler ──────────────────────────────────
// The frontend's fetch('/api/...') calls are intercepted and routed here.
// This replaces the entire Express REST API from server/main.js.

ipcMain.handle('api-fetch', async (_event, url, options) => {
  const method = (options?.method || 'GET').toUpperCase();
  let body = {};
  if (options?.body) {
    try { body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body; } catch (_) {}
  }

  // Parse URL
  const urlObj = new URL(url, 'http://localhost');
  const p = urlObj.pathname;
  const q = Object.fromEntries(urlObj.searchParams);

  try {
    // ── Models ──────────────────────────────────────────
    if (p === '/api/models' && method === 'GET') {
      return { models: modelManager.availableModels, status: llmEngine.getStatus() };
    }
    if (p === '/api/models/load' && method === 'POST') {
      const { modelPath } = body;
      if (!modelPath) return { _status: 400, error: 'modelPath required' };
      _send('model-loading', { path: modelPath });
      await llmEngine.initialize(modelPath);
      const info = llmEngine.modelInfo;
      settingsManager.set('lastModelPath', modelPath);
      _send('model-loaded', info);
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
      const content = fs.readFileSync(fullPath, 'utf8');
      const ext = path.extname(fullPath).slice(1);
      return { content, path: fullPath, extension: ext, name: path.basename(fullPath) };
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
              for (let i = 0; i < lines.length && results.length < maxResults; i++) {
                if (lines[i].toLowerCase().includes(lowerQuery)) {
                  results.push({ file: fullPath, line: i + 1, text: lines[i].trim().substring(0, 200) });
                }
              }
            } catch (_) {}
          }
        }
      };
      searchDir(basePath);
      return { results };
    }

    // ── Settings ────────────────────────────────────────
    if (p === '/api/settings' && method === 'GET') {
      return settingsManager.getAll();
    }
    if (p === '/api/settings' && method === 'POST') {
      settingsManager.setAll(body);
      currentSettings = settingsManager.getAll();
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
      return { success: true, url: oauthUrl };
    }
    if (p === '/api/license/deactivate' && method === 'POST') {
      licenseManager.deactivate();
      accountManager.logout();
      return { success: true };
    }
    if (p === '/api/license/plans' && method === 'GET') {
      return { plans: licenseManager.getPlans ? licenseManager.getPlans() : [] };
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
      const { url: oauthUrl, state } = accountManager.getOAuthURL(provider);
      return { success: true, url: oauthUrl, state };
    }
    if (p === '/api/account/oauth/callback' && method === 'POST') {
      const { code, state } = body;
      return await accountManager.completeOAuth(code, state);
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
      await new Promise(r => setTimeout(r, 100));
      await llmEngine.resetSession();
      agenticCancelled = false;
      ctx.agenticCancelled = false;
      console.log('[Main] session/clear: complete');
      return { success: true };
    }

    // ── Health ───────────────────────────────────────────
    if (p === '/api/health' && method === 'GET') {
      return {
        status: 'running',
        version: '2.0.0',
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
      autoUpdater.installUpdate();
      return { success: true };
    }

    // ── Unknown route ───────────────────────────────────
    console.warn(`[Main] Unknown API route: ${method} ${p}`);
    return { _status: 404, error: `Unknown route: ${method} ${p}` };

  } catch (e) {
    console.error(`[Main] API error (${method} ${p}):`, e.message);
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
  const cwd = currentProjectPath || process.cwd();

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

  // Auto-updater with real Electron IPC
  autoUpdater = new AutoUpdater(mainWindow, { autoDownload: false });
  autoUpdater.registerIPC(ipcMain);
  setTimeout(() => autoUpdater.checkForUpdates(), 5000);

  // Initialize models
  modelManager.initialize().then((models) => {
    console.log(`[Main] Found ${models.length} model(s)`);
    if (!llmEngine.isReady && models.length > 0) {
      const lastPath = settingsManager.get('lastModelPath');
      const lastModel = lastPath && models.find(m => m.path === lastPath);
      const target = lastModel || modelManager.getDefaultModel();
      if (target) {
        console.log(`[Main] Auto-loading ${lastModel ? 'last-used' : 'default'} model: ${target.name}`);
        llmEngine.initialize(target.path).catch(e => console.error(`[Main] Auto-load failed: ${e.message}`));
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

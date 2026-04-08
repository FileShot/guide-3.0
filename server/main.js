/**
 * guIDE 3.0 — Main Server Entry Point
 *
 * Starts the Node.js backend.
 * Provides:
 *   1. HTTP server serving the frontend static files
 *   2. WebSocket server for real-time streaming (tokens, events, tool progress)
 *   3. REST API for model management, file operations, settings
 *   4. Basic model chat via ChatEngine
 *
 * This server runs in two modes:
 *   - Standalone: accessed via browser at http://localhost:PORT
 *   - Tauri sidecar: launched by the Rust desktop app, communicates over the same WebSocket
 *
 * Usage:
 *   node server/main.js [--port PORT] [--dev]
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const cors = require('cors');
const prettier = require('prettier');

const { IpcMainBridge, MainWindowBridge, createAppBridge } = require('./ipcBridge');
const { Transport } = require('./transport');

// ─── Parse CLI args ──────────────────────────────────────
const args = process.argv.slice(2);
const isDev = args.includes('--dev');
const portArg = args.find((a, i) => args[i - 1] === '--port');
const PORT = parseInt(portArg, 10) || parseInt(process.env.GUIDE_PORT, 10) || 3000;

// ─── Paths ───────────────────────────────────────────────
const ROOT_DIR = path.resolve(__dirname, '..');
const FRONTEND_DIST = path.join(ROOT_DIR, 'frontend', 'dist');
const MODELS_DIR = path.join(ROOT_DIR, 'models');
const USER_DATA = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'guide-ide')
  : path.join(os.homedir(), '.config', 'guide-ide');

// Ensure critical directories exist
for (const dir of [MODELS_DIR, USER_DATA, path.join(USER_DATA, 'sessions'), path.join(USER_DATA, 'logs')]) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

// ─── Install Electron shims BEFORE loading modules ──
// Some modules do require('electron') — we intercept with bridges.
// We intercept this with a Module wrapper that returns our bridges.
const ipcMain = new IpcMainBridge();
const mainWindow = new MainWindowBridge();
const appBridge = createAppBridge(USER_DATA);

// Shim the 'electron' module so require('electron') returns our bridges
const Module = require('module');
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'electron') {
    // Return a path to our shim module
    return path.join(__dirname, '_electronShim.js');
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

// Electron shim — static file included in the package (server/_electronShim.js)
const shimPath = path.join(__dirname, '_electronShim.js');

// Set up globals so the static shim file can reference them
global.__guideIpcMain = ipcMain;
global.__guideMainWindow = mainWindow;
global.__guideApp = appBridge;

// ─── Now load modules (they will get our Electron shim) ──
console.log('[Server] Loading modules...');

const log = require(path.join(ROOT_DIR, 'logger'));
log.installConsoleIntercepts();

const { ChatEngine } = require(path.join(ROOT_DIR, 'chatEngine'));
const { MCPToolServer } = require(path.join(ROOT_DIR, 'mcpToolServer'));
const { ModelManager } = require(path.join(ROOT_DIR, 'modelManager'));
const { MemoryStore } = require(path.join(ROOT_DIR, 'memoryStore'));
const { LongTermMemory } = require(path.join(ROOT_DIR, 'longTermMemory'));
const { SessionStore } = require(path.join(ROOT_DIR, 'sessionStore'));
const { CloudLLMService } = require(path.join(ROOT_DIR, 'cloudLLMService'));
const { SettingsManager } = require(path.join(ROOT_DIR, 'settingsManager'));
const { GitManager } = require(path.join(ROOT_DIR, 'gitManager'));
const { BrowserManager } = require(path.join(ROOT_DIR, 'browserManager'));
const { FirstRunSetup } = require(path.join(ROOT_DIR, 'firstRunSetup'));
const { AutoUpdater } = require(path.join(ROOT_DIR, 'autoUpdater'));
const { RAGEngine } = require(path.join(ROOT_DIR, 'ragEngine'));
const { AccountManager } = require(path.join(ROOT_DIR, 'accountManager'));
const { LicenseManager } = require(path.join(ROOT_DIR, 'licenseManager'));
const { ExtensionManager } = require(path.join(ROOT_DIR, 'extensionManager'));
const { DebugService } = require(path.join(ROOT_DIR, 'debugService'));
const { ModelDownloader } = require(path.join(__dirname, 'modelDownloader'));
const liveServer = require(path.join(__dirname, 'liveServer'));

// ─── Initialize pipeline components ──────────────────────
console.log('[Server] Initializing pipeline components...');

const llmEngine = new ChatEngine();
const WebSearch = require(path.join(ROOT_DIR, 'webSearch'));
const webSearch = new WebSearch();
const mcpToolServer = new MCPToolServer({ projectPath: null, webSearch });

// Set default disabled tools — only core tools enabled by default
{
  const allDefs = mcpToolServer.getAllToolDefinitions();
  const defaultDisabled = allDefs
    .map(t => t.name)
    .filter(name => !ChatEngine.DEFAULT_ENABLED_TOOLS.has(name));
  mcpToolServer.setDisabledTools(defaultDisabled);
  console.log(`[Server] Tools: ${ChatEngine.DEFAULT_ENABLED_TOOLS.size} enabled, ${defaultDisabled.length} disabled by default`);
}

// R33-Phase1: Wire mcpToolServer to the mainWindow bridge so it can emit
// 'files-changed' and 'agent-file-modified' events to the frontend.
// Without this, the File Explorer never auto-updates after file operations
// because browserManager.parentWindow is null in web-server mode.
mcpToolServer.setBrowserManager({ parentWindow: mainWindow });

const gitManager = new GitManager();
mcpToolServer.setGitManager(gitManager);

const memoryStore = new MemoryStore();
const longTermMemory = new LongTermMemory();
const modelManager = new ModelManager(ROOT_DIR);
const sessionStore = new SessionStore(path.join(USER_DATA, 'sessions'));
const cloudLLM = new CloudLLMService();
const modelDownloader = new ModelDownloader(path.join(ROOT_DIR, 'models'));
const ragEngine = new RAGEngine();
const browserManager = new BrowserManager({ liveServer, parentWindow: mainWindow });

// Settings persistence — SettingsManager handles settings.json + encrypted API keys
const settingsManager = new SettingsManager(USER_DATA);

// Restore persisted API keys into cloudLLM on startup
const savedKeys = settingsManager.getAllApiKeys();
for (const [provider, key] of Object.entries(savedKeys)) {
  if (key && key.trim()) {
    cloudLLM.setApiKey(provider, key);
    console.log(`[Server] Restored API key for ${provider}`);
  }
}

const firstRunSetup = new FirstRunSetup(settingsManager);

// Auto-updater (fallback when not running in Electron)
const autoUpdater = new AutoUpdater(mainWindow, { autoDownload: false });

// Account/Auth manager
const accountManager = new AccountManager(settingsManager);

// License manager — validates licenses, handles Stripe checkout
const licenseManager = new LicenseManager(settingsManager, accountManager);

// Extension manager — community extension install, enable, disable
const extensionManager = new ExtensionManager(USER_DATA);
extensionManager.initialize().catch(err => console.error('[Server] Extension init error:', err.message));

// Debug service — manages debug sessions (Node.js/Python)
const debugService = new DebugService();

let currentSettings = settingsManager.getAll();

const ctx = {
  llmEngine,
  mcpToolServer,
  memoryStore,
  longTermMemory,
  modelManager,
  sessionStore,
  userDataPath: USER_DATA,
  currentProjectPath: null,
  agenticCancelled: false,

  getMainWindow: () => mainWindow,

  cloudLLM,

  // Browser — manages live preview + Playwright (if installed)
  playwrightBrowser: null,
  browserManager,

  // RAG engine — BM25 codebase search
  ragEngine,

  // Web search — DuckDuckGo HTML scraping, no API key required
  webSearch,

  // License/account — local-first, account optional for cloud features
  licenseManager,

  _truncateResult: (result) => {
    if (!result) return result;
    const str = typeof result === 'string' ? result : JSON.stringify(result);
    return str.length > 8000 ? str.substring(0, 8000) + '...[truncated]' : result;
  },

  _readConfig: () => currentSettings,
};

// Wire license manager into cloud service
cloudLLM.setLicenseManager(ctx.licenseManager);

// Register the ai-chat handler for basic model chat
ipcMain.handle('ai-chat', async (_event, userMessage, chatContext) => {
  if (!llmEngine.isReady) {
    return { error: 'No model loaded. Please load a model first.' };
  }
  try {
    ctx.agenticCancelled = false;
    const settings = chatContext?.settings || {};

    // Build tool functions from enabled tool definitions
    const toolDefs = mcpToolServer.getToolDefinitions();
    const functions = ChatEngine.convertToolDefs(toolDefs);

    const result = await llmEngine.chat(userMessage, {
      onToken: (token) => {
        mainWindow.webContents.send('llm-token', token);
      },
      onContextUsage: (data) => {
        mainWindow.webContents.send('context-usage', data);
      },
      onToolCall: (data) => {
        mainWindow.webContents.send('tool-call', data);
      },
      functions,
      executeToolFn: async (toolName, params) => {
        return await mcpToolServer.executeTool(toolName, params);
      },
      systemPrompt: settings.systemPrompt || undefined,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens || -1,
      topP: settings.topP,
      topK: settings.topK,
      repeatPenalty: settings.repeatPenalty,
    });
    return { text: result.text, toolCallCount: result.toolCallCount };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('cancel-generation', async () => {
  llmEngine.cancelGeneration('user');
  return { success: true };
});

async function openProjectPath(projectPath) {
  const resolved = path.resolve(projectPath);
  if (!fs.existsSync(resolved)) {
    const error = new Error('Directory not found');
    error.statusCode = 404;
    throw error;
  }

  ctx.currentProjectPath = resolved;
  mcpToolServer.projectPath = resolved;
  gitManager.setProjectPath(resolved);
  memoryStore.initialize(resolved);
  longTermMemory.initialize(resolved);
  ragEngine.indexProject(resolved).catch(e => console.warn('[Server] RAG indexing failed:', e.message));
  mainWindow.webContents.send('project-opened', { path: resolved });

  return { path: resolved };
}

// ─── Express HTTP Server ─────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ─── Project Templates ───────────────────────────────────
const { register: registerTemplates } = require(path.join(__dirname, 'templateHandlers'));
registerTemplates(app, { openProjectPath });

// ─── Module Routes (firstRun, autoUpdater, account, license) ──
firstRunSetup.registerRoutes(app);
autoUpdater.registerRoutes(app);
accountManager.registerRoutes(app);
licenseManager.registerRoutes(app);

// ─── REST API Routes ─────────────────────────────────────

// Model management
app.get('/api/models', async (req, res) => {
  try {
    const models = modelManager.availableModels;
    const status = llmEngine.getStatus();
    res.json({ models, status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/models/load', async (req, res) => {
  const { modelPath } = req.body;
  if (!modelPath) return res.status(400).json({ error: 'modelPath required' });
  try {
    // Send loading status to connected clients
    mainWindow.webContents.send('model-loading', { path: modelPath });
    await llmEngine.initialize(modelPath);
    const info = llmEngine.modelInfo;
    // Persist last-used model so it auto-loads on next startup
    settingsManager.set('lastModelPath', modelPath);
    mainWindow.webContents.send('model-loaded', info);
    res.json({ success: true, modelInfo: info });
  } catch (e) {
    mainWindow.webContents.send('model-error', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/models/unload', async (req, res) => {
  try {
    await llmEngine.dispose();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/models/status', (req, res) => {
  res.json(llmEngine.getStatus());
});

app.post('/api/models/scan', async (req, res) => {
  try {
    const models = await modelManager.scanModels();
    res.json({ models });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/models/add', async (req, res) => {
  const { filePaths } = req.body;
  if (!filePaths || !Array.isArray(filePaths)) return res.status(400).json({ error: 'filePaths array required' });
  try {
    const added = await modelManager.addModels(filePaths);
    res.json({ added });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload GGUF model files (browser fallback when Electron dialog unavailable)
app.post('/api/models/upload', async (req, res) => {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    return res.status(400).json({ error: 'multipart/form-data required' });
  }
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) return res.status(400).json({ error: 'Missing boundary' });
  const boundary = boundaryMatch[1];

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    const sep = Buffer.from(`--${boundary}`);
    const parts = [];
    let start = 0;
    while (true) {
      const idx = buffer.indexOf(sep, start);
      if (idx === -1) break;
      if (start > 0) parts.push(buffer.slice(start, idx));
      start = idx + sep.length;
      // Skip CRLF after boundary
      if (buffer[start] === 0x0D && buffer[start + 1] === 0x0A) start += 2;
    }

    const saved = [];
    const fsP = require('fs').promises;
    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const headers = part.slice(0, headerEnd).toString('utf8');
      const filenameMatch = headers.match(/filename="([^"]+)"/);
      if (!filenameMatch) continue;
      const filename = path.basename(filenameMatch[1]); // sanitize
      if (!filename.endsWith('.gguf')) continue;
      // Strip trailing CRLF
      let body = part.slice(headerEnd + 4);
      if (body[body.length - 2] === 0x0D && body[body.length - 1] === 0x0A) {
        body = body.slice(0, -2);
      }
      const destPath = path.join(modelManager.modelsDir, filename);
      await fsP.writeFile(destPath, body);
      saved.push(filename);
    }

    if (saved.length === 0) return res.status(400).json({ error: 'No .gguf files found in upload' });
    await modelManager.scanModels();
    res.json({ success: true, saved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GPU info + system resources
app.get('/api/gpu', async (req, res) => {
  try {
    const info = await llmEngine.getGPUInfo();
    // Add CPU/RAM info
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    info.ramTotalGB = (totalMem / (1024 ** 3)).toFixed(1);
    info.ramUsedGB = (usedMem / (1024 ** 3)).toFixed(1);
    // CPU usage: average across cores (idle vs total)
    const cpus = os.cpus();
    let totalIdle = 0, totalTick = 0;
    for (const cpu of cpus) {
      for (const type in cpu.times) totalTick += cpu.times[type];
      totalIdle += cpu.times.idle;
    }
    info.cpuUsage = Math.round(100 - (totalIdle / totalTick * 100));
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Project management
app.post('/api/project/open', (req, res) => {
  const { projectPath } = req.body;
  if (!projectPath) return res.status(400).json({ error: 'projectPath required' });
  try {
    openProjectPath(projectPath)
      .then(({ path: resolved }) => res.json({ success: true, path: resolved }))
      .catch((e) => {
        res.status(e.statusCode || 500).json({ error: e.message });
      });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/project/current', (req, res) => {
  res.json({ projectPath: ctx.currentProjectPath });
});

// File operations (for the file explorer)
app.get('/api/files/tree', async (req, res) => {
  const dirPath = req.query.path || ctx.currentProjectPath;
  if (!dirPath) return res.json({ items: [] });
  try {
    const items = await _readDirRecursive(dirPath, 0, 3);
    res.json({ items, root: dirPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/files/read', async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(ctx.currentProjectPath || '', filePath);
    const content = fs.readFileSync(fullPath, 'utf8');
    const ext = path.extname(fullPath).slice(1);
    res.json({ content, path: fullPath, extension: ext, name: path.basename(fullPath) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/files/write', async (req, res) => {
  const { filePath, content } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath required' });
  try {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(ctx.currentProjectPath || '', filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content || '', 'utf8');
    res.json({ success: true, path: fullPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Settings
app.get('/api/settings', (req, res) => {
  res.json(settingsManager.getAll());
});

app.post('/api/settings', (req, res) => {
  settingsManager.setAll(req.body);
  currentSettings = settingsManager.getAll();
  res.json({ success: true });
});

// ─── Cloud LLM API Routes ────────────────────────────────

app.get('/api/cloud/status', (req, res) => {
  res.json(cloudLLM.getStatus());
});

app.get('/api/cloud/providers', (req, res) => {
  res.json({
    configured: cloudLLM.getConfiguredProviders(),
    all: cloudLLM.getAllProviders(),
  });
});

app.get('/api/cloud/models/:provider', async (req, res) => {
  const { provider } = req.params;
  if (provider === 'openrouter') {
    try {
      const models = await cloudLLM.fetchOpenRouterModels();
      res.json({ models });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  } else if (provider === 'ollama') {
    await cloudLLM.detectOllama();
    res.json({ models: cloudLLM.getOllamaModels() });
  } else {
    res.json({ models: cloudLLM._getProviderModels(provider) });
  }
});

app.post('/api/cloud/provider', (req, res) => {
  const { provider, model } = req.body;
  if (!provider) return res.status(400).json({ error: 'provider required' });
  cloudLLM.activeProvider = provider;
  if (model) cloudLLM.activeModel = model;
  res.json({ success: true, activeProvider: cloudLLM.activeProvider, activeModel: cloudLLM.activeModel });
});

app.post('/api/cloud/apikey', (req, res) => {
  const { provider, key } = req.body;
  if (!provider) return res.status(400).json({ error: 'provider required' });
  cloudLLM.setApiKey(provider, key || '');
  // Persist the key (encrypted) so it survives restarts
  settingsManager.setApiKey(provider, key || '');
  res.json({ success: true, hasKey: !!(key && key.trim()) });
});

app.get('/api/cloud/pool/:provider', (req, res) => {
  res.json(cloudLLM.getPoolStatus(req.params.provider));
});

app.get('/api/cloud/test/:provider', async (req, res) => {
  const { provider } = req.params;
  if (!provider) return res.status(400).json({ error: 'provider required' });
  try {
    const key = cloudLLM.apiKeys[provider];
    if (!key) return res.json({ success: false, error: 'No API key set' });
    const models = cloudLLM._getProviderModels(provider);
    const testModel = models[0]?.id;
    if (!testModel) return res.json({ success: false, error: 'No models for provider' });
    // Quick validation: set the provider temporarily and do a minimal generate
    const prevProvider = cloudLLM.activeProvider;
    const prevModel = cloudLLM.activeModel;
    cloudLLM.activeProvider = provider;
    cloudLLM.activeModel = testModel;
    const result = await Promise.race([
      cloudLLM.generate([{ role: 'user', content: 'Say hi' }], { maxTokens: 5, stream: false }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout after 15s')), 15000)),
    ]);
    cloudLLM.activeProvider = prevProvider;
    cloudLLM.activeModel = prevModel;
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/models/recommend', async (req, res) => {
  try {
    const { execSync } = require('child_process');
    let vramMB = 0;
    try {
      const out = execSync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits', { timeout: 5000 }).toString().trim();
      vramMB = parseInt(out.split('\n')[0], 10) || 0;
    } catch { /* no GPU or nvidia-smi not available */ }
    const maxModelGB = vramMB > 0 ? Math.floor((vramMB * 0.85) / 1024) : 4;
    // Curated recommended models list
    const recommended = [
      { name: 'Qwen 3.5 0.8B', file: 'Qwen3.5-0.8B-Q8_0.gguf', size: 0.8, desc: 'Tiny, ultra-fast', downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf', tags: ['general'] },
      { name: 'Qwen 3.5 4B', file: 'Qwen3.5-4B-Q8_0.gguf', size: 4.5, desc: 'Great balance', downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q8_0.gguf', tags: ['coding', 'general'] },
      { name: 'Qwen 3.5 9B', file: 'Qwen3.5-9B-Q4_K_M.gguf', size: 5.7, desc: 'Strong all-rounder', downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf', tags: ['coding', 'reasoning'] },
      { name: 'Qwen 3.5 27B', file: 'Qwen3.5-27B-Q4_K_M.gguf', size: 16.7, desc: 'High quality', downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-27B-GGUF/resolve/main/Qwen3.5-27B-Q4_K_M.gguf', tags: ['coding', 'reasoning'] },
      { name: 'Qwen 3.5 35B-A3B (MoE)', file: 'Qwen3.5-35B-A3B-Q4_K_M.gguf', size: 22.0, desc: 'MoE, fast for size', downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-35B-A3B-GGUF/resolve/main/Qwen3.5-35B-A3B-Q4_K_M.gguf', tags: ['coding', 'reasoning'] },
    ];
    const fits = recommended.filter(m => m.size <= maxModelGB);
    const other = recommended.filter(m => m.size > maxModelGB);
    res.json({ fits, other, maxModelGB, vramMB });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HuggingFace model download endpoints ─────────────────────────
app.get('/api/models/hf/search', async (req, res) => {
  const q = req.query.q;
  if (!q || !q.trim()) return res.json({ models: [] });
  try {
    const models = await modelDownloader.searchModels(q.trim());
    res.json({ models });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/models/hf/files/:owner/:repo', async (req, res) => {
  const repoId = `${req.params.owner}/${req.params.repo}`;
  try {
    const result = await modelDownloader.getRepoFiles(repoId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/models/hf/download', async (req, res) => {
  const { url, fileName } = req.body || {};
  if (!url || !fileName) return res.status(400).json({ error: 'url and fileName required' });
  try {
    const result = await modelDownloader.downloadModel(url, fileName);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/models/hf/cancel', (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  const cancelled = modelDownloader.cancelDownload(id);
  res.json({ success: cancelled });
});

app.get('/api/models/hf/downloads', (req, res) => {
  res.json({ downloads: modelDownloader.getActiveDownloads() });
});

// ── License endpoints ────────────────────────────────────────────
app.get('/api/license/status', (req, res) => {
  const lm = ctx.licenseManager;
  res.json({
    isActivated: lm.isActivated || false,
    isAuthenticated: accountManager.isAuthenticated || false,
    license: lm.licenseData || null,
    machineId: lm.machineId || null,
    user: accountManager.user || null,
    plan: lm.getPlan(),
  });
});

// POST /api/license/activate — handled by licenseManager.registerRoutes()

app.post('/api/license/oauth', async (req, res) => {
  const { provider } = req.body || {};
  if (!provider || !['google', 'github'].includes(provider)) {
    return res.json({ success: false, error: 'Invalid OAuth provider' });
  }
  const { url } = accountManager.getOAuthURL(provider);
  res.json({ success: true, url });
});

app.post('/api/license/deactivate', (req, res) => {
  licenseManager.deactivate();
  accountManager.logout();
  res.json({ success: true });
});

// ─── Extension Management ────────────────────────────────

app.get('/api/extensions', async (req, res) => {
  try {
    const extensions = extensionManager.getInstalled();
    const categories = extensionManager.getCategories();
    res.json({ extensions, categories });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/extensions/install', async (req, res) => {
  try {
    // Multipart upload — parse the zip file from the request body
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ error: 'Expected multipart/form-data with a .zip or .guide-ext file' });
    }

    const boundary = contentType.split('boundary=')[1];
    if (!boundary) return res.status(400).json({ error: 'No boundary in multipart request' });

    const chunks = [];
    for await (const chunk of req) { chunks.push(chunk); }
    const body = Buffer.concat(chunks);
    const bodyStr = body.toString('binary');
    const parts = bodyStr.split('--' + boundary).filter(p => p.trim() && p.trim() !== '--');

    let fileBuffer = null;
    let fileName = 'extension.zip';

    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const headers = part.substring(0, headerEnd);
      if (!headers.includes('filename=')) continue;

      const fnMatch = headers.match(/filename="([^"]+)"/);
      if (fnMatch) fileName = path.basename(fnMatch[1]);

      const fileData = part.substring(headerEnd + 4);
      // Remove trailing \r\n
      const trimmed = fileData.endsWith('\r\n') ? fileData.slice(0, -2) : fileData;
      fileBuffer = Buffer.from(trimmed, 'binary');
      break;
    }

    if (!fileBuffer) {
      return res.status(400).json({ error: 'No file found in upload' });
    }

    const result = await extensionManager.installFromZip(fileBuffer, fileName);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/extensions/uninstall', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Extension ID required' });
    const result = await extensionManager.uninstall(id);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/extensions/enable', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Extension ID required' });
    const result = await extensionManager.enable(id);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/extensions/disable', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Extension ID required' });
    const result = await extensionManager.disable(id);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Debug Service ───────────────────────────────────────

// Forward debug events to the frontend via the WebSocket bridge
debugService.on('debug-event', (data) => {
  mainWindow.webContents.send('debug-event', data);
});

app.post('/api/debug/start', async (req, res) => {
  try {
    const { type, program, cwd, args } = req.body;
    if (!program) return res.status(400).json({ error: 'Program path required' });
    const result = await debugService.start({
      type: type || 'node',
      program,
      cwd: cwd || ctx.currentProjectPath || undefined,
      args: args || [],
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/debug/stop', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Session ID required' });
    const result = await debugService.stop(sessionId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/debug/continue', async (req, res) => {
  try {
    const { sessionId } = req.body;
    const result = await debugService.resume(sessionId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/debug/stepOver', async (req, res) => {
  try {
    const { sessionId } = req.body;
    const result = await debugService.stepOver(sessionId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/debug/stepInto', async (req, res) => {
  try {
    const { sessionId } = req.body;
    const result = await debugService.stepInto(sessionId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/debug/stepOut', async (req, res) => {
  try {
    const { sessionId } = req.body;
    const result = await debugService.stepOut(sessionId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/debug/pause', async (req, res) => {
  try {
    const { sessionId } = req.body;
    const result = await debugService.pause(sessionId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/debug/stackTrace', async (req, res) => {
  try {
    const sessionId = parseInt(req.query.sessionId);
    const result = await debugService.getStackTrace(sessionId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/debug/scopes', async (req, res) => {
  try {
    const sessionId = parseInt(req.query.sessionId);
    const frameId = parseInt(req.query.frameId || '0');
    const result = await debugService.getScopes(sessionId, frameId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/debug/variables', async (req, res) => {
  try {
    const sessionId = parseInt(req.query.sessionId);
    const ref = req.query.ref;
    const result = await debugService.getVariables(sessionId, ref);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/debug/evaluate', async (req, res) => {
  try {
    const { sessionId, expression, frameId } = req.body;
    const result = await debugService.evaluate(sessionId, expression, frameId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/debug/setBreakpoints', async (req, res) => {
  try {
    const { sessionId, filePath, breakpoints } = req.body;
    const result = await debugService.setBreakpoints(sessionId, filePath, breakpoints || []);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/debug/sessions', (req, res) => {
  res.json({ sessions: debugService.getActiveSessions() });
});

// ─── Code formatting (Prettier) ─────────────────────────
app.post('/api/format', async (req, res) => {
  try {
    const { content, language, filePath: fp } = req.body;
    if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });

    // Map language/extension to prettier parser
    const parserMap = {
      javascript: 'babel', js: 'babel', jsx: 'babel', mjs: 'babel', cjs: 'babel',
      typescript: 'typescript', ts: 'typescript', tsx: 'typescript',
      css: 'css', scss: 'css', less: 'less',
      html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte',
      json: 'json', jsonc: 'json',
      yaml: 'yaml', yml: 'yaml',
      markdown: 'markdown', md: 'markdown', mdx: 'mdx',
      graphql: 'graphql', gql: 'graphql',
      xml: 'html', svg: 'html'
    };

    const ext = fp ? path.extname(fp).replace('.', '').toLowerCase() : '';
    const parser = parserMap[language] || parserMap[ext] || 'babel';

    // Try to load .prettierrc from project
    let prettierConfig = {};
    if (ctx.projectPath) {
      try {
        const rcPath = path.join(ctx.projectPath, '.prettierrc');
        if (fs.existsSync(rcPath)) {
          prettierConfig = JSON.parse(fs.readFileSync(rcPath, 'utf-8'));
        }
      } catch (_) { /* ignore bad config */ }
    }

    const formatted = await prettier.format(content, {
      parser,
      ...prettierConfig,
      filepath: fp || undefined
    });
    res.json({ formatted });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── TODO / FIXME Scanner ────────────────────────────────
app.post('/api/todos/scan', async (req, res) => {
  try {
    const projectPath = ctx.projectPath;
    if (!projectPath) return res.status(400).json({ error: 'No project open' });

    const TODO_PATTERN = /\b(TODO|FIXME|HACK|NOTE|XXX|BUG|OPTIMIZE)\b[:\s]*(.*)/gi;
    const MAX_RESULTS = 500;
    const BINARY_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.webp','.bmp','.ico','.svg',
      '.woff','.woff2','.ttf','.eot','.mp3','.mp4','.wav','.ogg','.zip','.tar','.gz',
      '.rar','.7z','.pdf','.exe','.dll','.so','.dylib','.o','.pyc','.class','.gguf',
      '.bin','.dat','.db','.sqlite','.lock']);
    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
      '.venv', 'venv', '.cache', 'coverage', '.idea', '.vscode']);

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
                results.push({
                  file: path.relative(projectPath, fullPath).replace(/\\/g, '/'),
                  line: i + 1,
                  type: match[1].toUpperCase(),
                  text: match[2].trim() || match[0].trim()
                });
                if (results.length >= MAX_RESULTS) break;
              }
            }
          } catch (_) { /* skip unreadable files */ }
        }
      }
    }

    scanDir(projectPath);
    res.json({ todos: results, total: results.length, capped: results.length >= MAX_RESULTS });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Session management
app.post('/api/session/clear', async (req, res) => {
  try {
    ctx.agenticCancelled = true;
    try { llmEngine.cancelGeneration(); } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
    await llmEngine.resetSession();
    // R51-Fix: Clear todo state on session clear so the todo list
    // doesn't persist visually after the user hits the trash can button.
    if (ctx.mcpToolServer) {
      ctx.mcpToolServer._todos = [];
      ctx.mcpToolServer._todoNextId = 1;
    }
    ctx.agenticCancelled = false;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'running',
    version: '2.0.0',
    modelLoaded: llmEngine.isReady,
    modelInfo: llmEngine.modelInfo,
    projectPath: ctx.currentProjectPath,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

// File search
app.get('/api/files/search', async (req, res) => {
  const basePath = req.query.path || ctx.currentProjectPath;
  const query = req.query.query;
  if (!basePath || !query) return res.json({ results: [] });
  try {
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
            if (stat.size > 1024 * 1024) continue; // skip files > 1MB
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
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Git status
app.get('/api/git/status', async (req, res) => {
  const basePath = req.query.path || ctx.currentProjectPath;
  if (!basePath) return res.json({ error: 'No project path' });
  try {
    const result = gitManager.getStatus(basePath);
    res.json(result);
  } catch (e) {
    res.json({ error: e.message, branch: '', staged: [], modified: [], untracked: [] });
  }
});

// Git stage files
app.post('/api/git/stage', async (req, res) => {
  const basePath = req.body.path || ctx.currentProjectPath;
  if (!basePath) return res.status(400).json({ error: 'No project path' });
  try {
    if (req.body.all) {
      gitManager.stageAll(basePath);
    } else if (req.body.files && Array.isArray(req.body.files)) {
      gitManager.stageFiles(req.body.files, basePath);
    } else {
      return res.status(400).json({ error: 'Provide files array or all:true' });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Git unstage files
app.post('/api/git/unstage', async (req, res) => {
  const basePath = req.body.path || ctx.currentProjectPath;
  if (!basePath) return res.status(400).json({ error: 'No project path' });
  try {
    if (req.body.all) {
      gitManager.unstageAll(basePath);
    } else if (req.body.files && Array.isArray(req.body.files)) {
      gitManager.unstageFiles(req.body.files, basePath);
    } else {
      return res.status(400).json({ error: 'Provide files array or all:true' });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Git commit
app.post('/api/git/commit', async (req, res) => {
  const basePath = req.body.path || ctx.currentProjectPath;
  const message = req.body.message;
  if (!basePath) return res.status(400).json({ error: 'No project path' });
  if (!message || !message.trim()) return res.status(400).json({ error: 'Commit message required' });
  try {
    const result = gitManager.commit(message, basePath);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Git discard changes (checkout file from HEAD)
app.post('/api/git/discard', async (req, res) => {
  const basePath = req.body.path || ctx.currentProjectPath;
  if (!basePath) return res.status(400).json({ error: 'No project path' });
  try {
    if (req.body.files && Array.isArray(req.body.files)) {
      gitManager.discardFiles(req.body.files, basePath);
    } else {
      return res.status(400).json({ error: 'Provide files array' });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Git diff
app.get('/api/git/diff', async (req, res) => {
  const basePath = req.query.path || ctx.currentProjectPath;
  if (!basePath) return res.status(400).json({ error: 'No project path' });
  try {
    const result = gitManager.getDiff({ staged: req.query.staged === 'true', file: req.query.file }, basePath);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Git log
app.get('/api/git/log', async (req, res) => {
  const basePath = req.query.path || ctx.currentProjectPath;
  if (!basePath) return res.status(400).json({ error: 'No project path' });
  try {
    const count = parseInt(req.query.count) || 20;
    const result = gitManager.getLog(count, basePath);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Git branches
app.get('/api/git/branches', async (req, res) => {
  const basePath = req.query.path || ctx.currentProjectPath;
  if (!basePath) return res.status(400).json({ error: 'No project path' });
  try {
    const result = gitManager.getBranches(basePath);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Git checkout branch
app.post('/api/git/checkout', async (req, res) => {
  const basePath = req.body.path || ctx.currentProjectPath;
  const branch = req.body.branch;
  if (!basePath) return res.status(400).json({ error: 'No project path' });
  if (!branch) return res.status(400).json({ error: 'Branch name required' });
  try {
    const result = gitManager.checkout(branch, { create: !!req.body.create }, basePath);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Browser Preview Routes ─────────────────────────────

app.post('/api/preview/start', async (req, res) => {
  const rootPath = req.body.rootPath || ctx.currentProjectPath;
  if (!rootPath) return res.status(400).json({ error: 'No project path' });
  try {
    const result = await browserManager.startPreview(rootPath);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/preview/stop', async (req, res) => {
  try {
    const result = await browserManager.stopPreview();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/preview/reload', (req, res) => {
  browserManager.reloadPreview();
  res.json({ success: true });
});

app.get('/api/preview/status', (req, res) => {
  res.json(browserManager.getPreviewStatus());
});

// File create (for SearchPanel/explorer new file)
app.post('/api/files/create', async (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(ctx.currentProjectPath || '', filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    if (fs.existsSync(fullPath)) return res.status(409).json({ error: 'File already exists' });
    fs.writeFileSync(fullPath, content || '', 'utf8');
    res.json({ success: true, path: fullPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// File delete
app.post('/api/files/delete', async (req, res) => {
  const { path: filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(ctx.currentProjectPath || '', filePath);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Not found' });
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(fullPath);
    }
    // R51-Fix: Emit files-changed so the frontend file explorer updates
    // immediately after deletion (instead of requiring manual refresh).
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('files-changed');
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// File rename
app.post('/api/files/rename', async (req, res) => {
  const { oldPath, newPath } = req.body;
  if (!oldPath || !newPath) return res.status(400).json({ error: 'oldPath and newPath required' });
  try {
    const fullOld = path.isAbsolute(oldPath) ? oldPath : path.join(ctx.currentProjectPath || '', oldPath);
    const fullNew = path.isAbsolute(newPath) ? newPath : path.join(ctx.currentProjectPath || '', newPath);
    if (!fs.existsSync(fullOld)) return res.status(404).json({ error: 'Source not found' });
    fs.renameSync(fullOld, fullNew);
    // R51-Fix: Emit files-changed after rename so file explorer updates live.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('files-changed');
    }
    res.json({ success: true, path: fullNew });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Terminal execute (legacy — used when PTY is not available)
app.post('/api/terminal/execute', async (req, res) => {
  const { command, cwd } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  try {
    const { execSync } = require('child_process');
    const output = execSync(command, {
      cwd: cwd || ctx.currentProjectPath || process.cwd(),
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    res.json({ success: true, output });
  } catch (e) {
    res.json({ success: false, output: e.stderr || e.stdout || e.message });
  }
});

// ─── Live Server (Go Live preview) ───────────────────────
app.post('/api/live-server/start', async (req, res) => {
  const rootPath = req.body.path || ctx.currentProjectPath;
  if (!rootPath) return res.status(400).json({ error: 'No project path' });
  const result = await liveServer.start(rootPath);
  if (result.success) {
    res.json(result);
  } else {
    res.status(500).json(result);
  }
});

app.post('/api/live-server/stop', async (req, res) => {
  const result = await liveServer.stop();
  res.json(result);
});

app.get('/api/live-server/status', (req, res) => {
  res.json(liveServer.getStatus());
});

// ─── Serve Frontend ──────────────────────────────────────
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST));
  // SPA fallback — serve index.html for all non-API, non-file routes
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/ws')) {
      res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
    }
  });
} else if (isDev) {
  // In dev mode, Vite dev server handles the frontend — just serve API + WS
  app.get('/', (req, res) => {
    res.send('<html><body><h1>guIDE Backend Running</h1><p>Frontend dev server: <a href="http://localhost:5173">http://localhost:5173</a></p></body></html>');
  });
} else {
  app.get('/', (req, res) => {
    res.send('<html><body><h1>guIDE Backend Running</h1><p>Frontend not built. Run: npm run frontend:build</p></body></html>');
  });
}

// ─── Start Server ────────────────────────────────────────
const server = http.createServer(app);
const transport = new Transport({ ipcMain, mainWindow, server });
transport.start();

// ─── PTY Terminal WebSocket ──────────────────────────────
const WebSocket = require('ws');
let pty = undefined; // undefined = not yet attempted; null = attempted but unavailable
function _loadPty() {
  if (pty !== undefined) return pty;
  try {
    pty = require('node-pty');
    console.log('[Server] node-pty loaded — real terminal support enabled');
  } catch (e) {
    console.warn('[Server] node-pty not available — terminal will use exec fallback');
    pty = null;
  }
  return pty;
}

const ptyTerminals = new Map(); // terminalId -> { pty, ws }

const ptyWss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === '/ws/terminal') {
    ptyWss.handleUpgrade(request, socket, head, (ws) => {
      ptyWss.emit('connection', ws, request);
    });
  } else if (url.pathname === '/ws') {
    transport.handleUpgrade(request, socket, head);
  } else {
    socket.destroy();
  }
});

ptyWss.on('connection', (ws) => {
  let termId = null;
  let ptyProcess = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    if (msg.type === 'create') {
      termId = msg.terminalId || `pty-${Date.now()}`;
      const ptyModule = _loadPty(); // lazy-load native module on first terminal open
      if (ptyModule) {
        const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
        const cwd = ctx.currentProjectPath || process.cwd();
        ptyProcess = ptyModule.spawn(shell, [], {
          name: 'xterm-256color',
          cols: msg.cols || 80,
          rows: msg.rows || 24,
          cwd,
          env: process.env,
        });

        ptyProcess.onData((data) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'output', data }));
          }
        });

        ptyProcess.onExit(({ exitCode }) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'exit', exitCode }));
          }
          ptyTerminals.delete(termId);
        });

        ptyTerminals.set(termId, { pty: ptyProcess, ws });
        ws.send(JSON.stringify({ type: 'ready', terminalId: termId, shell }));
      } else {
        // No node-pty — send a message saying to use exec fallback
        ws.send(JSON.stringify({ type: 'no-pty' }));
      }
    } else if (msg.type === 'input' && ptyProcess) {
      ptyProcess.write(msg.data);
    } else if (msg.type === 'resize' && ptyProcess) {
      try { ptyProcess.resize(msg.cols || 80, msg.rows || 24); } catch (_) {}
    }
  });

  ws.on('close', () => {
    if (ptyProcess) {
      try { ptyProcess.kill(); } catch (_) {}
      if (termId) ptyTerminals.delete(termId);
    }
  });
});

// Initialize model manager
modelManager.initialize().then((models) => {
  console.log(`[Server] Found ${models.length} model(s)`);

  // Auto-load: prefer last-used model, then fall back to default heuristic
  if (!llmEngine.isReady && models.length > 0) {
    const lastPath = settingsManager.get('lastModelPath');
    const lastModel = lastPath && models.find(m => m.path === lastPath);
    const target = lastModel || modelManager.getDefaultModel();
    if (target) {
      console.log(`[Server] Auto-loading ${lastModel ? 'last-used' : 'default'} model: ${target.name}`);
      llmEngine.initialize(target.path).catch(e => {
        console.error(`[Server] Auto-load failed: ${e.message}`);
      });
    }
  }
}).catch(e => {
  console.error(`[Server] Model scan failed: ${e.message}`);
});

// Forward model manager events to clients
modelManager.on('models-updated', (models) => {
  mainWindow.webContents.send('models-updated', models);
});

// Forward model download events to clients
for (const evt of ['download-started', 'download-progress', 'download-complete', 'download-error', 'download-cancelled']) {
  modelDownloader.on(evt, (data) => {
    mainWindow.webContents.send(evt, data);
  });
}
// Auto-rescan models when a download completes
modelDownloader.on('download-complete', () => {
  modelManager.scanModels().catch(() => {});
});

llmEngine.on('status', (status) => {
  mainWindow.webContents.send('llm-status', status);
});

server.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  guIDE 3.0 Server`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`  Mode: ${isDev ? 'development' : 'production'}`);
  console.log(`  Models dir: ${MODELS_DIR}`);
  console.log(`  User data: ${USER_DATA}`);
  console.log(`${'='.repeat(60)}\n`);
});

// ─── Graceful Shutdown ───────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\n[Server] Shutting down...');
  transport.shutdown();
  settingsManager.flush();
  memoryStore.dispose();
  sessionStore.flush();
  try { await browserManager.dispose(); } catch (_) {}
  try { await llmEngine.dispose(); } catch (_) {}
  modelManager.dispose();
  log.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000); // Force exit after 5s
});

process.on('SIGTERM', () => process.emit('SIGINT'));

// ─── Helpers ─────────────────────────────────────────────

async function _readDirRecursive(dirPath, depth = 0, maxDepth = 3) {
  const items = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      // Skip hidden files, node_modules, .git, etc.
      if (entry.name.startsWith('.') && entry.name !== '.env') continue;
      if (['node_modules', '__pycache__', '.git', 'dist', 'build', '.next', 'target'].includes(entry.name)) continue;

      const fullPath = path.join(dirPath, entry.name);
      const item = {
        name: entry.name,
        path: fullPath,
        type: entry.isDirectory() ? 'directory' : 'file',
      };

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

    // Sort: directories first, then files, both alphabetically
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch (e) {
    // Permission denied or other errors — skip silently
  }
  return items;
}

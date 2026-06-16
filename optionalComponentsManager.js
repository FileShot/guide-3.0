'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile, execSync } = require('child_process');
const { promisify } = require('util');
const EventEmitter = require('events');
const {
  COMPONENT_IDS,
  getComponentsRoot,
  getManifestPath,
  getPlaywrightBrowsersDir,
  getSdCppDir,
  getWhisperDir,
  catalogForVariant,
  isPlaywrightBrowsersReady,
  isSdCppReady,
  isWhisperReady,
} = require('./optionalComponentPaths');

const execFileAsync = promisify(execFile);
const WHISPER_MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';

function log(msg) {
  console.log(`[OptionalComponents] ${msg}`);
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'guide-ide-components' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJson(res.headers.location).then(resolve, reject);
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, dest, { onProgress, expectedSize } = {}) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    const req = (u) => {
      https.get(u, { headers: { 'User-Agent': 'guide-ide-components' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return req(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const total = Number(res.headers['content-length']) || expectedSize || 0;
        let done = 0;
        const file = fs.createWriteStream(tmp);
        res.on('data', (chunk) => {
          done += chunk.length;
          if (onProgress && total > 0) onProgress(done, total);
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            fs.renameSync(tmp, dest);
            resolve(dest);
          });
        });
        file.on('error', reject);
      }).on('error', reject);
    };
    req(url);
  });
}

function extractZip(zipPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}' -Force"`,
      { stdio: 'pipe' },
    );
  } else {
    execSync(`unzip -o "${zipPath}" -d "${outDir}"`, { stdio: 'pipe' });
  }
}

function findSdBinary(dir) {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && /^sd(?:-cli)?\.exe?$/i.test(e.name)) return full;
    if (e.isDirectory()) {
      const found = findSdBinary(full);
      if (found) return found;
    }
  }
  return null;
}

function flattenSdExtract(extractRoot, outDir) {
  const sdBinary = findSdBinary(extractRoot);
  if (!sdBinary) throw new Error(`sd.exe not found under ${extractRoot}`);
  const binDir = path.dirname(sdBinary);
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of fs.readdirSync(binDir)) {
    const src = path.join(binDir, name);
    if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(outDir, name));
  }
  const sdCli = path.join(outDir, 'sd-cli.exe');
  const sdExe = path.join(outDir, 'sd.exe');
  if (!fs.existsSync(sdExe) && fs.existsSync(sdCli)) fs.copyFileSync(sdCli, sdExe);
}

class OptionalComponentsManager extends EventEmitter {
  /**
   * @param {{ userDataPath: string, resourcesPath?: string|null, installVariant?: 'cuda'|'cpu', settingsManager?: object, mainWindow?: object }} opts
   */
  constructor(opts) {
    super();
    this._userDataPath = opts.userDataPath;
    this._resourcesPath = opts.resourcesPath || null;
    this._installVariant = opts.installVariant || 'cpu';
    this._settingsManager = opts.settingsManager || null;
    this._mainWindow = opts.mainWindow || null;
    this._states = {};
    this._queueRunning = false;
    this._cancelled = false;
    this._currentId = null;
    this._aggregate = { bytesDone: 0, bytesTotal: 0 };
    this._loadManifest();
    this._syncReadyFromDisk();
  }

  setMainWindow(win) {
    this._mainWindow = win;
  }

  _loadManifest() {
    try {
      const raw = fs.readFileSync(getManifestPath(this._userDataPath), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.components && typeof parsed.components === 'object') {
        for (const [id, meta] of Object.entries(parsed.components)) {
          this._states[id] = { ...meta, phase: meta.phase === 'ready' ? 'ready' : meta.phase };
        }
      }
    } catch {
      // no manifest yet
    }
  }

  _saveManifest() {
    const components = {};
    for (const [id, st] of Object.entries(this._states)) {
      components[id] = {
        phase: st.phase,
        installedAt: st.installedAt || null,
        bytes: st.bytes || 0,
        version: st.version || null,
      };
    }
    fs.mkdirSync(getComponentsRoot(this._userDataPath), { recursive: true });
    fs.writeFileSync(getManifestPath(this._userDataPath), JSON.stringify({
      version: 1,
      installVariant: this._installVariant,
      components,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  }

  _syncReadyFromDisk() {
    for (const entry of catalogForVariant(this._installVariant)) {
      if (this._isComponentReadyOnDisk(entry.id)) {
        this._states[entry.id] = {
          ...(this._states[entry.id] || {}),
          phase: 'ready',
          installedAt: this._states[entry.id]?.installedAt || new Date().toISOString(),
        };
      }
    }
  }

  _isComponentReadyOnDisk(id) {
    switch (id) {
      case COMPONENT_IDS.PLAYWRIGHT:
        return isPlaywrightBrowsersReady(this._userDataPath, this._resourcesPath);
      case COMPONENT_IDS.SD_CUDA:
        return isSdCppReady(this._userDataPath, this._resourcesPath, 'cuda');
      case COMPONENT_IDS.SD_CPU:
        return isSdCppReady(this._userDataPath, this._resourcesPath, 'cpu');
      case COMPONENT_IDS.WHISPER:
        return isWhisperReady(this._userDataPath, this._resourcesPath);
      default:
        return false;
    }
  }

  getCatalog() {
    return catalogForVariant(this._installVariant);
  }

  getStatus() {
    const catalog = this.getCatalog();
    const pending = catalog.filter((c) => !this._isComponentReadyOnDisk(c.id) && this._states[c.id]?.phase !== 'skipped');
    const downloading = this._queueRunning;
    let phase = 'idle';
    if (downloading) phase = 'downloading';
    else if (pending.length === 0 && catalog.every((c) => this._isComponentReadyOnDisk(c.id) || this._states[c.id]?.phase === 'skipped')) {
      phase = 'done';
    } else if (catalog.some((c) => this._states[c.id]?.phase === 'error')) {
      phase = 'error';
    }

    const current = this._currentId
      ? catalog.find((c) => c.id === this._currentId)
      : null;
    const percent = this._aggregate.bytesTotal > 0
      ? Math.min(100, Math.round((this._aggregate.bytesDone / this._aggregate.bytesTotal) * 100))
      : (phase === 'done' ? 100 : 0);

    return {
      phase,
      label: current?.label || (phase === 'done' ? 'Optional components ready' : 'Optional components'),
      percent,
      currentComponent: this._currentId,
      currentComponentLabel: current?.label || null,
      bytesDone: this._aggregate.bytesDone,
      bytesTotal: this._aggregate.bytesTotal,
      needsRestart: false,
      error: catalog.map((c) => this._states[c.id]?.error).find(Boolean) || null,
      components: Object.fromEntries(catalog.map((c) => [c.id, {
        phase: this._isComponentReadyOnDisk(c.id) ? 'ready' : (this._states[c.id]?.phase || 'missing'),
        label: c.label,
      }])),
    };
  }

  _sendStatus(overrides = {}) {
    const payload = { ...this.getStatus(), ...overrides };
    try {
      if (this._mainWindow && !this._mainWindow.isDestroyed()) {
        this._mainWindow.webContents.send('component-bundle-status', payload);
      }
    } catch {
      // window closed
    }
    this.emit('status', payload);
  }

  async startBackgroundQueue() {
    if (this._queueRunning) return;
    const flag = this._settingsManager?.get?.('optionalComponentsQueueStarted');
    if (flag) {
      log('background queue already started previously — syncing status only');
      this._sendStatus();
      return;
    }

    const catalog = this.getCatalog().filter((c) => !this._isComponentReadyOnDisk(c.id) && this._states[c.id]?.phase !== 'skipped');
    if (catalog.length === 0) {
      log('all optional components already present');
      this._sendStatus({ phase: 'done' });
      return;
    }

    this._aggregate.bytesTotal = catalog.reduce((s, c) => s + (c.bytesEstimate || 0), 0);
    this._aggregate.bytesDone = 0;
    this._queueRunning = true;
    this._cancelled = false;
    this._settingsManager?.set?.('optionalComponentsQueueStarted', true);
    log(`background queue started (${catalog.length} component(s))`);
    this._sendStatus({ phase: 'downloading' });

    for (const entry of catalog) {
      if (this._cancelled) break;
      if (this._isComponentReadyOnDisk(entry.id)) continue;
      this._currentId = entry.id;
      this._states[entry.id] = { ...(this._states[entry.id] || {}), phase: 'downloading', error: null };
      this._sendStatus();
      try {
        await this._installComponent(entry.id, (done, total) => {
          const base = catalog.slice(0, catalog.indexOf(entry)).reduce((s, c) => s + (c.bytesEstimate || 0), 0);
          this._aggregate.bytesDone = base + done;
          if (total > 0) this._aggregate.bytesDone = base + done;
          this._sendStatus();
        });
        this._states[entry.id] = {
          phase: 'ready',
          installedAt: new Date().toISOString(),
          bytes: entry.bytesEstimate,
        };
        this._saveManifest();
        log(`${entry.id} ready`);
      } catch (err) {
        console.error(`[OptionalComponents] ${entry.id} failed:`, err.message);
        this._states[entry.id] = { phase: 'error', error: err.message };
        this._saveManifest();
        this._sendStatus({ phase: 'error', error: err.message });
      }
    }

    this._currentId = null;
    this._queueRunning = false;
    const hasError = catalog.some((c) => this._states[c.id]?.phase === 'error');
    this._sendStatus({ phase: hasError ? 'error' : 'done', percent: 100 });
    log('background queue finished');
  }

  async retry() {
    for (const entry of this.getCatalog()) {
      if (this._states[entry.id]?.phase === 'error') {
        delete this._states[entry.id];
      }
    }
    this._settingsManager?.set?.('optionalComponentsQueueStarted', false);
    return this.startBackgroundQueue();
  }

  skip(id) {
    if (id) {
      this._states[id] = { phase: 'skipped' };
    } else {
      for (const entry of this.getCatalog()) {
        if (!this._isComponentReadyOnDisk(entry.id)) {
          this._states[entry.id] = { phase: 'skipped' };
        }
      }
      this._cancelled = true;
    }
    this._saveManifest();
    this._sendStatus();
  }

  async ensureReady(id) {
    if (this._isComponentReadyOnDisk(id)) return true;
    if (this._states[id]?.phase === 'skipped') return false;
    this._currentId = id;
    this._states[id] = { phase: 'downloading' };
    this._sendStatus({ phase: 'downloading' });
    try {
      await this._installComponent(id);
      this._states[id] = { phase: 'ready', installedAt: new Date().toISOString() };
      this._saveManifest();
      this._currentId = null;
      this._sendStatus();
      return true;
    } catch (err) {
      this._states[id] = { phase: 'error', error: err.message };
      this._saveManifest();
      this._currentId = null;
      this._sendStatus({ phase: 'error', error: err.message });
      return false;
    }
  }

  async _installComponent(id, onProgress) {
    switch (id) {
      case COMPONENT_IDS.PLAYWRIGHT:
        return this._installPlaywright(onProgress);
      case COMPONENT_IDS.SD_CUDA:
        return this._installSdCpp('cuda', onProgress);
      case COMPONENT_IDS.SD_CPU:
        return this._installSdCpp('cpu', onProgress);
      case COMPONENT_IDS.WHISPER:
        return this._installWhisper(onProgress);
      default:
        throw new Error(`Unknown component: ${id}`);
    }
  }

  async _installPlaywright(onProgress) {
    const dest = getPlaywrightBrowsersDir(this._userDataPath);
    if (isPlaywrightBrowsersReady(this._userDataPath, this._resourcesPath)) return;
    fs.mkdirSync(dest, { recursive: true });
    const playwrightRoot = this._findPlaywrightPackageRoot();
    if (!playwrightRoot) throw new Error('Playwright package not found');
    const cli = path.join(playwrightRoot, 'cli.js');
    const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: dest };
    log(`installing Chromium → ${dest}`);
    await execFileAsync(process.execPath, [cli, 'install', 'chromium'], {
      cwd: playwrightRoot,
      env,
      timeout: 900000,
      windowsHide: true,
    });
    if (!isPlaywrightBrowsersReady(this._userDataPath, this._resourcesPath)) {
      throw new Error('Chromium install finished but browser not found');
    }
    if (onProgress) onProgress(350_000_000, 350_000_000);
  }

  _findPlaywrightPackageRoot() {
    try {
      const pkg = require.resolve('playwright/package.json');
      return path.dirname(pkg);
    } catch {
      return null;
    }
  }

  async _installSdCpp(variant, onProgress) {
    const outDir = getSdCppDir(this._userDataPath, variant);
    if (isSdCppReady(this._userDataPath, this._resourcesPath, variant)) return;

    const release = await fetchJson('https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/latest');
    const pattern = variant === 'cuda'
      ? /sd-master-.*-bin-win-cuda12-x64\.zip$/i
      : /sd-master-.*-bin-win-vulkan-x64\.zip$/i;
    const asset = (release.assets || []).find((a) => pattern.test(a.name));
    if (!asset) throw new Error(`No sd-cpp ${variant} asset in latest release`);

    const tmp = path.join(getComponentsRoot(this._userDataPath), '_tmp');
    fs.mkdirSync(tmp, { recursive: true });
    const zipPath = path.join(tmp, asset.name);
    log(`downloading ${asset.name} (${Math.round(asset.size / 1e6)}MB)`);
    await downloadFile(asset.browser_download_url, zipPath, {
      expectedSize: asset.size,
      onProgress,
    });
    const extractDir = path.join(tmp, `extract-${variant}`);
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
    extractZip(zipPath, extractDir);
    if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
    flattenSdExtract(extractDir, outDir);
    if (!isSdCppReady(this._userDataPath, this._resourcesPath, variant)) {
      throw new Error(`sd-cpp ${variant} install incomplete`);
    }
  }

  async _installWhisper(onProgress) {
    const outDir = getWhisperDir(this._userDataPath);
    fs.mkdirSync(outDir, { recursive: true });
    const modelDest = path.join(outDir, 'ggml-base.en.bin');
    if (!fs.existsSync(modelDest)) {
      log('downloading whisper model ggml-base.en.bin');
      await downloadFile(WHISPER_MODEL_URL, modelDest, { onProgress });
    }
    const isWin = process.platform === 'win32';
    const cliName = isWin ? 'whisper-cli.exe' : 'whisper-cli';
    const cliDest = path.join(outDir, cliName);
    if (!fs.existsSync(cliDest)) {
      const release = await fetchJson('https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest');
      const assets = release.assets || [];
      const asset = assets.find((a) => /whisper.*bin.*x64.*\.zip$/i.test(a.name))
        || assets.find((a) => /whisper.*x64.*\.zip$/i.test(a.name));
      if (!asset) {
        log('whisper CLI zip not found — model only (cloud fallback available)');
        return;
      }
      const tmp = path.join(getComponentsRoot(this._userDataPath), '_tmp');
      fs.mkdirSync(tmp, { recursive: true });
      const zipPath = path.join(tmp, asset.name);
      await downloadFile(asset.browser_download_url, zipPath, { expectedSize: asset.size });
      const extractDir = path.join(tmp, 'whisper-cli-extract');
      if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
      extractZip(zipPath, extractDir);
      const names = isWin ? ['whisper-cli.exe', 'whisper.exe', 'main.exe'] : ['whisper-cli', 'whisper', 'main'];
      let found = null;
      const walk = (dir) => {
        for (const name of fs.readdirSync(dir)) {
          const full = path.join(dir, name);
          if (fs.statSync(full).isDirectory()) walk(full);
          else if (names.includes(name)) found = full;
        }
      };
      walk(extractDir);
      if (found) fs.copyFileSync(found, cliDest);
    }
    if (!fs.existsSync(modelDest)) throw new Error('Whisper model missing after download');
  }

  registerIPC(ipcMain) {
    ipcMain.handle('component-bundle-status', () => this.getStatus());
    ipcMain.handle('component-bundle-retry', () => this.retry());
    ipcMain.handle('component-bundle-skip', (_e, id) => {
      this.skip(id || null);
      return this.getStatus();
    });
  }
}

module.exports = { OptionalComponentsManager };

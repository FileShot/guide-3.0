'use strict';

/**
 * LspBundleManager — bundled TS/JS LSP + on-demand download for Python/Rust/Go.
 * TS: ships via npm dependency (typescript-language-server + typescript).
 * Others: download to <userData>/lsp/<lang>/ on first project open.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

const DOWNLOAD_DEFS = {
  python: {
    npmPackage: 'pyright',
    binName: process.platform === 'win32' ? 'pyright-langserver.cmd' : 'pyright-langserver',
    npmBin: process.platform === 'win32' ? 'pyright-langserver.cmd' : 'pyright-langserver',
  },
  rust: {
    githubRepo: 'rust-lang/rust-analyzer',
    assetPattern: (platform, arch) => {
      if (platform === 'win32') return 'rust-analyzer-x86_64-pc-windows-msvc.zip';
      if (platform === 'darwin') return arch === 'arm64' ? 'rust-analyzer-aarch64-apple-darwin.zip' : 'rust-analyzer-x86_64-apple-darwin.zip';
      return 'rust-analyzer-x86_64-unknown-linux-gnu.gz';
    },
    binName: process.platform === 'win32' ? 'rust-analyzer.exe' : 'rust-analyzer',
  },
  go: {
    goPackage: 'golang.org/x/tools/gopls@latest',
    binName: process.platform === 'win32' ? 'gopls.exe' : 'gopls',
  },
  yaml: {
    npmPackage: 'yaml-language-server',
    binName: process.platform === 'win32' ? 'yaml-language-server.cmd' : 'yaml-language-server',
    npmBin: process.platform === 'win32' ? 'yaml-language-server.cmd' : 'yaml-language-server',
  },
};

class LspBundleManager {
  constructor(userDataPath) {
    this.userDataPath = userDataPath;
    this.lspDir = path.join(userDataPath, 'lsp');
    this._status = {};
    this._downloading = new Map();
  }

  _appRoots() {
    const roots = [];
    try {
      if (process.resourcesPath) {
        roots.push(path.join(process.resourcesPath, 'app.asar.unpacked'));
        roots.push(path.join(process.resourcesPath, 'app'));
      }
    } catch (_) {}
    try {
      const { app } = require('electron');
      if (app?.getAppPath) roots.push(app.getAppPath());
    } catch (_) {
      roots.push(path.dirname(__dirname));
    }
    roots.push(path.dirname(__dirname));
    return [...new Set(roots)];
  }

  _resolveBundledBin(binName) {
    const isWin = process.platform === 'win32';
    const names = [binName, isWin && !binName.endsWith('.cmd') ? `${binName}.cmd` : binName].filter(Boolean);
    for (const root of this._appRoots()) {
      for (const name of names) {
        const p = path.join(root, 'node_modules', '.bin', name);
        if (fs.existsSync(p)) return p;
      }
    }
    return null;
  }

  getTypescriptCommand() {
    const bundled = this._resolveBundledBin('typescript-language-server');
    if (bundled) {
      this._status.typescript = { installed: true, bundled: true, path: bundled };
      return { command: bundled, args: ['--stdio'], bundled: true };
    }
    const fallback = process.platform === 'win32' ? 'typescript-language-server.cmd' : 'typescript-language-server';
    this._status.typescript = { installed: false, bundled: false, path: fallback, note: 'Install typescript-language-server or rebuild app with bundled deps' };
    return { command: fallback, args: ['--stdio'], bundled: false };
  }

  _langDir(key) {
    return path.join(this.lspDir, key);
  }

  _npmInstallPrefix(prefixDir, pkg) {
    fs.mkdirSync(prefixDir, { recursive: true });
    execSync(`npm install ${pkg} --prefix "${prefixDir}" --no-save --no-audit --no-fund`, {
      timeout: 180000,
      stdio: 'pipe',
      env: { ...process.env, npm_config_optional: 'false' },
    });
  }

  _downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      https.get(url, { headers: { 'User-Agent': 'guIDE-lsp-downloader' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlink(dest, () => {});
          return this._downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(dest, () => {});
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
      }).on('error', reject);
    });
  }

  async _fetchLatestRelease(repo) {
    const url = `https://api.github.com/repos/${repo}/releases/latest`;
    const body = await new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'guIDE-lsp-downloader' } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
    return body;
  }

  async _ensurePython() {
    const dir = this._langDir('python');
    const bin = path.join(dir, 'node_modules', '.bin', DOWNLOAD_DEFS.python.npmBin);
    if (fs.existsSync(bin)) {
      this._status.python = { installed: true, path: bin };
      return { command: bin, args: ['--stdio'], bundled: true };
    }
    if (this._downloading.has('python')) return this._downloading.get('python');
    const p = (async () => {
      fs.mkdirSync(dir, { recursive: true });
      this._npmInstallPrefix(dir, 'pyright');
      if (!fs.existsSync(bin)) throw new Error('pyright-langserver not found after install');
      this._status.python = { installed: true, path: bin };
      return { command: bin, args: ['--stdio'], bundled: true };
    })();
    this._downloading.set('python', p);
    try { return await p; } finally { this._downloading.delete('python'); }
  }

  async _ensureRust() {
    const dir = this._langDir('rust');
    const binPath = path.join(dir, DOWNLOAD_DEFS.rust.binName);
    if (fs.existsSync(binPath)) {
      this._status.rust = { installed: true, path: binPath };
      return { command: binPath, args: [], bundled: true };
    }
    if (this._downloading.has('rust')) return this._downloading.get('rust');
    const p = (async () => {
      fs.mkdirSync(dir, { recursive: true });
      const release = await this._fetchLatestRelease(DOWNLOAD_DEFS.rust.githubRepo);
      const pattern = DOWNLOAD_DEFS.rust.assetPattern(process.platform, process.arch);
      const asset = (release.assets || []).find((a) => a.name === pattern || a.name.includes('rust-analyzer'));
      if (!asset) throw new Error(`No rust-analyzer asset matching ${pattern}`);
      const archive = path.join(dir, asset.name);
      await this._downloadFile(asset.browser_download_url, archive);
      if (archive.endsWith('.zip')) {
        if (process.platform === 'win32') {
          execSync(`powershell -Command "Expand-Archive -Path '${archive}' -DestinationPath '${dir}' -Force"`, { timeout: 120000 });
        } else {
          execSync(`unzip -o "${archive}" -d "${dir}"`, { timeout: 120000 });
        }
      } else if (archive.endsWith('.gz')) {
        execSync(`gzip -dc "${archive}" > "${binPath}"`, { timeout: 120000, shell: true });
        fs.chmodSync(binPath, 0o755);
      }
      if (!fs.existsSync(binPath)) {
        const found = execSync(`find "${dir}" -name rust-analyzer* -type f 2>/dev/null || dir /s /b "${dir}\\rust-analyzer*" 2>nul`, { encoding: 'utf8', shell: true }).trim().split('\n')[0];
        if (found && fs.existsSync(found.trim())) {
          fs.copyFileSync(found.trim(), binPath);
        }
      }
      if (!fs.existsSync(binPath)) throw new Error('rust-analyzer binary not found after extract');
      this._status.rust = { installed: true, path: binPath };
      return { command: binPath, args: [], bundled: true };
    })();
    this._downloading.set('rust', p);
    try { return await p; } finally { this._downloading.delete('rust'); }
  }

  async _ensureGo() {
    const dir = this._langDir('go');
    const binPath = path.join(dir, 'bin', DOWNLOAD_DEFS.go.binName);
    if (fs.existsSync(binPath)) {
      this._status.go = { installed: true, path: binPath };
      return { command: binPath, args: ['serve'], bundled: true };
    }
    if (this._downloading.has('go')) return this._downloading.get('go');
    const p = (async () => {
      fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
      try {
        execSync(`go install ${DOWNLOAD_DEFS.go.goPackage}`, {
          timeout: 300000,
          env: { ...process.env, GOBIN: path.join(dir, 'bin'), GOPATH: path.join(dir, 'go-path') },
          stdio: 'pipe',
        });
      } catch (e) {
        throw new Error(`gopls install failed (is Go installed?): ${e.message}`);
      }
      if (!fs.existsSync(binPath)) throw new Error('gopls not found after go install');
      this._status.go = { installed: true, path: binPath };
      return { command: binPath, args: ['serve'], bundled: true };
    })();
    this._downloading.set('go', p);
    try { return await p; } finally { this._downloading.delete('go'); }
  }

  async _ensureYaml() {
    const dir = this._langDir('yaml');
    const bin = path.join(dir, 'node_modules', '.bin', DOWNLOAD_DEFS.yaml.npmBin);
    if (fs.existsSync(bin)) {
      this._status.yaml = { installed: true, path: bin };
      return { command: bin, args: ['--stdio'], bundled: true };
    }
    if (this._downloading.has('yaml')) return this._downloading.get('yaml');
    const p = (async () => {
      fs.mkdirSync(dir, { recursive: true });
      this._npmInstallPrefix(dir, 'yaml-language-server');
      if (!fs.existsSync(bin)) throw new Error('yaml-language-server not found after install');
      this._status.yaml = { installed: true, path: bin };
      return { command: bin, args: ['--stdio'], bundled: true };
    })();
    this._downloading.set('yaml', p);
    try { return await p; } finally { this._downloading.delete('yaml'); }
  }

  /** Sync resolve for typescript; async for downloadable langs */
  getCommand(key) {
    if (key === 'typescript') return this.getTypescriptCommand();
    const localBin = this._resolveLocal(key);
    if (localBin) return { command: localBin.command, args: localBin.args, bundled: true };
    const def = DOWNLOAD_DEFS[key];
    if (!def) return null;
    const fallback = def.binName;
    return { command: fallback, args: key === 'go' ? ['serve'] : (key === 'python' || key === 'yaml') ? ['--stdio'] : [], bundled: false };
  }

  _resolveLocal(key) {
    if (key === 'python') {
      const bin = path.join(this._langDir('python'), 'node_modules', '.bin', DOWNLOAD_DEFS.python.npmBin);
      if (fs.existsSync(bin)) return { command: bin, args: ['--stdio'] };
    }
    if (key === 'rust') {
      const bin = path.join(this._langDir('rust'), DOWNLOAD_DEFS.rust.binName);
      if (fs.existsSync(bin)) return { command: bin, args: [] };
    }
    if (key === 'go') {
      const bin = path.join(this._langDir('go'), 'bin', DOWNLOAD_DEFS.go.binName);
      if (fs.existsSync(bin)) return { command: bin, args: ['serve'] };
    }
    if (key === 'yaml') {
      const bin = path.join(this._langDir('yaml'), 'node_modules', '.bin', DOWNLOAD_DEFS.yaml.npmBin);
      if (fs.existsSync(bin)) return { command: bin, args: ['--stdio'] };
    }
    return null;
  }

  async ensureLanguage(key) {
    if (key === 'typescript') return this.getTypescriptCommand();
    if (key === 'python') return this._ensurePython();
    if (key === 'rust') return this._ensureRust();
    if (key === 'go') return this._ensureGo();
    if (key === 'yaml') return this._ensureYaml();
    return null;
  }

  getStatus() {
    const status = { ...this._status };
    for (const key of ['typescript', 'python', 'rust', 'go', 'yaml']) {
      if (!status[key]) {
        const local = this._resolveLocal(key);
        if (local) status[key] = { installed: true, path: local.command };
        else if (key === 'typescript') {
          const bundled = this._resolveBundledBin('typescript-language-server');
          status[key] = bundled
            ? { installed: true, bundled: true, path: bundled }
            : { installed: false, bundled: false };
        } else {
          status[key] = { installed: false, bundled: false };
        }
      }
    }
    return status;
  }
}

module.exports = { LspBundleManager, DOWNLOAD_DEFS };

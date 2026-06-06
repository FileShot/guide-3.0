'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execFileSync } = require('child_process');
const { validateTorBrowserPath } = require('./geckodriverResolver');
const { redactPathForLog } = require('./refUtils');

/** Pin to a version compatible with geckodriver 0.36.x (Firefox ESR 128+) */
const TOR_BROWSER_VERSION = '14.5.8';

const TOR_DOWNLOAD = {
  win32: {
    file: (v) => `tor-browser-windows-x86_64-portable-${v}.exe`,
    url: (v) => `https://archive.torproject.org/tor-package-archive/torbrowser/${v}/tor-browser-windows-x86_64-portable-${v}.exe`,
  },
  linux: {
    file: (v) => `tor-browser-linux-x86_64-${v}.tar.xz`,
    url: (v) => `https://archive.torproject.org/tor-package-archive/torbrowser/${v}/tor-browser-linux-x86_64-${v}.tar.xz`,
  },
};

function getManagedTorRoot(userDataPath) {
  const base = userDataPath || path.join(process.env.APPDATA || os.homedir(), 'guide-ide');
  return path.join(base, 'tor-browser');
}

function firefoxBinaryName() {
  return process.platform === 'win32' ? 'firefox.exe' : 'firefox';
}

function isTorFirefoxBinary(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  const base = path.basename(filePath).toLowerCase();
  if (process.platform === 'win32') return base === 'firefox.exe';
  if (process.platform === 'linux') return base === 'firefox' || base === 'firefox.real';
  return base === 'firefox' || filePath.includes('Tor Browser.app');
}

function findFirefoxInTree(rootDir, depth = 0) {
  if (!rootDir || depth > 8 || !fs.existsSync(rootDir)) return null;
  const direct = path.join(rootDir, 'Browser', firefoxBinaryName());
  if (isTorFirefoxBinary(direct)) return direct;
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = findFirefoxInTree(path.join(rootDir, entry.name), depth + 1);
    if (nested) return nested;
  }
  return null;
}

function discoverTorBrowserPaths(userDataPath) {
  const candidates = [];
  const home = os.homedir();
  const managedRoot = getManagedTorRoot(userDataPath);

  if (process.platform === 'win32') {
    candidates.push(
      path.join(managedRoot, 'Tor Browser', 'Browser', 'firefox.exe'),
      path.join(home, 'Desktop', 'Tor Browser', 'Browser', 'firefox.exe'),
      path.join(home, 'Downloads', 'Tor Browser', 'Browser', 'firefox.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Tor Browser', 'Browser', 'firefox.exe'),
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Tor Browser', 'Browser', 'firefox.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Tor Browser', 'Browser', 'firefox.exe'),
    );
    for (const base of [path.join(home, 'Desktop'), path.join(home, 'Downloads'), home]) {
      try {
        for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
          if (!entry.isDirectory() || !/^Tor Browser/i.test(entry.name)) continue;
          candidates.push(path.join(base, entry.name, 'Browser', 'firefox.exe'));
        }
      } catch {}
    }
  } else if (process.platform === 'linux') {
    candidates.push(
      path.join(managedRoot, 'tor-browser', 'Browser', 'firefox'),
      path.join(managedRoot, 'Tor Browser', 'Browser', 'firefox'),
      path.join(home, 'tor-browser', 'Browser', 'firefox'),
      path.join(home, 'Tor Browser', 'Browser', 'firefox'),
      path.join(home, '.local', 'share', 'tor-browser', 'Browser', 'firefox'),
      '/usr/lib/tor-browser/Browser/firefox',
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      path.join(managedRoot, 'Tor Browser.app', 'Contents', 'MacOS', 'firefox'),
      '/Applications/Tor Browser.app/Contents/MacOS/firefox',
      path.join(home, 'Applications', 'Tor Browser.app/Contents/MacOS/firefox'),
    );
  }

  const seen = new Set();
  const valid = [];
  for (const candidate of candidates) {
    const norm = path.normalize(candidate);
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (isTorFirefoxBinary(norm)) valid.push(norm);
  }
  return valid;
}

function discoverTorBrowserPath(userDataPath) {
  return discoverTorBrowserPaths(userDataPath)[0] || null;
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        try { fs.unlinkSync(destPath); } catch {}
        return downloadFile(res.headers.location, destPath, onProgress).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(destPath); } catch {}
        return reject(new Error(`HTTP ${res.statusCode} downloading Tor Browser`));
      }
      const total = Number(res.headers['content-length']) || 0;
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress && total > 0) onProgress(Math.round((received / total) * 100));
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(destPath)));
    }).on('error', (err) => {
      try { fs.unlinkSync(destPath); } catch {}
      reject(err);
    });
  });
}

function get7zaPath() {
  try {
    return require('7zip-bin').path7za;
  } catch {
    return '7z';
  }
}

function extractArchive(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (archivePath.endsWith('.exe')) {
    const sevenZip = get7zaPath();
    console.log(`[TorBrowserBackend] tor extract: 7z x ${path.basename(archivePath)}`);
    execFileSync(sevenZip, ['x', archivePath, `-o${destDir}`, '-y'], { stdio: 'pipe', windowsHide: true });
    return;
  }
  if (archivePath.endsWith('.tar.xz') || archivePath.endsWith('.tar.gz')) {
    execFileSync('tar', ['-xf', archivePath, '-C', destDir], { stdio: 'pipe' });
    return;
  }
  throw new Error(`Unsupported Tor Browser archive: ${archivePath}`);
}

async function downloadTorBrowser(userDataPath) {
  const platform = process.platform;
  const spec = TOR_DOWNLOAD[platform];
  if (!spec) {
    return {
      success: false,
      error: 'Automatic Tor Browser download is not supported on this platform yet. Install Tor Browser manually or set an override path in Settings.',
    };
  }

  const root = getManagedTorRoot(userDataPath);
  fs.mkdirSync(root, { recursive: true });
  const archiveName = spec.file(TOR_BROWSER_VERSION);
  const archivePath = path.join(root, archiveName);
  const extractDir = path.join(root, '_extract');
  const url = spec.url(TOR_BROWSER_VERSION);

  console.log(`[TorBrowserBackend] tor resolve: download START v${TOR_BROWSER_VERSION}`);
  try {
    if (!fs.existsSync(archivePath)) {
      await downloadFile(url, archivePath, (pct) => {
        if (pct % 20 === 0) console.log(`[TorBrowserBackend] tor download: ${pct}%`);
      });
    } else {
      console.log('[TorBrowserBackend] tor resolve: using cached installer archive');
    }

    fs.rmSync(extractDir, { recursive: true, force: true });
    extractArchive(archivePath, extractDir);

    const firefoxPath = findFirefoxInTree(extractDir);
    if (!firefoxPath) {
      return { success: false, error: 'Tor Browser downloaded but firefox binary not found after extract' };
    }

    console.log(`[TorBrowserBackend] tor resolve: download DONE ${redactPathForLog(firefoxPath)}`);
    return {
      success: true,
      path: firefoxPath,
      source: 'downloaded',
      version: TOR_BROWSER_VERSION,
    };
  } catch (e) {
    console.error(`[TorBrowserBackend] tor download FAILED: ${e.message}`);
    return {
      success: false,
      error: `Could not download Tor Browser automatically (${e.message}). Install from torproject.org or set path in Settings → Browser.`,
      diagnosticHint: 'See guide-main.log for [TorBrowserBackend] tor download FAILED',
    };
  }
}

let _resolvePromise = null;

/**
 * Resolve Tor Browser executable: user override → auto-discover → auto-download.
 */
async function resolveTorBrowserExecutable({ configuredPath, userDataPath, autoDownload = true } = {}) {
  const manual = validateTorBrowserPath(configuredPath);
  if (manual.pathValid) {
    console.log(`[TorBrowserBackend] tor resolve: configured ${redactPathForLog(manual.normalizedPath)}`);
    return { success: true, path: manual.normalizedPath, source: 'configured', pathValid: true };
  }

  const discovered = discoverTorBrowserPath(userDataPath);
  if (discovered) {
    console.log(`[TorBrowserBackend] tor resolve: discovered ${redactPathForLog(discovered)}`);
    return { success: true, path: discovered, source: 'discovered', pathValid: true };
  }

  if (!autoDownload) {
    return {
      success: false,
      pathValid: false,
      error: 'Tor Browser not found on this system.',
    };
  }

  if (!_resolvePromise) {
    _resolvePromise = downloadTorBrowser(userDataPath).finally(() => {
      _resolvePromise = null;
    });
  }
  const result = await _resolvePromise;
  return { ...result, pathValid: !!result.path };
}

module.exports = {
  TOR_BROWSER_VERSION,
  discoverTorBrowserPath,
  discoverTorBrowserPaths,
  resolveTorBrowserExecutable,
  getManagedTorRoot,
};

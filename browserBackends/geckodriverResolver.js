'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const os = require('os');

const DEFAULT_GECKODRIVER_VERSION = '0.36.0';

const PLATFORM_ASSET = {
  win32: 'win64.zip',
  linux: 'linux64.tar.gz',
  darwin: 'macos.tar.gz',
};

function getCacheRoot(userDataPath) {
  const base = userDataPath || path.join(process.env.APPDATA || os.homedir(), 'guide-ide');
  return path.join(base, 'geckodriver');
}

function geckodriverBinaryName() {
  return process.platform === 'win32' ? 'geckodriver.exe' : 'geckodriver';
}

function getBundledGeckodriverNearTor(torBrowserPath) {
  if (!torBrowserPath) return null;
  const browserDir = path.dirname(torBrowserPath);
  const candidates = [
    path.join(browserDir, geckodriverBinaryName()),
    path.join(browserDir, '..', geckodriverBinaryName()),
    path.join(browserDir, 'geckodriver', geckodriverBinaryName()),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function getCachedGeckodriver(userDataPath, version = DEFAULT_GECKODRIVER_VERSION) {
  const cached = path.join(getCacheRoot(userDataPath), version, geckodriverBinaryName());
  return fs.existsSync(cached) ? cached : null;
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        return reject(new Error(`HTTP ${res.statusCode} downloading geckodriver`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(destPath)));
    }).on('error', (err) => {
      try { fs.unlinkSync(destPath); } catch {}
      reject(err);
    });
  });
}

function extractArchive(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (archivePath.endsWith('.zip')) {
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ], { stdio: 'pipe', windowsHide: true });
    return;
  }
  execFileSync('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'pipe' });
}

function findExtractedBinary(rootDir) {
  const name = geckodriverBinaryName();
  const direct = path.join(rootDir, name);
  if (fs.existsSync(direct)) return direct;
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const nested = path.join(rootDir, entry.name, name);
      if (fs.existsSync(nested)) return nested;
    }
  }
  return null;
}

async function downloadGeckodriver(userDataPath, version = DEFAULT_GECKODRIVER_VERSION) {
  const platform = process.platform;
  const assetSuffix = PLATFORM_ASSET[platform];
  if (!assetSuffix) {
    return { success: false, error: `geckodriver auto-download not supported on ${platform}` };
  }
  const cacheDir = path.join(getCacheRoot(userDataPath), version);
  fs.mkdirSync(cacheDir, { recursive: true });
  const archivePath = path.join(cacheDir, `geckodriver-${assetSuffix}`);
  const url = `https://github.com/mozilla/geckodriver/releases/download/v${version}/geckodriver-v${version}-${assetSuffix}`;
  console.log(`[TorBrowserBackend] geckodriver resolve: cache miss, downloading v${version}`);
  try {
    await downloadFile(url, archivePath);
    const extractDir = path.join(cacheDir, '_extract');
    fs.rmSync(extractDir, { recursive: true, force: true });
    extractArchive(archivePath, extractDir);
    const binary = findExtractedBinary(extractDir);
    if (!binary) {
      return { success: false, error: 'geckodriver binary not found after extract' };
    }
    const dest = path.join(cacheDir, geckodriverBinaryName());
    fs.copyFileSync(binary, dest);
    if (platform !== 'win32') fs.chmodSync(dest, 0o755);
    try { fs.unlinkSync(archivePath); } catch {}
    console.log(`[TorBrowserBackend] geckodriver resolve: downloaded to ${dest}`);
    return { success: true, path: dest, version, source: 'download' };
  } catch (e) {
    console.error(`[TorBrowserBackend] geckodriver download FAILED: ${e.message}`);
    return { success: false, error: e.message };
  }
}

async function resolveGeckodriver({ userDataPath, torBrowserPath, geckodriverPath, version = DEFAULT_GECKODRIVER_VERSION } = {}) {
  if (geckodriverPath && fs.existsSync(geckodriverPath)) {
    console.log('[TorBrowserBackend] geckodriver resolve: user override');
    return { success: true, path: geckodriverPath, version: 'override', source: 'override' };
  }

  const bundled = getBundledGeckodriverNearTor(torBrowserPath);
  if (bundled) {
    console.log('[TorBrowserBackend] geckodriver resolve: bundled near Tor Browser');
    return { success: true, path: bundled, version, source: 'bundled' };
  }

  const cached = getCachedGeckodriver(userDataPath, version);
  if (cached) {
    console.log('[TorBrowserBackend] geckodriver resolve: cache hit');
    return { success: true, path: cached, version, source: 'cache' };
  }

  return downloadGeckodriver(userDataPath, version);
}

function validateTorBrowserPath(torBrowserPath) {
  if (!torBrowserPath || !String(torBrowserPath).trim()) {
    return { pathValid: false, error: 'Tor Browser path not set' };
  }
  const normalized = path.normalize(String(torBrowserPath).trim());
  if (!fs.existsSync(normalized)) {
    return { pathValid: false, error: 'Tor Browser executable not found at configured path' };
  }
  const base = path.basename(normalized).toLowerCase();
  if (process.platform === 'win32' && base !== 'firefox.exe') {
    return { pathValid: false, error: 'Path must point to firefox.exe inside Tor Browser (Browser/firefox.exe)' };
  }
  if (process.platform === 'linux' && base !== 'firefox' && base !== 'firefox.real') {
    return { pathValid: false, error: 'Path must point to firefox inside Tor Browser' };
  }
  if (process.platform === 'darwin' && !normalized.includes('Firefox')) {
    return { pathValid: false, error: 'Path must point to Tor Browser Firefox.app binary' };
  }
  return { pathValid: true, normalizedPath: normalized };
}

module.exports = {
  DEFAULT_GECKODRIVER_VERSION,
  resolveGeckodriver,
  validateTorBrowserPath,
  getCachedGeckodriver,
};

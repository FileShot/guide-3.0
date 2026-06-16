'use strict';

const fs = require('fs');
const path = require('path');

const COMPONENT_IDS = {
  PLAYWRIGHT: 'playwright-chromium',
  SD_CUDA: 'sd-cpp-cuda',
  SD_CPU: 'sd-cpp-cpu',
  WHISPER: 'whisper',
};

function getComponentsRoot(userDataPath) {
  return path.join(userDataPath, 'components');
}

function getManifestPath(userDataPath) {
  return path.join(getComponentsRoot(userDataPath), 'manifest.json');
}

function getPlaywrightBrowsersDir(userDataPath) {
  return path.join(getComponentsRoot(userDataPath), 'playwright-browsers');
}

function getSdCppDir(userDataPath, variant) {
  const sub = variant === 'cuda' ? 'cuda' : 'cpu';
  return path.join(getComponentsRoot(userDataPath), 'sd-cpp', sub);
}

function getWhisperDir(userDataPath) {
  return path.join(getComponentsRoot(userDataPath), 'whisper');
}

function _dirHasChromium(browsersDir) {
  if (!browsersDir || !fs.existsSync(browsersDir)) return false;
  try {
    const entries = fs.readdirSync(browsersDir, { withFileTypes: true });
    return entries.some((e) => e.isDirectory() && /chromium/i.test(e.name));
  } catch {
    return false;
  }
}

function _dirHasSdExe(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  return fs.existsSync(path.join(dir, 'sd.exe')) || fs.existsSync(path.join(dir, 'sd'));
}

function _bundledPlaywrightDir(resourcesPath) {
  if (!resourcesPath) return null;
  const p = path.join(resourcesPath, 'playwright-browsers');
  return fs.existsSync(p) ? p : null;
}

function _bundledSdDir(resourcesPath, sub) {
  if (!resourcesPath) return null;
  const candidates = sub === 'cuda'
    ? [path.join(resourcesPath, 'sd-cpp'), path.join(resourcesPath, 'sd-cpp', 'win-x64-cuda')]
    : [path.join(resourcesPath, 'sd-cpp-cpu'), path.join(resourcesPath, 'sd-cpp'), path.join(resourcesPath, 'sd-cpp', 'win-x64-cpu')];
  for (const p of candidates) {
    if (_dirHasSdExe(p)) return p;
  }
  return null;
}

function _bundledWhisperDir(resourcesPath) {
  if (!resourcesPath) return null;
  const p = path.join(resourcesPath, 'whisper');
  return fs.existsSync(p) ? p : null;
}

/**
 * Resolve Playwright browsers directory — cache first, then legacy bundled path.
 */
function resolvePlaywrightBrowsersPath(userDataPath, resourcesPath) {
  const cached = getPlaywrightBrowsersDir(userDataPath);
  if (_dirHasChromium(cached)) return cached;
  const bundled = _bundledPlaywrightDir(resourcesPath);
  if (bundled && _dirHasChromium(bundled)) return bundled;
  return cached;
}

function isPlaywrightBrowsersReady(userDataPath, resourcesPath) {
  const dir = resolvePlaywrightBrowsersPath(userDataPath, resourcesPath);
  return _dirHasChromium(dir);
}

/**
 * Resolve sd-cpp binary directory — userData cache first, then bundled extraResources.
 */
function resolveSdCppDir(userDataPath, resourcesPath, variant = 'cuda') {
  const cached = getSdCppDir(userDataPath, variant);
  if (_dirHasSdExe(cached)) return cached;
  const bundled = _bundledSdDir(resourcesPath, variant);
  if (bundled) return bundled;
  return cached;
}

function isSdCppReady(userDataPath, resourcesPath, variant) {
  return _dirHasSdExe(resolveSdCppDir(userDataPath, resourcesPath, variant));
}

function resolveWhisperModelPath(userDataPath, resourcesPath) {
  const cached = path.join(getWhisperDir(userDataPath), 'ggml-base.en.bin');
  if (fs.existsSync(cached)) return cached;
  const bundledRoot = _bundledWhisperDir(resourcesPath);
  if (bundledRoot) {
    const bundled = path.join(bundledRoot, 'ggml-base.en.bin');
    if (fs.existsSync(bundled)) return bundled;
  }
  const legacy = path.join(userDataPath, 'whisper-models', 'ggml-base.en.bin');
  if (fs.existsSync(legacy)) return legacy;
  return cached;
}

function resolveWhisperCliPath(userDataPath, resourcesPath) {
  const isWin = process.platform === 'win32';
  const names = isWin ? ['whisper-cli.exe', 'whisper.exe', 'main.exe'] : ['whisper-cli', 'whisper', 'main'];
  const cachedRoot = getWhisperDir(userDataPath);
  for (const name of names) {
    const p = path.join(cachedRoot, name);
    if (fs.existsSync(p)) return p;
  }
  const bundledRoot = _bundledWhisperDir(resourcesPath);
  if (bundledRoot) {
    for (const name of names) {
      const p = path.join(bundledRoot, name);
      if (fs.existsSync(p)) return p;
    }
    const platDir = path.join(bundledRoot, isWin ? 'win32' : process.platform);
    for (const name of names) {
      const p = path.join(platDir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function isWhisperReady(userDataPath, resourcesPath) {
  return !!resolveWhisperCliPath(userDataPath, resourcesPath)
    && fs.existsSync(resolveWhisperModelPath(userDataPath, resourcesPath));
}

function catalogForVariant(installVariant) {
  const items = [
    { id: COMPONENT_IDS.PLAYWRIGHT, label: 'Browser tools', bytesEstimate: 350_000_000 },
    { id: COMPONENT_IDS.WHISPER, label: 'Voice transcription', bytesEstimate: 155_000_000 },
  ];
  if (installVariant === 'cuda') {
    items.push({ id: COMPONENT_IDS.SD_CUDA, label: 'Image generation (CUDA)', bytesEstimate: 250_000_000 });
    items.push({ id: COMPONENT_IDS.SD_CPU, label: 'Image generation (Vulkan)', bytesEstimate: 180_000_000 });
  } else {
    items.push({ id: COMPONENT_IDS.SD_CPU, label: 'Image generation', bytesEstimate: 180_000_000 });
  }
  return items;
}

module.exports = {
  COMPONENT_IDS,
  getComponentsRoot,
  getManifestPath,
  getPlaywrightBrowsersDir,
  getSdCppDir,
  getWhisperDir,
  resolvePlaywrightBrowsersPath,
  isPlaywrightBrowsersReady,
  resolveSdCppDir,
  isSdCppReady,
  resolveWhisperModelPath,
  resolveWhisperCliPath,
  isWhisperReady,
  catalogForVariant,
  _dirHasChromium,
  _dirHasSdExe,
};

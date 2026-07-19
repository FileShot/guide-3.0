'use strict';

const fs = require('fs');
const path = require('path');

const GITHUB_OWNER = 'FileShot';
const GITHUB_REPO = 'guide-3.0';

const FULL_IDENTITY = {
  edition: 'full',
  appId: 'com.guide-ide.desktop',
  productName: 'guIDE',
  userDataName: 'guide-ide',
  appUserModelId: 'com.guide-ide.desktop',
  tagline: null,
};

const LITE_IDENTITY = {
  edition: 'lite',
  appId: 'com.guide-ide.lite',
  productName: 'guIDE Lite',
  userDataName: 'guide-ide-lite',
  appUserModelId: 'com.guide-ide.lite',
  tagline: 'guIDE Minus — not Plus',
};

function _resourcesDir() {
  return process.resourcesPath || null;
}

function _readInstallManifest() {
  const resources = _resourcesDir();
  if (!resources) return null;
  const manifestPath = path.join(resources, 'install-variant.json');
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

/** Channel embedded by electron-builder into app-update.yml (cuda builds). */
function _readAppUpdateYmlChannel() {
  const resources = _resourcesDir();
  if (!resources) return null;
  const ymlPath = path.join(resources, 'app-update.yml');
  try {
    const text = fs.readFileSync(ymlPath, 'utf8');
    const match = text.match(/^channel:\s*(\S+)/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function _llamaBackendRoots() {
  const resources = _resourcesDir();
  if (!resources) return [];
  return [
    path.join(resources, 'app.asar.unpacked', 'node_modules', '@node-llama-cpp'),
    path.join(resources, 'app', 'node_modules', '@node-llama-cpp'),
  ];
}

function _hasCudaBackendBinaries() {
  const cudaNames = process.platform === 'win32'
    ? ['win-x64-cuda']
    : process.platform === 'linux'
      ? ['linux-x64-cuda']
      : [];
  for (const root of _llamaBackendRoots()) {
    for (const name of cudaNames) {
      if (fs.existsSync(path.join(root, name))) return true;
    }
  }
  return false;
}

/**
 * Product edition: full (bundled extras) or lite (add-on downloads).
 * @returns {'full' | 'lite'}
 */
function getInstallEdition() {
  const manifest = _readInstallManifest();
  if (manifest?.edition === 'lite') return 'lite';
  return 'full';
}

/**
 * Display / identity metadata for the running install.
 */
function getProductIdentity() {
  const manifest = _readInstallManifest();
  if (manifest?.edition === 'lite') {
    return {
      ...LITE_IDENTITY,
      appId: manifest.appId || LITE_IDENTITY.appId,
      productName: manifest.productName || LITE_IDENTITY.productName,
      userDataName: manifest.userDataName || LITE_IDENTITY.userDataName,
      appUserModelId: manifest.appUserModelId || LITE_IDENTITY.appUserModelId,
      tagline: manifest.tagline || LITE_IDENTITY.tagline,
    };
  }
  return { ...FULL_IDENTITY };
}

/**
 * Apply Lite vs Full identity before any userData path is read.
 * Call once at process start (packaged Lite must not share Full AppData).
 * @param {import('electron').App} electronApp
 */
function applyProductIdentity(electronApp) {
  const identity = getProductIdentity();
  if (identity.edition === 'lite') {
    try {
      electronApp.setName(identity.userDataName);
    } catch (_) {}
    try {
      const appData = electronApp.getPath('appData');
      electronApp.setPath('userData', path.join(appData, identity.userDataName));
    } catch (_) {}
  }
  if (process.platform === 'win32') {
    try {
      electronApp.setAppUserModelId(identity.appUserModelId);
    } catch (_) {}
  }
  return identity;
}

/**
 * Installed GPU variant: cpu (Vulkan/CPU inference) or cuda (NVIDIA CUDA).
 * Priority: build manifest → app-update.yml channel → bundled CUDA binaries.
 * @returns {'cuda' | 'cpu'}
 */
function getInstallVariant() {
  const manifest = _readInstallManifest();
  if (manifest?.gpuBackend === 'cuda' || manifest?.gpuBackend === 'cpu') {
    return manifest.gpuBackend;
  }
  if (manifest?.variant === 'cuda' || manifest?.variant === 'cpu') {
    return manifest.variant;
  }

  const ymlChannel = _readAppUpdateYmlChannel();
  if (ymlChannel === 'cuda' || ymlChannel === 'lite-cuda') return 'cuda';

  if (_hasCudaBackendBinaries()) return 'cuda';
  return 'cpu';
}

/**
 * electron-updater channel.
 * null / unset → latest.yml (CPU). 'cuda' → cuda.yml. 'lite-cuda' → lite-cuda.yml.
 * @returns {string|null}
 */
function getUpdateChannel() {
  const manifest = _readInstallManifest();
  if (manifest?.channel && manifest.channel !== 'latest') {
    return manifest.channel;
  }
  if (manifest?.edition === 'lite' && getInstallVariant() === 'cuda') return 'lite-cuda';
  if (manifest?.variant === 'cuda') return 'cuda';

  const ymlChannel = _readAppUpdateYmlChannel();
  if (ymlChannel) return ymlChannel;

  return getInstallVariant() === 'cuda' ? 'cuda' : null;
}

/** Reject feed artifacts that do not match this install. */
function isUpdateArtifactCompatible(updateInfo, installVariant = getInstallVariant()) {
  if (!updateInfo) return true;
  const names = [];
  if (typeof updateInfo.path === 'string') names.push(updateInfo.path);
  if (Array.isArray(updateInfo.files)) {
    for (const f of updateInfo.files) {
      if (f?.url) names.push(f.url);
    }
  }
  const blob = names.join(' ').toLowerCase();
  if (!blob) return true;

  const edition = getInstallEdition();
  const looksLite = blob.includes('-lite-');
  if (edition === 'lite' && !looksLite && (blob.includes('-cuda-') || blob.includes('-cpu-'))) {
    return false;
  }
  if (edition === 'full' && looksLite) return false;

  const looksCpu = blob.includes('-cpu-');
  const looksCuda = blob.includes('-cuda-');
  if (installVariant === 'cuda' && looksCpu && !looksCuda) return false;
  if (installVariant === 'cpu' && looksCuda && !looksCpu) return false;
  return true;
}

function getGithubFeedConfig() {
  return {
    provider: 'github',
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
  };
}

module.exports = {
  GITHUB_OWNER,
  GITHUB_REPO,
  FULL_IDENTITY,
  LITE_IDENTITY,
  getInstallEdition,
  getProductIdentity,
  applyProductIdentity,
  getInstallVariant,
  getUpdateChannel,
  getGithubFeedConfig,
  isUpdateArtifactCompatible,
};

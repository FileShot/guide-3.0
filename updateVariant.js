'use strict';

const fs = require('fs');
const path = require('path');

const GITHUB_OWNER = 'FileShot';
const GITHUB_REPO = 'guide-3.0';

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
 * Installed variant: cpu (Vulkan/CPU inference) or cuda (NVIDIA CUDA).
 * Priority: build manifest → app-update.yml channel → bundled CUDA binaries.
 * @returns {'cuda' | 'cpu'}
 */
function getInstallVariant() {
  const manifest = _readInstallManifest();
  if (manifest?.variant === 'cuda' || manifest?.variant === 'cpu') {
    return manifest.variant;
  }

  const ymlChannel = _readAppUpdateYmlChannel();
  if (ymlChannel === 'cuda') return 'cuda';

  if (_hasCudaBackendBinaries()) return 'cuda';
  return 'cpu';
}

/**
 * electron-updater channel.
 * null / unset → latest.yml (CPU). 'cuda' → cuda.yml / cuda-linux.yml.
 * @returns {string|null}
 */
function getUpdateChannel() {
  const manifest = _readInstallManifest();
  if (manifest?.channel && manifest.channel !== 'latest') {
    return manifest.channel;
  }
  if (manifest?.variant === 'cuda') return 'cuda';

  const ymlChannel = _readAppUpdateYmlChannel();
  if (ymlChannel) return ymlChannel;

  return getInstallVariant() === 'cuda' ? 'cuda' : null;
}

/** Reject feed artifacts that do not match this install (e.g. CPU update on CUDA install). */
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
  getInstallVariant,
  getUpdateChannel,
  getGithubFeedConfig,
  isUpdateArtifactCompatible,
};

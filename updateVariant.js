'use strict';

const fs = require('fs');
const path = require('path');

const GITHUB_OWNER = 'FileShot';
const GITHUB_REPO = 'guide-3.0';

/**
 * Detect packaged install variant (cpu vs cuda) from bundled llama backends.
 * @returns {'cuda' | 'cpu'}
 */
function getInstallVariant() {
  if (!process.resourcesPath) return 'cpu';
  const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@node-llama-cpp');
  const cudaNames = process.platform === 'win32'
    ? ['win-x64-cuda']
    : process.platform === 'linux'
      ? ['linux-x64-cuda']
      : [];
  for (const name of cudaNames) {
    if (fs.existsSync(path.join(unpacked, name))) return 'cuda';
  }
  return 'cpu';
}

/** electron-updater channel: null/default for cpu, 'cuda' for cuda builds. */
function getUpdateChannel() {
  return getInstallVariant() === 'cuda' ? 'cuda' : null;
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
};

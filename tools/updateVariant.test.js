'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  getInstallEdition,
  getProductIdentity,
  getInstallVariant,
  getUpdateChannel,
  isUpdateArtifactCompatible,
  LITE_IDENTITY,
  FULL_IDENTITY,
} = require('../updateVariant');

const tmp = path.join(os.tmpdir(), `guide-variant-${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });

// Without packaged resources → full defaults
assert.strictEqual(getInstallEdition(), 'full');
assert.strictEqual(getProductIdentity().userDataName, FULL_IDENTITY.userDataName);

// Simulate Lite manifest via process.resourcesPath override is hard; test identity constants + helpers.
assert.strictEqual(LITE_IDENTITY.edition, 'lite');
assert.strictEqual(LITE_IDENTITY.appId, 'com.guide-ide.lite');
assert.strictEqual(LITE_IDENTITY.userDataName, 'guide-ide-lite');
assert.ok(LITE_IDENTITY.tagline.includes('Minus'));

const resources = path.join(tmp, 'resources');
fs.mkdirSync(resources, { recursive: true });
fs.writeFileSync(path.join(resources, 'install-variant.json'), JSON.stringify({
  variant: 'cuda',
  edition: 'lite',
  channel: 'lite-cuda',
  gpuBackend: 'cuda',
  userDataName: 'guide-ide-lite',
}));

const origResources = process.resourcesPath;
Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true });

assert.strictEqual(getInstallEdition(), 'lite');
assert.strictEqual(getInstallVariant(), 'cuda');
assert.strictEqual(getUpdateChannel(), 'lite-cuda');
assert.strictEqual(getProductIdentity().productName, 'guIDE Lite');

assert.strictEqual(
  isUpdateArtifactCompatible({ path: 'guIDE-0.4.82-lite-cuda-x64-setup.exe' }, 'cuda'),
  true,
);
assert.strictEqual(
  isUpdateArtifactCompatible({ path: 'guIDE-0.4.82-cuda-x64-setup.exe' }, 'cuda'),
  false,
);

Object.defineProperty(process, 'resourcesPath', { value: origResources, configurable: true });

// Full must reject lite artifacts when edition is full (no lite manifest)
assert.strictEqual(getInstallEdition(), 'full');
assert.strictEqual(
  isUpdateArtifactCompatible({ path: 'guIDE-0.4.82-lite-cuda-x64-setup.exe' }, 'cuda'),
  false,
);

console.log('PASS updateVariant lite identity + channel guards');
console.log('updateVariant.test.js: all passed');

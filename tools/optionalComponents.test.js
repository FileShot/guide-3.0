'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  COMPONENT_IDS,
  getComponentsRoot,
  getManifestPath,
  getPlaywrightBrowsersDir,
  getSdCppDir,
  resolvePlaywrightBrowsersPath,
  resolveSdCppDir,
  resolveWhisperModelPath,
  catalogForVariant,
  isPlaywrightBrowsersReady,
  isSdCppReady,
} = require('../optionalComponentPaths');

const tmp = path.join(os.tmpdir(), `guide-opt-components-${Date.now()}`);
const userData = path.join(tmp, 'user');
const resources = path.join(tmp, 'resources');
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(resources, { recursive: true });

// Manifest path
assert.strictEqual(getManifestPath(userData), path.join(userData, 'components', 'manifest.json'));
assert.strictEqual(getComponentsRoot(userData), path.join(userData, 'components'));

// Catalog per variant
const cudaCatalog = catalogForVariant('cuda');
const cpuCatalog = catalogForVariant('cpu');
assert.ok(cudaCatalog.some((c) => c.id === COMPONENT_IDS.SD_CUDA));
assert.ok(cudaCatalog.some((c) => c.id === COMPONENT_IDS.SD_CPU));
assert.ok(!cpuCatalog.some((c) => c.id === COMPONENT_IDS.SD_CUDA));
assert.ok(cpuCatalog.some((c) => c.id === COMPONENT_IDS.SD_CPU));
assert.ok(cudaCatalog.some((c) => c.id === COMPONENT_IDS.PLAYWRIGHT));
assert.ok(cudaCatalog.some((c) => c.id === COMPONENT_IDS.WHISPER));

// userData cache preferred over bundled resources
const bundledBrowsers = path.join(resources, 'playwright-browsers', 'chromium-1234');
fs.mkdirSync(bundledBrowsers, { recursive: true });
const cachedBrowsers = path.join(getPlaywrightBrowsersDir(userData), 'chromium-9999');
fs.mkdirSync(cachedBrowsers, { recursive: true });
assert.strictEqual(
  resolvePlaywrightBrowsersPath(userData, resources),
  getPlaywrightBrowsersDir(userData),
);
assert.ok(isPlaywrightBrowsersReady(userData, resources));

const bundledSd = path.join(resources, 'sd-cpp');
fs.mkdirSync(bundledSd, { recursive: true });
fs.writeFileSync(path.join(bundledSd, 'sd.exe'), 'fake');
const cachedSdCuda = getSdCppDir(userData, 'cuda');
fs.mkdirSync(cachedSdCuda, { recursive: true });
fs.writeFileSync(path.join(cachedSdCuda, 'sd.exe'), 'cached');
assert.strictEqual(resolveSdCppDir(userData, resources, 'cuda'), cachedSdCuda);
assert.ok(isSdCppReady(userData, resources, 'cuda'));

// Whisper model path prefers cache
const whisperDir = path.join(userData, 'components', 'whisper');
fs.mkdirSync(whisperDir, { recursive: true });
const cachedModel = path.join(whisperDir, 'ggml-base.en.bin');
fs.writeFileSync(cachedModel, 'model');
assert.strictEqual(resolveWhisperModelPath(userData, resources), cachedModel);

// Footer status normalizer (inline mirror of frontend helper)
function normalizeComponentBundleStatus(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return {
    phase: payload.phase || 'idle',
    label: payload.label || 'Optional components',
    percent: typeof payload.percent === 'number' ? payload.percent : 0,
    currentComponentLabel: payload.currentComponentLabel || null,
    needsRestart: !!payload.needsRestart,
    error: payload.error || null,
  };
}

const normalized = normalizeComponentBundleStatus({
  phase: 'downloading',
  percent: 42,
  currentComponentLabel: 'Browser tools',
});
assert.strictEqual(normalized.phase, 'downloading');
assert.strictEqual(normalized.percent, 42);
assert.strictEqual(normalized.currentComponentLabel, 'Browser tools');
assert.strictEqual(normalizeComponentBundleStatus(null), null);

// OptionalComponentsManager manifest round-trip
const { OptionalComponentsManager } = require('../optionalComponentsManager');
const settingsStub = {
  _data: {},
  get(k) { return this._data[k]; },
  set(k, v) { this._data[k] = v; },
};
const mgr = new OptionalComponentsManager({
  userDataPath: path.join(tmp, 'mgr-user'),
  resourcesPath: resources,
  installVariant: 'cpu',
  settingsManager: settingsStub,
});
const status = mgr.getStatus();
assert.ok(['idle', 'done', 'error', 'downloading'].includes(status.phase));
assert.strictEqual(status.needsRestart, false);
mgr._states[COMPONENT_IDS.PLAYWRIGHT] = { phase: 'ready', installedAt: new Date().toISOString() };
mgr._saveManifest();
assert.ok(fs.existsSync(getManifestPath(path.join(tmp, 'mgr-user'))));

console.log('PASS optionalComponents paths, catalog, normalizer, manifest');
console.log('optionalComponents.test.js: all passed');

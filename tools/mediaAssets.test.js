'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { archToMediaProfile, getAuxKeyMap } = require('../mediaAssetsCatalog');
const { MediaAssetsManager } = require('../mediaAssetsManager');

assert.strictEqual(archToMediaProfile('lumina2', 'diffusion', ''), 'lumina-image');
assert.strictEqual(archToMediaProfile('wan', 'video', '/wan14.gguf'), 'wan-video');
assert.strictEqual(archToMediaProfile('wan2', 'video', '/Wan2.2-TI2V-5B.gguf'), 'wan22-ti2v');
assert.strictEqual(archToMediaProfile('flux', 'diffusion', ''), 'flux-image');

const lowWanKeys = getAuxKeyMap('wan-video', true);
assert.ok(lowWanKeys.tae);
assert.ok(!lowWanKeys.vae);

const tmp = path.join(os.tmpdir(), `guide-media-assets-test-${Date.now()}`);
const bundled = path.join(tmp, 'bundled', 'media-assets');
fs.mkdirSync(path.join(bundled, 'wan'), { recursive: true });
const vaePath = path.join(bundled, 'wan', 'wan_2.1_vae.safetensors');
fs.writeFileSync(vaePath, 'fake-vae');

const mgr = new MediaAssetsManager({
  userDataPath: path.join(tmp, 'user'),
  resourcesPath: path.join(tmp, 'bundled'),
  rootDir: path.join(__dirname, '..'),
});

const aux = mgr.resolveAux('wan', 'video');
assert.strictEqual(aux.vae, vaePath);
assert.ok(!aux.t5, 't5 not bundled in this fixture');

console.log('PASS mediaAssets resolver');
console.log('mediaAssets.test.js: all passed');

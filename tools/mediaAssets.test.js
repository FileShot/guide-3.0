'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { archToMediaProfile } = require('../mediaAssetsCatalog');
const { MediaAssetsManager } = require('../mediaAssetsManager');

assert.strictEqual(archToMediaProfile('lumina2', 'diffusion'), 'lumina-image');
assert.strictEqual(archToMediaProfile('wan', 'video'), 'wan-video');
assert.strictEqual(archToMediaProfile('flux', 'diffusion'), 'flux-image');

const tmp = path.join(os.tmpdir(), `guide-media-assets-test-${Date.now()}`);
const bundled = path.join(tmp, 'bundled', 'media-assets');
fs.mkdirSync(path.join(bundled, 'wan'), { recursive: true });
const taePath = path.join(bundled, 'wan', 'taew2_2.safetensors');
fs.writeFileSync(taePath, 'fake-tae');

const mgr = new MediaAssetsManager({
  userDataPath: path.join(tmp, 'user'),
  resourcesPath: path.join(tmp, 'bundled'),
  rootDir: path.join(__dirname, '..'),
});

const aux = mgr.resolveAux('wan2', 'video');
assert.strictEqual(aux.tae, taePath);
assert.ok(!aux.t5, 't5 not bundled in this fixture');

console.log('PASS mediaAssets resolver');
console.log('mediaAssets.test.js: all passed');

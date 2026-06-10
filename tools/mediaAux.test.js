'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { archToMediaProfile, isWan22Ti2v, getAuxKeyMap } = require('../mediaAssetsCatalog');
const { scanSameDirectory } = require('../mediaAuxResolver');

assert.strictEqual(archToMediaProfile('lumina2', 'diffusion', '/m/z.gguf'), 'lumina-image');
assert.strictEqual(archToMediaProfile('wan2', 'video', '/m/Wan2.2-TI2V-5B-Q2_K.gguf'), 'wan22-ti2v');
assert.strictEqual(archToMediaProfile('wan', 'video', '/m/wan14b.gguf'), 'wan-video');
assert.strictEqual(isWan22Ti2v('wan2', 'D:\\Wan2.2-TI2V-5B-Q2_K.gguf'), true);

const lowKeys = getAuxKeyMap('wan22-ti2v', true);
assert.ok(lowKeys.tae);
assert.ok(!lowKeys.vae);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-aux-'));
fs.writeFileSync(path.join(tmpDir, 'ae.safetensors'), '');
fs.writeFileSync(path.join(tmpDir, 'model.gguf'), '');
const scanned = scanSameDirectory(path.join(tmpDir, 'model.gguf'));
assert.ok(scanned.vae);

console.log('mediaAux.test.js: all passed');

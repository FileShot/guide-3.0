'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  archToMediaProfile,
  isWan22Ti2v,
  getAuxKeyMap,
  MEDIA_ASSET_PROFILES,
} = require('../mediaAssetsCatalog');
const { scanSameDirectory, _auxDownloadMessage } = require('../mediaAuxResolver');

assert.strictEqual(archToMediaProfile('lumina2', 'diffusion', '/m/z.gguf'), 'lumina-image');
assert.strictEqual(archToMediaProfile('wan2', 'video', '/m/Wan2.2-TI2V-5B-Q2_K.gguf'), 'wan22-ti2v');
assert.strictEqual(archToMediaProfile('wan', 'video', '/m/wan14b.gguf'), 'wan-video');
assert.strictEqual(archToMediaProfile('sd3', 'diffusion', '/m/sd3.gguf'), 'sd3-image');
assert.strictEqual(archToMediaProfile('pixart', 'diffusion', '/m/px.gguf'), 'pixart-image');
assert.strictEqual(isWan22Ti2v('wan2', 'D:\\Wan2.2-TI2V-5B-Q2_K.gguf'), true);

const wan22Low = getAuxKeyMap('wan22-ti2v', true);
assert.ok(wan22Low.vae, 'wan22-ti2v must use wan2.2_vae on low VRAM');
assert.ok(!wan22Low.tae, 'wan22-ti2v must not auto-swap to TAE');

const wan21Low = getAuxKeyMap('wan-video', true);
assert.ok(wan21Low.tae);
assert.ok(!wan21Low.vae);

const luminaLlm = MEDIA_ASSET_PROFILES['lumina-image'].assets.find((a) => a.id === 'qwen3-4b-llm');
assert.ok(luminaLlm.userLabel.includes('not chat'));

const msg = _auxDownloadMessage(luminaLlm);
assert.ok(msg.includes('not your chat model'));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-aux-'));
fs.writeFileSync(path.join(tmpDir, 'ae.safetensors'), '');
fs.writeFileSync(path.join(tmpDir, 'qwen_3_4b.safetensors'), '');
fs.writeFileSync(path.join(tmpDir, 'model.gguf'), '');
const scanned = scanSameDirectory(path.join(tmpDir, 'model.gguf'));
assert.ok(scanned.vae);
assert.ok(scanned.llm);

console.log('mediaAux.test.js: all passed');

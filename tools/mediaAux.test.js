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
const { MediaAuxResolver, scanSameDirectory, _auxDownloadMessage } = require('../mediaAuxResolver');

assert.strictEqual(archToMediaProfile('lumina2', 'diffusion', '/m/z.gguf'), 'lumina-image');
assert.strictEqual(archToMediaProfile('wan2', 'video', '/m/Wan2.2-TI2V-5B-Q2_K.gguf'), 'wan22-ti2v');
assert.strictEqual(archToMediaProfile('wan', 'video', '/m/wan14b.gguf'), 'wan-video');
assert.strictEqual(archToMediaProfile('cogvideox', 'video', '/m/cog.gguf'), 'cogvideo-video');
assert.strictEqual(archToMediaProfile('ltx', 'video', '/m/ltx.gguf'), 'ltx-video');
assert.notStrictEqual(archToMediaProfile('cogvideox', 'video', '/m/cog.gguf'), 'wan-video');
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

// SD3 profile must auto-resolve VAE + CLIP-L/G + T5 (was empty auxKeys → generation failed)
const sd3Keys = getAuxKeyMap('sd3-image', false);
assert.ok(sd3Keys.vae, 'sd3-image needs VAE');
assert.ok(sd3Keys.clip_l, 'sd3-image needs CLIP-L');
assert.ok(sd3Keys.clip_g, 'sd3-image needs CLIP-G');
assert.ok(sd3Keys.t5, 'sd3-image needs T5');
const sd3Profile = MEDIA_ASSET_PROFILES['sd3-image'];
assert.ok(sd3Profile.assets.length >= 4, 'sd3-image catalog has companion assets');

const sd3Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-sd3-aux-'));
fs.writeFileSync(path.join(sd3Dir, 'sd3.5m_turbo-Q4_K_M.gguf'), '');
fs.writeFileSync(path.join(sd3Dir, 'clip_l.safetensors'), '');
fs.writeFileSync(path.join(sd3Dir, 'clip_g.safetensors'), '');
fs.writeFileSync(path.join(sd3Dir, 'sd3_vae.safetensors'), '');
fs.writeFileSync(path.join(sd3Dir, 't5xxl_fp16.safetensors'), '');
const sd3Scanned = scanSameDirectory(path.join(sd3Dir, 'sd3.5m_turbo-Q4_K_M.gguf'), 'sd3-image');
assert.ok(sd3Scanned.clip_l);
assert.ok(sd3Scanned.clip_g);
assert.ok(sd3Scanned.vae);
assert.ok(sd3Scanned.t5);

const preflightDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-sd3-preflight-'));
fs.writeFileSync(path.join(preflightDir, 'sd3.gguf'), '');
const resolver = new MediaAuxResolver({ userDataPath: path.join(os.tmpdir(), 'guide-preflight-') });
const preflightMissing = resolver.preflight({
  arch: 'sd3',
  modelType: 'diffusion',
  modelPath: path.join(preflightDir, 'sd3.gguf'),
  settings: {},
  vramMB: 4096,
});
assert.strictEqual(preflightMissing.profileId, 'sd3-image');
assert.strictEqual(preflightMissing.ready, false);
assert.ok(preflightMissing.missing.includes('vae'));
assert.ok(preflightMissing.willAutoDownload);

console.log('mediaAux.test.js: all passed');

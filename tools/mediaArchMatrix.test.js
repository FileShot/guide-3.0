'use strict';

/**
 * Ensures every sd.cpp diffusion/video arch maps to the correct profile
 * (no blanket Wan routing for non-Wan video models).
 */

const assert = require('assert');
const { archToMediaProfile } = require('../mediaAssetsCatalog');
const { DIFFUSION_ARCHITECTURES, VIDEO_ARCHITECTURES } = require('../modelDetection');

const EXPECTED = {
  lumina2: 'lumina-image',
  'z-image': 'lumina-image',
  flux: 'flux-image',
  flux2: 'flux-image',
  sdxl: 'sdxl-image',
  sd: 'sd-image',
  sd3: 'sd3-image',
  pixart: 'pixart-image',
  kolors: 'image-generic',
  aura: 'image-generic',
  'qwen-image': 'image-generic',
  wan: 'wan-video',
  wan2: 'wan-video',
  cogvideox: 'cogvideo-video',
  cogvideo: 'cogvideo-video',
  ltx: 'ltx-video',
  'hunyuan-video': 'hunyuan-video',
  mochi: 'mochi-video',
};

for (const arch of DIFFUSION_ARCHITECTURES) {
  const profile = archToMediaProfile(arch, 'diffusion', `/models/${arch}-test.gguf`);
  assert.ok(profile, `diffusion arch "${arch}" must map to a profile`);
  assert.notStrictEqual(profile, 'wan-video', `diffusion arch "${arch}" must not map to wan-video`);
  assert.notStrictEqual(profile, 'wan22-ti2v', `diffusion arch "${arch}" must not map to wan22-ti2v`);
}

for (const arch of VIDEO_ARCHITECTURES) {
  const profile = archToMediaProfile(arch, 'video', `/models/${arch}-test.gguf`);
  assert.ok(profile, `video arch "${arch}" must map to a profile`);
  if (!arch.startsWith('wan')) {
    assert.notStrictEqual(profile, 'wan-video', `video arch "${arch}" must not map to wan-video`);
    assert.notStrictEqual(profile, 'wan22-ti2v', `video arch "${arch}" must not map to wan22-ti2v`);
  }
}

for (const [arch, expected] of Object.entries(EXPECTED)) {
  const modelType = VIDEO_ARCHITECTURES.has(arch) || arch.startsWith('wan') ? 'video' : 'diffusion';
  const profile = archToMediaProfile(arch, modelType, `/models/${arch}-test.gguf`);
  assert.strictEqual(profile, expected, `arch ${arch}`);
}

assert.strictEqual(
  archToMediaProfile('wan2', 'video', '/models/Wan2.2-TI2V-5B-Q2_K.gguf'),
  'wan22-ti2v',
);

console.log('mediaArchMatrix.test.js: all passed');

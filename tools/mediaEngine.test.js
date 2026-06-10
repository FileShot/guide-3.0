'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  MediaEngine,
  resolveMediaMemoryFlags,
  getDefaultMediaDimensions,
  formatSdExitError,
  WIN_DLL_NOT_FOUND,
  VRAM_LOW_MB,
} = require('../mediaEngine');

function touchTmp(name) {
  const p = path.join(os.tmpdir(), `guide-media-test-${name}`);
  fs.writeFileSync(p, '');
  return p;
}

function makeEngine(settings = {}, aux = {}) {
  const e = new MediaEngine({
    rootDir: path.join(__dirname, '..'),
    getSettings: () => settings,
  });
  e._resolvedAux = aux;
  return e;
}

function assertDiffusionModelArgs(built, modelPath) {
  assert.strictEqual(built.missing.length, 0);
  assert.ok(built.args.includes('--diffusion-model'));
  assert.ok(built.args.includes(modelPath));
  assert.ok(!built.args.includes('-m'));
}

function testImageArchUsesDiffusionModelFlag() {
  for (const arch of ['flux', 'lumina2', 'sd3', 'pixart']) {
    const e = makeEngine({});
    const modelPath = `/tmp/${arch}.gguf`;
    e.modelPath = modelPath;
    e.ggufArchitecture = arch;
    e.modelType = 'diffusion';
    const built = e._buildSdArgs({
      model: modelPath,
      prompt: 'test',
      width: 512,
      height: 512,
      steps: 10,
      seed: 1,
      output: '/tmp/out.png',
      aux: {},
    });
    assert.strictEqual(built.isVideo, false);
    assertDiffusionModelArgs(built, modelPath);
  }
  console.log('PASS image arches use --diffusion-model');
}

function testLuminaCfgScale() {
  const e = makeEngine({});
  e.ggufArchitecture = 'lumina2';
  e.modelType = 'diffusion';
  const built = e._buildSdArgs({
    model: '/tmp/z.gguf',
    prompt: 'x',
    width: 512,
    height: 512,
    steps: 10,
    seed: 1,
    output: '/tmp/out.png',
    aux: {},
  });
  assert.ok(built.args.includes('--cfg-scale'));
  assert.ok(built.args.includes('1.0'));
  console.log('PASS lumina cfg-scale 1.0');
}

function testVideoArchUsesVidGenAndDiffusionModel() {
  for (const arch of ['wan', 'wan2', 'cogvideox']) {
    const e = makeEngine({});
    const modelPath = `/tmp/${arch}.gguf`;
    e.modelPath = modelPath;
    e.ggufArchitecture = arch;
    e.modelType = 'video';
    const mem = resolveMediaMemoryFlags({}, VRAM_LOW_MB);
    const built = e._buildSdArgs({
      model: modelPath,
      prompt: 'motion',
      width: 512,
      height: 512,
      steps: 10,
      seed: 1,
      output: '/tmp/out.mp4',
      videoFrames: 33,
      memoryFlags: mem,
      aux: {},
    });
    assert.strictEqual(built.isVideo, true);
    assert.ok(built.args.includes('vid_gen'));
    assertDiffusionModelArgs(built, modelPath);
    assert.ok(built.args.includes('--video-frames'));
    assert.ok(built.args.includes('--flow-shift'));
    assert.ok(built.args.includes('--offload-to-cpu'));
    assert.ok(built.args.includes('--vae-tiling'));
  }
  console.log('PASS video arches use -M vid_gen --diffusion-model');
}

function testOptionalAuxPassedToCli() {
  const vae = touchTmp('vae.safetensors');
  const tae = touchTmp('tae.safetensors');
  const t5 = touchTmp('t5.gguf');
  const clip = touchTmp('clip.gguf');

  const imageEngine = makeEngine({}, { vae, llm: clip });
  imageEngine.ggufArchitecture = 'flux';
  imageEngine.modelType = 'diffusion';
  const imageBuilt = imageEngine._buildSdArgs({
    model: '/tmp/model.gguf',
    prompt: 'test',
    width: 512,
    height: 512,
    steps: 10,
    seed: 1,
    output: '/tmp/out.png',
    aux: { vae, llm: clip },
  });
  assert.ok(imageBuilt.args.includes('--vae'));
  assert.ok(imageBuilt.args.includes('--llm'));

  const videoEngine = makeEngine({}, { tae, t5 });
  videoEngine.ggufArchitecture = 'wan2';
  videoEngine.modelType = 'video';
  const videoBuilt = videoEngine._buildSdArgs({
    model: '/tmp/video.gguf',
    prompt: 'test',
    width: 384,
    height: 384,
    steps: 10,
    seed: 1,
    output: '/tmp/out.mp4',
    videoFrames: 17,
    memoryFlags: resolveMediaMemoryFlags({ mediaTaePath: tae }, 4096),
    aux: { tae, t5 },
  });
  assert.ok(videoBuilt.args.includes('--tae'));
  assert.ok(!videoBuilt.args.includes('--vae'));
  assert.ok(videoBuilt.args.includes('--t5xxl'));
  console.log('PASS optional aux passed to CLI');
}

function testLowVramAutoOffload() {
  const flags = resolveMediaMemoryFlags({ mediaOffloadPolicy: 'auto' }, 4096);
  assert.strictEqual(flags.offloadToCpu, true);
  assert.strictEqual(flags.vaeOnCpu, true);
  assert.strictEqual(flags.vaeTiling, true);
  const dims = getDefaultMediaDimensions(4096, true);
  assert.strictEqual(dims.width, 384);
  assert.ok(dims.videoFrames < 33);
  console.log('PASS low vram auto offload');
}

function testFormatSdExitError() {
  const msg = formatSdExitError(WIN_DLL_NOT_FOUND, '');
  assert.ok(msg.includes('could not start'));
  const vulkanSpam = 'ggml_vulkan: Found 2 Vulkan devices\n[ERROR] stable-diffusion.cpp:410 - get sd version from file failed';
  const cleaned = formatSdExitError(1, vulkanSpam);
  assert.ok(!cleaned.includes('ggml_vulkan'));
  assert.ok(cleaned.includes('Could not load model file') || cleaned.includes('get sd version'));
  const wan5d = '[ERROR] ggml_extend.hpp:70 - patch_embedding.weight has invalid number of dimensions: 5 > 4';
  const wanMsg = formatSdExitError(1, wan5d);
  assert.ok(wanMsg.includes('5D tensors') || wanMsg.includes('QuantStack'));
  console.log('PASS formatSdExitError');
}

testImageArchUsesDiffusionModelFlag();
testLuminaCfgScale();
testVideoArchUsesVidGenAndDiffusionModel();
testOptionalAuxPassedToCli();
testLowVramAutoOffload();
testFormatSdExitError();
console.log('mediaEngine.test.js: all passed');

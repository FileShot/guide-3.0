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

function makeEngine(settings = {}) {
  return new MediaEngine({
    rootDir: path.join(__dirname, '..'),
    getSettings: () => settings,
  });
}

function assertGenericImageArgs(built, modelPath) {
  assert.strictEqual(built.isVideo, false);
  assert.strictEqual(built.missing.length, 0);
  assert.ok(built.args.includes('-m'));
  assert.ok(built.args.includes(modelPath));
  assert.ok(!built.args.includes('--diffusion-model'));
}

function assertGenericVideoArgs(built, modelPath) {
  assert.strictEqual(built.isVideo, true);
  assert.strictEqual(built.missing.length, 0);
  assert.ok(built.args.includes('vid_gen'));
  assert.ok(built.args.includes('-m'));
  assert.ok(built.args.includes(modelPath));
  assert.ok(!built.args.includes('--diffusion-model'));
}

function testImageArchUsesUnifiedModelFlag() {
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
    });
    assertGenericImageArgs(built, modelPath);
  }
  console.log('PASS image arches use -m');
}

function testVideoArchUsesVidGenAndUnifiedModelFlag() {
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
    });
    assertGenericVideoArgs(built, modelPath);
    assert.ok(built.args.includes('--video-frames'));
    assert.ok(built.args.includes('--flow-shift'));
    assert.ok(built.args.includes('--offload-to-cpu'));
    assert.ok(built.args.includes('--diffusion-fa'));
  }
  console.log('PASS video arches use -M vid_gen -m');
}

function testOptionalAuxFromSettingsOnly() {
  const vae = touchTmp('vae.safetensors');
  const tae = touchTmp('tae.safetensors');
  const t5 = touchTmp('t5.gguf');
  const clip = touchTmp('clip.gguf');

  const imageEngine = makeEngine({ mediaVaePath: vae, mediaClipPath: clip });
  imageEngine.modelPath = '/tmp/model.gguf';
  imageEngine.ggufArchitecture = 'flux';
  imageEngine.modelType = 'diffusion';
  const imageBuilt = imageEngine._buildSdArgs({
    model: imageEngine.modelPath,
    prompt: 'test',
    width: 512,
    height: 512,
    steps: 10,
    seed: 1,
    output: '/tmp/out.png',
  });
  assert.ok(imageBuilt.args.includes('--vae'));
  assert.ok(imageBuilt.args.includes('--llm'));
  assert.ok(!imageBuilt.args.includes('--tae'));

  const videoEngine = makeEngine({ mediaTaePath: tae, mediaT5Path: t5 });
  videoEngine.modelPath = '/tmp/video.gguf';
  videoEngine.ggufArchitecture = 'wan2';
  videoEngine.modelType = 'video';
  const videoBuilt = videoEngine._buildSdArgs({
    model: videoEngine.modelPath,
    prompt: 'test',
    width: 384,
    height: 384,
    steps: 10,
    seed: 1,
    output: '/tmp/out.mp4',
    videoFrames: 17,
    memoryFlags: resolveMediaMemoryFlags({ mediaTaePath: tae }, 4096),
  });
  assert.ok(videoBuilt.args.includes('--tae'));
  assert.ok(!videoBuilt.args.includes('--vae'));
  assert.ok(videoBuilt.args.includes('--t5xxl'));
  console.log('PASS optional aux from settings only');
}

function testGgufOnlyNoAuxRequired() {
  const e = makeEngine({});
  e.modelPath = '/tmp/any-image.gguf';
  e.ggufArchitecture = 'lumina2';
  e.modelType = 'diffusion';
  const built = e._buildSdArgs({
    model: e.modelPath,
    prompt: 'x',
    width: 512,
    height: 512,
    steps: 10,
    seed: 1,
    output: '/tmp/out.png',
  });
  assertGenericImageArgs(built, e.modelPath);
  assert.ok(!built.args.includes('--vae'));
  assert.ok(!built.args.includes('--llm'));
  assert.ok(!built.args.includes('--t5xxl'));
  console.log('PASS gguf-only no aux required');
}

function testLowVramAutoOffload() {
  const flags = resolveMediaMemoryFlags({ mediaOffloadPolicy: 'auto' }, 4096);
  assert.strictEqual(flags.offloadToCpu, true);
  assert.strictEqual(flags.vaeOnCpu, true);
  assert.strictEqual(flags.clipOnCpu, true);
  const dims = getDefaultMediaDimensions(4096, true);
  assert.strictEqual(dims.width, 384);
  assert.ok(dims.videoFrames < 33);
  console.log('PASS low vram auto offload');
}

function testFormatSdExitError() {
  const msg = formatSdExitError(WIN_DLL_NOT_FOUND, '');
  assert.ok(msg.includes('could not start'));
  assert.ok(formatSdExitError(1, 'tensor missing').includes('tensor missing'));
  console.log('PASS formatSdExitError');
}

testImageArchUsesUnifiedModelFlag();
testVideoArchUsesVidGenAndUnifiedModelFlag();
testOptionalAuxFromSettingsOnly();
testGgufOnlyNoAuxRequired();
testLowVramAutoOffload();
testFormatSdExitError();
console.log('mediaEngine.test.js: all passed');

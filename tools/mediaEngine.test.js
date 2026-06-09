'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  MediaEngine,
  resolveMediaMemoryFlags,
  getDefaultMediaDimensions,
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

function testFluxArgsNeedVae() {
  const e = makeEngine({ mediaVaePath: touchTmp('vae.safetensors'), mediaClipPath: touchTmp('clip.gguf') });
  e.modelPath = '/tmp/flux.gguf';
  e.ggufArchitecture = 'flux';
  e.modelType = 'diffusion';
  const built = e._buildSdArgs({
    model: e.modelPath,
    prompt: 'test',
    width: 512,
    height: 512,
    steps: 10,
    seed: 1,
    output: '/tmp/out.png',
  });
  assert.strictEqual(built.missing.length, 0);
  assert.ok(built.args.includes('--diffusion-model'));
  assert.ok(built.args.includes('--vae'));
  assert.ok(!built.args.includes('-m'));
  console.log('PASS flux args');
}

function testWanVideoArgs() {
  const e = makeEngine({
    mediaVaePath: touchTmp('wan_vae.safetensors'),
    mediaT5Path: touchTmp('t5.gguf'),
  });
  e.modelPath = '/tmp/wan.gguf';
  e.ggufArchitecture = 'wan2';
  e.modelType = 'video';
  const mem = resolveMediaMemoryFlags({}, VRAM_LOW_MB);
  const built = e._buildSdArgs({
    model: e.modelPath,
    prompt: 'cat walking',
    width: 512,
    height: 512,
    steps: 10,
    seed: 1,
    output: '/tmp/out.mp4',
    videoFrames: 33,
    memoryFlags: mem,
  });
  assert.strictEqual(built.isVideo, true);
  assert.ok(built.args.includes('vid_gen'));
  assert.ok(built.args.includes('--t5xxl'));
  assert.ok(built.args.includes('--video-frames'));
  assert.ok(built.args.includes('--offload-to-cpu'));
  assert.ok(built.args.includes('--diffusion-fa'));
  assert.ok(built.args.includes('--flow-shift'));
  console.log('PASS wan video args');
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

function testWanTaeInsteadOfVae() {
  const tae = touchTmp('taew2_2.safetensors');
  const e = makeEngine({ mediaTaePath: tae, mediaT5Path: touchTmp('t5.gguf') });
  e.modelPath = '/tmp/wan.gguf';
  e.ggufArchitecture = 'wan';
  e.modelType = 'video';
  const built = e._buildSdArgs({
    model: e.modelPath,
    prompt: 'cat',
    width: 384,
    height: 384,
    steps: 10,
    seed: 1,
    output: '/tmp/out.mp4',
    videoFrames: 17,
    memoryFlags: resolveMediaMemoryFlags({ mediaTaePath: tae }, 4096),
  });
  assert.strictEqual(built.missing.length, 0);
  assert.ok(built.args.includes('--tae'));
  assert.ok(!built.args.includes('--vae'));
  console.log('PASS wan tae path');
}

function testLuminaNeedsLlm() {
  const e = makeEngine({
    mediaVaePath: touchTmp('ae.safetensors'),
    mediaClipPath: touchTmp('qwen.gguf'),
  });
  e.modelPath = '/tmp/z-image.gguf';
  e.ggufArchitecture = 'lumina2';
  e.modelType = 'diffusion';
  const built = e._buildSdArgs({
    model: e.modelPath,
    prompt: 'sunset',
    width: 512,
    height: 512,
    steps: 10,
    seed: 1,
    output: '/tmp/out.png',
    memoryFlags: resolveMediaMemoryFlags({}, 4096),
  });
  assert.strictEqual(built.missing.length, 0);
  assert.ok(built.args.includes('--llm'));
  console.log('PASS lumina llm args');
}

function testGgufOnlyNoBundledAuxRequired() {
  const e = makeEngine({});
  e.modelPath = '/tmp/flux.gguf';
  e.ggufArchitecture = 'flux';
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
  assert.strictEqual(built.missing.length, 0);
  assert.ok(built.args.includes('--diffusion-model'));
  console.log('PASS gguf-only no bundled aux required');
}

testFluxArgsNeedVae();
testWanVideoArgs();
testLowVramAutoOffload();
testWanTaeInsteadOfVae();
testLuminaNeedsLlm();
testGgufOnlyNoBundledAuxRequired();
console.log('mediaEngine.test.js: all passed');

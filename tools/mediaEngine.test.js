'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { MediaEngine } = require('../mediaEngine');

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
  const built = e._buildSdArgs({
    model: e.modelPath,
    prompt: 'cat walking',
    width: 512,
    height: 512,
    steps: 10,
    seed: 1,
    output: '/tmp/out.mp4',
    videoFrames: 33,
  });
  assert.strictEqual(built.isVideo, true);
  assert.ok(built.args.includes('vid_gen'));
  assert.ok(built.args.includes('--t5xxl'));
  assert.ok(built.args.includes('--video-frames'));
  console.log('PASS wan video args');
}

function testMissingAuxReported() {
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
  assert.ok(built.missing.length > 0);
  console.log('PASS missing aux detection');
}

testFluxArgsNeedVae();
testWanVideoArgs();
testMissingAuxReported();
console.log('mediaEngine.test.js: all passed');

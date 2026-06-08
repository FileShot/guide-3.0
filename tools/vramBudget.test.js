'use strict';

const assert = require('assert');
const { computeUnifiedVramBudget } = require('../chatEngine');

const GiB = 1024 * 1024 * 1024;

/** Synthetic ~5GB model on ~4GB GPU (tight VRAM). */
const FIXTURE = {
  vramFree: 3.8 * GiB,
  vramTotal: 4 * GiB,
  modelSizeBytes: 5 * GiB,
  totalLayers: 32,
  kvBytesPerToken: 800000,
  desiredMaxContext: 32768,
  minContext: 2048,
  trainMaxContext: 32768,
};

function runPreset(mode) {
  return computeUnifiedVramBudget({
    ...FIXTURE,
    vramBalance: mode,
    gpuConstrainedContext: true,
  });
}

const speed = runPreset('speed');
const balanced = runPreset('balanced');
const context = runPreset('context');

assert(speed.gpuLayers >= balanced.gpuLayers, 'speed should not use fewer GPU layers than balanced');
assert(speed.gpuLayers >= context.gpuLayers, 'speed should not use fewer GPU layers than context');
assert(context.contextSize >= speed.contextSize, 'context preset should not shrink context vs speed');
assert(speed.contextSize >= FIXTURE.minContext, 'speed context stays above floor');
assert(speed.gpuLayers > 0, 'speed uses partial GPU on tight fixture');

console.log('vramBudget.test.js OK', {
  speed: { gpuLayers: speed.gpuLayers, contextSize: speed.contextSize },
  balanced: { gpuLayers: balanced.gpuLayers, contextSize: balanced.contextSize },
  context: { gpuLayers: context.gpuLayers, contextSize: context.contextSize },
});

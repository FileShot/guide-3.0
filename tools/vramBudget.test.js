'use strict';

const assert = require('assert');
const { computeUnifiedVramBudget } = require('../chatEngine');

const GiB = 1024 * 1024 * 1024;

/** RTX 3050 Ti laptop 4GB — ~5GB Qwen3.5-9B Q4, 32 layers (Wild West session hardware). */
const RTX_3050_TI_4GB = {
  vramFree: 3.8 * GiB,
  vramTotal: 4 * GiB,
  modelSizeBytes: 5 * GiB,
  totalLayers: 32,
  kvBytesPerToken: 800000,
  desiredMaxContext: 32768,
  minContext: 2048,
  trainMaxContext: 32768,
};

function runPreset(fixture, mode) {
  return computeUnifiedVramBudget({
    ...fixture,
    vramBalance: mode,
    gpuConstrainedContext: true,
  });
}

const speed = runPreset(RTX_3050_TI_4GB, 'speed');
const balanced = runPreset(RTX_3050_TI_4GB, 'balanced');
const context = runPreset(RTX_3050_TI_4GB, 'context');

assert(speed.gpuLayers >= balanced.gpuLayers, 'speed should not use fewer GPU layers than balanced');
assert(speed.gpuLayers >= context.gpuLayers, 'speed should not use fewer GPU layers than context');
assert(context.contextSize >= speed.contextSize, 'context preset should not shrink context vs speed');
assert(speed.contextSize >= RTX_3050_TI_4GB.minContext, 'speed context stays above floor');
assert(speed.gpuLayers > 0, 'speed uses partial GPU on tight fixture');
assert(speed.gpuLayers < RTX_3050_TI_4GB.totalLayers, '4GB cannot fit all layers for ~5GB model');
// Documented expectation from v0.4.22 audit: partial offload ~40–50% of layers on this fixture.
assert(speed.gpuLayers >= 10 && speed.gpuLayers <= 20, `speed layers in expected partial-offload band, got ${speed.gpuLayers}`);

console.log('vramBudget.test.js OK', {
  fixture: 'RTX 3050 Ti 4GB / ~5GB model',
  speed: { gpuLayers: speed.gpuLayers, contextSize: speed.contextSize },
  balanced: { gpuLayers: balanced.gpuLayers, contextSize: balanced.contextSize },
  context: { gpuLayers: context.gpuLayers, contextSize: context.contextSize },
});

'use strict';

const assert = require('assert');
const { GGUF_ARCH_TO_FAMILY } = require('../modelDetection');
const { GENERATION_PROFILES } = require('../generationProfiles');
const { getModelProfile } = require('../modelProfiles');

// Every mapped arch has a generation profile with official source URL
for (const arch of Object.keys(GGUF_ARCH_TO_FAMILY)) {
  const prof = GENERATION_PROFILES[arch] || getModelProfile(arch, 7);
  const source = prof._meta?.source || prof._meta?.profileSource;
  assert(source && String(source).startsWith('http'), `arch "${arch}" missing _meta.source URL`);
}

// Known divergences
const qwen3 = getModelProfile('qwen3', 7);
const qwen35 = getModelProfile('qwen35', 7);
assert.strictEqual(qwen3.sampling.temperature, 0.6);
assert.strictEqual(qwen35.sampling.temperature, 1.0);
assert.notStrictEqual(qwen3.sampling.temperature, qwen35.sampling.temperature);

const gemma2 = getModelProfile('gemma2', 7);
const gemma4 = getModelProfile('gemma4', 7);
assert.strictEqual(gemma2.sampling.topK, 64);
assert.strictEqual(gemma4.sampling.topK, 64);

const phi2 = getModelProfile('phi2', 3);
const phi3 = getModelProfile('phi3', 3);
assert.notStrictEqual(phi2.sampling.repeatPenalty, phi3.sampling.repeatPenalty);

// Flux diffusion arch classification
const { detectModelTypeFromGguf } = require('../modelDetection');
assert.strictEqual(detectModelTypeFromGguf({ general: { architecture: 'flux' } }), 'diffusion');
assert.strictEqual(detectModelTypeFromGguf({ general: { architecture: 'qwen35' } }), 'llm');

console.log('modelProfiles.test.js OK');

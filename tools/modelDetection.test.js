'use strict';

const assert = require('assert');
const {
  detectModelTypeFromGguf,
  DIFFUSION_ARCHITECTURES,
  VIDEO_ARCHITECTURES,
} = require('../modelDetection');

assert.strictEqual(detectModelTypeFromGguf({ general: { architecture: 'flux' } }), 'diffusion');
assert.strictEqual(detectModelTypeFromGguf({ general: { architecture: 'sd3' } }), 'diffusion');
assert.strictEqual(detectModelTypeFromGguf({ general: { architecture: 'qwen35' } }), 'llm');
assert.strictEqual(detectModelTypeFromGguf({ general: { architecture: 'wan' } }), 'video');
assert.strictEqual(detectModelTypeFromGguf({ general: { architecture: 'lumina2' } }), 'diffusion');
assert.strictEqual(detectModelTypeFromGguf({ general: { architecture: 'cogvideox' } }), 'video');
assert(DIFFUSION_ARCHITECTURES.has('flux'));
assert(VIDEO_ARCHITECTURES.has('wan'));

console.log('modelDetection.test.js OK');

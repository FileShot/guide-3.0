'use strict';

const assert = require('assert');
const path = require('path');
const {
  is5dCompatArch,
  needs5dFix,
  normalizeModelStem,
  inferSourceRepo,
} = require('../gguf5dCompat');

assert.strictEqual(is5dCompatArch('wan'), true);
assert.strictEqual(is5dCompatArch('flux'), false);
assert.strictEqual(needs5dFix('patch_embedding.weight has invalid number of dimensions: 5 > 4'), true);
assert.strictEqual(normalizeModelStem('Wan2.2-TI2V-5B-Q2_K.gguf'), 'Wan2.2-TI2V-5B');
assert.strictEqual(inferSourceRepo('D:\\Wan2.2-TI2V-5B-Q2_K.gguf'), 'Wan-AI/Wan2.2-TI2V-5B');
console.log('gguf5dCompat.test.js: all passed');

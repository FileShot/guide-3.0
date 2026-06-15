'use strict';

const assert = require('assert');
const { estimateKvBytesPerToken, parsePerLayerInts } = require('../chatEngine');

// Gemma4-style per-layer head_count_kv (comma string)
const gemma4HeadKv = Array(48).fill(8).join(',');
gemma4HeadKv.split(',')[5] = '1'; // one layer with 1 head — rebuild properly
const gemma4Heads = Array.from({ length: 48 }, (_, i) => (i === 5 ? 1 : 8));
const gemma4Meta = {
  block_count: 48,
  attention: {
    head_count_kv: gemma4Heads.join(','),
    head_count: 8,
    key_length: 256,
    value_length: 256,
  },
};

const gemma4Kv = estimateKvBytesPerToken(gemma4Meta, 'q8_0');
assert.strictEqual(typeof gemma4Kv, 'number');
assert.ok(Number.isFinite(gemma4Kv));
assert.ok(gemma4Kv > 0);
const gemma4Expected = gemma4Heads.reduce((a, b) => a + b, 0) * (256 + 256) * 1;
assert.strictEqual(gemma4Kv, gemma4Expected);

// Qwen/MTP scalar head_count_kv regression
const qwenMeta = {
  block_count: 36,
  attention: {
    head_count_kv: 4,
    head_count: 8,
    key_length: 128,
    value_length: 128,
  },
};
const qwenKv = estimateKvBytesPerToken(qwenMeta, 'q8_0');
assert.strictEqual(qwenKv, 36 * 4 * (128 + 128) * 1);

// Bad comma string must not return NaN
const badMeta = {
  block_count: 32,
  attention: { head_count_kv: 'not,a,number', key_length: 128, value_length: 128 },
};
assert.strictEqual(estimateKvBytesPerToken(badMeta, 'q8_0'), null);

assert.deepStrictEqual(parsePerLayerInts('8,8,1'), [8, 8, 1]);
assert.deepStrictEqual(parsePerLayerInts(4), [4]);
assert.strictEqual(parsePerLayerInts(null), null);

console.log('kvEstimate.test.js OK');

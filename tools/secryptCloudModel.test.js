'use strict';

const assert = require('assert');
const {
  resolveSecryptCloudModel,
  SECRYPT_QUALITY_MODEL,
  secryptQualitySampling,
} = require('../cloudLLMService');

assert.strictEqual(SECRYPT_QUALITY_MODEL, 'cipher-quality');
assert.strictEqual(resolveSecryptCloudModel('secrypt', 'cipher'), 'cipher-quality');
assert.strictEqual(resolveSecryptCloudModel('secrypt', ''), 'cipher-quality');
assert.strictEqual(resolveSecryptCloudModel('secrypt', null), 'cipher-quality');
assert.strictEqual(resolveSecryptCloudModel('graysoft', 'gpt-oss-120b'), 'cipher-quality');
assert.strictEqual(resolveSecryptCloudModel('cerebras', 'gpt-oss-120b'), 'cipher-quality');
assert.strictEqual(resolveSecryptCloudModel('secrypt', 'cipher-quality'), 'cipher-quality');
assert.strictEqual(resolveSecryptCloudModel('secrypt', 'cipher-fast'), 'cipher-fast');
assert.strictEqual(resolveSecryptCloudModel('openai', 'gpt-4o'), 'gpt-4o');

const think = secryptQualitySampling(true);
assert.deepStrictEqual(
  {
    temperature: think.temperature,
    topP: think.topP,
    topK: think.topK,
    minP: think.minP,
    presencePenalty: think.presencePenalty,
    repeatPenalty: think.repeatPenalty,
    reasoningEffort: think.reasoningEffort,
  },
  {
    temperature: 1.0,
    topP: 0.95,
    topK: 20,
    minP: 0,
    presencePenalty: 0,
    repeatPenalty: 1.0,
    reasoningEffort: 'xhigh',
  },
);

const instruct = secryptQualitySampling(false);
assert.deepStrictEqual(
  {
    temperature: instruct.temperature,
    topP: instruct.topP,
    topK: instruct.topK,
    minP: instruct.minP,
    presencePenalty: instruct.presencePenalty,
    repeatPenalty: instruct.repeatPenalty,
    reasoningEffort: instruct.reasoningEffort,
  },
  {
    temperature: 0.7,
    topP: 0.8,
    topK: 20,
    minP: 0,
    presencePenalty: 1.5,
    repeatPenalty: 1.0,
    reasoningEffort: 'low',
  },
);

console.log('secryptCloudModel.test.js OK');

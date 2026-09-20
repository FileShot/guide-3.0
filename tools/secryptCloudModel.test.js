'use strict';

const assert = require('assert');
const { resolveSecryptCloudModel, SECRYPT_QUALITY_MODEL } = require('../cloudLLMService');

assert.strictEqual(SECRYPT_QUALITY_MODEL, 'cipher-quality');
assert.strictEqual(resolveSecryptCloudModel('secrypt', 'cipher'), 'cipher-quality');
assert.strictEqual(resolveSecryptCloudModel('secrypt', ''), 'cipher-quality');
assert.strictEqual(resolveSecryptCloudModel('secrypt', null), 'cipher-quality');
assert.strictEqual(resolveSecryptCloudModel('graysoft', 'gpt-oss-120b'), 'cipher-quality');
assert.strictEqual(resolveSecryptCloudModel('cerebras', 'gpt-oss-120b'), 'cipher-quality');
assert.strictEqual(resolveSecryptCloudModel('secrypt', 'cipher-quality'), 'cipher-quality');
assert.strictEqual(resolveSecryptCloudModel('secrypt', 'cipher-fast'), 'cipher-fast');
assert.strictEqual(resolveSecryptCloudModel('openai', 'gpt-4o'), 'gpt-4o');

console.log('secryptCloudModel.test.js OK');

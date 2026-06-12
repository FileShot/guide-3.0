'use strict';

const assert = require('assert');
const {
  getModelProfile,
  resolveSamplingProfile,
  resolveAgentDryRepeatPenalty,
  BASE_DEFAULTS,
} = require('../modelProfiles');
const {
  STRUCTURED_OUTPUT_FLOORS,
  STRUCTURED_OUTPUT_PRESENCE_CAP,
} = require('../generationProfiles');

function assertAgentStructured(profile, label) {
  const sampling = resolveSamplingProfile(profile, { agentToolLoop: true, thinkingActive: true });
  assert.notStrictEqual(
    sampling.presencePenalty,
    1.5,
    `${label}: must not inherit instruct presencePenalty 1.5`,
  );
  assert.ok(
    sampling.presencePenalty >= STRUCTURED_OUTPUT_FLOORS.presencePenalty,
    `${label}: presencePenalty ${sampling.presencePenalty}`,
  );
  assert.ok(
    sampling.presencePenalty <= STRUCTURED_OUTPUT_PRESENCE_CAP,
    `${label}: presencePenalty ${sampling.presencePenalty} exceeds cap`,
  );
  assert.ok(
    sampling.repeatPenalty >= STRUCTURED_OUTPUT_FLOORS.repeatPenalty,
    `${label}: repeatPenalty ${sampling.repeatPenalty}`,
  );
  assert.ok(
    sampling.lastTokensPenaltyCount >= STRUCTURED_OUTPUT_FLOORS.lastTokensPenaltyCount,
    `${label}: lastTokensPenaltyCount ${sampling.lastTokensPenaltyCount}`,
  );
  const dry = resolveAgentDryRepeatPenalty(true);
  assert.strictEqual(dry.strength, 0.8);
  assert.strictEqual(dry.lastTokens, 512);
}

const qwen35 = getModelProfile('qwen35', 2);
assertAgentStructured(qwen35, 'qwen35');
assert.strictEqual(qwen35.samplingStructuredOutput.presencePenalty, 1.0);
assert.strictEqual(qwen35.samplingStructuredOutput.temperature, 0.6);
assert.ok(
  qwen35.samplingCoding.presencePenalty === 0,
  'vendor samplingCoding unchanged for documentation',
);
const askQwen = resolveSamplingProfile(qwen35, { agentToolLoop: false, thinkingActive: true });
assert.strictEqual(askQwen.presencePenalty, qwen35.sampling.presencePenalty);

const gemma3 = getModelProfile('gemma3', 7);
assertAgentStructured(gemma3, 'gemma3');

const phi4 = getModelProfile('phi4', 7);
assertAgentStructured(phi4, 'phi4');
assert.ok(phi4.samplingStructuredOutput.repeatPenalty >= 1.12);

const llama = getModelProfile('llama', 7);
assertAgentStructured(llama, 'llama');

const unknown = getModelProfile('totally-unknown-arch-xyz', 7);
assertAgentStructured(unknown, 'unknown arch');
assert.strictEqual(
  resolveSamplingProfile(unknown, { agentToolLoop: true }).repeatPenalty,
  BASE_DEFAULTS.samplingStructuredOutput.repeatPenalty,
);

assert.strictEqual(resolveAgentDryRepeatPenalty(false), undefined);
const askOnly = resolveSamplingProfile(qwen35, { agentToolLoop: false, thinkingActive: true });
assert.strictEqual(askOnly.temperature, qwen35.sampling.temperature);
assert.strictEqual(resolveAgentDryRepeatPenalty(false), undefined);

console.log('samplingProfile.test.js OK');

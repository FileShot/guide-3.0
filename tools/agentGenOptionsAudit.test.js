'use strict';

/**
 * Audit: agent tool-loop sampling (repeatPenalty + DRY) is applied on genOptions for
 * the whole generateResponse call — node-llama-cpp does not split penalties between
 * thought and prose segments; one genOptions object drives both.
 *
 * guIDE skatepark log (2026-06-13): thoughtLen=3290, agent temp=0.6, repeatPenalty floor 1.12.
 */

const assert = require('assert');
const {
  getModelProfile,
  resolveSamplingProfile,
  resolveAgentDryRepeatPenalty,
} = require('../modelProfiles');

function buildAgentGenOptionsLikeChatEngine(modelProfile) {
  const sampling = resolveSamplingProfile(modelProfile, {
    agentToolLoop: true,
    thinkingActive: true,
  });
  const dryRepeatPenalty = resolveAgentDryRepeatPenalty(true);
  return {
    temperature: sampling.temperature ?? 0.4,
    topP: sampling.topP,
    topK: sampling.topK,
    repeatPenalty: {
      penalty: sampling.repeatPenalty ?? 1.1,
      frequencyPenalty: sampling.frequencyPenalty ?? 0,
      presencePenalty: sampling.presencePenalty ?? 0,
      lastTokens: sampling.lastTokensPenaltyCount ?? 128,
    },
    dryRepeatPenalty,
    budgets: { thoughtTokens: 2048 },
  };
}

const qwen4b = getModelProfile('qwen35', 4);
const opts = buildAgentGenOptionsLikeChatEngine(qwen4b);

assert.ok(opts.repeatPenalty.penalty >= 1.12, `repeatPenalty ${opts.repeatPenalty.penalty}`);
assert.ok(opts.dryRepeatPenalty, 'agent tool loop must set dryRepeatPenalty');
assert.strictEqual(opts.dryRepeatPenalty.strength, 0.8);
assert.strictEqual(opts.dryRepeatPenalty.lastTokens, 512);
assert.strictEqual(opts.budgets.thoughtTokens, 2048);
assert.strictEqual(opts.temperature, 0.6);

// Skatepark session used presencePenalty capped at 1.0 (structured output), not instruct 1.5
assert.ok(opts.repeatPenalty.presencePenalty <= 1.2);
assert.ok(opts.repeatPenalty.presencePenalty >= 1.0);

console.log('agentGenOptionsAudit.test.js OK');

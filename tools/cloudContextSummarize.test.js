'use strict';

const assert = require('assert');
const {
  SUMMARIZER_SYSTEM_PROMPT,
  SUMMARIZER_MODEL,
  isValidSummary,
  normalizeSummary,
  buildSummarizerUserPrompt,
  providerIsSecryptCloud,
  upgradeRotatedHistoryWithFastSummary,
} = require('./cloudContextSummarize');
const { NOTICE_MARK, fitCloudHistory } = require('./cloudContextFit');

assert.ok(SUMMARIZER_SYSTEM_PROMPT.includes('context compressor'));
assert.ok(SUMMARIZER_SYSTEM_PROMPT.includes('TASK:'));
assert.strictEqual(SUMMARIZER_MODEL, 'cipher-fast');
assert.ok(providerIsSecryptCloud('secrypt'));
assert.ok(providerIsSecryptCloud('cipher'));
assert.ok(!providerIsSecryptCloud('openai'));

assert.ok(isValidSummary('TASK: build shop\nDONE:\n- wrote index.html\nERRORS: none\nOPEN:\n- css\nNEXT: add styles'));
assert.ok(!isValidSummary('short'));
assert.ok(!isValidSummary('{"tool":"write_file","params":{}}'));
assert.ok(!isValidSummary('<think>planning</think>hello world without sections'));

const cleaned = normalizeSummary('<think>x</think>\nTASK: a\nDONE: b\nNEXT: c');
assert.ok(!cleaned.includes('<think>'));
assert.ok(cleaned.includes('TASK:'));

const userPrompt = buildSummarizerUserPrompt({
  droppedText: 'user: make a shop\nassistant: wrote index.html',
  taskHint: 'keep going',
  heuristicSummary: 'TASK:\nkeep going\nDONE:\nwrite_file → index.html',
  droppedCount: 4,
});
assert.ok(userPrompt.includes('Dropped turns: 4'));
assert.ok(userPrompt.includes('index.html'));

(async () => {
  const fat = 'x'.repeat(12000);
  const history = [];
  for (let i = 0; i < 8; i++) {
    history.push({ role: 'user', content: `turn ${i} ${fat}` });
    history.push({ role: 'assistant', content: `{"tool":"write_file","params":{"filePath":"src/f${i}.js"}}` });
  }
  const fit = fitCloudHistory({
    systemPrompt: 'sys',
    history,
    nextUser: 'continue the shop',
    contextLimit: 24576,
    outputTokens: 8192,
  });
  assert.ok(fit.droppedCount > 0);
  assert.ok(fit.history[0].content.includes(NOTICE_MARK));

  const phases = [];
  const fakeLlm = {
    async generate(prompt, opts) {
      assert.strictEqual(opts.model, 'cipher-fast');
      assert.strictEqual(opts.enableThinking, false);
      assert.strictEqual(opts.thinkingMode, 'off');
      assert.ok(String(opts.systemPrompt).includes('context compressor'));
      assert.ok(!String(opts.systemPrompt).includes('guIDE'));
      assert.deepStrictEqual(opts.conversationHistory, []);
      assert.ok(prompt.includes('Dropped'));
      return {
        text: 'TASK: continue the shop\nDONE:\n- wrote src/f0.js\nERRORS: none\nOPEN:\n- remaining pages\nNEXT: keep editing files',
      };
    },
  };

  const upgraded = await upgradeRotatedHistoryWithFastSummary({
    cloudLLM: fakeLlm,
    history: fit.history,
    droppedText: fit.droppedText,
    droppedCount: fit.droppedCount,
    taskHint: fit.nextUser,
    provider: 'secrypt',
    onPhase: (phase, text) => phases.push({ phase, text }),
  });
  assert.strictEqual(upgraded.usedLlm, true);
  assert.ok(upgraded.history[0].content.includes(NOTICE_MARK));
  assert.ok(upgraded.history[0].content.includes('continue the shop'));
  assert.ok(upgraded.history[0].content.includes('src/f0.js'));
  assert.deepStrictEqual(phases.map((p) => p.phase), ['start', 'done']);

  const skipped = await upgradeRotatedHistoryWithFastSummary({
    cloudLLM: fakeLlm,
    history: fit.history,
    droppedText: fit.droppedText,
    droppedCount: fit.droppedCount,
    taskHint: fit.nextUser,
    provider: 'openai',
    onPhase: () => {},
  });
  assert.strictEqual(skipped.usedLlm, false);
  assert.strictEqual(skipped.reason, 'non-secrypt');

  const fallbackLlm = {
    async generate() {
      return { text: 'nope' };
    },
  };
  const fbPhases = [];
  const fell = await upgradeRotatedHistoryWithFastSummary({
    cloudLLM: fallbackLlm,
    history: fit.history,
    droppedText: fit.droppedText,
    droppedCount: fit.droppedCount,
    taskHint: fit.nextUser,
    provider: 'cipher',
    onPhase: (phase) => fbPhases.push(phase),
  });
  assert.strictEqual(fell.usedLlm, false);
  assert.ok(fbPhases.includes('start') && fbPhases.includes('fallback'));

  console.log('cloudContextSummarize.test.js OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

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
const { NOTICE_MARK, fitCloudHistory, buildDroppedSummary } = require('./cloudContextFit');
const { textFromCompletionBody, parseCompletionBody } = require('../cloudLLMService');

const completion = JSON.stringify({
  choices: [{ message: { role: 'assistant', content: 'TASK: keep building\nDONE: read the plan\nERRORS: none\nOPEN: remaining files\nNEXT: write the next file' }, finish_reason: 'stop' }],
});
assert.ok(textFromCompletionBody(completion).includes('keep building'));
assert.strictEqual(parseCompletionBody(completion).stopReason, 'stop');
assert.strictEqual(textFromCompletionBody('{"choices":[{"message":{"content":"","reasoning_content":"TASK: from reasoning channel with enough detail to keep the task"}}]}').includes('from reasoning'), true);
assert.strictEqual(textFromCompletionBody(''), '');

assert.ok(SUMMARIZER_SYSTEM_PROMPT.includes('context compressor'));
assert.ok(SUMMARIZER_SYSTEM_PROMPT.includes('TASK:'));
assert.strictEqual(SUMMARIZER_MODEL, 'cipher-fast');
assert.ok(providerIsSecryptCloud('secrypt'));
assert.ok(providerIsSecryptCloud('cipher'));
assert.ok(!providerIsSecryptCloud('openai'));

assert.ok(isValidSummary('TASK: build shop\nDONE:\n- wrote index.html\nERRORS: none\nOPEN:\n- css\nNEXT: add styles'));
assert.ok(isValidSummary('The user asked to keep building. Files already read stay in the note. Next step is the remaining work.'));
assert.ok(!isValidSummary('short'));
assert.ok(!isValidSummary('{"tool":"write_file","params":{}}'));
assert.ok(!isValidSummary('<think>planning</think>hello world without sections'));

const cleaned = normalizeSummary('<think>x</think>\nTASK: a\nDONE: b\nNEXT: c');
assert.ok(!cleaned.includes('<think>'));
assert.ok(cleaned.includes('TASK:'));

const todos = [
  { id: 1, text: 'sign package', status: 'pending' },
  { id: 2, text: 'write installer', status: 'in-progress' },
  { id: 3, text: 'done step', status: 'done' },
];
const heuristicOpen = buildDroppedSummary(
  [{ role: 'user', content: 'ship' }, { role: 'assistant', content: 'working' }],
  'ship cipher7',
  todos,
);
assert.ok(heuristicOpen.includes('id 1: sign package'));
assert.ok(heuristicOpen.includes('id 2: write installer'));
assert.ok(!heuristicOpen.includes('id 3:'));

const userPrompt = buildSummarizerUserPrompt({
  droppedText: 'user: make a shop\nassistant: wrote index.html',
  taskHint: 'keep going',
  heuristicSummary: 'TASK:\nkeep going\nDONE:\nwrite_file → index.html',
  droppedCount: 4,
  activeTodos: todos,
});
assert.ok(userPrompt.includes('Dropped turns: 4'));
assert.ok(userPrompt.includes('index.html'));
assert.ok(userPrompt.includes('id 1: sign package'));
assert.ok(userPrompt.includes('id 2: write installer'));
assert.ok(userPrompt.includes('TODO LEDGER'));
assert.ok(SUMMARIZER_SYSTEM_PROMPT.includes('Never write OPEN: none'));

const emptyTodoPrompt = buildSummarizerUserPrompt({
  droppedText: 'user: finish the installer and sign the package\nassistant: wrote half of it',
  keptTailText: 'user: then ship it',
  taskHint: 'finish installer',
  heuristicSummary: 'TASK:\nfinish installer',
  droppedCount: 2,
  activeTodos: [],
});
assert.ok(emptyTodoPrompt.includes('empty'));
assert.ok(emptyTodoPrompt.includes('Do NOT write OPEN: none'));
assert.ok(emptyTodoPrompt.includes('Kept conversation tail'));
assert.ok(emptyTodoPrompt.includes('finish the installer'));

const noTodoHeuristic = buildDroppedSummary(
  [
    { role: 'user', content: 'build the shop and add checkout' },
    { role: 'assistant', content: 'I created index.html. Next I need styles and checkout.' },
  ],
  'build the shop',
  [],
);
assert.ok(noTodoHeuristic.includes('TODO LEDGER: empty'));
assert.ok(!/\bOPEN:\s*\nnone\b/i.test(noTodoHeuristic));
assert.ok(noTodoHeuristic.includes('DROPPED USER TURNS'));
assert.ok(noTodoHeuristic.includes('DROPPED ASSISTANT PROSE'));

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
    activeTodos: todos,
  });
  assert.ok(fit.droppedCount > 0);
  assert.ok(fit.history[0].content.includes(NOTICE_MARK));
  assert.ok(fit.history[0].content.includes('id 1: sign package'));

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
      assert.ok(prompt.includes('id 1: sign package'));
      return {
        text: 'TASK: continue the shop\nDONE:\n- wrote src/f0.js\nERRORS: none\nOPEN:\n- id 1: sign package [pending]\n- id 2: write installer [in-progress]\nNEXT: keep editing files',
        stopReason: 'stop',
      };
    },
  };

  const upgraded = await upgradeRotatedHistoryWithFastSummary({
    cloudLLM: fakeLlm,
    history: fit.history,
    droppedText: fit.droppedText,
    droppedCount: fit.droppedCount,
    taskHint: fit.nextUser,
    activeTodos: todos,
    provider: 'secrypt',
    onPhase: (phase, text) => phases.push({ phase, text }),
  });
  assert.strictEqual(upgraded.usedLlm, true);
  assert.ok(upgraded.history[0].content.includes(NOTICE_MARK));
  assert.ok(upgraded.history[0].content.includes('continue the shop'));
  assert.ok(upgraded.history[0].content.includes('src/f0.js'));
  assert.ok(upgraded.history[0].content.includes('sign package'));
  assert.deepStrictEqual(phases.map((p) => p.phase), ['start', 'done']);

  let continueCalls = 0;
  const continueLlm = {
    async generate(prompt) {
      continueCalls += 1;
      if (continueCalls === 1) {
        assert.ok(!prompt.includes('continue from the end') && !prompt.includes('Continue the progress note'));
        return { text: 'TASK: continue\nDONE:\n- Completed \'sign', stopReason: 'length' };
      }
      assert.ok(prompt.includes("Completed 'sign"));
      return {
        text: " package.json\nERRORS: none\nOPEN:\n- id 2: write installer\nNEXT: finish installer",
        stopReason: 'stop',
      };
    },
  };
  const continued = await upgradeRotatedHistoryWithFastSummary({
    cloudLLM: continueLlm,
    history: fit.history,
    droppedText: fit.droppedText,
    droppedCount: fit.droppedCount,
    taskHint: fit.nextUser,
    activeTodos: todos,
    provider: 'secrypt',
    onPhase: () => {},
  });
  assert.strictEqual(continued.usedLlm, true);
  assert.ok(continued.continueRounds >= 1);
  assert.ok(continued.summary.includes("Completed 'sign package.json"));
  assert.ok(continued.summary.includes('NEXT:'));

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

  // S9: live 2026-09-28 23:46–00:07 — 33 calls, 59,821-char note; prompt flat at 13,344 once the note passed 6,000 chars.
  // Length stops may continue a few times, but must stop once the note is usable —
  // never chase dropped-transcript size (live hang: 8+ continues toward 10k+ chars).
  const runawayPrompts = [];
  const runawayLlm = {
    _getModelContextLimit: () => 131072,
    async generate(prompt, opts) {
      runawayPrompts.push({ prompt, measured: opts.measuredPrompt || null });
      const n = runawayPrompts.length;
      return {
        text: `${n === 1 ? 'TASK: shop\nDONE:\n' : ''}- section ${n} ${'z'.repeat(480)}\n`,
        stopReason: 'length',
        promptTokens: Math.ceil((prompt.length + String(opts.systemPrompt).length) / 3.4),
        promptChars: prompt.length + String(opts.systemPrompt).length,
      };
    },
  };
  const runaway = await upgradeRotatedHistoryWithFastSummary({
    cloudLLM: runawayLlm,
    history: fit.history,
    droppedText: fit.droppedText,
    droppedCount: fit.droppedCount,
    taskHint: fit.nextUser,
    activeTodos: todos,
    provider: 'secrypt',
    onPhase: () => {},
  });
  const replaced = fit.droppedText.length;
  assert.strictEqual(runaway.usedLlm, true);
  assert.ok(runaway.summary.length >= 40, `usable note too short: ${runaway.summary.length}`);
  assert.ok(runaway.summary.length < replaced, `summary must stay shorter than dropped (${runaway.summary.length} vs ${replaced})`);
  assert.ok(runawayPrompts.length <= 4, `continue cap: got ${runawayPrompts.length} summarizer calls`);
  for (let i = 1; i < runawayPrompts.length; i += 1) {
    assert.ok(runawayPrompts[i].prompt.includes('TASK: shop\nDONE:\n- section 1 '), `continuation #${i} shows the whole note`);
    assert.ok(runawayPrompts[i].prompt.includes(`- section ${i} `), `continuation #${i} shows the latest chunk`);
    assert.ok(runawayPrompts[i].measured && runawayPrompts[i].measured.promptTokens > 0, 'continuations pass the measured prompt');
  }

  // S9 + S10: on the 2B's real 6,144-token slot every prompt fits, and the note plus the instruction are never cut.
  const { estimateTokens, inputBudgetTokens, measuredCost } = require('./cloudContextFit');
  const budget2b = inputBudgetTokens(6144, 512);
  const smallPrompts = [];
  const smallLlm = {
    _getModelContextLimit: (provider, model) => (model === 'cipher-fast' ? 6144 : 131072),
    async generate(prompt, opts) {
      const chars = prompt.length + String(opts.systemPrompt).length;
      const cost = measuredCost(opts.measuredPrompt, chars, estimateTokens(opts.systemPrompt) + estimateTokens(prompt));
      smallPrompts.push({ prompt, cost });
      const n = smallPrompts.length;
      return {
        text: `${n === 1 ? 'TASK: shop\nDONE:\n' : ''}- part ${n} ${'q'.repeat(300)}\n`,
        stopReason: 'length',
        promptTokens: Math.ceil(chars / 3.4),
        promptChars: chars,
      };
    },
  };
  const small = await upgradeRotatedHistoryWithFastSummary({
    cloudLLM: smallLlm,
    history: fit.history,
    droppedText: fit.droppedText,
    keptTailText: 'user: ' + 'k'.repeat(3900),
    droppedCount: fit.droppedCount,
    taskHint: fit.nextUser,
    activeTodos: todos,
    provider: 'secrypt',
    onPhase: () => {},
  });
  assert.strictEqual(small.usedLlm, true);
  for (let i = 0; i < smallPrompts.length; i += 1) {
    assert.ok(smallPrompts[i].cost <= budget2b, `prompt #${i} cost ${smallPrompts[i].cost} fits ${budget2b}`);
    if (i > 0) {
      assert.ok(smallPrompts[i].prompt.includes('TASK: shop\nDONE:\n- part 1 '), `2B continuation #${i} shows the whole note`);
      assert.ok(smallPrompts[i].prompt.endsWith('Continue the progress note now from the exact cut point.'));
    }
  }

  console.log('cloudContextSummarize.test.js OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

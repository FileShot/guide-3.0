'use strict';

const assert = require('assert');
const {
  fitCloudHistory,
  estimateTokens,
  inputBudgetTokens,
  NOTICE_MARK,
} = require('./cloudContextFit');

const contextLimit = 24576;
const outputTokens = 8192;
const budget = inputBudgetTokens(contextLimit, outputTokens);
assert.strictEqual(budget, 24576 - 8192 - 256);

const small = fitCloudHistory({
  systemPrompt: 'You are a coding agent.',
  history: [
    { role: 'user', content: 'create index.html' },
    { role: 'assistant', content: 'wrote index.html' },
  ],
  nextUser: 'now add css',
  contextLimit,
  outputTokens,
});
assert.strictEqual(small.droppedCount, 0);
assert.strictEqual(small.history.length, 2);
assert.strictEqual(small.nextUser, 'now add css');

const fat = 'x'.repeat(estimateTokens('x') * 4000);
const history = [];
for (let i = 0; i < 12; i++) {
  history.push({ role: 'user', content: `turn ${i} ${fat}` });
  history.push({ role: 'assistant', content: `{"tool":"write_file","params":{"filePath":"src/file${i}.js"}} ${fat}` });
}
const fitted = fitCloudHistory({
  systemPrompt: 'system',
  history,
  nextUser: 'keep going on the shop',
  contextLimit,
  outputTokens,
});
assert.ok(fitted.droppedCount > 0, 'over-budget history must drop turns');
assert.ok(fitted.history[0].content.includes(NOTICE_MARK));
assert.ok(fitted.history[0].content.includes('file0.js') || fitted.history[0].content.includes('write_file'));
const used = estimateTokens('system')
  + estimateTokens(fitted.nextUser)
  + fitted.history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
assert.ok(used <= budget, `fitted ${used} tokens over budget ${budget}`);

const again = fitCloudHistory({
  systemPrompt: 'system',
  history: fitted.history,
  nextUser: fitted.nextUser,
  contextLimit,
  outputTokens,
});
assert.strictEqual(again.droppedCount, 0);

console.log('cloudContextFit.test.js OK', { dropped: fitted.droppedCount, used, budget });

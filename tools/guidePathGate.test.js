'use strict';

const assert = require('assert');
const {
  checkGuideMetadataPathGate,
  checkPlanModeToolGate,
} = require('../agentModeResolver');

function guideGate(tool, params) {
  return checkGuideMetadataPathGate(tool, params);
}

// Allowed metadata paths
assert.strictEqual(guideGate('write_file', { filePath: '.guide/plans/foo.plan.md' }).allowed, true);
assert.strictEqual(guideGate('write_file', { filePath: '.guide/rules/my-rule.md' }).allowed, true);
assert.strictEqual(guideGate('write_file', { filePath: '.guide-scratch/context-state.md' }).allowed, true);
assert.strictEqual(guideGate('create_directory', { path: '.guide/plans' }).allowed, true);
assert.strictEqual(guideGate('create_directory', { path: '.guide/rules' }).allowed, true);

// Block application source under .guide/plans
for (const fp of [
  '.guide/plans/index.html',
  '.guide/plans/style.css',
  'D:\\proj\\.guide\\plans\\index.html',
]) {
  const r = guideGate('write_file', { filePath: fp });
  assert.strictEqual(r.allowed, false, `expected block for ${fp}`);
  assert.match(r.error, /project root/i);
}

assert.strictEqual(guideGate('edit_file', { filePath: '.guide/plans/data.js' }).allowed, false);
assert.strictEqual(guideGate('delete_file', { filePath: '.guide/checkpoints/x' }).allowed, false);
assert.strictEqual(guideGate('create_directory', { path: '.guide/foo' }).allowed, false);

// Read tools are not gated here
assert.strictEqual(guideGate('read_file', { filePath: '.guide/plans/index.html' }).allowed, true);

// Plan mode still stricter than guide gate
const planBlock = checkPlanModeToolGate('write_file', { filePath: 'index.html' }, { planMode: true, agentPhase: 'planning' });
assert.strictEqual(planBlock.allowed, false);

console.log('guidePathGate.test.js OK');

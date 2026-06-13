'use strict';

const assert = require('assert');
const { buildTodoProgressHint, _sanitizeFileSnippetText } = require('../chatEngine');

// buildTodoProgressHint
assert.strictEqual(buildTodoProgressHint([], ['read_file']), '');
assert.strictEqual(buildTodoProgressHint([{ id: 1, text: 'A', status: 'done' }], ['read_file']), '');
const hint = buildTodoProgressHint(
  [{ id: 1, text: 'Scaffold HTML', status: 'in-progress' }, { id: 2, text: 'Add CSS', status: 'pending' }],
  ['write_file'],
  3,
);
assert(hint.includes('Active todo list'), hint);
assert(hint.includes('id 1: Scaffold HTML'), hint);
assert(hint.includes('update_todo'), hint);
assert(hint.includes('several tools ran without update_todo'), hint);
assert.strictEqual(buildTodoProgressHint([{ id: 1, text: 'A', status: 'pending' }], ['update_todo']), '');

// After write_todos: no prefix (tool result line carries reminder; short fallback removed)
assert.strictEqual(
  buildTodoProgressHint(
    [{ id: 1, text: 'Step one', status: 'in-progress' }, { id: 2, text: 'Step two', status: 'pending' }],
    ['write_todos'],
  ),
  '',
);

// All todos done: no prefix
assert.strictEqual(
  buildTodoProgressHint(
    [{ id: 1, text: 'Done step', status: 'done' }],
    ['write_file'],
  ),
  '',
);

// Mid-build without update_todo: detailed hint still fires
const midBuild = buildTodoProgressHint(
  [{ id: 1, text: 'Scaffold', status: 'in-progress' }],
  ['read_file'],
);
assert(midBuild.includes('[System: Active todo list'), midBuild);
assert(!midBuild.includes('mark completed items with update_todo(id'), midBuild);

// _sanitizeFileSnippetText
const raw = 'Build the page\n\n[Current file: D:\\proj\\index.html]\n<!DOCTYPE html>\n/* Rese';
const sanitized = _sanitizeFileSnippetText(raw);
assert(sanitized.includes('snippet only'), sanitized);
assert(sanitized.includes('index.html'), sanitized);
assert(!sanitized.includes('<!DOCTYPE'), sanitized);

console.log('todoDigestHelpers.test.js OK');

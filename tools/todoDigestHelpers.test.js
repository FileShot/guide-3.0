'use strict';

const assert = require('assert');
const { buildTodoProgressHint, _sanitizeFileSnippetText } = require('../chatEngine');

// buildTodoProgressHint — structural ledger only (no coaching English)
assert.strictEqual(buildTodoProgressHint([], ['read_file']), '');
assert.strictEqual(buildTodoProgressHint([{ id: 1, text: 'A', status: 'done' }], ['read_file']), '');
const hint = buildTodoProgressHint(
  [{ id: 1, text: 'Scaffold HTML', status: 'in-progress' }, { id: 2, text: 'Add CSS', status: 'pending' }],
  ['write_file'],
  3,
);
assert(hint.includes('Active todo list'), hint);
assert(hint.includes('id 1: Scaffold HTML'), hint);
assert(!hint.includes('If you finished a step'), hint);
assert(!hint.includes('several tools ran without update_todo'), hint);
assert(!/call update_todo/i.test(hint), hint);
assert.strictEqual(buildTodoProgressHint([{ id: 1, text: 'A', status: 'pending' }], ['update_todo']).includes('id 1:'), true);
assert(buildTodoProgressHint([{ id: 1, text: 'A', status: 'pending' }], ['update_todo']).includes('Active todo list'));

// After write_todos: no prefix (tool result already carries the list)
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

// Mid-build without update_todo: ledger dump only
const midBuild = buildTodoProgressHint(
  [{ id: 1, text: 'Scaffold', status: 'in-progress' }],
  ['read_file'],
);
assert(midBuild.includes('[System: Active todo list'), midBuild);
assert(!midBuild.includes('mark completed items with update_todo(id'), midBuild);
assert(!/Do not end/i.test(midBuild), midBuild);

// _sanitizeFileSnippetText
const raw = 'Build the page\n\n[Current file: D:\\proj\\index.html]\n<!DOCTYPE html>\n/* Rese';
const sanitized = _sanitizeFileSnippetText(raw);
assert(sanitized.includes('snippet only'), sanitized);
assert(sanitized.includes('index.html'), sanitized);
assert(!sanitized.includes('<!DOCTYPE'), sanitized);

console.log('todoDigestHelpers.test.js OK');

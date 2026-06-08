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

// _sanitizeFileSnippetText
const raw = 'Build the page\n\n[Current file: D:\\proj\\index.html]\n<!DOCTYPE html>\n/* Rese';
const sanitized = _sanitizeFileSnippetText(raw);
assert(sanitized.includes('snippet only'), sanitized);
assert(sanitized.includes('index.html'), sanitized);
assert(!sanitized.includes('<!DOCTYPE'), sanitized);

console.log('todoDigestHelpers.test.js OK');

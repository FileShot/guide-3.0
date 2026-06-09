'use strict';

const assert = require('assert');
const { canonicalizeToolParams } = require('./canonicalizeToolParams');
const { MCPToolServer } = require('../mcpToolServer');

// canonicalize: todos → items, title/description → text
const canon = canonicalizeToolParams('write_todos', {
  items: [
    { id: 1, title: 'Hero Section', description: 'Build landing hero', status: 'pending' },
    { id: 2, title: 'Footer', description: 'Add footer links', status: 'pending' },
  ],
});
assert.strictEqual(canon.items.length, 2);
assert.strictEqual(canon.items[0].text, 'Hero Section: Build landing hero');
assert.strictEqual(canon.items[1].text, 'Footer: Add footer links');

const canonTodos = canonicalizeToolParams('write_todos', {
  todos: ['Step one', 'Step two'],
});
assert.deepStrictEqual(canonTodos.items, ['Step one', 'Step two']);

// executor: model-shaped payload creates todos
const server = new MCPToolServer({ projectPath: process.cwd() });
const result = server._writeTodos(canon);
assert.strictEqual(result.success, true, JSON.stringify(result));
assert.strictEqual(result.created.length, 2);
assert.strictEqual(result.created[0].text, 'Hero Section: Build landing hero');
assert.strictEqual(result.created[0].status, 'in-progress');

// empty-after-normalize returns failure
const badCanon = canonicalizeToolParams('write_todos', {
  items: [{ title: '', description: '' }],
});
const bad = server._writeTodos(badCanon);
assert.strictEqual(bad.success, false);
assert(bad.error.includes('No valid todo items'), bad.error);

console.log('writeTodos.test.js OK');

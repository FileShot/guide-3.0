'use strict';
const { isCursorAdmin, assertCursorAdmin } = require('../cursorAdminGate');
const assert = require('assert');

assert.strictEqual(isCursorAdmin({ email: 'brendan36363@gmail.com' }), true);
assert.strictEqual(isCursorAdmin({ email: 'Brendan36363@Gmail.com' }), true);
assert.strictEqual(isCursorAdmin({ email: 'user@graysoft.dev' }), false);
assert.strictEqual(isCursorAdmin({ email: 'merklegarland@gmail.com' }), false);
assert.throws(
  () => assertCursorAdmin({ email: 'other@x.com' }),
  (e) => e.code === 'CURSOR_ADMIN_ONLY'
);
console.log('cursorAdminGate.test OK');

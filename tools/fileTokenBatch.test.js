'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const FILE_TOKEN_FLUSH_MS = 16;

describe('fileTokenBatch', () => {
  it('coalesces rapid appends into one flush per 16ms window', async () => {
    let flushes = 0;
    let buffer = '';
    let timer = null;

    const flush = () => {
      flushes += 1;
      buffer = '';
      timer = null;
    };

    const append = (chunk) => {
      if (!buffer) {
        buffer = chunk;
        timer = setTimeout(flush, FILE_TOKEN_FLUSH_MS);
      } else {
        buffer += chunk;
      }
    };

    for (let i = 0; i < 200; i++) append('x');
    assert.equal(flushes, 0, 'no flush before timer');
    assert.equal(buffer.length, 200);

    await new Promise((r) => setTimeout(r, FILE_TOKEN_FLUSH_MS + 8));
    assert.equal(flushes, 1, 'single flush after coalesce window');
    assert.equal(buffer, '');
  });

  it('multiple windows produce multiple flushes', async () => {
    let flushes = 0;
    let buffer = '';
    let timer = null;

    const flush = () => {
      flushes += 1;
      buffer = '';
      timer = null;
    };

    const append = (chunk) => {
      if (!buffer) {
        buffer = chunk;
        timer = setTimeout(flush, FILE_TOKEN_FLUSH_MS);
      } else {
        buffer += chunk;
      }
    };

    append('aaa');
    await new Promise((r) => setTimeout(r, FILE_TOKEN_FLUSH_MS + 8));
    append('bbb');
    await new Promise((r) => setTimeout(r, FILE_TOKEN_FLUSH_MS + 8));
    assert.equal(flushes, 2);
  });
});

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { jsonStringChunkDecode } = require('./jsonStringChunkDecode');

describe('jsonStringChunkDecode', () => {
  it('decodes This intact', () => {
    const r = jsonStringChunkDecode('This is a complete', false);
    assert.equal(r.out, 'This is a complete');
    assert.equal(r.ended, false);
  });

  it('decodes </html> intact', () => {
    const r = jsonStringChunkDecode('</html>', false);
    assert.equal(r.out, '</html>');
  });

  it('decodes </script> intact', () => {
    const r = jsonStringChunkDecode('</script>', false);
    assert.equal(r.out, '</script>');
  });

  it('preserves backslash on invalid escape (not swallow)', () => {
    const r = jsonStringChunkDecode(String.raw`th\is`, false);
    assert.equal(r.out, String.raw`th\is`);
  });

  it('does not drop characters on split invalid escape (th\\ + s)', () => {
    const a = jsonStringChunkDecode('th\\', false);
    assert.equal(a.out, 'th');
    assert.equal(a.escPending, true);
    const b = jsonStringChunkDecode('s', a.escPending);
    assert.equal(a.out + b.out, String.raw`th\s`);
    assert.notEqual(a.out + b.out, 'ths');
  });

  it('ends on closing quote', () => {
    const r = jsonStringChunkDecode('hello"', false);
    assert.equal(r.out, 'hello');
    assert.equal(r.ended, true);
  });
});

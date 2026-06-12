'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createJsonStringStreamState,
  jsonStringStreamStep,
  jsonStringChunkDecode,
} = require('./jsonStringChunkDecode');

function streamChars(chars, initialState) {
  let state = initialState || createJsonStringStreamState();
  let out = '';
  let ended = false;
  let endReason = null;
  for (const ch of chars) {
    const step = jsonStringStreamStep(ch, state);
    state = step.state;
    out += step.out;
    if (step.ended) {
      ended = true;
      endReason = step.endReason;
      break;
    }
  }
  return { out, state, ended, endReason };
}

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
    const b = jsonStringChunkDecode('s', a.state);
    assert.equal(a.out + b.out, String.raw`th\s`);
    assert.notEqual(a.out + b.out, 'ths');
  });

  it('ends on structural close quote before }', () => {
    const r = jsonStringChunkDecode('hello"}', false);
    assert.equal(r.out, 'hello');
    assert.equal(r.ended, true);
    assert.equal(r.endReason, 'structural-close');
  });

  it('ends on structural close quote before comma', () => {
    const r = jsonStringChunkDecode('hello",', false);
    assert.equal(r.out, 'hello');
    assert.equal(r.ended, true);
  });

  it('keeps interior HTML quotes charset="UTF-8"', () => {
    const seq = 'charset="UTF-8">';
    const r = streamChars(seq);
    assert.equal(r.out, 'charset="UTF-8">');
    assert.equal(r.ended, false);
  });

  it('keeps interior quotes across chunk boundaries', () => {
    const a = jsonStringChunkDecode('charset=', false);
    const b = jsonStringChunkDecode('"UTF-8">', a.state);
    assert.equal(a.out + b.out, 'charset="UTF-8">');
    assert.equal(b.ended, false);
  });

  it('decodes escaped lang attribute in HTML', () => {
    const r = jsonStringChunkDecode('<html lang=\\"en\\">', false);
    assert.equal(r.out, '<html lang="en">');
    assert.equal(r.ended, false);
  });
});

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractPartialWriteFileFromToolJson,
  normalizeStreamingFilePath,
} = require('./toolParser');

describe('normalizeStreamingFilePath', () => {
  it('strips trailing backslash', () => {
    assert.equal(normalizeStreamingFilePath('D:\\proj\\style.css\\'), 'D:\\proj\\style.css');
  });

  it('strips trailing forward slash', () => {
    assert.equal(normalizeStreamingFilePath('src/app/'), 'src/app');
  });
});

describe('extractPartialWriteFileFromToolJson', () => {
  const prefix = '{"tool":"write_file","params":{"filePath":"index.html","content":"';

  it('keeps JS keys["left"], intact in partial buffer', () => {
    const partial = `${prefix}const keys = { left: 1 }; input.keys["left"], more`;
    const r = extractPartialWriteFileFromToolJson(partial);
    assert.ok(r);
    assert.equal(r.filePath, 'index.html');
    assert.equal(r.content, 'const keys = { left: 1 }; input.keys["left"], more');
  });

  it('keeps HTML charset="UTF-8" intact', () => {
    const partial = `${prefix}<meta charset="UTF-8"><title>Hi`;
    const r = extractPartialWriteFileFromToolJson(partial);
    assert.ok(r);
    assert.equal(r.content, '<meta charset="UTF-8"><title>Hi');
  });

  it('returns growing prefix on truncated buffer', () => {
    const a = extractPartialWriteFileFromToolJson(`${prefix}line1`);
    const b = extractPartialWriteFileFromToolJson(`${prefix}line1\\nline2`);
    assert.ok(a);
    assert.ok(b);
    assert.equal(a.content, 'line1');
    assert.equal(b.content, 'line1\nline2');
    assert.ok(b.content.length > a.content.length);
  });

  it('strips complete JSON suffix when requested', () => {
    const complete = `${prefix}done"}}`;
    const r = extractPartialWriteFileFromToolJson(complete, { stripCompleteSuffix: true });
    assert.ok(r);
    assert.equal(r.content, 'done');
  });

  it('normalizes filePath with trailing backslash', () => {
    const partial = '{"tool":"write_file","params":{"filePath":"D:\\\\proj\\\\style.css\\\\","content":"body{';
    const r = extractPartialWriteFileFromToolJson(partial);
    assert.ok(r);
    assert.equal(r.filePath, 'D:\\proj\\style.css');
    assert.equal(r.content, 'body{');
  });

  it('returns null when content field not started', () => {
    const r = extractPartialWriteFileFromToolJson('{"tool":"write_file","params":{"filePath":"a.txt"');
    assert.equal(r, null);
  });

  it('stops at merged JSON reason field boundary', () => {
    const partial = `${prefix}body{color:red}","reason":"Creating full HTML file"}]`;
    const r = extractPartialWriteFileFromToolJson(partial);
    assert.ok(r);
    assert.equal(r.content, 'body{color:red}');
    assert.ok(!r.content.includes('reason'));
  });

  it('stops at merged tool field boundary in script.js blob', () => {
    const partial = '{"tool":"write_file","params":{"filePath":"script.js","content":"","reason":"Creating main game logic"}';
    const r = extractPartialWriteFileFromToolJson(partial);
    assert.ok(r);
    assert.equal(r.content, '');
  });

  it('strips JSON close suffix and fence backticks from HTML tail', () => {
    const partial = `${prefix}</div>"},\n\`\`\``;
    const r = extractPartialWriteFileFromToolJson(partial, { stripCompleteSuffix: true });
    assert.ok(r);
    assert.equal(r.content, '</div>');
    assert.ok(!r.content.includes('"},'));
    assert.ok(!r.content.includes('`'));
  });

  it('stops at quote-comma tail without closing brace', () => {
    const partial = `${prefix}</div>",`;
    const r = extractPartialWriteFileFromToolJson(partial);
    assert.ok(r);
    assert.equal(r.content, '</div>');
    assert.ok(!r.content.includes('",'));
  });

  it('stops at structural JSON close without strip flag during live delta', () => {
    const partial = `${prefix}</div>"},`;
    const r = extractPartialWriteFileFromToolJson(partial);
    assert.ok(r);
    assert.equal(r.content, '</div>');
  });
});

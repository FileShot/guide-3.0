'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function canonicalizeStreamingFilePath(filePath) {
  if (!filePath) return '';
  return String(filePath).trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').replace(/\/+/g, '/');
}

function findActiveStreamingFileBlockIndex(blocks, fileKey) {
  if (!Array.isArray(blocks) || blocks.length === 0) return -1;
  if (fileKey) {
    const keyedIdx = blocks.findIndex((b) => b.fileKey === fileKey && !b.complete);
    if (keyedIdx !== -1) return keyedIdx;
  }
  for (let idx = blocks.length - 1; idx >= 0; idx--) {
    if (!blocks[idx].complete) return idx;
  }
  return -1;
}

function addCompleteLegacy(blocks, segs, { filePath, fileName, content }) {
  const normalizedKey = canonicalizeStreamingFilePath(filePath);
  let existingIdx = blocks.findIndex((b) => b.fileKey === normalizedKey);
  if (existingIdx === -1) {
    existingIdx = findActiveStreamingFileBlockIndex(blocks, normalizedKey);
  }
  if (existingIdx === -1 && fileName) {
    existingIdx = blocks.findIndex(
      (b) => !b.complete && (b.fileName === fileName || (b.filePath && b.filePath.endsWith(fileName))),
    );
  }
  if (existingIdx !== -1) {
    blocks[existingIdx] = {
      ...blocks[existingIdx],
      filePath,
      fileKey: normalizedKey,
      fileName,
      content: String(content),
      complete: true,
    };
    return existingIdx;
  }
  const fileIndex = blocks.length;
  blocks.push({
    filePath,
    fileKey: normalizedKey,
    fileName,
    content: String(content),
    complete: true,
  });
  segs.push({ type: 'file', index: fileIndex });
  return fileIndex;
}

function addCompleteFixed(blocks, segs, { filePath, fileName, content }) {
  const normalizedKey = canonicalizeStreamingFilePath(filePath);
  const existingIdx = blocks.findIndex(
    (b) => b.fileKey === normalizedKey
      || canonicalizeStreamingFilePath(b.filePath) === normalizedKey,
  );
  if (existingIdx !== -1) {
    blocks[existingIdx] = {
      ...blocks[existingIdx],
      filePath,
      fileKey: normalizedKey,
      fileName,
      content: String(content),
      complete: true,
    };
    return existingIdx;
  }
  const fileIndex = blocks.length;
  blocks.push({
    filePath,
    fileKey: normalizedKey,
    fileName,
    content: String(content),
    complete: true,
  });
  segs.push({ type: 'file', index: fileIndex });
  return fileIndex;
}

describe('streamingBlockPreserve', () => {
  it('legacy addComplete overwrites unrelated in-progress index.html with style.css', () => {
    const blocks = [{
      filePath: 'index.html',
      fileKey: 'index.html',
      fileName: 'index.html',
      content: '<!DOCTYPE html><html>'.repeat(100),
      complete: false,
    }];
    const segs = [{ type: 'file', index: 0 }];
    addCompleteLegacy(blocks, segs, {
      filePath: 'style.css',
      fileName: 'style.css',
      content: 'body { color: red; }',
    });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].filePath, 'style.css');
    assert.notEqual(blocks[0].content.includes('<!DOCTYPE html>'), true);
  });

  it('fixed addComplete keeps index.html and adds style.css separately', () => {
    const blocks = [{
      filePath: 'index.html',
      fileKey: 'index.html',
      fileName: 'index.html',
      content: '<!DOCTYPE html><html>'.repeat(100),
      complete: false,
    }];
    const segs = [{ type: 'file', index: 0 }];
    addCompleteFixed(blocks, segs, {
      filePath: 'style.css',
      fileName: 'style.css',
      content: 'body { color: red; }',
    });
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].filePath, 'index.html');
    assert.ok(blocks[0].content.includes('<!DOCTYPE html>'));
    assert.equal(blocks[1].filePath, 'style.css');
    assert.equal(segs.length, 2);
    assert.equal(segs[1].index, 1);
  });
});

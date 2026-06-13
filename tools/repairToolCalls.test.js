'use strict';

const assert = require('assert');
const {
  repairToolCalls,
  parseToolCalls,
  _inferFilePath,
  _looksLikeRealFilePath,
} = require('./toolParser');

function writeCall(filePath, content) {
  return { tool: 'write_file', params: { filePath, content } };
}

// Bare root filenames are valid paths
assert.strictEqual(_looksLikeRealFilePath('server.js'), true);
assert.strictEqual(_looksLikeRealFilePath('index.html'), true);
assert.strictEqual(_looksLikeRealFilePath('data/articles.json'), true);
assert.strictEqual(_looksLikeRealFilePath('public/admin.html'), true);

// _inferFilePath must never return output.txt
const expressBody = "const express = require('express');\napp.listen(3000);";
assert.strictEqual(_inferFilePath('', expressBody), 'server.js');
assert.strictEqual(_inferFilePath('', '<!DOCTYPE html><html></html>'), 'index.html');
assert.strictEqual(_inferFilePath('noise', 'just some text'), null);
assert.notStrictEqual(_inferFilePath('', expressBody), 'output.txt');

const paths = ['server.js', 'index.html', 'data/articles.json', 'public/admin.html'];
for (const fp of paths) {
  const content = fp.endsWith('.html') ? '<html></html>' : 'const x = 1;';
  const { repaired } = repairToolCalls([writeCall(fp, content)], `writing ${fp}`);
  assert.strictEqual(repaired[0].params.filePath, fp, `repair must not rewrite ${fp}`);
}

// Parsed path must survive repair even when inference would differ
const serverCall = writeCall('server.js', expressBody);
const { repaired: fixedCalls } = repairToolCalls([serverCall], 'create backend');
assert.strictEqual(fixedCalls[0].params.filePath, 'server.js');

// Missing path: infer from HTML content
const noPath = { tool: 'write_file', params: { content: '<!DOCTYPE html><html><body>hi</body></html>' } };
const { repaired: inferredCalls } = repairToolCalls([noPath], '');
assert.strictEqual(inferredCalls[0].params.filePath, 'index.html');

// Missing path with uninferable content → dropped
const { repaired: dropped } = repairToolCalls([{ tool: 'write_file', params: { content: 'x' } }], '');
assert.strictEqual(dropped.length, 0);

// Metadata-only merged JSON blob → dropped (not executed as file body)
const metadataBlob = '","reason":"Creating main game logic file with three parts"}]\n';
const { repaired: metaDropped } = repairToolCalls(
  [writeCall('script.js', metadataBlob)],
  'tool json fragment',
);
assert.strictEqual(metaDropped.length, 0);

console.log('repairToolCalls.test.js: all passed');

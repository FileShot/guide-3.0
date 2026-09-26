'use strict';

const assert = require('assert');
const {
  parseToolCalls,
  looksLikeToolAttempt,
  stripToolCallText,
} = require('./toolParser');

const jsonFence = '```json\n{"tool":"read_file","params":{"filePath":"src/index.js"}}\n```';
const jsonCalls = parseToolCalls(jsonFence);
assert.strictEqual(jsonCalls.length, 1);
assert.strictEqual(jsonCalls[0].tool, 'read_file');
assert.strictEqual(jsonCalls[0].params.filePath, 'src/index.js');

const cleanQwen =
  'Love this challenge.\n'
  + '<function=list_directory>\n'
  + '<parameter=dirPath>\n.\n</parameter>\n'
  + '</function>';
assert.ok(looksLikeToolAttempt(cleanQwen));
const qwenCalls = parseToolCalls(cleanQwen);
assert.strictEqual(qwenCalls.length, 1, JSON.stringify(qwenCalls));
assert.strictEqual(qwenCalls[0].tool, 'list_directory');
assert.strictEqual(qwenCalls[0].params.dirPath, '.');
const stripped = stripToolCallText(cleanQwen);
assert.ok(!stripped.includes('<function='), stripped);
assert.ok(stripped.includes('Love this challenge'));

const mangled =
  'Love this challenge. Let me first look.\n'
  + '<function=list_directory>\n'
  + '<parameter=dirPath>\n'
  + '.\n'
  + '</parameter>\n'
  + '</function>-" && (git --version 2>nul || echo no-git) </parameter>\n'
  + '<parameter=reason>\n'
  + 'Check Node, npm, and git versions to pick a compatible stack.\n'
  + '</parameter>\n'
  + '</function>';
assert.ok(looksLikeToolAttempt(mangled));
const mangledCalls = parseToolCalls(mangled);
assert.ok(mangledCalls.some((c) => c.tool === 'list_directory'), JSON.stringify(mangledCalls));
const mangledStrip = stripToolCallText(mangled);
assert.ok(!mangledStrip.includes('<function=list_directory>'), mangledStrip);

const runCmd =
  '<function=run_command>\n'
  + '<parameter=command>\nnode --version\n</parameter>\n'
  + '</function>';
const runCalls = parseToolCalls(runCmd);
assert.strictEqual(runCalls.length, 1);
assert.strictEqual(runCalls[0].tool, 'run_command');
assert.ok(String(runCalls[0].params.command).includes('node --version'));

console.log('qwenFunctionXml.test.js OK', {
  json: jsonCalls[0].tool,
  qwen: qwenCalls[0].tool,
  mangled: mangledCalls.map((c) => c.tool),
});

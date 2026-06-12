'use strict';

/**
 * Post-run gate for agent skatepark validation.
 * Usage: node tools/agentTurnLogGate.js [path/to/guide-main.log]
 * Default log: %APPDATA%/guide-ide/logs/guide-main.log
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const logPath = process.argv[2] || path.join(
  process.env.APPDATA || path.join(os.homedir(), '.config'),
  'guide-ide',
  'logs',
  'guide-main.log',
);

if (!fs.existsSync(logPath)) {
  console.error(`FAIL: log not found: ${logPath}`);
  process.exit(1);
}

const text = fs.readFileSync(logPath, 'utf8');
const lines = text.split(/\r?\n/);

const createDirCalls = [];
const toolRe = /Tool call #\d+: create_directory\((\{[^}]+\})\)/;
let writeFileSeen = false;
let presence15 = false;

for (const line of lines) {
  if (/presencePenalty.:1\.5/.test(line) || /"presencePenalty":1\.5/.test(line)) {
    presence15 = true;
  }
  const m = line.match(toolRe);
  if (m) createDirCalls.push(m[1]);
  if (/Tool call #\d+: write_file/.test(line)) writeFileSeen = true;
}

let createBeforeWrite = 0;
for (const line of lines) {
  if (/Tool call #\d+: write_file/.test(line)) break;
  if (toolRe.test(line)) createBeforeWrite++;
}

let maxRepeat = 1;
let streak = 1;
for (let i = 1; i < createDirCalls.length; i++) {
  if (createDirCalls[i] === createDirCalls[i - 1]) {
    streak++;
    maxRepeat = Math.max(maxRepeat, streak);
  } else {
    streak = 1;
  }
}

const rotInStream = /sunPosRot{3,}|lookAtRot{3,}/.test(text);

const checks = [
  { name: 'no presencePenalty 1.5 in trace', ok: !presence15 },
  { name: `create_directory <= 5 before write_file (got ${createBeforeWrite})`, ok: !writeFileSeen || createBeforeWrite <= 5 },
  { name: 'write_file reached', ok: writeFileSeen },
  { name: `identical create_directory streak <= 2 (got ${maxRepeat})`, ok: maxRepeat <= 2 },
  { name: 'no Rot degenerate loop in log', ok: !rotInStream },
];

let failed = 0;
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}: ${c.name}`);
  if (!c.ok) failed++;
}

if (failed > 0) {
  console.error(`\nagentTurnLogGate: ${failed} check(s) failed — do not tag release`);
  process.exit(1);
}
console.log('\nagentTurnLogGate: all checks passed — OK to tag v0.4.61');

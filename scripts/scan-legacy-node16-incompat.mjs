#!/usr/bin/env node
/** Fail if tree has Node-20-only syntax (Electron 22 legacy = Node 16). */
'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

function findAppDirFromArgv() {
  const idx = process.argv.indexOf('--app-dir');
  if (idx === -1 || !process.argv[idx + 1]) {
    console.error('Usage: --app-dir <resources/app>');
    process.exit(2);
  }
  return path.resolve(process.argv[idx + 1]);
}

function walkJs(dir, files = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'llama' || ent.name === '.bin') continue;
      walkJs(full, files);
    } else if (ent.name.endsWith('.js') || ent.name.endsWith('.mjs')) {
      files.push(full);
    }
  }
  return files;
}

function findStringWidthIndexFiles(nm) {
  const out = [];
  for (const file of walkJs(nm)) {
    if (file.endsWith(`${path.sep}string-width${path.sep}index.js`)) out.push(file);
  }
  return out;
}

const appDir = findAppDirFromArgv();
const nm = path.join(appDir, 'node_modules');
if (!fs.existsSync(nm)) {
  console.error('[scan-legacy-node16] missing node_modules');
  process.exit(1);
}

const offenders = [];
const importAttr = /import\s+[\s\S]*?\bwith\s*\{\s*type\s*:\s*['"]json['"]\s*\}/;
const stringWidthV = /\/v;|\)\$\/v/;

for (const file of walkJs(nm)) {
  const rel = path.relative(appDir, file);
  const text = fs.readFileSync(file, 'utf8');
  if (importAttr.test(text)) offenders.push(`${rel}: import attributes (need Node 20+)`);
}

for (const file of findStringWidthIndexFiles(nm)) {
  const rel = path.relative(appDir, file);
  const text = fs.readFileSync(file, 'utf8');
  if (stringWidthV.test(text)) offenders.push(`${rel}: RegExp /v flag (need Node 20+)`);
}

if (offenders.length) {
  console.error('[scan-legacy-node16] FAIL:\n' + offenders.join('\n'));
  process.exit(1);
}
console.log('[scan-legacy-node16] OK');

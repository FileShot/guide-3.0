#!/usr/bin/env node
/**
 * Pre-flight: enumerate every Node-20-only construct on the getLlama import path.
 * Run after npm ci + prepare-legacy-runtime, before electron-builder.
 */
'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(ROOT, 'node_modules');

const importAttr = /import\s+[\s\S]*?\bwith\s*\{\s*type\s*:\s*['"]json['"]\s*\}/;
const stringWidthV = /\/v;|\)\$\/v/;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === '.bin' || ent.name === 'llama') continue;
      walk(full, out);
    } else if (ent.name.endsWith('.js') || ent.name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

const llamaPkg = path.join(NM, 'node-llama-cpp', 'package.json');
if (!fs.existsSync(llamaPkg)) {
  console.error('[audit-legacy-node16] run npm ci first');
  process.exit(1);
}

const engines = JSON.parse(fs.readFileSync(llamaPkg, 'utf8')).engines?.node;
console.log(`[audit-legacy-node16] node-llama-cpp engines.node=${engines}`);

const scanRoots = [
  path.join(NM, 'node-llama-cpp'),
  path.join(NM, 'stdout-update'),
  path.join(NM, 'ora'),
  path.join(NM, 'cli-spinners'),
].filter((d) => fs.existsSync(d));

const offenders = [];
for (const root of scanRoots) {
  for (const file of walk(root)) {
    const rel = path.relative(ROOT, file);
    const text = fs.readFileSync(file, 'utf8');
    if (importAttr.test(text)) offenders.push(`${rel}: import attributes`);
    if (rel.includes(`${path.sep}string-width${path.sep}index.js`)) {
      if (stringWidthV.test(text)) offenders.push(`${rel}: string-width /v flag`);
    }
  }
}

const ev = path.join(ROOT, 'build', 'legacy-electron-version.txt');
if (fs.existsSync(ev)) {
  const v = fs.readFileSync(ev, 'utf8').trim();
  const major = parseInt(v.split('.')[0], 10);
  console.log(`[audit-legacy-node16] legacy-electron-version=${v}`);
  if (major > 22) offenders.push(`legacy-electron-version.txt: Electron ${v} > 22 (Haswell SIGILL risk)`);
}

if (offenders.length) {
  console.error('[audit-legacy-node16] BLOCKERS (patch before package):\n' + offenders.join('\n'));
  process.exit(1);
}

console.log('[audit-legacy-node16] workspace OK — still patch --app-dir after electron-builder --dir');

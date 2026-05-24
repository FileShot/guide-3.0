#!/usr/bin/env node
/**
 * Electron 22 = Node 16. node-llama-cpp 3.18 needs patches for cli-spinners + string-width@8 (/v flag).
 * Must run on the tree that ships: use --app-dir dist-electron/linux-unpacked/resources/app after --dir build.
 */
'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function log(msg) {
  console.log(`[patch-legacy-node16] ${msg}`);
}

function resolveNodeModulesRoot() {
  const appIdx = process.argv.indexOf('--app-dir');
  if (appIdx !== -1 && process.argv[appIdx + 1]) {
    return path.join(path.resolve(process.argv[appIdx + 1]), 'node_modules');
  }
  return path.join(ROOT, 'node_modules');
}

function patchCliSpinners(file) {
  if (!fs.existsSync(file)) return false;
  const needle = "import spinners from './spinners.json' with {type: 'json'};";
  const replacement = `import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const spinners = require('./spinners.json');`;
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes('with {type: \'json\'}')) return false;
  fs.writeFileSync(file, text.replace(needle, replacement), 'utf8');
  log(`patched cli-spinners: ${file}`);
  return true;
}

function stringWidthNeedsPatch(text) {
  return /\/v;/.test(text) || /\)\$\/v/.test(text);
}

function patchStringWidth(file) {
  if (!fs.existsSync(file)) return false;
  let text = fs.readFileSync(file, 'utf8');
  if (!stringWidthNeedsPatch(text)) return false;

  text = text.replace(
    /const zeroWidthClusterRegex = \/[\s\S]*?\/v;/,
    "const zeroWidthClusterRegex = /^(?:\\p{Default_Ignorable_Code_Point}|\\p{Control}|\\p{Format}|\\p{Mark}|\\p{Surrogate})+$/u;",
  );
  text = text.replace(
    /const leadingNonPrintingRegex = \/[\s\S]*?\/v;/,
    "const leadingNonPrintingRegex = /^[\\p{Default_Ignorable_Code_Point}\\p{Control}\\p{Format}\\p{Mark}\\p{Surrogate}]+/u;",
  );
  text = text.replace(
    /const rgiEmojiRegex = \/[\s\S]*?\/v;/,
    "const rgiEmojiRegex = /^\\p{Extended_Pictographic}(?:\\uFE0F)?$/u;",
  );

  if (stringWidthNeedsPatch(text)) {
    throw new Error(`string-width still has /v flag after patch: ${file}`);
  }
  fs.writeFileSync(file, text, 'utf8');
  log(`patched string-width: ${file}`);
  return true;
}

function findAllIndexJs(dir, name, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === '.bin' || ent.name === 'llama' || ent.name === '.cache') continue;
      findAllIndexJs(full, name, out);
    } else if (ent.isFile() && ent.name === 'index.js' && full.includes(`${path.sep}${name}${path.sep}`)) {
      out.push(full);
    }
  }
  return out;
}

const nmRoot = resolveNodeModulesRoot();
log(`scanning ${nmRoot}`);

const stringWidthFiles = findAllIndexJs(nmRoot, 'string-width');
const spinnerFiles = findAllIndexJs(nmRoot, 'cli-spinners');
let stringWidthFixed = 0;
let spinnersFixed = 0;

for (const file of stringWidthFiles) {
  if (patchStringWidth(file)) stringWidthFixed++;
}
for (const file of spinnerFiles) {
  if (patchCliSpinners(file)) spinnersFixed++;
}

const pending = stringWidthFiles.filter((f) => stringWidthNeedsPatch(fs.readFileSync(f, 'utf8')));
if (pending.length) {
  console.error('[patch-legacy-node16] FAIL: unpatched string-width still has /v:\n' + pending.join('\n'));
  process.exit(1);
}

log(
  `done: cli-spinners=${spinnersFixed} string-width=${stringWidthFixed} ` +
    `(paths: ${spinnerFiles.length} spinners, ${stringWidthFiles.length} string-width)`,
);

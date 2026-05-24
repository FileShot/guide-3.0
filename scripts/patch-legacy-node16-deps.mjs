#!/usr/bin/env node
/**
 * Electron 22 bundles Node 16. node-llama-cpp 3.18 pulls ora/stdout-update → string-width@8
 * which uses RegExp /v and \p{RGI_Emoji} (Node 20+). Patch for legacy packaging only.
 */
'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function log(msg) {
  console.log(`[patch-legacy-node16] ${msg}`);
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

/** string-width@7+ uses /v; Node 16 only accepts flags through /u. */
function patchStringWidth(file) {
  if (!fs.existsSync(file)) return false;
  let text = fs.readFileSync(file, 'utf8');
  if (!/\/v;/.test(text)) return false;

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

  if (/\/v;/.test(text)) {
    throw new Error(`string-width still has /v flag after patch: ${file}`);
  }
  fs.writeFileSync(file, text, 'utf8');
  log(`patched string-width: ${file}`);
  return true;
}

function walkStringWidthAndSpinners(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === '.bin' || ent.name === 'llama') continue;
      walkStringWidthAndSpinners(full, out);
    } else if (ent.name === 'index.js' && /[\\/]string-width[\\/]/.test(full)) {
      out.push(full);
    } else if (ent.name === 'index.js' && /[\\/]cli-spinners[\\/]/.test(full)) {
      out.push(full);
    }
  }
  return out;
}

const spinnersFixed = [
  path.join(ROOT, 'node_modules', 'node-llama-cpp', 'node_modules', 'cli-spinners', 'index.js'),
  path.join(ROOT, 'node_modules', 'cli-spinners', 'index.js'),
].filter((f) => patchCliSpinners(f));

const targets = walkStringWidthAndSpinners(path.join(ROOT, 'node_modules'));
let stringWidthFixed = 0;
for (const file of targets) {
  if (/[\\/]string-width[\\/]/.test(file) && patchStringWidth(file)) stringWidthFixed++;
}

if (!spinnersFixed.length && !stringWidthFixed) {
  log('warn: no files patched (already patched or node_modules missing?)');
} else {
  log(`done: cli-spinners=${spinnersFixed.length} string-width=${stringWidthFixed}`);
}

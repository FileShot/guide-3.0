#!/usr/bin/env node
/**
 * node-llama-cpp 3.18.1 addon calls cpu_get_num_math(); b9253 common uses common_cpu_get_num_math().
 */
'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADDON_DIR = path.join(ROOT, 'node_modules', 'node-llama-cpp', 'llama', 'addon');

function log(msg) {
  console.log(`[patch-llama-addon-api] ${msg}`);
}

if (!fs.existsSync(ADDON_DIR)) {
  log(`skip — no ${ADDON_DIR}`);
  process.exit(0);
}

let files = 0;
for (const name of fs.readdirSync(ADDON_DIR)) {
  if (!/\.(cpp|h|hpp)$/.test(name)) continue;
  const filePath = path.join(ADDON_DIR, name);
  const src = fs.readFileSync(filePath, 'utf8');
  let next = src.replace(/common_common_cpu_get_num_math/g, 'common_cpu_get_num_math');
  if (!next.includes('cpu_get_num_math')) {
    if (next !== src) fs.writeFileSync(filePath, next);
    continue;
  }
  next = next.replace(/\b(?<!common_)cpu_get_num_math\b/g, 'common_cpu_get_num_math');
  fs.writeFileSync(filePath, next);
  files += 1;
  log(`patched ${name}`);
}

log(files ? `done (${files} file(s))` : 'no cpu_get_num_math references found');

#!/usr/bin/env node
/** Node 18 (Electron 22–28) cannot parse `import … with { type: 'json' }` in cli-spinners. */
'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  path.join(ROOT, 'node_modules', 'node-llama-cpp', 'node_modules', 'cli-spinners', 'index.js'),
  path.join(ROOT, 'node_modules', 'cli-spinners', 'index.js'),
];

const needle = "import spinners from './spinners.json' with {type: 'json'};";
const replacement = `import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const spinners = require('./spinners.json');`;

for (const file of targets) {
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes('with {type: \'json\'}')) {
    console.log(`[patch-cli-spinners] skip (already patched): ${file}`);
    continue;
  }
  fs.writeFileSync(file, text.replace(needle, replacement), 'utf8');
  console.log(`[patch-cli-spinners] patched ${file}`);
}

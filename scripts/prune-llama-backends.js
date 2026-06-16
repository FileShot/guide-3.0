#!/usr/bin/env node
'use strict';

/**
 * Remove unused @node-llama-cpp platform backends before packaging.
 * Keeps installer size under NSIS mmap limits on Windows.
 *
 * Usage: node scripts/prune-llama-backends.js --cuda | --cpu
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LLAMA_BACKENDS = path.join(ROOT, 'node_modules', '@node-llama-cpp');

const PROFILES = {
  cuda: ['win-x64-cuda'],
  cpu: ['win-x64', 'win-x64-vulkan'],
};

function main() {
  const mode = process.argv.includes('--cuda') ? 'cuda' : process.argv.includes('--cpu') ? 'cpu' : null;
  if (!mode) {
    console.error('Usage: node scripts/prune-llama-backends.js --cuda | --cpu');
    process.exit(1);
  }
  if (!fs.existsSync(LLAMA_BACKENDS)) {
    console.warn('[prune-llama-backends] @node-llama-cpp not installed — skip');
    return;
  }
  const keep = new Set(PROFILES[mode]);
  let removed = 0;
  for (const name of fs.readdirSync(LLAMA_BACKENDS, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    if (keep.has(name.name)) {
      console.log(`[prune-llama-backends] keep ${name.name}`);
      continue;
    }
    const dir = path.join(LLAMA_BACKENDS, name.name);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[prune-llama-backends] removed ${name.name}`);
    removed += 1;
  }
  console.log(`[prune-llama-backends] ${mode}: kept ${[...keep].join(', ')} (${removed} removed)`);
}

main();

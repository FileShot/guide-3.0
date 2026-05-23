#!/usr/bin/env node
/**
 * Full legacy Linux prep: llama CUDA/CPU source build, native module rebuild, legacy Electron dist.
 *
 * Usage:
 *   node scripts/prepare-legacy-linux.mjs [--cuda]
 */
'use strict';

import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const useCuda = process.argv.includes('--cuda');

function run(script, args = []) {
  const r = spawnSync(process.execPath, [path.join('scripts', script), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log(`[prepare-legacy-linux] cuda=${useCuda}`);
run('fetch-legacy-electron.mjs');
run('prepare-legacy-runtime.mjs', useCuda ? ['--cuda'] : []);
run('rebuild-native-modules-legacy.mjs');
console.log('[prepare-legacy-linux] done');

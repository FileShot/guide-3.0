#!/usr/bin/env node
/**
 * Legacy installer prep: compile node-llama-cpp for old x86_64 (Haswell / x86-64-v2),
 * then remove npm prebuilt @node-llama-cpp packages so packaged apps cannot load
 * AVX-512 / -march=native binaries from the registry.
 *
 * Usage:
 *   node scripts/prepare-legacy-runtime.mjs           # CPU legacy
 *   node scripts/prepare-legacy-runtime.mjs --cuda    # CUDA legacy
 */
'use strict';

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BACKENDS = path.join(ROOT, 'node_modules', '@node-llama-cpp');

const useCuda = process.argv.includes('--cuda');
const profile = useCuda ? 'cuda-x86-64-v2' : 'x86-64-v2';

function log(msg) {
  console.log(`[prepare-legacy] ${msg}`);
}

function run(cmd, args, env = {}) {
  log(`${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: false,
  });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

log(`profile=${profile} (linux/windows legacy — x86-64-v2 baseline, no prebuilt fallback)`);

run(process.execPath, [path.join('scripts', 'rebuild-llama-runtime.mjs'), '--profile', profile], {
  LLAMA_CPP_RELEASE: process.env.LLAMA_CPP_RELEASE || 'b8954',
});

if (fs.existsSync(BACKENDS)) {
  for (const name of fs.readdirSync(BACKENDS)) {
    const full = path.join(BACKENDS, name);
    if (fs.statSync(full).isDirectory()) {
      fs.rmSync(full, { recursive: true, force: true });
      log(`removed prebuilt package @node-llama-cpp/${name}`);
    }
  }
} else {
  log('no @node-llama-cpp folder (optional deps missing — local build only)');
}

log('done — packaged app will use source-built llama.cpp binary only');

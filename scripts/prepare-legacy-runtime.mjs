#!/usr/bin/env node
/**
 * Legacy installer prep: compile node-llama-cpp for Haswell-class CPUs, then remove
 * only the matching npm prebuilt package(s) so the packaged app cannot load modern
 * -march=native / AVX-512 binaries from the registry.
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
/** haswell / cuda-haswell: GGML_NATIVE=OFF, -march=haswell (AVX2, no ADX). Proven in rebuild-llama-runtime.mjs. */
const profile = useCuda ? 'cuda-haswell' : 'haswell';

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

function prebuiltPackagesToRemove() {
  if (process.platform === 'linux') {
    return useCuda ? ['linux-x64-cuda', 'linux-x64-cuda-ext'] : ['linux-x64-vulkan', 'linux-x64'];
  }
  if (process.platform === 'win32') {
    return useCuda ? ['win-x64-cuda', 'win-x64-cuda-ext'] : ['win-x64-vulkan', 'win-x64'];
  }
  return [];
}

log(`profile=${profile} platform=${process.platform} cuda=${useCuda}`);

run(process.execPath, [path.join('scripts', 'rebuild-llama-runtime.mjs'), '--profile', profile], {
  LLAMA_CPP_RELEASE: process.env.LLAMA_CPP_RELEASE || 'b8954',
});

const llamaDir = path.join(ROOT, 'node_modules', 'node-llama-cpp', 'llama');
if (!fs.existsSync(llamaDir)) {
  console.error('[prepare-legacy] node-llama-cpp/llama missing after build');
  process.exit(1);
}

const localBuilds = path.join(llamaDir, 'localBuilds');
if (!fs.existsSync(localBuilds)) {
  console.error('[prepare-legacy] localBuilds/ missing — source build did not produce a binary');
  process.exit(1);
}

for (const pkg of prebuiltPackagesToRemove()) {
  const full = path.join(BACKENDS, pkg);
  if (fs.existsSync(full)) {
    fs.rmSync(full, { recursive: true, force: true });
    log(`removed @node-llama-cpp/${pkg}`);
  }
}

log('done — legacy build uses local source-built llama.cpp only');

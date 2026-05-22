#!/usr/bin/env node
/**
 * Download pinned llama.cpp, compile node-llama-cpp native addon, verify gemma4 arch.
 *
 * Usage:
 *   node scripts/rebuild-llama-runtime.mjs [--profile default|haswell|cuda|cuda-haswell]
 *
 * Env:
 *   LLAMA_CPP_RELEASE — llama.cpp tag (default b9253)
 *   GITHUB_TOKEN — optional, avoids GitHub API rate limits in CI
 */
'use strict';

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RELEASE = process.env.LLAMA_CPP_RELEASE || 'b9253';

const PROFILES = {
  default: {},
  haswell: {
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_NATIVE: 'OFF',
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_AVX: 'ON',
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_AVX2: 'ON',
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_FMA: 'ON',
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_F16C: 'ON',
    ...(process.platform === 'win32'
      ? {
          NODE_LLAMA_CPP_CMAKE_OPTION_DCMAKE_CXX_FLAGS: '/arch:AVX2',
          NODE_LLAMA_CPP_CMAKE_OPTION_DCMAKE_C_FLAGS: '/arch:AVX2',
        }
      : {
          NODE_LLAMA_CPP_CMAKE_OPTION_DCMAKE_CXX_FLAGS: '-march=haswell',
          NODE_LLAMA_CPP_CMAKE_OPTION_DCMAKE_C_FLAGS: '-march=haswell',
        }),
  },
  cuda: {
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_CUDA: 'ON',
  },
  'cuda-haswell': {
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_NATIVE: 'OFF',
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_CUDA: 'ON',
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_AVX: 'ON',
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_AVX2: 'ON',
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_FMA: 'ON',
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_F16C: 'ON',
    ...(process.platform === 'win32'
      ? {
          NODE_LLAMA_CPP_CMAKE_OPTION_DCMAKE_CXX_FLAGS: '/arch:AVX2',
          NODE_LLAMA_CPP_CMAKE_OPTION_DCMAKE_C_FLAGS: '/arch:AVX2',
        }
      : {
          NODE_LLAMA_CPP_CMAKE_OPTION_DCMAKE_CXX_FLAGS: '-march=haswell',
          NODE_LLAMA_CPP_CMAKE_OPTION_DCMAKE_C_FLAGS: '-march=haswell',
        }),
  },
};

function log(msg) {
  console.log(`[rebuild-llama] ${msg}`);
}

function parseProfile(argv) {
  const idx = argv.indexOf('--profile');
  if (idx === -1 || !argv[idx + 1]) return 'default';
  const p = argv[idx + 1];
  if (!PROFILES[p]) {
    console.error(`Unknown profile "${p}". Use: ${Object.keys(PROFILES).join(', ')}`);
    process.exit(1);
  }
  return p;
}

const NLC_CLI = path.join(ROOT, 'node_modules', 'node-llama-cpp', 'dist', 'cli', 'cli.js');

function run(cmd, args, extraEnv = {}) {
  log(`${cmd} ${args.join(' ')}`);
  const env = { ...process.env, ...extraEnv };
  const r = spawnSync(cmd, args, { cwd: ROOT, env, stdio: 'inherit', shell: false });
  if (r.status !== 0) {
    console.error(`[rebuild-llama] exited ${r.status}: ${cmd} ${args.join(' ')}`);
    if (r.stderr) console.error(r.stderr.toString());
    process.exit(r.status ?? 1);
  }
}

function runNlc(subcmd, extraEnv = {}) {
  if (!fs.existsSync(NLC_CLI)) {
    console.error(`[rebuild-llama] missing CLI at ${NLC_CLI}`);
    process.exit(1);
  }
  run(process.execPath, [NLC_CLI, ...subcmd], extraEnv);
}

const profileName = parseProfile(process.argv.slice(2));
const profileEnv = PROFILES[profileName];

log(`profile=${profileName} release=${RELEASE} platform=${process.platform}`);

runNlc(['source', 'download', '--release', RELEASE], profileEnv);
run('node', [path.join('scripts', 'verify-llama-gemma4.mjs')], { LLAMA_CPP_RELEASE: RELEASE });
runNlc(['source', 'build'], profileEnv);
run('node', [path.join('scripts', 'verify-llama-gemma4.mjs')], { LLAMA_CPP_RELEASE: RELEASE });

log('done');

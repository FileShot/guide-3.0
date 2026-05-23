#!/usr/bin/env node
/**
 * Download pinned llama.cpp, compile node-llama-cpp native addon, verify gemma4 arch.
 *
 * Usage:
 *   node scripts/rebuild-llama-runtime.mjs [--profile default|haswell|cuda|cuda-haswell|x86-64-v2|cuda-x86-64-v2] [--legacy]
 *
 * Env:
 *   LLAMA_CPP_RELEASE — llama.cpp tag (default b9253)
 *   GITHUB_TOKEN — optional, passed to curl for tarball download
 */
'use strict';

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// Legacy/source builds must match node-llama-cpp@3.18.1 bundled glue (b9253).
const RELEASE = process.env.LLAMA_CPP_RELEASE || 'b9253';

// b8954+ common/ uses std::string_view; builds need C++17 explicitly.
const CXX17 = {
  NODE_LLAMA_CPP_CMAKE_OPTION_DCMAKE_CXX_STANDARD: '17',
  NODE_LLAMA_CPP_CMAKE_OPTION_DCMAKE_CXX_STANDARD_REQUIRED: 'ON',
};

/** MSVC needs /std:c++17; profile arch flags must not replace it. */
function winCxxFlags(archFlag = '') {
  const base = '/std:c++17 /Zc:__cplusplus';
  return archFlag ? `${base} ${archFlag}` : base;
}

/** --ciMode turns on GGML_BACKEND_DL + CPU_ALL_VARIANTS, which breaks -lcommon on Linux source builds. */
const LEGACY_SOURCE_OPTS = {
  NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_BACKEND_DL: 'OFF',
  NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_CPU_ALL_VARIANTS: 'OFF',
};

const GPU_FOR_PROFILE = {
  default: 'false',
  haswell: 'false',
  cuda: 'cuda',
  'cuda-haswell': 'cuda',
  'x86-64-v2': 'false',
  'cuda-x86-64-v2': 'cuda',
};

/** Oldest supported desktop CPUs (Haswell / x86-64-v2). No AVX-512, no -march=native. */
const X86_64_V2_FLAGS = {
  NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_NATIVE: 'OFF',
  NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_AVX: 'OFF',
  NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_AVX2: 'OFF',
  NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_AVX512: 'OFF',
  NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_FMA: 'OFF',
  NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_F16C: 'OFF',
  ...(process.platform === 'win32'
    ? {
        NODE_LLAMA_CPP_CMAKE_OPTION_DCMAKE_CXX_FLAGS: winCxxFlags('/arch:SSE2'),
        NODE_LLAMA_CPP_CMAKE_OPTION_DCMAKE_C_FLAGS: '/arch:SSE2',
      }
    : {
        NODE_LLAMA_CPP_CMAKE_OPTION_DCMAKE_CXX_FLAGS: '-march=x86-64-v2 -mtune=generic',
        NODE_LLAMA_CPP_CMAKE_OPTION_DCMAKE_C_FLAGS: '-march=x86-64-v2 -mtune=generic',
      }),
};

const PROFILES = {
  default: {
    ...CXX17,
    ...(process.platform === 'win32'
      ? { NODE_LLAMA_CPP_CMAKE_OPTION_DCMAKE_CXX_FLAGS: winCxxFlags() }
      : {}),
  },
  haswell: {
    ...CXX17,
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_NATIVE: 'OFF',
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_AVX: 'ON',
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_AVX2: 'ON',
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_FMA: 'ON',
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_F16C: 'ON',
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_AVX512: 'OFF',
    ...(process.platform === 'win32'
      ? {
          NODE_LLAMA_CPP_CMAKE_OPTION_DCMAKE_CXX_FLAGS: winCxxFlags('/arch:AVX2'),
          NODE_LLAMA_CPP_CMAKE_OPTION_DCMAKE_C_FLAGS: '/arch:AVX2',
        }
      : {
          NODE_LLAMA_CPP_CMAKE_OPTION_DCMAKE_CXX_FLAGS: '-march=haswell',
          NODE_LLAMA_CPP_CMAKE_OPTION_DCMAKE_C_FLAGS: '-march=haswell',
        }),
  },
  cuda: {
    ...CXX17,
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_CUDA: 'ON',
  },
  'cuda-haswell': {
    ...CXX17,
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_NATIVE: 'OFF',
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_CUDA: 'ON',
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_AVX: 'ON',
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_AVX2: 'ON',
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_FMA: 'ON',
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_F16C: 'ON',
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_AVX512: 'OFF',
    ...(process.platform === 'win32'
      ? {
          NODE_LLAMA_CPP_CMAKE_OPTION_DCMAKE_CXX_FLAGS: winCxxFlags('/arch:AVX2'),
          NODE_LLAMA_CPP_CMAKE_OPTION_DCMAKE_C_FLAGS: '/arch:AVX2',
        }
      : {
          NODE_LLAMA_CPP_CMAKE_OPTION_DCMAKE_CXX_FLAGS: '-march=haswell',
          NODE_LLAMA_CPP_CMAKE_OPTION_DCMAKE_C_FLAGS: '-march=haswell',
        }),
  },
  'x86-64-v2': {
    ...CXX17,
    ...X86_64_V2_FLAGS,
  },
  'cuda-x86-64-v2': {
    ...CXX17,
    ...X86_64_V2_FLAGS,
    NODE_LLAMA_CPP_CMAKE_OPTION_DGGML_CUDA: 'ON',
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

const argv = process.argv.slice(2);
const profileName = parseProfile(argv);
const legacyMode = argv.includes('--legacy');
const profileEnv = PROFILES[profileName];

log(
  `profile=${profileName} release=${RELEASE} platform=${process.platform} legacy=${legacyMode}`,
);

const gpu = GPU_FOR_PROFILE[profileName];
if (legacyMode) {
  // npm ci --ignore-scripts skips postinstall; fetch the release node-llama-cpp expects (b9253 layout).
  runNlc(['source', 'download', '--release', RELEASE, '--skipBuild', '--gpu', gpu], { CI: 'true' });
  run('node', [path.join('scripts', 'patch-llama-addon-api.mjs')]);
} else {
  run('node', [path.join('scripts', 'download-llama-cpp-tarball.mjs')], { LLAMA_CPP_RELEASE: RELEASE });
}
run('node', [path.join('scripts', 'verify-llama-gemma4.mjs')], { LLAMA_CPP_RELEASE: RELEASE });
const nlcArgs = ['source', 'build', '--gpu', gpu];
if (!legacyMode) {
  nlcArgs.push('--ciMode');
}
runNlc(nlcArgs, {
  ...profileEnv,
  ...(legacyMode ? LEGACY_SOURCE_OPTS : {}),
  CI: 'true',
  NODE_LLAMA_CPP_GPU: gpu,
});
run('node', [path.join('scripts', 'verify-llama-gemma4.mjs')], { LLAMA_CPP_RELEASE: RELEASE });

log('done');

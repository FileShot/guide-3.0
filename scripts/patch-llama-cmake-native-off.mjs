#!/usr/bin/env node
/**
 * Force GGML_NATIVE=OFF in every ggml/CMakeLists.txt found under the node-llama-cpp llama
 * source tree, using `set(... CACHE ... FORCE)` BEFORE the option() declaration.
 *
 * Why this is needed:
 *   node-llama-cpp passes cmake options as env vars with a naming convention that accidentally
 *   creates cmake variable `DGGML_NATIVE` (with leading D) instead of `GGML_NATIVE`.
 *   As a result, cmake's `option(GGML_NATIVE ... ${GGML_NATIVE_DEFAULT})` always uses the
 *   default value, which is ON when not cross-compiling (i.e. on every CI runner).
 *   With GGML_NATIVE=ON, ggml detects the CI runner's CPU at compile time and emits
 *   post-Haswell instructions (AVX-512 / ZMM registers) that SIGILL on real i7-4790 hardware.
 *
 * This patch inserts `set(GGML_NATIVE OFF CACHE BOOL "" FORCE)` immediately before the
 * `option(GGML_NATIVE ...)` line.  CMake's FORCE keyword overrides any existing cache entry.
 * The SOURCE_DATE_EPOCH=1 env var (set by rebuild-llama-runtime.mjs) is a belt; this is the
 * suspenders.
 */
'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NEEDLE = `option(GGML_NATIVE "ggml: optimize the build for the current system"`;
const INJECTION = `# guIDE legacy patch: force off — CI runner may have AVX-512, Haswell does not\nset(GGML_NATIVE OFF CACHE BOOL "ggml: optimize the build for the current system" FORCE)\n`;

function log(msg) {
  console.log(`[patch-llama-cmake-native-off] ${msg}`);
}

const CANDIDATES = [
  path.join(ROOT, 'node_modules', 'node-llama-cpp', 'llama', 'ggml', 'CMakeLists.txt'),
  path.join(ROOT, 'node_modules', 'node-llama-cpp', 'llama', 'llama.cpp', 'ggml', 'CMakeLists.txt'),
];

let patched = 0;
const seen = new Set();

for (const file of CANDIDATES) {
  if (!fs.existsSync(file)) {
    log(`skip (not found): ${file}`);
    continue;
  }
  const real = fs.realpathSync(file);
  if (seen.has(real)) {
    log(`skip (symlink dupe): ${file}`);
    continue;
  }
  seen.add(real);

  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes(NEEDLE)) {
    log(`skip (needle not found): ${file}`);
    continue;
  }
  if (src.includes('guIDE legacy patch')) {
    log(`already patched: ${file}`);
    patched++;
    continue;
  }
  const next = src.replace(NEEDLE, INJECTION + NEEDLE);
  if (next === src) {
    log(`WARN: replace produced no change in ${file}`);
    continue;
  }
  fs.writeFileSync(file, next, 'utf8');
  log(`patched: ${file}`);
  patched++;
}

if (patched === 0) {
  console.error('[patch-llama-cmake-native-off] FAIL: no ggml CMakeLists.txt patched');
  process.exit(1);
}
log(`done — ${patched} file(s) patched`);

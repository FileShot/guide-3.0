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

// ggml-cpu/CMakeLists.txt builds libggml-cpu.so as a dynamically loaded backend.
// It inherits arch flags from the parent scope. If GGML_NATIVE leaks through, the
// CI runner's CPU feature detection compiles AVX-512 into libggml-cpu.so which then
// SIGILLs on Haswell at createContext time (not at getLlama() time, so CI missed it).
// Patch: insert set(GGML_NATIVE OFF CACHE BOOL "" FORCE) at the top of each ggml-cpu cmake.
const CPU_NEEDLE = `function(ggml_add_cpu_backend_features`;
const CPU_INJECTION = `# guIDE legacy patch: force GGML_NATIVE off in ggml-cpu variants\nset(GGML_NATIVE OFF CACHE BOOL "ggml: optimize the build for the current system" FORCE)\n`;

function log(msg) {
  console.log(`[patch-llama-cmake-native-off] ${msg}`);
}

const CANDIDATES = [
  path.join(ROOT, 'node_modules', 'node-llama-cpp', 'llama', 'ggml', 'CMakeLists.txt'),
  path.join(ROOT, 'node_modules', 'node-llama-cpp', 'llama', 'llama.cpp', 'ggml', 'CMakeLists.txt'),
];

const CPU_CANDIDATES = [
  path.join(ROOT, 'node_modules', 'node-llama-cpp', 'llama', 'ggml', 'src', 'ggml-cpu', 'CMakeLists.txt'),
  path.join(ROOT, 'node_modules', 'node-llama-cpp', 'llama', 'llama.cpp', 'ggml', 'src', 'ggml-cpu', 'CMakeLists.txt'),
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

// Also patch ggml-cpu/CMakeLists.txt — this controls libggml-cpu.so, which is
// dlopen'd at createContext() time and was the *actual* source of the Haswell SIGILL
// (offset 0x37e3b4f in guide-ide process, caused by AVX-512 code in libggml-cpu.so).
let cpuPatched = 0;
for (const file of CPU_CANDIDATES) {
  if (!fs.existsSync(file)) {
    log(`cpu: skip (not found): ${file}`);
    continue;
  }
  const real = fs.realpathSync(file);
  if (seen.has(real)) {
    log(`cpu: skip (symlink dupe): ${file}`);
    continue;
  }
  seen.add(real);

  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes(CPU_NEEDLE)) {
    log(`cpu: skip (needle not found): ${file}`);
    continue;
  }
  if (src.includes('guIDE legacy patch')) {
    log(`cpu: already patched: ${file}`);
    cpuPatched++;
    continue;
  }
  const next = src.replace(CPU_NEEDLE, CPU_INJECTION + CPU_NEEDLE);
  if (next === src) {
    log(`cpu: WARN: replace produced no change in ${file}`);
    continue;
  }
  fs.writeFileSync(file, next, 'utf8');
  log(`cpu: patched: ${file}`);
  cpuPatched++;
}

if (cpuPatched === 0) {
  console.error('[patch-llama-cmake-native-off] FAIL: no ggml-cpu CMakeLists.txt patched (libggml-cpu.so would get native flags)');
  process.exit(1);
}

log(`done — ${patched} ggml + ${cpuPatched} ggml-cpu file(s) patched`);

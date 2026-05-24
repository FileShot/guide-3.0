#!/usr/bin/env node
/**
 * Fail if a legacy llama source build left GGML_NATIVE=ON in CMakeCache.txt.
 * Catches the v0.3.132 class of bug before packaging.
 */
'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_BUILDS = path.join(ROOT, 'node_modules', 'node-llama-cpp', 'llama', 'localBuilds');

function log(msg) {
  console.log(`[assert-legacy-ggml-cache] ${msg}`);
}

function findCMakeCaches(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) findCMakeCaches(full, out);
    else if (ent.name === 'CMakeCache.txt') out.push(full);
  }
  return out;
}

const caches = findCMakeCaches(LOCAL_BUILDS);
if (!caches.length) {
  console.error('[assert-legacy-ggml-cache] FAIL: no CMakeCache.txt under localBuilds/');
  process.exit(1);
}

let failed = false;
for (const cache of caches) {
  const text = fs.readFileSync(cache, 'utf8');
  const rel = path.relative(ROOT, cache);
  const nativeOn = /^GGML_NATIVE:BOOL=ON$/m.test(text);
  const nativeDefaultOn = /^GGML_NATIVE_DEFAULT:BOOL=ON$/m.test(text);
  if (nativeOn) {
    console.error(`[assert-legacy-ggml-cache] FAIL: ${rel} has GGML_NATIVE:BOOL=ON`);
    failed = true;
  } else {
    log(`OK: ${rel} GGML_NATIVE=OFF`);
  }
  if (nativeDefaultOn) {
    log(`note: ${rel} GGML_NATIVE_DEFAULT=ON (acceptable if GGML_NATIVE=OFF)`);
  }
}

if (failed) process.exit(1);
log('done');

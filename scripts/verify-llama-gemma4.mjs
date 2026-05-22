#!/usr/bin/env node
/**
 * Fail the build if downloaded llama.cpp source does not declare gemma4 architecture.
 * Run after `node-llama-cpp source download` (and ideally after source build).
 */
'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LLAMA_SRC = path.join(ROOT, 'node_modules', 'node-llama-cpp', 'llama');
const ARCH_CPP = path.join(LLAMA_SRC, 'src', 'llama-arch.cpp');
const INFO_JSON = path.join(LLAMA_SRC, 'llama.cpp.info.json');

function fail(msg) {
  console.error(`[verify-llama-gemma4] FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`[verify-llama-gemma4] OK: ${msg}`);
}

if (!fs.existsSync(ARCH_CPP)) {
  fail(`missing ${ARCH_CPP} — run source download first`);
}

const archSrc = fs.readFileSync(ARCH_CPP, 'utf8');
if (!archSrc.includes('LLM_ARCH_GEMMA4') || !archSrc.includes('"gemma4"')) {
  fail('llama-arch.cpp does not contain gemma4 — wrong llama.cpp release');
}
ok('llama-arch.cpp includes gemma4');

if (fs.existsSync(INFO_JSON)) {
  const info = JSON.parse(fs.readFileSync(INFO_JSON, 'utf8'));
  const tag = info.tag || '(unknown)';
  const min = process.env.LLAMA_CPP_RELEASE || 'b8954';
  ok(`llama.cpp.info.json tag=${tag} (expected pin ${min})`);
} else {
  fail(`missing ${INFO_JSON}`);
}

process.exit(0);

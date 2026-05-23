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
// node-llama-cpp 3.18.x builds from llama/src/ (bundled). Tarball installs use llama/llama.cpp/src/.
const ARCH_CPP_CANDIDATES = [
  path.join(LLAMA_SRC, 'src', 'llama-arch.cpp'),
  path.join(LLAMA_SRC, 'llama.cpp', 'src', 'llama-arch.cpp'),
];
const INFO_JSON = path.join(LLAMA_SRC, 'llama.cpp.info.json');

function fail(msg) {
  console.error(`[verify-llama-gemma4] FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`[verify-llama-gemma4] OK: ${msg}`);
}

const ARCH_CPP = ARCH_CPP_CANDIDATES.find((p) => fs.existsSync(p));
if (!ARCH_CPP) {
  fail(`missing llama-arch.cpp under ${LLAMA_SRC} — run source download first`);
}

const archSrc = fs.readFileSync(ARCH_CPP, 'utf8');
if (!archSrc.includes('LLM_ARCH_GEMMA4') || !archSrc.includes('"gemma4"')) {
  fail('llama-arch.cpp does not contain gemma4 — wrong llama.cpp release');
}
ok('llama-arch.cpp includes gemma4');

if (fs.existsSync(INFO_JSON)) {
  const info = JSON.parse(fs.readFileSync(INFO_JSON, 'utf8'));
  const tag = info.tag || '(unknown)';
  const min = process.env.LLAMA_CPP_RELEASE || 'b9253';
  ok(`llama.cpp.info.json tag=${tag} (expected pin ${min})`);
} else {
  fail(`missing ${INFO_JSON}`);
}

process.exit(0);

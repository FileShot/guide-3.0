#!/usr/bin/env node
/**
 * Download llama.cpp release tarball without GitHub API (avoids CI 403 rate limits).
 * Preserves node-llama-cpp/llama metadata (binariesGithubRelease.json, addon/, etc.).
 */
'use strict';

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RELEASE = process.env.LLAMA_CPP_RELEASE || 'b8954';
const REPO = 'ggml-org/llama.cpp';
const LLAMA_DIR = path.join(ROOT, 'node_modules', 'node-llama-cpp', 'llama');
const LLAMA_CPP_DIR = path.join(LLAMA_DIR, 'llama.cpp');
const TAR_URL = `https://github.com/${REPO}/archive/refs/tags/${RELEASE}.tar.gz`;
const TMP_TAR = path.join(ROOT, '.build-temp', `llama.cpp-${RELEASE}.tar.gz`);
const TMP_EXTRACT = path.join(ROOT, '.build-temp', 'llama-cpp-extract');

function log(msg) {
  console.log(`[download-llama-tarball] ${msg}`);
}

function run(cmd, args) {
  log(`${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: false });
  if (r.status !== 0) {
    console.error(`[download-llama-tarball] failed: ${cmd}`);
    process.exit(r.status ?? 1);
  }
}

function curlDownload(url, dest) {
  const args = ['-fsSL', '--retry', '3', '--retry-delay', '5', '-o', dest, url];
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    args.unshift('-H', `Authorization: Bearer ${token}`);
  }
  run('curl', args);
}

fs.mkdirSync(path.dirname(TMP_TAR), { recursive: true });
if (fs.existsSync(TMP_EXTRACT)) {
  fs.rmSync(TMP_EXTRACT, { recursive: true, force: true });
}
fs.mkdirSync(TMP_EXTRACT, { recursive: true });

log(`release=${RELEASE} url=${TAR_URL}`);
curlDownload(TAR_URL, TMP_TAR);

run('tar', ['-xzf', TMP_TAR, '-C', TMP_EXTRACT]);

const extracted = path.join(TMP_EXTRACT, `llama.cpp-${RELEASE}`);
if (!fs.existsSync(extracted)) {
  console.error(`[download-llama-tarball] expected ${extracted} after extract`);
  process.exit(1);
}

if (fs.existsSync(LLAMA_CPP_DIR)) {
  fs.rmSync(LLAMA_CPP_DIR, { recursive: true, force: true });
}
fs.renameSync(extracted, LLAMA_CPP_DIR);

fs.writeFileSync(
  path.join(LLAMA_DIR, 'llama.cpp.info.json'),
  JSON.stringify({ tag: RELEASE, llamaCppGithubRepo: REPO }, null, 2) + '\n',
);

const binariesMeta = path.join(LLAMA_DIR, 'binariesGithubRelease.json');
if (fs.existsSync(binariesMeta)) {
  fs.writeFileSync(binariesMeta, JSON.stringify({ release: RELEASE }, null, 2) + '\n');
}

fs.rmSync(TMP_TAR, { force: true });
fs.rmSync(TMP_EXTRACT, { recursive: true, force: true });

log(`installed to ${LLAMA_CPP_DIR}`);

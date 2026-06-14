#!/usr/bin/env node
/**
 * After rebuild-llama-runtime.mjs: strip npm prebuilts so runtime uses getLlama('lastBuild').
 * v0.3.94 compiled b9253 but kept @node-llama-cpp b8390 — this fixes that wiring gap.
 *
 * Usage: node scripts/install-compiled-llama.mjs [--keep-prebuilts]
 */
'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LLAMA_DIR = path.join(ROOT, 'node_modules', 'node-llama-cpp', 'llama');
const LOCAL_BUILDS = path.join(LLAMA_DIR, 'localBuilds');
const LAST_BUILD = path.join(LLAMA_DIR, 'lastBuild.json');
const INFO_JSON = path.join(LLAMA_DIR, 'llama.cpp.info.json');
const BACKENDS = path.join(ROOT, 'node_modules', '@node-llama-cpp');

function log(msg) {
  console.log(`[install-compiled-llama] ${msg}`);
}

function fail(msg) {
  console.error(`[install-compiled-llama] FAIL: ${msg}`);
  process.exit(1);
}

function findAddonPath() {
  if (!fs.existsSync(LOCAL_BUILDS)) {
    fail(`missing ${LOCAL_BUILDS} — run rebuild-llama-runtime.mjs first`);
  }
  for (const name of fs.readdirSync(LOCAL_BUILDS)) {
    const base = path.join(LOCAL_BUILDS, name);
    if (!fs.statSync(base).isDirectory()) continue;
    for (const sub of ['Release', 'Debug', '.']) {
      const dir = sub === '.' ? base : path.join(base, sub);
      const addon = path.join(dir, 'llama-addon.node');
      if (fs.existsSync(addon)) return addon;
    }
  }
  fail('no llama-addon.node under localBuilds');
}

function stripPrebuilts() {
  if (!fs.existsSync(BACKENDS)) {
    log('no @node-llama-cpp — nothing to strip');
    return [];
  }
  const removed = [];
  for (const ent of fs.readdirSync(BACKENDS, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    fs.rmSync(path.join(BACKENDS, ent.name), { recursive: true, force: true });
    removed.push(ent.name);
  }
  return removed;
}

const keepPrebuilts = process.argv.includes('--keep-prebuilts');

if (!fs.existsSync(LAST_BUILD)) {
  fail(`missing ${LAST_BUILD} — source build did not finish`);
}

const addon = findAddonPath();
log(`compiled addon: ${addon}`);

if (fs.existsSync(INFO_JSON)) {
  const info = JSON.parse(fs.readFileSync(INFO_JSON, 'utf8'));
  log(`llama.cpp tag=${info.tag || '(unknown)'}`);
}

if (!keepPrebuilts) {
  const removed = stripPrebuilts();
  log(`stripped ${removed.length} prebuilt package(s): ${removed.join(', ') || '(none)'}`);
  const left = fs.existsSync(BACKENDS)
    ? fs.readdirSync(BACKENDS).filter((n) => !n.startsWith('.'))
    : [];
  if (left.length) fail(`prebuilts still present: ${left.join(', ')}`);
} else {
  log('keeping prebuilts (--keep-prebuilts); chatEngine must use getLlama(lastBuild)');
}

log('OK — runtime wired to lastBuild');

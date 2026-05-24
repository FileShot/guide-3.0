#!/usr/bin/env node
/**
 * Download legacy Electron (Haswell-safe Chromium) and verify under QEMU Haswell.
 * Must run real `electron --version` — ELECTRON_RUN_AS_NODE does not execute the crashing paths.
 *
 * Only advances to a newer candidate on SIGILL. Config / Node gate failures abort (no silent fallback).
 */
'use strict';

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertHaswellSafeBinaries } from './lib/check-haswell-disallowed-insns.mjs';
import {
  LEGACY_ELECTRON_CANDIDATES,
  minNodeMajorForElectron,
} from './lib/legacy-electron.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build', 'electron-legacy-dist');
const CACHE = path.join(ROOT, 'build', 'electron-legacy-cache');

const QEMU_CPU =
  process.env.LEGACY_QEMU_CPU ||
  'Haswell-noTSX,+sse4.2,+avx,+avx2,+fma,+popcnt';

const CANDIDATES = (
  process.env.LEGACY_ELECTRON_CANDIDATES || LEGACY_ELECTRON_CANDIDATES.join(',')
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export class LegacyElectronSigillError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LegacyElectronSigillError';
  }
}

function log(msg) {
  console.log(`[fetch-legacy-electron] ${msg}`);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function hasQemu() {
  return spawnSync('which', ['qemu-x86_64-static'], { encoding: 'utf8' }).status === 0;
}

function platformAsset() {
  if (process.platform === 'win32') {
    return { zipSuffix: 'win32-x64.zip', binary: 'electron.exe' };
  }
  return { zipSuffix: 'linux-x64.zip', binary: 'electron' };
}

function isSigill(output, status) {
  return (
    status === 132 ||
    /invalid opcode|SIGILL|signal 4|Illegal instruction|trap invalid opcode/i.test(output)
  );
}

function verifyElectronHaswell(electronBin, libDir, electronVersion) {
  if (process.platform !== 'linux') {
    log('skip QEMU Haswell test (non-linux host)');
    return;
  }
  if (!hasQemu()) {
    log('warn: qemu-x86_64-static not found — skipping Haswell execution test');
    return;
  }

  log(`objdump: post-Haswell instructions in ${electronBin}`);
  assertHaswellSafeBinaries([electronBin], 'Electron');

  log(`QEMU Haswell: Chromium --version (real binary — same path as app launch)`);
  const ver = spawnSync(
    'qemu-x86_64-static',
    ['-cpu', QEMU_CPU, electronBin, '--no-sandbox', '--disable-gpu', '--version'],
    {
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, LD_LIBRARY_PATH: libDir },
    },
  );
  const out = `${ver.stdout}\n${ver.stderr}`;
  if (isSigill(out, ver.status)) {
    throw new LegacyElectronSigillError(`SIGILL under Haswell QEMU on --version:\n${out}`);
  }
  if (ver.status !== 0) {
    throw new Error(`electron --version failed under Haswell QEMU (exit ${ver.status}):\n${out}`);
  }
  log(`QEMU Chromium ok: ${(ver.stdout || '').trim()}`);

  const minNode = minNodeMajorForElectron(electronVersion);
  const nv = spawnSync(
    'qemu-x86_64-static',
    [
      '-cpu',
      QEMU_CPU,
      electronBin,
      '-e',
      `const m=+process.versions.node.split(".")[0]; console.log(process.versions.node); if(m<${minNode})process.exit(2)`,
    ],
    {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, LD_LIBRARY_PATH: libDir, ELECTRON_RUN_AS_NODE: '1' },
    },
  );
  const nodeOut = `${nv.stdout}${nv.stderr}`.trim();
  if (nv.status === 2) {
    throw new Error(
      `Node runtime check failed for Electron ${electronVersion} (need Node >= ${minNode}, got ${nodeOut})`,
    );
  }
  if (nv.status !== 0) {
    throw new Error(`Node version probe failed (exit ${nv.status}): ${nodeOut}`);
  }
  log(`bundled Node ok: ${nodeOut} (min ${minNode} for Electron ${electronVersion})`);
}

function fetchVersion(version) {
  const { zipSuffix, binary } = platformAsset();
  const zip = `electron-v${version}-${zipSuffix}`;
  const url = `https://github.com/electron/electron/releases/download/v${version}/${zip}`;
  const cacheZip = path.join(CACHE, zip);
  fs.mkdirSync(CACHE, { recursive: true });
  if (!fs.existsSync(cacheZip)) {
    log(`Downloading ${url}`);
    run('curl', ['-fsSL', '--retry', '3', '-o', cacheZip, url]);
  }
  if (fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  run('unzip', ['-q', cacheZip, '-d', OUT_DIR]);
  const electronBin = path.join(OUT_DIR, binary);
  if (!fs.existsSync(electronBin)) {
    throw new Error(`Missing ${electronBin} after extract`);
  }
  if (process.platform !== 'win32') fs.chmodSync(electronBin, 0o755);
  verifyElectronHaswell(electronBin, OUT_DIR, version);
  fs.writeFileSync(
    path.join(ROOT, 'build', 'legacy-electron-version.txt'),
    `${version}\n`,
    'utf8',
  );
  log(`SELECTED Electron v${version} → ${OUT_DIR}`);
  return version;
}

for (const version of CANDIDATES) {
  try {
    fetchVersion(version);
    process.exit(0);
  } catch (e) {
    if (e instanceof LegacyElectronSigillError) {
      log(`Electron v${version}: SIGILL on Haswell — trying newer Chromium`);
      continue;
    }
    console.error(`[fetch-legacy-electron] Electron v${version} failed: ${e.message}`);
    console.error(
      '[fetch-legacy-electron] Aborting (no fallback). Chromium passed QEMU but was rejected, or download/verify failed.',
    );
    process.exit(1);
  }
}
console.error('[fetch-legacy-electron] All candidates SIGILL under Haswell QEMU');
process.exit(1);

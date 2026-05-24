#!/usr/bin/env node
/**
 * Download legacy Electron (Node 20+, not v34 Haswell-SIGILL) and verify under QEMU Haswell.
 */
'use strict';

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  LEGACY_ELECTRON_CANDIDATES,
  LEGACY_ELECTRON_MIN_NODE_MAJOR,
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

function verifyElectronHaswell(electronBin, libDir) {
  if (process.platform !== 'linux') {
    log('skip QEMU Haswell test (non-linux host)');
    return;
  }
  if (!hasQemu()) {
    log('warn: qemu-x86_64-static not found — skipping Haswell execution test');
    return;
  }
  log(`QEMU Haswell smoke test: ${electronBin}`);
  const checkNode = [
    '-e',
    `const m=+process.versions.node.split(".")[0]; if(m<${LEGACY_ELECTRON_MIN_NODE_MAJOR}){process.exit(2)}; console.log("node",process.versions.node,"electron",process.versions.electron)`,
  ];
  const r = spawnSync(
    'qemu-x86_64-static',
    ['-cpu', QEMU_CPU, electronBin, ...checkNode],
    {
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, LD_LIBRARY_PATH: libDir, ELECTRON_RUN_AS_NODE: '1' },
    },
  );
  if (r.status === 2) {
    throw new Error(
      `Electron bundles Node ${(r.stderr || r.stdout || '').trim()} — need Node >= ${LEGACY_ELECTRON_MIN_NODE_MAJOR}`,
    );
  }
  if (r.status !== 0) {
    console.error(r.stdout);
    console.error(r.stderr);
    throw new Error(`Electron failed under QEMU Haswell (exit ${r.status})`);
  }
  log(`QEMU ok: ${(r.stdout || '').trim()}`);
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
  verifyElectronHaswell(electronBin, OUT_DIR);
  fs.writeFileSync(
    path.join(ROOT, 'build', 'legacy-electron-version.txt'),
    `${version}\n`,
    'utf8',
  );
  log(`Ready: ${OUT_DIR} (Electron v${version})`);
  return version;
}

for (const version of CANDIDATES) {
  try {
    fetchVersion(version);
    process.exit(0);
  } catch (e) {
    log(`Electron v${version} failed: ${e.message}`);
  }
}
console.error('[fetch-legacy-electron] No candidate Electron passed Haswell QEMU test');
process.exit(1);

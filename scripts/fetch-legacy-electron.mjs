#!/usr/bin/env node
/**
 * Download an Electron release and verify the binary runs under QEMU Haswell CPU model.
 * Legacy AppImages must not ship electron@34 (built for modern host CPUs).
 */
'use strict';

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build', 'electron-legacy-dist');
const CACHE = path.join(ROOT, 'build', 'electron-legacy-cache');

/** Oldest reasonably modern Electron that still runs guIDE; verified via QEMU in CI. */
const ELECTRON_VERSION = process.env.LEGACY_ELECTRON_VERSION || '28.3.3';
const QEMU_CPU =
  process.env.LEGACY_QEMU_CPU ||
  'Haswell-noTSX,+sse4.2,+avx,+avx2,+fma,+popcnt';

const CANDIDATES = (
  process.env.LEGACY_ELECTRON_CANDIDATES || '28.3.3,26.6.10,22.3.27'
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
  const r = spawnSync(
    'qemu-x86_64-static',
    ['-cpu', QEMU_CPU, electronBin, '--no-sandbox', '--version'],
    {
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, LD_LIBRARY_PATH: libDir },
    },
  );
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

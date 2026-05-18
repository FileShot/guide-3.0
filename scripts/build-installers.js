/**
 * guIDE 2.0 — Multi-variant installer build script
 *
 * Produces two NSIS installers from a single source tree via Electron + electron-builder:
 *   dist/guIDE-2.0.0-cuda-x64-setup.exe   — NVIDIA CUDA (GPU inference)
 *   dist/guIDE-2.0.0-cpu-x64-setup.exe    — CPU / Vulkan (no NVIDIA GPU required)
 *
 * Usage:
 *   node scripts/build-installers.js          # build both
 *   node scripts/build-installers.js --cuda   # CUDA only
 *   node scripts/build-installers.js --cpu    # CPU only
 *
 * Prerequisites:
 *   - electron and electron-builder installed (npm install)
 *   - frontend already built (cd frontend && npm run build)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ─── Config ──────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');
const ELECTRON_OUT_DIR = path.join(ROOT, 'dist-electron');
const DIST_DIR = path.join(ROOT, 'dist');
const LLAMA_BACKENDS = path.join(ROOT, 'node_modules', '@node-llama-cpp');
const BACKUP_DIR = path.join(ROOT, '.build-backup', '@node-llama-cpp');

// Backend folders — what each variant keeps vs strips
const CUDA_KEEP   = ['win-x64-cuda', 'win-x64-cuda-ext', 'win-x64'];
const CPU_KEEP    = ['win-x64', 'win-x64-vulkan'];

// Read version from package.json and auto-bump patch for each build
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const parts = pkg.version.split('.');
const bumpedVersion = `${parts[0]}.${parts[1]}.${parseInt(parts[2] || 0) + 1}`;
pkg.version = bumpedVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
const VERSION = bumpedVersion;
log(`Version bumped: ${pkg.version} → ${bumpedVersion}`);

// ─── Util ─────────────────────────────────────────────────────────────────────

function log(msg) { console.log(`\n[build] ${msg}`); }
function err(msg) { console.error(`\n[build] ERROR: ${msg}`); }

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function moveDir(src, dest) {
  if (!fs.existsSync(src)) return;
  ensureDir(path.dirname(dest));
  fs.renameSync(src, dest);
}

function restoreDir(dest, src) {
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(src, dest);
}

function getExistingBackends() {
  if (!fs.existsSync(LLAMA_BACKENDS)) return [];
  return fs.readdirSync(LLAMA_BACKENDS, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

function pruneBackends(keep) {
  const moved = [];
  for (const backend of getExistingBackends()) {
    if (!keep.includes(backend)) {
      moveDir(path.join(LLAMA_BACKENDS, backend), path.join(BACKUP_DIR, backend));
      log(`  strip ${backend}`);
      moved.push(backend);
    }
  }
  return moved;
}

function restoreBackends(moved) {
  for (const backend of moved) {
    const src = path.join(BACKUP_DIR, backend);
    if (fs.existsSync(src)) {
      log(`  restore ${backend}`);
      restoreDir(path.join(LLAMA_BACKENDS, backend), src);
    }
  }
}

// Pull the latest published llama.cpp release into node-llama-cpp before
// building installers. The npm package node-llama-cpp@3.18.1 ships with
// llama.cpp build b8352 (2026-03-15), which predates several model
// architectures released after that date (gemma4 landed in llama.cpp
// PR #21326 on 2026-04-02). Running 'source download --release latest'
// downloads and compiles a fresh llama.cpp from the latest tagged release
// so the shipped binaries support newly-released model families.
//
// Requirements on the build machine: cmake + C++ toolchain (MSVC on
// Windows, clang/gcc on Unix). The existing build already needs these
// for prebuilt-binary fallback compilation, so this adds no new
// prerequisites.
function rebuildLlamaCpp() {
  log('Rebuilding bundled llama.cpp from latest release (gemma4 + future arch support)');
  const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const result = spawnSync(
    npxBin,
    ['-n', 'node-llama-cpp', 'source', 'download', '--release', 'latest'],
    { cwd: ROOT, stdio: 'inherit', shell: true },
  );
  if (result.status !== 0) {
    throw new Error(`llama.cpp rebuild exited with status ${result.status}`);
  }
  log('llama.cpp rebuild complete.');
}

function electronBuild(config) {
  log(`Running: electron-builder --config ${config}`);
  const ebBin = path.join(ROOT, 'node_modules', '.bin', 'electron-builder');
  const result = spawnSync(ebBin, ['--config', config], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error(`electron-builder exited with status ${result.status}`);
  }
}

function collectInstaller(variantSuffix) {
  ensureDir(DIST_DIR);
  if (!fs.existsSync(ELECTRON_OUT_DIR)) {
    throw new Error(`dist-electron/ not found — did the build succeed?`);
  }
  const files = fs.readdirSync(ELECTRON_OUT_DIR)
    .filter(f => f.endsWith('.exe') && f.toLowerCase().includes('setup'));
  if (!files.length) {
    throw new Error(`No setup .exe found in dist-electron/`);
  }
  const newest = files
    .map(f => ({ f, mtime: fs.statSync(path.join(ELECTRON_OUT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].f;

  const src = path.join(ELECTRON_OUT_DIR, newest);
  const dest = path.join(DIST_DIR, `guIDE-${VERSION}-${variantSuffix}-setup.exe`);
  fs.copyFileSync(src, dest);
  const sizeMb = Math.round(fs.statSync(dest).size / 1024 / 1024);
  log(`Output: ${path.relative(ROOT, dest)} (${sizeMb} MB)`);
  return dest;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const buildCuda = args.length === 0 || args.includes('--cuda');
  const buildCpu  = args.length === 0 || args.includes('--cpu');

  // Restore stale backups from any previous crash
  if (fs.existsSync(BACKUP_DIR)) {
    const stale = fs.readdirSync(BACKUP_DIR);
    if (stale.length > 0) {
      log(`Restoring stale backup from previous run: ${stale.join(', ')}`);
      restoreBackends(stale);
    }
    fs.rmSync(path.dirname(BACKUP_DIR), { recursive: true, force: true });
  }

  // Pull the latest llama.cpp release before building so installers ship
  // support for model architectures that landed after node-llama-cpp 3.18.1
  // was published (e.g. gemma4).
  rebuildLlamaCpp();

  ensureDir(DIST_DIR);
  const outputs = [];

  // ── CUDA installer ──────────────────────────────────────────────────────────
  if (buildCuda) {
    log('═══════════════════════════════════════');
    log('Building CUDA installer (win-x64-cuda + win-x64-cuda-ext + win-x64 fallback)');
    log('═══════════════════════════════════════');
    log('Present backends: ' + getExistingBackends().join(', '));
    const moved = pruneBackends(CUDA_KEEP);
    log('Active backends: ' + getExistingBackends().join(', '));
    try {
      electronBuild('electron-builder.nosign.cuda.json');
      outputs.push(collectInstaller('cuda-x64'));
    } finally {
      restoreBackends(moved);
      log('Backends restored.');
    }
  }

  // ── CPU installer ───────────────────────────────────────────────────────────
  if (buildCpu) {
    log('═══════════════════════════════════════');
    log('Building CPU installer (win-x64 + win-x64-vulkan)');
    log('═══════════════════════════════════════');
    log('Present backends: ' + getExistingBackends().join(', '));
    const moved = pruneBackends(CPU_KEEP);
    log('Active backends: ' + getExistingBackends().join(', '));
    try {
      electronBuild('electron-builder.nosign.json');
      outputs.push(collectInstaller('cpu-x64'));
    } finally {
      restoreBackends(moved);
      log('Backends restored.');
    }
  }

  if (fs.existsSync(path.dirname(BACKUP_DIR))) {
    fs.rmSync(path.dirname(BACKUP_DIR), { recursive: true, force: true });
  }

  log('═══════════════════════════════════════');
  log('Build complete.');
  for (const f of outputs) {
    const sizeMb = Math.round(fs.statSync(f).size / 1024 / 1024);
    log(`  ${path.basename(f)}  (${sizeMb} MB)`);
  }
  log('═══════════════════════════════════════');
}

main().catch(e => {
  err(e.message || String(e));
  if (fs.existsSync(BACKUP_DIR)) {
    const stale = fs.readdirSync(BACKUP_DIR);
    if (stale.length > 0) { err('Restoring backends after crash...'); restoreBackends(stale); }
  }
  process.exit(1);
});


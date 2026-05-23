#!/usr/bin/env node
/**
 * Gate legacy Linux artifacts: objdump AVX-512 check on critical binaries + QEMU Haswell load test.
 *
 * Usage:
 *   node scripts/verify-legacy-haswell-artifact.mjs --appimage path/to.AppImage
 */
'use strict';

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const QEMU_CPU =
  process.env.LEGACY_QEMU_CPU ||
  'Haswell-noTSX,+sse4.2,+avx,+avx2,+fma,+popcnt';

function log(msg) {
  console.log(`[verify-legacy-haswell] ${msg}`);
}

function fail(msg) {
  console.error(`[verify-legacy-haswell] FAIL: ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...opts });
}

function parseArgs() {
  const idx = process.argv.indexOf('--appimage');
  if (idx === -1 || !process.argv[idx + 1]) {
    fail('Usage: --appimage <path-to-legacy.AppImage>');
  }
  return path.resolve(process.argv[idx + 1]);
}

/** Disassembly lines using ZMM registers indicate AVX-512 (invalid on Haswell). */
function disasmUsesAvx512(filePath) {
  const r = run('objdump', ['-d', filePath]);
  if (r.status !== 0) return false;
  return /\bzmm[0-9]+\b/.test(r.stdout);
}

function findFiles(dir, name) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.name === name) out.push(full);
    }
  }
  return out;
}

function criticalArtifactPaths(root, appDir) {
  const paths = [path.join(root, 'electron')];
  for (const name of ['llama-addon.node', 'pty.node', 'libffmpeg.so']) {
    paths.push(...findFiles(appDir, name));
  }
  const libnode = path.join(root, 'libnode.so');
  if (fs.existsSync(libnode)) paths.push(libnode);
  return [...new Set(paths.filter((p) => fs.existsSync(p)))];
}

function qemuRun(bin, args, cwd, extraEnv = {}) {
  return run('qemu-x86_64-static', ['-cpu', QEMU_CPU, bin, ...args], {
    cwd,
    env: { ...process.env, LD_LIBRARY_PATH: cwd, ...extraEnv },
    timeout: 300_000,
  });
}

function main() {
  const appimage = parseArgs();
  if (!fs.existsSync(appimage)) fail(`missing ${appimage}`);
  if (run('which', ['qemu-x86_64-static']).status !== 0) {
    fail('qemu-x86_64-static required for legacy verification');
  }
  if (run('which', ['objdump']).status !== 0) {
    fail('objdump required for AVX-512 disassembly check');
  }

  const extractDir = path.join(ROOT, '.build-temp', 'appimage-extract');
  if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });

  log(`Extracting ${appimage}`);
  const extract = run(path.resolve(appimage), ['--appimage-extract'], { cwd: extractDir });
  if (extract.status !== 0) fail(`appimage extract failed: ${extract.stderr}`);

  const root = path.join(extractDir, 'squashfs-root');
  const appDir = path.join(root, 'resources', 'app');
  const electronBin = path.join(root, 'electron');
  if (!fs.existsSync(electronBin)) fail(`missing ${electronBin}`);

  const critical = criticalArtifactPaths(root, appDir);
  log(`Checking ${critical.length} critical binaries for AVX-512 (zmm)`);
  const avx512 = critical.filter((f) => disasmUsesAvx512(f));
  if (avx512.length) {
    fail(
      `AVX-512 in: ${avx512.map((f) => path.relative(root, f)).join(', ')}`,
    );
  }

  if (findFiles(appDir, 'llama-addon.node').length === 0) {
    fail('no llama-addon.node in packaged app');
  }
  if (fs.existsSync(path.join(appDir, 'node_modules', '@node-llama-cpp'))) {
    const left = fs.readdirSync(path.join(appDir, 'node_modules', '@node-llama-cpp'));
    if (left.length) fail(`prebuilt @node-llama-cpp still packaged: ${left.join(', ')}`);
  }
  if (fs.existsSync(path.join(appDir, 'node_modules', 'playwright'))) {
    fail('playwright must not be bundled in legacy builds');
  }

  log('QEMU: electron --version');
  const ev = qemuRun(electronBin, ['--no-sandbox', '--version'], root);
  if (ev.status !== 0) fail(`electron under Haswell QEMU: ${ev.stderr || ev.stdout}`);

  const testScript = path.join(appDir, 'build', 'test-load-llama-legacy.mjs');
  if (!fs.existsSync(testScript)) fail(`missing ${testScript}`);
  log('QEMU: node-llama-cpp getLlama (CPU)');
  const lr = qemuRun(
    electronBin,
    ['--no-sandbox', testScript],
    root,
    { ELECTRON_RUN_AS_NODE: '1' },
  );
  if (lr.status !== 0) {
    const err = `${lr.stdout}\n${lr.stderr}`;
    const cudaArtifact = /--cuda-legacy-/.test(appimage);
    if (cudaArtifact && /libcuda|nvidia|CUDA driver/i.test(err)) {
      log(
        'warn: getLlama needs NVIDIA in QEMU; llama-addon.node passed AVX-512 objdump',
      );
    } else {
      fail(`node-llama-cpp load:\n${err}`);
    }
  } else {
    log((lr.stdout || '').trim());
  }

  log('PASS — legacy artifact verified for Haswell (objdump + QEMU)');
}

main();

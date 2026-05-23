#!/usr/bin/env node
/**
 * Gate legacy Linux AppImages before release (Haswell SIGILL bug):
 * - No AVX-512 in packaged Electron shell + llama-addon
 * - No npm @node-llama-cpp prebuilts or Playwright in bundle
 * - QEMU Haswell runs packaged ELF + loads node-llama-cpp (CPU)
 *
 * Run under xvfb-run in CI so Electron does not die on missing DISPLAY.
 */
'use strict';

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  appImageLibraryPath,
  findAppImageBinary,
  findPackagedAppDir,
  resolveAppImageRoot,
} from './lib/appimage-layout.mjs';

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

function criticalArtifactPaths(shellBinary, appDir, root) {
  const paths = [shellBinary];
  for (const name of ['llama-addon.node', 'pty.node', 'libffmpeg.so']) {
    paths.push(...findFiles(appDir, name));
  }
  for (const name of ['libffmpeg.so', 'libnode.so']) {
    const p = path.join(root, name);
    if (fs.existsSync(p)) paths.push(p);
  }
  return [...new Set(paths.filter((p) => fs.existsSync(p)))];
}

function qemuRun(bin, args, libPath, extraEnv = {}) {
  return run('qemu-x86_64-static', ['-cpu', QEMU_CPU, bin, ...args], {
    env: {
      ...process.env,
      LD_LIBRARY_PATH: libPath,
      ...extraEnv,
    },
    timeout: 300_000,
  });
}

function isSigill(output) {
  return /invalid opcode|SIGILL|signal 4|Illegal instruction/i.test(output);
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

  const root = resolveAppImageRoot(extractDir);
  const shellBinary = findAppImageBinary(root);
  const appDir = findPackagedAppDir(root);
  const libPath = appImageLibraryPath(root);

  log(`shell ELF: ${path.relative(root, shellBinary)}`);
  log(`app dir: ${path.relative(root, appDir)}`);

  const critical = criticalArtifactPaths(shellBinary, appDir, root);
  log(`objdump AVX-512 (zmm) check on ${critical.length} binaries`);
  const avx512 = critical.filter((f) => disasmUsesAvx512(f));
  if (avx512.length) {
    fail(
      `AVX-512 in: ${avx512.map((f) => path.relative(root, f)).join(', ')}`,
    );
  }

  if (findFiles(appDir, 'llama-addon.node').length === 0) {
    fail('no llama-addon.node in package');
  }
  if (fs.existsSync(path.join(appDir, 'node_modules', '@node-llama-cpp'))) {
    const left = fs.readdirSync(path.join(appDir, 'node_modules', '@node-llama-cpp'));
    if (left.length) fail(`prebuilt @node-llama-cpp packaged: ${left.join(', ')}`);
  }
  if (fs.existsSync(path.join(appDir, 'node_modules', 'playwright'))) {
    fail('playwright packaged (modern Chromium → SIGILL on Haswell)');
  }

  log('QEMU Haswell: packaged shell (ELECTRON_RUN_AS_NODE, no GUI)');
  const ev = qemuRun(
    shellBinary,
    ['-e', 'console.log("ok", process.versions.electron)'],
    libPath,
    { ELECTRON_RUN_AS_NODE: '1' },
  );
  const evOut = `${ev.stdout}\n${ev.stderr}`;
  if (ev.status !== 0) {
    if (isSigill(evOut)) fail(`packaged shell SIGILL under Haswell QEMU:\n${evOut}`);
    fail(`packaged shell failed under Haswell QEMU:\n${evOut}`);
  }
  log((ev.stdout || '').trim());

  const testScript = path.join(appDir, 'build', 'test-load-llama-legacy.mjs');
  if (!fs.existsSync(testScript)) fail(`missing ${testScript}`);
  log('QEMU Haswell: node-llama-cpp getLlama (CPU)');
  const lr = qemuRun(shellBinary, [testScript], libPath, { ELECTRON_RUN_AS_NODE: '1' });
  const lrOut = `${lr.stdout}\n${lr.stderr}`;
  if (lr.status !== 0) {
    if (isSigill(lrOut)) fail(`llama-addon SIGILL under Haswell QEMU:\n${lrOut}`);
    const cudaArtifact = /--cuda-legacy-/.test(appimage);
    if (cudaArtifact && /libcuda|nvidia|CUDA driver/i.test(lrOut)) {
      log('warn: no NVIDIA in QEMU; objdump already passed on llama-addon');
    } else {
      fail(`node-llama-cpp load under Haswell QEMU:\n${lrOut}`);
    }
  } else {
    log((lr.stdout || '').trim());
  }

  log('PASS — legacy AppImage cleared for Haswell-class CPUs');
}

main();

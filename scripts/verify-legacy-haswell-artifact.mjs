#!/usr/bin/env node
/**
 * Gate legacy Linux AppImages before release (Haswell SIGILL):
 * - objdump: no post-Haswell instructions in guide-ide + llama-addon
 * - QEMU Haswell: real `guide-ide --version` (Chromium startup — NOT ELECTRON_RUN_AS_NODE only)
 * - QEMU Haswell: getLlama('lastBuild') import path (model load)
 */
'use strict';

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertHaswellSafeBinaries } from './lib/check-haswell-disallowed-insns.mjs';
import { LEGACY_ELECTRON_MIN_NODE_MAJOR } from './lib/legacy-electron.mjs';
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
    env: { ...process.env, LD_LIBRARY_PATH: libPath, ...extraEnv },
    timeout: 300_000,
  });
}

function isSigill(output, status) {
  return (
    status === 132 ||
    /invalid opcode|SIGILL|signal 4|Illegal instruction|trap invalid opcode/i.test(output)
  );
}

function isEsmSyntaxError(output) {
  return /Unexpected token ['']with['']|import attributes|SyntaxError/i.test(output);
}

function main() {
  const appimage = parseArgs();
  if (!fs.existsSync(appimage)) fail(`missing ${appimage}`);
  if (run('which', ['qemu-x86_64-static']).status !== 0) {
    fail('qemu-x86_64-static required');
  }
  if (run('which', ['objdump']).status !== 0) {
    fail('objdump required');
  }

  const extractDir = path.join(ROOT, '.build-temp', 'appimage-extract');
  if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });

  log(`Extracting ${appimage}`);
  const extract = run(path.resolve(appimage), ['--appimage-extract'], { cwd: extractDir });
  if (extract.status !== 0) fail(`extract failed: ${extract.stderr}`);

  const root = resolveAppImageRoot(extractDir);
  const shellBinary = findAppImageBinary(root);
  const appDir = findPackagedAppDir(root);
  const libPath = appImageLibraryPath(root);

  log(`shell ELF: ${path.relative(root, shellBinary)}`);

  const critical = criticalArtifactPaths(shellBinary, appDir, root);
  log(`objdump: post-Haswell instruction scan (${critical.length} binaries)`);
  try {
    assertHaswellSafeBinaries(critical, 'packaged');
  } catch (e) {
    fail(e.message);
  }

  if (findFiles(appDir, 'llama-addon.node').length === 0) {
    fail('no llama-addon.node in package');
  }
  const lastBuildJson = path.join(appDir, 'node_modules', 'node-llama-cpp', 'llama', 'lastBuild.json');
  if (!fs.existsSync(lastBuildJson)) {
    fail('missing lastBuild.json');
  }
  if (fs.existsSync(path.join(appDir, 'node_modules', '@node-llama-cpp'))) {
    const left = fs.readdirSync(path.join(appDir, 'node_modules', '@node-llama-cpp'));
    if (left.length) fail(`prebuilt @node-llama-cpp packaged: ${left.join(', ')}`);
  }
  if (fs.existsSync(path.join(appDir, 'node_modules', 'playwright'))) {
    fail('playwright packaged');
  }

  log('QEMU Haswell: guide-ide --version (real Chromium launch path)');
  const ver = qemuRun(shellBinary, ['--no-sandbox', '--disable-gpu', '--version'], libPath);
  const verOut = `${ver.stdout}\n${ver.stderr}`;
  if (isSigill(verOut, ver.status)) {
    fail(`SIGILL on guide-ide --version (your kernel trap):\n${verOut}`);
  }
  if (ver.status !== 0) {
    fail(`guide-ide --version failed under Haswell QEMU:\n${verOut}`);
  }
  log((ver.stdout || '').trim());

  const nv = qemuRun(
    shellBinary,
    [
      '-e',
      `const m=+process.versions.node.split(".")[0]; console.log(process.versions.node); if(m<${LEGACY_ELECTRON_MIN_NODE_MAJOR})process.exit(2)`,
    ],
    libPath,
    { ELECTRON_RUN_AS_NODE: '1' },
  );
  if (nv.status === 2) fail(`Node < ${LEGACY_ELECTRON_MIN_NODE_MAJOR}`);

  const testScript = path.join(appDir, 'build', 'test-load-llama-legacy.mjs');
  if (!fs.existsSync(testScript)) fail(`missing ${testScript}`);
  log('QEMU Haswell: getLlama(lastBuild) — model load path');
  const lr = qemuRun(shellBinary, [testScript], libPath, { ELECTRON_RUN_AS_NODE: '1' });
  const lrOut = `${lr.stdout}\n${lr.stderr}`;
  if (lr.status !== 0) {
    if (isSigill(lrOut, lr.status)) fail(`SIGILL in getLlama:\n${lrOut}`);
    if (isEsmSyntaxError(lrOut)) {
      fail(`ESM syntax (patch cli-spinners / need Node 20+):\n${lrOut}`);
    }
    const cudaArtifact = /-cuda-legacy-/.test(appimage);
    if (
      cudaArtifact &&
      /libcuda\.so|ERR_DLOPEN_FAILED|Failed to load last build/i.test(lrOut)
    ) {
      log('warn: CUDA .node needs libcuda in QEMU (OK on your GPU)');
    } else {
      fail(`getLlama failed:\n${lrOut}`);
    }
  } else {
    log((lr.stdout || '').trim());
  }

  log('PASS — Haswell-safe guide-ide + getLlama path verified');
}

main();

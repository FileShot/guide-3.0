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
import {
  LEGACY_ELECTRON_PREFER_MAX_MAJOR,
  electronMajor,
  minNodeMajorForElectron,
} from './lib/legacy-electron.mjs';
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

function isNode16RuntimeSyntaxError(output) {
  return (
    /Unexpected token ['']with['']|import attributes/i.test(output) ||
    /Invalid regular expression flags/i.test(output) ||
    (/SyntaxError/i.test(output) && /string-width|cli-spinners|node-llama-cpp/i.test(output))
  );
}

function findPkgIndexFiles(dir, pkgName, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'llama' || ent.name === '.bin') continue;
      findPkgIndexFiles(full, pkgName, out);
    } else if (ent.name === 'index.js' && full.includes(`${path.sep}${pkgName}${path.sep}`)) {
      out.push(full);
    }
  }
  return out;
}

function assertNode16DepsPatched(appDir) {
  const nm = path.join(appDir, 'node_modules');
  for (const p of findPkgIndexFiles(nm, 'cli-spinners')) {
    const rel = path.relative(appDir, p);
    if (/with \{type: 'json'\}/.test(fs.readFileSync(p, 'utf8'))) fail(`unpatched cli-spinners: ${rel}`);
    log(`Node16-deps ok: ${rel}`);
  }
  for (const p of findPkgIndexFiles(nm, 'string-width')) {
    const rel = path.relative(appDir, p);
    if (/\/v;/.test(fs.readFileSync(p, 'utf8'))) fail(`unpatched string-width (/v flag): ${rel}`);
    log(`Node16-deps ok: ${rel}`);
  }
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

  assertNode16DepsPatched(appDir);

  const scan = run(process.execPath, [
    path.join(ROOT, 'scripts', 'scan-legacy-node16-incompat.mjs'),
    '--app-dir',
    appDir,
  ]);
  if (scan.status !== 0) {
    fail(`Node 16 incompat scan:\n${scan.stdout}${scan.stderr}`);
  }
  log((scan.stdout || '').trim());

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

  const meta = qemuRun(
    shellBinary,
    [
      '-e',
      'console.log(JSON.stringify({electron:process.versions.electron,node:process.versions.node}))',
    ],
    libPath,
    { ELECTRON_RUN_AS_NODE: '1' },
  );
  if (meta.status !== 0) fail(`runtime probe failed:\n${meta.stdout}${meta.stderr}`);
  let runtime;
  try {
    runtime = JSON.parse((meta.stdout || '').trim());
  } catch {
    fail(`runtime probe JSON parse failed: ${meta.stdout}`);
  }
  const { electron: electronVer, node: nodeVer } = runtime;
  log(`packaged runtime: Electron ${electronVer}, Node ${nodeVer}`);

  const minNode = minNodeMajorForElectron(electronVer);
  const nodeMajor = parseInt(String(nodeVer).split('.')[0], 10);
  if (nodeMajor < minNode) {
    fail(`Node ${nodeVer} < ${minNode} required for Electron ${electronVer}`);
  }

  const em = electronMajor(electronVer);
  const allowFallback = process.env.LEGACY_ALLOW_ELECTRON_FALLBACK === '1';
  if (em > LEGACY_ELECTRON_PREFER_MAX_MAJOR && !allowFallback) {
    fail(
      `packaged Electron ${electronVer} > max ${LEGACY_ELECTRON_PREFER_MAX_MAJOR} ` +
        '(would have shipped 30.5.1 in v0.3.128 after rejecting 22). ' +
        'Set LEGACY_ALLOW_ELECTRON_FALLBACK=1 only if all older candidates SIGILL under QEMU.',
    );
  }

  const testScript = path.join(appDir, 'build', 'test-load-llama-legacy.mjs');
  if (!fs.existsSync(testScript)) fail(`missing ${testScript}`);
  log('QEMU Haswell: getLlama(lastBuild) — model load path');
  const lr = qemuRun(shellBinary, [testScript], libPath, { ELECTRON_RUN_AS_NODE: '1' });
  const lrOut = `${lr.stdout}\n${lr.stderr}`;
  if (lr.status !== 0) {
    if (isSigill(lrOut, lr.status)) fail(`SIGILL in getLlama:\n${lrOut}`);
    if (isNode16RuntimeSyntaxError(lrOut)) {
      fail(`Node 16 runtime syntax (run patch-legacy-node16-deps):\n${lrOut}`);
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

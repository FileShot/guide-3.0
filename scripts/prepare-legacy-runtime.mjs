#!/usr/bin/env node
/**
 * Legacy installer prep: compile node-llama-cpp for Haswell-class CPUs, then remove
 * only the matching npm prebuilt package(s) so the packaged app cannot load modern
 * -march=native / AVX-512 binaries from the registry.
 *
 * Usage:
 *   node scripts/prepare-legacy-runtime.mjs           # CPU legacy
 *   node scripts/prepare-legacy-runtime.mjs --cuda    # CUDA legacy
 */
'use strict';

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BACKENDS = path.join(ROOT, 'node_modules', '@node-llama-cpp');

const useCuda = process.argv.includes('--cuda');
/** x86-64-v2: baseline for Haswell-class CPUs (-march=x86-64-v2, no AVX-512, no -march=native). */
const profile = useCuda ? 'cuda-x86-64-v2' : 'x86-64-v2';

function log(msg) {
  console.log(`[prepare-legacy] ${msg}`);
}

function run(cmd, args, env = {}) {
  log(`${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: false,
  });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

function prebuiltPackagesToRemove() {
  if (process.platform === 'linux') {
    return useCuda ? ['linux-x64-cuda', 'linux-x64-cuda-ext'] : ['linux-x64-vulkan', 'linux-x64'];
  }
  if (process.platform === 'win32') {
    return useCuda ? ['win-x64-cuda', 'win-x64-cuda-ext'] : ['win-x64-vulkan', 'win-x64'];
  }
  return [];
}

log(`profile=${profile} platform=${process.platform} cuda=${useCuda}`);

run(process.execPath, [path.join('scripts', 'patch-legacy-node16-deps.mjs')]);

run(process.execPath, [path.join('scripts', 'rebuild-llama-runtime.mjs'), '--profile', profile, '--legacy'], {
  LLAMA_CPP_RELEASE: process.env.LLAMA_CPP_RELEASE || 'b9253',
});

const llamaDir = path.join(ROOT, 'node_modules', 'node-llama-cpp', 'llama');
if (!fs.existsSync(llamaDir)) {
  console.error('[prepare-legacy] node-llama-cpp/llama missing after build');
  process.exit(1);
}

const localBuilds = path.join(llamaDir, 'localBuilds');
if (!fs.existsSync(localBuilds)) {
  console.error('[prepare-legacy] localBuilds/ missing — source build did not produce a binary');
  process.exit(1);
}

// Preserve llama-addon.node from prebuilt package — the local cmake build only
// produces .so libraries, not the Node.js addon itself.
const prebuiltPkg = useCuda ? 'linux-x64-cuda' : 'linux-x64';
const prebuiltDir = path.join(BACKENDS, prebuiltPkg, 'bins', prebuiltPkg);
const prebuiltAddon = path.join(prebuiltDir, 'llama-addon.node');
const prebuiltMeta  = path.join(prebuiltDir, '_nlcBuildMetadata.json');

if (fs.existsSync(prebuiltAddon)) {
  const localBuildEntries = fs.readdirSync(localBuilds).filter((n) => fs.statSync(path.join(localBuilds, n)).isDirectory());
  for (const folder of localBuildEntries) {
    const releaseDir = path.join(localBuilds, folder, 'Release');
    if (!fs.existsSync(releaseDir)) continue;
    fs.copyFileSync(prebuiltAddon, path.join(releaseDir, 'llama-addon.node'));
    if (fs.existsSync(prebuiltMeta)) {
      fs.copyFileSync(prebuiltMeta, path.join(releaseDir, '_nlcBuildMetadata.json'));
    }
    log(`copied llama-addon.node into localBuilds/${folder}/Release`);

    // The prebuilt addon may link to .so files with CUDA-specific suffixes
    // (e.g. libllama.cuda.b8390.so). Create symlinks so the addon finds our locally-built .so files.
    const soFiles = fs.readdirSync(releaseDir).filter((n) => n.endsWith('.so') && !n.includes('.cuda.'));
    for (const so of soFiles) {
      const base = so.replace(/\.so$/, '');
      // Try to create common suffixed variants the prebuilt addon might reference
      for (const suffix of ['.cuda.b8390.so', '.cuda.so', '.b8390.so']) {
        const linkName = base + suffix;
        const linkPath = path.join(releaseDir, linkName);
        if (!fs.existsSync(linkPath)) {
          try {
            fs.symlinkSync(so, linkPath);
            log(`symlink ${linkName} -> ${so}`);
          } catch {}
        }
      }
    }
  }
}

for (const pkg of prebuiltPackagesToRemove()) {
  const full = path.join(BACKENDS, pkg);
  if (fs.existsSync(full)) {
    fs.rmSync(full, { recursive: true, force: true });
    log(`removed @node-llama-cpp/${pkg}`);
  }
}

if (fs.existsSync(BACKENDS)) {
  for (const name of fs.readdirSync(BACKENDS)) {
    if (name === '.package-lock.json') continue;
    const full = path.join(BACKENDS, name);
    if (fs.statSync(full).isDirectory()) {
      fs.rmSync(full, { recursive: true, force: true });
      log(`removed @node-llama-cpp/${name}`);
    }
  }
}

log('done — legacy build uses local source-built llama.cpp only');

#!/usr/bin/env node
/**
 * Copy companion CUDA DLLs (cudart/cublas) beside source-built llama-addon.node.
 * ggml-cuda.dll depends on cudart64_12.dll + cublas64_12.dll; CI compile does not copy them.
 */
'use strict';

import fs from 'fs';
import path from 'path';
import https from 'https';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LLAMA_DIR = path.join(ROOT, 'node_modules', 'node-llama-cpp', 'llama');
const LOCAL_BUILDS = path.join(LLAMA_DIR, 'localBuilds');
const RELEASE = process.env.LLAMA_CPP_RELEASE || 'b9253';
const CUDA_VER = process.env.LLAMA_CUDA_DLL_VER || '12.4';

function log(msg) {
  console.log(`[bundle-llama-cuda-dlls] ${msg}`);
}

function fail(msg) {
  console.error(`[bundle-llama-cuda-dlls] FAIL: ${msg}`);
  process.exit(1);
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'guide-ide-fetch' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location).then(resolve, reject);
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, dest, expectedSize) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'guide-ide-fetch' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadFile(res.headers.location, dest, expectedSize).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          const got = fs.statSync(dest).size;
          if (expectedSize && got !== expectedSize) {
            fs.unlinkSync(dest);
            reject(new Error(`size mismatch ${path.basename(dest)}: ${got} vs ${expectedSize}`));
            return;
          }
          resolve();
        });
      });
      file.on('error', reject);
    }).on('error', reject);
  });
}

function extractZip(zipPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}' -Force"`,
      { stdio: 'inherit' },
    );
  } else {
    execSync(`unzip -o "${zipPath}" -d "${outDir}"`, { stdio: 'inherit' });
  }
}

function findCudaBuildDirs() {
  if (!fs.existsSync(LOCAL_BUILDS)) return [];
  return fs.readdirSync(LOCAL_BUILDS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.includes('cuda'))
    .map((e) => path.join(LOCAL_BUILDS, e.name));
}

function dllTargets(buildDir) {
  const dirs = [
    path.join(buildDir, 'Release'),
    path.join(buildDir, 'bin', 'Release'),
  ];
  return dirs.filter((d) => fs.existsSync(d));
}

function copyDllsFromTree(srcDir, targets) {
  let copied = 0;
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.dll$/i.test(name)) continue;
      for (const target of targets) {
        const dest = path.join(target, name);
        if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(full).size) continue;
        fs.copyFileSync(full, dest);
        copied += 1;
        log(`copied ${name} -> ${target}`);
      }
    }
  };
  walk(srcDir);
  return copied;
}

async function main() {
  if (process.platform !== 'win32') {
    log('skip — Windows CUDA DLL bundle only needed on win32');
    return;
  }

  const buildDirs = findCudaBuildDirs();
  if (!buildDirs.length) {
    log('skip — no win-x64-cuda localBuild');
    return;
  }

  const release = await fetchJson(`https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${RELEASE}`);
  const assetName = `cudart-llama-bin-win-cuda-${CUDA_VER}-x64.zip`;
  const asset = (release.assets || []).find((a) => a.name === assetName)
    || (release.assets || []).find((a) => /^cudart-llama-bin-win-cuda-\d+\.\d+-x64\.zip$/.test(a.name));
  if (!asset) fail(`no companion CUDA zip on release ${RELEASE}`);

  const cacheDir = path.join(ROOT, '.cache', 'llama-cuda-dlls');
  const zipPath = path.join(cacheDir, asset.name);
  fs.mkdirSync(cacheDir, { recursive: true });
  if (!fs.existsSync(zipPath)) {
    log(`downloading ${asset.name} (${Math.round(asset.size / 1e6)}MB)`);
    await downloadFile(asset.browser_download_url, zipPath, asset.size);
  }

  const extractDir = path.join(cacheDir, `extract-${asset.name}`);
  if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
  extractZip(zipPath, extractDir);

  let total = 0;
  for (const buildDir of buildDirs) {
    const targets = dllTargets(buildDir);
    if (!targets.length) continue;
    total += copyDllsFromTree(extractDir, targets);
    const releaseDir = path.join(buildDir, 'Release');
    const required = ['cudart64_12.dll', 'cublas64_12.dll'];
    for (const dll of required) {
      if (!fs.existsSync(path.join(releaseDir, dll))) {
        fail(`missing ${dll} in ${releaseDir} after bundle`);
      }
    }
  }

  log(`OK — ${total} DLL copy operation(s) across ${buildDirs.length} cuda build(s)`);
}

main().catch((err) => fail(err.message));

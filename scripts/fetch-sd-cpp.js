#!/usr/bin/env node
'use strict';

/**
 * Download stable-diffusion.cpp release binaries for bundling in guIDE installers.
 * Outputs:
 *   resources/sd-cpp/win-x64-cuda/sd.exe (+ DLLs)
 *   resources/sd-cpp/win-x64-cpu/sd.exe  (Vulkan build)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_CUDA = path.join(ROOT, 'resources', 'sd-cpp', 'win-x64-cuda');
const OUT_CPU = path.join(ROOT, 'resources', 'sd-cpp', 'win-x64-cpu');
const BIN_DEV = path.join(ROOT, 'bin');

const VARIANTS = [
  {
    name: 'cuda',
    assetPattern: /sd-master-.*-bin-win-cuda12-x64\.zip$/i,
    outDir: OUT_CUDA,
  },
  {
    name: 'cpu',
    assetPattern: /sd-master-.*-bin-win-vulkan-x64\.zip$/i,
    outDir: OUT_CPU,
  },
];

function log(msg) { console.log(`[fetch-sd-cpp] ${msg}`); }

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'guide-ide-fetch' } }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
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

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': 'guide-ide-fetch' } }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(resolve); });
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

function findSdExe(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && /^sd\.exe$/i.test(e.name)) return full;
    if (e.isDirectory()) {
      const found = findSdExe(full);
      if (found) return found;
    }
  }
  return null;
}

function flattenToOut(extractRoot, outDir) {
  const sdExe = findSdExe(extractRoot);
  if (!sdExe) throw new Error(`sd.exe not found under ${extractRoot}`);
  const binDir = path.dirname(sdExe);
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of fs.readdirSync(binDir)) {
    const src = path.join(binDir, name);
    const dest = path.join(outDir, name);
    if (fs.statSync(src).isFile()) fs.copyFileSync(src, dest);
  }
}

async function main() {
  log('Fetching latest stable-diffusion.cpp release...');
  const release = await fetchJson('https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/latest');
  const tag = release.tag_name;
  log(`Latest release: ${tag}`);

  const tmp = path.join(ROOT, '.tmp-sd-cpp');
  fs.mkdirSync(tmp, { recursive: true });

  for (const variant of VARIANTS) {
    const asset = (release.assets || []).find((a) => variant.assetPattern.test(a.name));
    if (!asset) {
      log(`WARN: No asset matching ${variant.assetPattern} — skip ${variant.name}`);
      continue;
    }
    const zipPath = path.join(tmp, asset.name);
    if (!fs.existsSync(zipPath)) {
      log(`Downloading ${asset.name} (${Math.round(asset.size / 1e6)}MB)...`);
      await downloadFile(asset.browser_download_url, zipPath);
    }
    const extractDir = path.join(tmp, `extract-${variant.name}`);
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
    extractZip(zipPath, extractDir);
    if (fs.existsSync(variant.outDir)) fs.rmSync(variant.outDir, { recursive: true, force: true });
    flattenToOut(extractDir, variant.outDir);
    log(`Installed ${variant.name} → ${variant.outDir}`);
  }

  const cudaSd = path.join(OUT_CUDA, 'sd.exe');
  if (fs.existsSync(cudaSd)) {
    fs.mkdirSync(BIN_DEV, { recursive: true });
    for (const name of fs.readdirSync(OUT_CUDA)) {
      fs.copyFileSync(path.join(OUT_CUDA, name), path.join(BIN_DEV, name));
    }
    log(`Dev copy → ${BIN_DEV}`);
  }

  log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

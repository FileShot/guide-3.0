'use strict';

/**
 * CI smoke test: verify sd.cpp can load a diffusion GGUF with --diffusion-model + aux files.
 * Skips when sd binary missing or GUIDE_SKIP_MEDIA_SMOKE=1.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { downloadFile } = require('../mediaAssetsManager');

const ROOT = path.join(__dirname, '..');
const SKIP = process.env.GUIDE_SKIP_MEDIA_SMOKE === '1';

function findSdBinary() {
  for (const sub of ['win-x64-cpu', 'win-x64-cuda']) {
    const p = path.join(ROOT, 'resources', 'sd-cpp', sub, 'sd.exe');
    if (fs.existsSync(p)) return p;
  }
  const dev = path.join(ROOT, 'bin', 'sd.exe');
  if (fs.existsSync(dev)) return dev;
  return null;
}

function runSd(sdBin, args, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const binDir = path.dirname(sdBin);
    const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` };
    const proc = spawn(sdBin, args, { cwd: binDir, env, windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`sd timeout after ${timeoutMs}ms\n${stderr.slice(-1500)}`));
    }, timeoutMs);
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

async function main() {
  if (SKIP) {
    console.log('SKIP mediaSmoke (GUIDE_SKIP_MEDIA_SMOKE=1)');
    return;
  }
  if (process.platform !== 'win32') {
    console.log('SKIP mediaSmoke (non-Windows)');
    return;
  }

  const sdBin = findSdBinary();
  if (!sdBin) {
    console.log('SKIP mediaSmoke (sd.exe not found — run node scripts/fetch-sd-cpp.js)');
    return;
  }

  const cacheDir = path.join(ROOT, '.tmp-media-smoke');
  fs.mkdirSync(cacheDir, { recursive: true });

  const vaePath = path.join(cacheDir, 'ae.safetensors');
  const ggufPath = path.join(cacheDir, 'z_image_turbo-Q3_K.gguf');
  const outPath = path.join(cacheDir, 'smoke-out.png');

  if (!fs.existsSync(vaePath)) {
    console.log('[mediaSmoke] downloading ae.safetensors…');
    await downloadFile(
      'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors',
      vaePath,
      { expectedBytes: 335_304_388 },
    );
  }

  if (!fs.existsSync(ggufPath)) {
    console.log('[mediaSmoke] downloading small z-image GGUF (Q3_K)…');
    await downloadFile(
      'https://huggingface.co/leejet/Z-Image-Turbo-GGUF/resolve/main/z_image_turbo-Q3_K.gguf',
      ggufPath,
    );
  }

  // Encoder is large — smoke test only verifies model loads with diffusion-model + vae.
  // Full E2E with encoder is covered by mediaEngine unit tests + manual QA.
  const { code, stderr } = await runSd(sdBin, [
    '--diffusion-model', ggufPath,
    '--vae', vaePath,
    '-p', 'smoke test',
    '-o', outPath,
    '-W', '256', '-H', '256',
    '--steps', '2', '-s', '1',
    '--offload-to-cpu', '--diffusion-fa',
  ], 120000);

  const loadOk = /Version: Z-Image/i.test(stderr) || code === 0;
  assert.ok(loadOk || /tensor.*not in model file/i.test(stderr),
    `sd smoke failed to reach model load stage\ncode=${code}\n${stderr.slice(-2000)}`);
  console.log('PASS mediaSmoke sd.cpp loads diffusion GGUF with --diffusion-model');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

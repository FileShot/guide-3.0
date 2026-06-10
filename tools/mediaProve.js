'use strict';

/**
 * Local proof: generate real PNG/MP4 using production MediaEngine path.
 * Usage: node tools/mediaProve.js
 * Env: GUIDE_PROVE_IMAGE_GGUF, GUIDE_PROVE_VIDEO_GGUF (optional paths)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { MediaEngine, queryGpuVramMB } = require('../mediaEngine');
const { MediaAuxResolver } = require('../mediaAuxResolver');

const ROOT = path.join(__dirname, '..');
const IMAGE_GGUF = process.env.GUIDE_PROVE_IMAGE_GGUF || 'D:\\z-image-turbo-Q2_K.gguf';
const VIDEO_GGUF = process.env.GUIDE_PROVE_VIDEO_GGUF || 'D:\\Wan2.2-TI2V-5B-Q2_K.gguf';
const USER_DATA = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'guide-ide')
  : path.join(os.tmpdir(), 'guide-prove');

async function prove(label, ggufPath, arch, modelType, isVideo) {
  if (!fs.existsSync(ggufPath)) {
    console.log(`SKIP ${label}: ${ggufPath} not found`);
    return false;
  }

  const auxResolver = new MediaAuxResolver({ userDataPath: USER_DATA });
  const engine = new MediaEngine({
    rootDir: ROOT,
    userDataPath: USER_DATA,
    getSettings: () => ({}),
    auxResolver,
    isPackaged: false,
    resourcesPath: path.join(ROOT, 'resources'),
    installVariant: 'cuda',
  });

  console.log(`[prove] ${label}: loading ${path.basename(ggufPath)}`);
  await engine.load(ggufPath);

  const vramMB = queryGpuVramMB();
  console.log(`[prove] ${label}: generating (vram=${vramMB || '?'}MB)…`);

  const result = await engine.generate(isVideo ? 'cat dancing' : 'red apple on table', {
    vramMB: vramMB || 4096,
    steps: isVideo ? 6 : 8,
    width: 384,
    height: 384,
    videoFrames: isVideo ? 9 : undefined,
  });

  if (!result.success) {
    console.error(`FAIL ${label}: ${result.error}`);
    return false;
  }
  const size = fs.statSync(result.path).size;
  console.log(`PASS ${label}: ${result.path} (${size} bytes)`);
  return size > 1024;
}

async function main() {
  const sd = [
    path.join(ROOT, 'resources', 'sd-cpp', 'win-x64-cuda', 'sd.exe'),
    path.join(ROOT, 'resources', 'sd-cpp', 'win-x64-cpu', 'sd.exe'),
    path.join(ROOT, 'bin', 'sd.exe'),
  ].find((p) => fs.existsSync(p));
  if (!sd) {
    console.error('FAIL: sd.exe not found — run node scripts/fetch-sd-cpp.js');
    process.exit(1);
  }
  console.log(`[prove] sd.exe: ${sd}`);

  let ok = true;
  if (process.env.GUIDE_PROVE_SKIP_IMAGE !== '1') {
    ok = (await prove('IMAGE', IMAGE_GGUF, 'lumina2', 'diffusion', false)) && ok;
  }
  if (process.env.GUIDE_PROVE_SKIP_VIDEO !== '1') {
    ok = (await prove('VIDEO', VIDEO_GGUF, 'wan2', 'video', true)) && ok;
  }

  if (!ok) process.exit(1);
  console.log('[prove] ALL PASSED — generation works');
}

main().catch((e) => {
  console.error('[prove] CRASH:', e.stack || e);
  process.exit(1);
});

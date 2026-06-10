'use strict';

/**
 * Production E2E gate: load GGUF + resolve aux + generate real PNG/MP4 per arch profile.
 * Skips when GUIDE_SKIP_MEDIA_E2E=1, non-Windows, or sd.exe missing.
 * Full matrix (including Wan video): set GUIDE_MEDIA_E2E_FULL=1 (long downloads).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { downloadFileWithRetry } = require('../mediaAssetsManager');
const { MediaEngine, queryGpuVramMB } = require('../mediaEngine');
const { MediaAuxResolver } = require('../mediaAuxResolver');
const { listProfileIds } = require('../mediaAssetsCatalog');

const ROOT = path.join(__dirname, '..');
const SKIP = process.env.GUIDE_SKIP_MEDIA_E2E === '1';
const FULL = process.env.GUIDE_MEDIA_E2E_FULL === '1';

const E2E_PROFILES = {
  'lumina-image': {
    arch: 'lumina2',
    modelType: 'diffusion',
    ggufUrl: 'https://huggingface.co/leejet/Z-Image-Turbo-GGUF/resolve/main/z_image_turbo-Q3_K.gguf',
    ggufName: 'z_image_turbo-Q3_K.gguf',
    ext: 'png',
    steps: 4,
    size: 256,
  },
  'flux-image': {
    arch: 'flux',
    modelType: 'diffusion',
    ggufUrl: 'https://huggingface.co/leejet/FLUX.1-schnell-gguf/resolve/main/flux1-schnell-q4_0.gguf',
    ggufName: 'flux1-schnell-q4_0.gguf',
    ext: 'png',
    steps: 4,
    size: 256,
    fullOnly: true,
  },
  'wan-video': {
    arch: 'wan',
    modelType: 'video',
    ggufUrl: 'https://huggingface.co/calcuis/wan-1.3b-gguf/resolve/main/wan2.1_t2v_1.3b_q4_k_s.gguf',
    ggufName: 'wan2.1_t2v_1.3b_q4_k_s.gguf',
    ext: 'mp4',
    steps: 4,
    size: 256,
    frames: 9,
    fullOnly: true,
  },
  'wan22-ti2v': {
    arch: 'wan2',
    modelType: 'video',
    ggufUrl: 'https://huggingface.co/QuantStack/Wan2.2-TI2V-5B-GGUF/resolve/main/Wan2.2-TI2V-5B-Q4_K_S.gguf',
    ggufName: 'Wan2.2-TI2V-5B-Q4_K_S.gguf',
    ext: 'mp4',
    steps: 4,
    size: 256,
    frames: 9,
    fullOnly: true,
  },
};

function findSdBinary() {
  for (const sub of ['win-x64-cuda', 'win-x64-cpu']) {
    const p = path.join(ROOT, 'resources', 'sd-cpp', sub, 'sd.exe');
    if (fs.existsSync(p)) return p;
  }
  const dev = path.join(ROOT, 'bin', 'sd.exe');
  if (fs.existsSync(dev)) return dev;
  return null;
}

function profilesToRun() {
  const ids = listProfileIds().filter((id) => E2E_PROFILES[id]);
  if (FULL) return ids;
  // CI default: one small image profile (lumina) — proven PNG gate without 6GB+ downloads.
  return ids.filter((id) => id === 'lumina-image');
}

async function ensureGguf(cacheDir, spec) {
  const dest = path.join(cacheDir, spec.ggufName);
  if (!fs.existsSync(dest)) {
    console.log(`[mediaE2E] downloading ${spec.ggufName}…`);
    await downloadFileWithRetry(spec.ggufUrl, dest);
  }
  return dest;
}

async function runProfile(profileId, workDir, vramMB) {
  const spec = E2E_PROFILES[profileId];
  const ggufPath = await ensureGguf(path.join(workDir, 'models'), spec);
  const cacheDir = path.join(workDir, 'media-cache');
  const userData = path.join(workDir, 'userdata');

  const auxResolver = new MediaAuxResolver({ userDataPath: userData });
  const engine = new MediaEngine({
    rootDir: ROOT,
    userDataPath: userData,
    getSettings: () => ({}),
    auxResolver,
    isPackaged: false,
    installVariant: 'cpu',
  });

  engine.ggufArchitecture = spec.arch;
  engine.modelType = spec.modelType;
  engine.modelPath = ggufPath;

  const aux = await auxResolver.ensureForGenerate({
    arch: spec.arch,
    modelType: spec.modelType,
    modelPath: ggufPath,
    settings: {},
    vramMB,
  });
  engine._resolvedAux = aux;

  const result = await engine.generate('e2e test cat', {
    vramMB,
    width: spec.size,
    height: spec.size,
    steps: spec.steps,
    videoFrames: spec.frames || 1,
  });

  assert.strictEqual(result.success, true, `${profileId} failed: ${result.error || 'unknown'}`);
  assert.ok(result.path && fs.existsSync(result.path), `${profileId}: output missing`);
  const stat = fs.statSync(result.path);
  assert.ok(stat.size > 1024, `${profileId}: output too small (${stat.size} bytes)`);
  console.log(`PASS mediaE2E ${profileId} → ${result.path} (${stat.size} bytes)`);
}

async function main() {
  if (SKIP) {
    console.log('SKIP mediaE2E (GUIDE_SKIP_MEDIA_E2E=1)');
    return;
  }
  if (process.platform !== 'win32') {
    console.log('SKIP mediaE2E (non-Windows — run on Windows CI after fetch-sd-cpp)');
    return;
  }

  const sdBin = findSdBinary();
  if (!sdBin) {
    console.log('SKIP mediaE2E (sd.exe not found — run node scripts/fetch-sd-cpp.js)');
    return;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-media-e2e-'));
  const vramMB = queryGpuVramMB();
  const ids = profilesToRun();

  console.log(`[mediaE2E] profiles=${ids.join(',')} vram=${vramMB || 'unknown'}MB full=${FULL}`);

  for (const profileId of ids) {
    await runProfile(profileId, workDir, vramMB || 4096);
  }

  console.log('mediaE2E.test.js: all profiles passed');
}

main().catch((e) => {
  console.error('[mediaE2E] FAILED:', e?.stack || e?.message || e);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';

/**
 * Download media auxiliary models for bundling in guIDE installers.
 *   resources/media-assets/image/ae.safetensors
 *   resources/media-assets/image/Qwen3-4B-Instruct-2507-Q4_K_M.gguf
 *   resources/media-assets/wan/taew2_2.safetensors
 *   resources/media-assets/wan/umt5-xxl-encoder-Q3_K_S.gguf
 *
 * Usage: node scripts/fetch-media-assets.js [--profile lumina-image|wan-video|all]
 */

const fs = require('fs');
const path = require('path');
const { MEDIA_ASSET_PROFILES } = require('../mediaAssetsCatalog');
const { downloadFile } = require('../mediaAssetsManager');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'resources', 'media-assets');

async function fetchProfile(profileId) {
  const profile = MEDIA_ASSET_PROFILES[profileId];
  if (!profile) throw new Error(`Unknown profile: ${profileId}`);
  console.log(`[fetch-media-assets] Profile: ${profile.label}`);
  for (const asset of profile.assets) {
    const dest = path.join(OUT, asset.relPath);
    if (fs.existsSync(dest)) {
      const got = fs.statSync(dest).size;
      if (asset.bytes > 0 && got >= asset.bytes * 0.95) {
        console.log(`[fetch-media-assets] skip (exists) ${asset.relPath} (${Math.round(got / 1e6)}MB)`);
        continue;
      }
      fs.unlinkSync(dest);
    }
    console.log(`[fetch-media-assets] downloading ${asset.relPath}...`);
    await downloadFile(asset.url, dest, {
      expectedBytes: asset.bytes || undefined,
      onProgress: ({ received, total }) => {
        if (!total) return;
        const pct = Math.round((received / total) * 100);
        if (pct % 10 === 0) process.stdout.write(`\r[fetch-media-assets] ${asset.relPath}: ${pct}%`);
      },
    });
    console.log(`\n[fetch-media-assets] ok ${asset.relPath}`);
  }
}

async function main() {
  const arg = process.argv.find((a) => a.startsWith('--profile='));
  const profileArg = arg ? arg.split('=')[1] : 'all';
  const profiles = profileArg === 'all'
    ? Object.keys(MEDIA_ASSET_PROFILES)
    : [profileArg];
  fs.mkdirSync(OUT, { recursive: true });
  for (const id of profiles) {
    await fetchProfile(id);
  }
  console.log('[fetch-media-assets] Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

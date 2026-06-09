#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { MEDIA_ASSET_PROFILES } = require('../mediaAssetsCatalog');

const ROOT = path.join(__dirname, '..', 'resources', 'media-assets');
let ok = true;

function assetPresent(relPath) {
  const p = path.join(ROOT, relPath);
  if (fs.existsSync(p)) return fs.statSync(p).size;
  const partsMeta = `${p}.parts.json`;
  if (!fs.existsSync(partsMeta)) return 0;
  const meta = JSON.parse(fs.readFileSync(partsMeta, 'utf8'));
  let total = 0;
  for (let i = 0; i < meta.chunks; i++) {
    const chunk = `${p}.part${String(i).padStart(3, '0')}`;
    if (!fs.existsSync(chunk)) return 0;
    total += fs.statSync(chunk).size;
  }
  return total;
}

for (const [profileId, profile] of Object.entries(MEDIA_ASSET_PROFILES)) {
  for (const asset of profile.assets) {
    const size = assetPresent(asset.relPath);
    if (!size) {
      console.error(`[verify-media-assets] MISSING ${profileId}: ${asset.relPath}`);
      ok = false;
      continue;
    }
    if (asset.bytes > 0 && size < asset.bytes * 0.9) {
      console.error(`[verify-media-assets] TOO SMALL ${asset.relPath}: ${size} < ${asset.bytes}`);
      ok = false;
      continue;
    }
    console.log(`[verify-media-assets] ok ${asset.relPath} (${Math.round(size / 1e6)}MB)`);
  }
}

if (!ok) process.exit(1);
console.log('[verify-media-assets] All bundled media assets present.');

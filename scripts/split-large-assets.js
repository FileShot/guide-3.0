#!/usr/bin/env node
'use strict';

/**
 * NSIS/electron-builder cannot pack files >2GB. Split large media assets into chunks.
 */
const fs = require('fs');
const path = require('path');
const { MEDIA_ASSET_PROFILES } = require('../mediaAssetsCatalog');

const ROOT = path.join(__dirname, '..', 'resources', 'media-assets');
const CHUNK_BYTES = 1024 * 1024 * 1024; // 1GB — safe for NSIS

function splitFile(absPath) {
  const size = fs.statSync(absPath).size;
  if (size <= CHUNK_BYTES) return 0;
  const base = absPath;
  let part = 0;
  const fd = fs.openSync(absPath, 'r');
  try {
    let offset = 0;
    while (offset < size) {
      const len = Math.min(CHUNK_BYTES, size - offset);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      const chunkPath = `${base}.part${String(part).padStart(3, '0')}`;
      fs.writeFileSync(chunkPath, buf);
      console.log(`[split-large-assets] ${path.basename(chunkPath)} (${Math.round(len / 1e6)}MB)`);
      offset += len;
      part += 1;
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.unlinkSync(absPath);
  fs.writeFileSync(`${base}.parts.json`, JSON.stringify({ originalSize: size, chunks: part }));
  console.log(`[split-large-assets] split ${path.basename(absPath)} → ${part} parts`);
  return part;
}

function main() {
  let split = 0;
  for (const profile of Object.values(MEDIA_ASSET_PROFILES)) {
    for (const asset of profile.assets) {
      const p = path.join(ROOT, asset.relPath);
      if (!fs.existsSync(p)) continue;
      split += splitFile(p) > 0 ? 1 : 0;
    }
  }
  console.log(`[split-large-assets] Done. Split ${split} large file(s).`);
}

main();

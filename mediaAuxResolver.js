'use strict';

const fs = require('fs');
const path = require('path');
const {
  MEDIA_ASSET_PROFILES,
  archToMediaProfile,
  listAssetsForProfile,
  getAuxKeyMap,
} = require('./mediaAssetsCatalog');
const { downloadFile } = require('./mediaAssetsManager');
const { VRAM_LOW_MB } = require('./mediaEngine');

const SETTING_KEYS = {
  vae: 'mediaVaePath',
  tae: 'mediaTaePath',
  t5: 'mediaT5Path',
  llm: 'mediaClipPath',
  clip: 'mediaClipPath',
};

const SAME_DIR_PATTERNS = {
  vae: [/ae\.safetensors$/i, /wan2\.2_vae\.safetensors$/i, /wan_2\.1_vae\.safetensors$/i],
  tae: [/taew2_2\.safetensors$/i],
  t5: [/umt5.*\.gguf$/i],
  llm: [/qwen3.*4b.*\.gguf$/i, /qwen.*instruct.*\.gguf$/i],
};

function scanSameDirectory(modelPath) {
  const found = {};
  if (!modelPath) return found;
  const dir = path.dirname(modelPath);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    try {
      if (!fs.statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    for (const [key, patterns] of Object.entries(SAME_DIR_PATTERNS)) {
      if (found[key]) continue;
      if (patterns.some((p) => p.test(name))) found[key] = full;
    }
  }
  if (found.llm) found.clip = found.llm;
  return found;
}

function pickFromSettings(settings) {
  const out = {};
  for (const [auxKey, settingKey] of Object.entries(SETTING_KEYS)) {
    if (out[auxKey]) continue;
    const p = settings?.[settingKey];
    if (p && fs.existsSync(p)) out[auxKey] = p;
  }
  if (out.llm) out.clip = out.llm;
  return out;
}

class MediaAuxResolver {
  constructor(options = {}) {
    this.userDataPath = options.userDataPath || require('os').tmpdir();
    this._cacheDir = path.join(this.userDataPath, 'media-cache');
    this._inflight = new Map();
  }

  _cachedPath(relPath) {
    const p = path.join(this._cacheDir, relPath);
    return fs.existsSync(p) ? p : null;
  }

  async _downloadAsset(asset, onProgress) {
    const key = `asset:${asset.relPath}`;
    if (this._inflight.has(key)) return this._inflight.get(key);
    const dest = path.join(this._cacheDir, asset.relPath);
    const job = (async () => {
      const label = asset.userLabel || path.basename(asset.relPath);
      const sizeMb = asset.bytes ? Math.round(asset.bytes / 1e6) : null;
      if (onProgress) {
        onProgress({
          phase: 'start',
          label,
          file: path.basename(asset.relPath),
          total: asset.bytes || 0,
          message: sizeMb
            ? `Setting up ${label}… downloading ${sizeMb} MB (one-time)`
            : `Setting up ${label}…`,
        });
      }
      console.log(`[MediaAux] Downloading ${asset.relPath} (${label})`);
      await downloadFile(asset.url, dest, {
        expectedBytes: asset.bytes || undefined,
        onProgress: ({ received, total }) => {
          if (onProgress && total > 0) {
            onProgress({
              phase: 'progress',
              label,
              file: path.basename(asset.relPath),
              received,
              total,
              pct: Math.floor((received / total) * 100),
            });
          }
        },
      });
      if (onProgress) onProgress({ phase: 'done', label, file: path.basename(asset.relPath) });
      return dest;
    })().finally(() => this._inflight.delete(key));
    this._inflight.set(key, job);
    return job;
  }

  async ensureForGenerate({ arch, modelType, modelPath, settings = {}, vramMB = 0, onProgress }) {
    const profileId = archToMediaProfile(arch, modelType, modelPath);
    if (!profileId) {
      return pickFromSettings(settings);
    }

    const lowVram = vramMB > 0 && vramMB <= VRAM_LOW_MB;
    const auxKeyMap = getAuxKeyMap(profileId, lowVram);
    const profile = MEDIA_ASSET_PROFILES[profileId];
    const assetsById = Object.fromEntries(listAssetsForProfile(profileId).map((a) => [a.id, a]));

    const resolved = { ...scanSameDirectory(modelPath), ...pickFromSettings(settings) };

    for (const [auxKey, assetId] of Object.entries(auxKeyMap)) {
      if (resolved[auxKey] && fs.existsSync(resolved[auxKey])) continue;
      const asset = assetsById[assetId];
      if (!asset) continue;
      const cached = this._cachedPath(asset.relPath);
      if (cached) {
        resolved[auxKey] = cached;
        continue;
      }
      try {
        resolved[auxKey] = await this._downloadAsset(asset, onProgress);
      } catch (e) {
        throw new Error(`Could not download ${asset.userLabel || asset.relPath}: ${e.message}`);
      }
    }

    if (resolved.llm) resolved.clip = resolved.llm;
    resolved._profileId = profileId;
    resolved._profileLabel = profile?.label;
    return resolved;
  }
}

module.exports = {
  MediaAuxResolver,
  scanSameDirectory,
  pickFromSettings,
  SAME_DIR_PATTERNS,
};

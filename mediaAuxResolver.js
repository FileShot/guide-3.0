'use strict';

const fs = require('fs');
const path = require('path');
const {
  MEDIA_ASSET_PROFILES,
  archToMediaProfile,
  listAssetsForProfile,
  getAuxKeyMap,
  getAuxKeyFallbacks,
  getRequiredAuxKeys,
} = require('./mediaAssetsCatalog');
const { downloadFileWithRetry } = require('./mediaAssetsManager');
const { VRAM_LOW_MB } = require('./mediaConstants');

const SETTING_KEYS = {
  vae: 'mediaVaePath',
  tae: 'mediaTaePath',
  t5: 'mediaT5Path',
  llm: 'mediaClipPath',
  clip: 'mediaClipPath',
  clip_l: 'mediaClipPath',
  clip_g: 'mediaClipGPath',
};

const SAME_DIR_PATTERNS = {
  vae: [
    /ae\.safetensors$/i,
    /wan2\.2_vae\.safetensors$/i,
    /wan_2\.1_vae\.safetensors$/i,
    /diffusion_pytorch_model\.safetensors$/i,
    /sdxl.*vae.*\.safetensors$/i,
    /sd3.*vae.*\.safetensors$/i,
    /vae.*\.safetensors$/i,
  ],
  tae: [/taew2_2\.safetensors$/i],
  t5: [/umt5.*\.gguf$/i, /umt5.*\.safetensors$/i, /t5xxl.*\.safetensors$/i],
  clip_l: [/clip_l\.safetensors$/i, /clip-l\.safetensors$/i],
  clip_g: [/clip_g\.safetensors$/i, /clip-g\.safetensors$/i],
  clip: [/clip_l\.safetensors$/i, /clip-l\.safetensors$/i],
  llm: [
    /qwen_3_4b\.safetensors$/i,
    /qwen3.*4b.*\.safetensors$/i,
    /qwen3.*4b.*\.gguf$/i,
    /qwen.*instruct.*\.gguf$/i,
  ],
};

/** Cache scan patterns scoped per profile — prevents image VAE matching video jobs. */
const PROFILE_CACHE_PATTERNS = {
  'lumina-image': { vae: [/ae\.safetensors$/i], llm: SAME_DIR_PATTERNS.llm },
  'flux-image': { vae: [/ae\.safetensors$/i] },
  'sdxl-image': { vae: SAME_DIR_PATTERNS.vae, clip_l: SAME_DIR_PATTERNS.clip_l, clip_g: SAME_DIR_PATTERNS.clip_g },
  'sd-image': { vae: SAME_DIR_PATTERNS.vae, clip_l: SAME_DIR_PATTERNS.clip_l },
  'sd3-image': { vae: SAME_DIR_PATTERNS.vae, clip_l: SAME_DIR_PATTERNS.clip_l, clip_g: SAME_DIR_PATTERNS.clip_g, t5: SAME_DIR_PATTERNS.t5 },
  'pixart-image': { vae: SAME_DIR_PATTERNS.vae, t5: SAME_DIR_PATTERNS.t5 },
  'image-generic': { vae: SAME_DIR_PATTERNS.vae, llm: SAME_DIR_PATTERNS.llm, clip: SAME_DIR_PATTERNS.clip },
  'wan22-ti2v': { vae: [/wan2\.2_vae\.safetensors$/i], t5: SAME_DIR_PATTERNS.t5, tae: SAME_DIR_PATTERNS.tae },
  'wan-video': { vae: [/wan_2\.1_vae\.safetensors$/i], t5: SAME_DIR_PATTERNS.t5, tae: SAME_DIR_PATTERNS.tae },
  'cogvideo-video': { vae: SAME_DIR_PATTERNS.vae, t5: SAME_DIR_PATTERNS.t5, llm: SAME_DIR_PATTERNS.llm },
  'ltx-video': { vae: SAME_DIR_PATTERNS.vae, llm: SAME_DIR_PATTERNS.llm },
  'hunyuan-video': { vae: SAME_DIR_PATTERNS.vae, llm: SAME_DIR_PATTERNS.llm },
  'mochi-video': { vae: SAME_DIR_PATTERNS.vae, llm: SAME_DIR_PATTERNS.llm },
  'video-generic': { vae: SAME_DIR_PATTERNS.vae, t5: SAME_DIR_PATTERNS.t5, tae: SAME_DIR_PATTERNS.tae, llm: SAME_DIR_PATTERNS.llm },
};

function scanSameDirectory(modelPath, profileId) {
  const found = {};
  if (!modelPath) return found;
  const dir = path.dirname(modelPath);
  const patternSource = (profileId && PROFILE_CACHE_PATTERNS[profileId])
    ? PROFILE_CACHE_PATTERNS[profileId]
    : SAME_DIR_PATTERNS;
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
    for (const [key, patterns] of Object.entries(patternSource)) {
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

function _auxDownloadMessage(asset) {
  const label = asset.userLabel || path.basename(asset.relPath);
  const sizeMb = asset.bytes ? Math.round(asset.bytes / 1e6) : null;
  if (sizeMb) {
    return `First generate needs ~${sizeMb} MB diffusion weights for ${label} (one-time cache, not your chat model)`;
  }
  return `Setting up ${label} for diffusion (one-time cache, not your chat model)…`;
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

  _findCachedByPattern(auxKey, profileId) {
    const profileMap = PROFILE_CACHE_PATTERNS[profileId] || {};
    const patterns = profileMap[auxKey] || SAME_DIR_PATTERNS[auxKey];
    if (!patterns?.length || !fs.existsSync(this._cacheDir)) return null;

    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return null;
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isFile() && patterns.some((p) => p.test(ent.name))) return full;
        if (ent.isDirectory()) {
          const nested = walk(full);
          if (nested) return nested;
        }
      }
      return null;
    };
    return walk(this._cacheDir);
  }

  async _downloadAsset(asset, onProgress) {
    const key = `asset:${asset.relPath}`;
    if (this._inflight.has(key)) return this._inflight.get(key);
    const dest = path.join(this._cacheDir, asset.relPath);
    const job = (async () => {
      const label = asset.userLabel || path.basename(asset.relPath);
      const message = _auxDownloadMessage(asset);
      if (onProgress) {
        onProgress({
          phase: 'start',
          label,
          file: path.basename(asset.relPath),
          total: asset.bytes || 0,
          message,
        });
      }
      console.log(`[MediaAux] Downloading ${asset.relPath} (${label})`);
      await downloadFileWithRetry(asset.url, dest, {
        expectedBytes: asset.bytes || undefined,
        retries: 3,
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

  async _resolveAuxKey(auxKey, primaryAssetId, fallbacks, assetsById, resolved, onProgress, profileId) {
    if (resolved[auxKey] && fs.existsSync(resolved[auxKey])) return;

    const patternCached = this._findCachedByPattern(auxKey, profileId);
    if (patternCached) {
      resolved[auxKey] = patternCached;
      return;
    }

    const tryIds = [primaryAssetId, fallbacks[auxKey]].filter(Boolean);
    for (const assetId of tryIds) {
      const asset = assetsById[assetId];
      if (!asset) continue;
      const cached = this._cachedPath(asset.relPath);
      if (cached) {
        resolved[auxKey] = cached;
        return;
      }
      try {
        resolved[auxKey] = await this._downloadAsset(asset, onProgress);
        return;
      } catch (e) {
        console.warn(`[MediaAux] Could not fetch ${asset.relPath}: ${e.message}`);
      }
    }
  }

  async ensureForGenerate({ arch, modelType, modelPath, settings = {}, vramMB = 0, onProgress }) {
    const profileId = archToMediaProfile(arch, modelType, modelPath);
    if (!profileId) {
      return pickFromSettings(settings);
    }

    const lowVram = vramMB > 0 && vramMB <= VRAM_LOW_MB;
    const auxKeyMap = getAuxKeyMap(profileId, lowVram, settings);
    const fallbacks = getAuxKeyFallbacks(profileId);
    const profile = MEDIA_ASSET_PROFILES[profileId];
    const assetsById = Object.fromEntries(listAssetsForProfile(profileId).map((a) => [a.id, a]));

    const resolved = { ...scanSameDirectory(modelPath, profileId), ...pickFromSettings(settings) };

    for (const [auxKey, assetId] of Object.entries(auxKeyMap)) {
      await this._resolveAuxKey(auxKey, assetId, fallbacks, assetsById, resolved, onProgress, profileId);
    }

    const missing = [];
    for (const key of getRequiredAuxKeys(profileId, lowVram, settings)) {
      if (!resolved[key] || !fs.existsSync(resolved[key])) {
        missing.push(key);
      }
    }

    if (missing.length > 0) {
      const labels = missing.map((k) => {
        if (k === 'llm') return 'text encoder (Settings → Media → Text encoder, or beside your GGUF)';
        if (k === 'clip_l') return 'CLIP-L encoder (Settings → Media, or beside your GGUF)';
        if (k === 'clip_g') return 'CLIP-G encoder (Settings → Media → CLIP-G, or beside your GGUF)';
        if (k === 't5') return 'T5 encoder (Settings → Media → T5 override, or beside your GGUF)';
        if (k === 'vae') return 'VAE';
        if (k === 'tae') return 'TAE decoder';
        return k;
      });
      const profileLabel = profile?.label || profileId || 'media';
      throw new Error(
        `[${profileLabel}] Missing required diffusion components: ${labels.join(', ')}. `
        + 'Place files beside your GGUF, set paths in Settings → Media, or retry to download.',
      );
    }

    if (resolved.llm) resolved.clip = resolved.llm;
    if (resolved.clip_l && !resolved.clip) resolved.clip = resolved.clip_l;
    resolved._profileId = profileId;
    resolved._profileLabel = profile?.label;
    return resolved;
  }

  /** Lightweight preflight — scan/settings only, no downloads. */
  preflight({ arch, modelType, modelPath, settings = {}, vramMB = 0 }) {
    const profileId = archToMediaProfile(arch, modelType, modelPath);
    if (!profileId) return { profileId: null, ready: true, missing: [] };
    const lowVram = vramMB > 0 && vramMB <= VRAM_LOW_MB;
    const required = getRequiredAuxKeys(profileId, lowVram, settings);
    const resolved = { ...scanSameDirectory(modelPath, profileId), ...pickFromSettings(settings) };
    const missing = required.filter((k) => !resolved[k] || !fs.existsSync(resolved[k]));
    return {
      profileId,
      ready: missing.length === 0,
      missing,
      willAutoDownload: missing.length > 0 && (MEDIA_ASSET_PROFILES[profileId]?.assets?.length > 0),
    };
  }
}

module.exports = {
  MediaAuxResolver,
  scanSameDirectory,
  pickFromSettings,
  SAME_DIR_PATTERNS,
  _auxDownloadMessage,
};

'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const https = require('https');
const {
  MEDIA_ASSET_PROFILES,
  archToMediaProfile,
  listAssetsForProfile,
} = require('./mediaAssetsCatalog');

function githubHeaders() {
  const headers = { 'User-Agent': 'guIDE-media-assets' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  if (process.env.HF_TOKEN) headers.Authorization = `Bearer ${process.env.HF_TOKEN}`;
  return headers;
}

function downloadFile(url, dest, { onProgress, expectedBytes } = {}) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    const file = fs.createWriteStream(tmp);
    const req = (u) => {
      https.get(u, { headers: githubHeaders() }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlink(tmp, () => {});
          return req(res.headers.location);
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(tmp, () => {});
          return reject(new Error(`Download failed HTTP ${res.statusCode}: ${u}`));
        }
        const total = Number(res.headers['content-length'] || expectedBytes || 0);
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress && total > 0) onProgress({ received, total, file: path.basename(dest) });
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            try {
              if (fs.existsSync(dest)) fs.unlinkSync(dest);
              fs.renameSync(tmp, dest);
              resolve(dest);
            } catch (e) {
              reject(e);
            }
          });
        });
      }).on('error', reject);
    };
    req(url);
  });
}

class MediaAssetsManager {
  constructor(options = {}) {
    this.userDataPath = options.userDataPath || require('os').tmpdir();
    this.resourcesPath = options.resourcesPath || null;
    this.rootDir = options.rootDir || __dirname;
    this.onProgress = options.onProgress || null;
    this._bundledDir = this.resourcesPath
      ? path.join(this.resourcesPath, 'media-assets')
      : path.join(this.rootDir, 'resources', 'media-assets');
    this._cacheDir = path.join(this.userDataPath, 'media-assets');
  }

  _assetPath(relPath) {
    const bundled = path.join(this._bundledDir, relPath);
    if (fs.existsSync(bundled)) return bundled;
    const cached = path.join(this._cacheDir, relPath);
    if (fs.existsSync(cached)) return cached;
    return null;
  }

  _destPath(relPath) {
    return path.join(this._cacheDir, relPath);
  }

  getProfileStatus(profileId) {
    const profile = MEDIA_ASSET_PROFILES[profileId];
    if (!profile) return { profileId, ready: false, assets: [] };
    const assets = profile.assets.map((asset) => {
      const resolved = this._assetPath(asset.relPath);
      return {
        id: asset.id,
        relPath: asset.relPath,
        ready: !!resolved,
        path: resolved,
        bytes: asset.bytes,
      };
    });
    return {
      profileId,
      label: profile.label,
      ready: assets.every((a) => a.ready),
      assets,
    };
  }

  resolveAux(arch, modelType) {
    const profileId = archToMediaProfile(arch, modelType);
    if (!profileId) return null;
    const profile = MEDIA_ASSET_PROFILES[profileId];
    const byId = Object.fromEntries(
      profile.assets.map((a) => [a.id, this._assetPath(a.relPath)]).filter(([, p]) => p),
    );
    const aux = {};
    for (const [key, assetId] of Object.entries(profile.auxKeys || {})) {
      if (byId[assetId]) aux[key] = byId[assetId];
    }
    if (aux.llm) aux.clip = aux.llm;
    if (aux.tae) aux.tae = aux.tae;
    if (aux.vae) aux.vae = aux.vae;
    if (aux.t5) aux.t5 = aux.t5;
    return { profileId, ...aux };
  }

  async ensureForModel(arch, modelType, onProgress) {
    const profileId = archToMediaProfile(arch, modelType);
    if (!profileId) return this.resolveAux(arch, modelType);
    await this.ensureProfile(profileId, onProgress);
    return this.resolveAux(arch, modelType);
  }

  async ensureProfile(profileId, onProgress) {
    const progress = onProgress || this.onProgress;
    for (const asset of listAssetsForProfile(profileId)) {
      if (this._assetPath(asset.relPath)) continue;
      const dest = this._destPath(asset.relPath);
      if (fs.existsSync(dest)) continue;
      if (progress) progress({ phase: 'start', asset: asset.id, file: path.basename(asset.relPath) });
      await downloadFile(asset.url, dest, {
        expectedBytes: asset.bytes || undefined,
        onProgress: progress
          ? ({ received, total, file }) => progress({
            phase: 'download',
            asset: asset.id,
            file,
            received,
            total: total || asset.bytes || 0,
          })
          : undefined,
      });
      if (progress) progress({ phase: 'done', asset: asset.id, file: path.basename(asset.relPath) });
    }
    return this.getProfileStatus(profileId);
  }
}

module.exports = { MediaAssetsManager, downloadFile };

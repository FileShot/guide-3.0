'use strict';

const fs = require('fs');
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
    this._inflight = new Map();
    if (!fs.existsSync(this._bundledDir)) {
      console.warn(`[MediaAssets] Bundled dir missing: ${this._bundledDir}`);
    } else {
      console.log(`[MediaAssets] Bundled dir: ${this._bundledDir}`);
    }
  }

  _hasBundled(relPath) {
    const b = path.join(this._bundledDir, relPath);
    return fs.existsSync(b) || fs.existsSync(`${b}.parts.json`);
  }

  _reassembleFromParts(srcBase, destPath) {
    return new Promise((resolve, reject) => {
      const metaPath = `${srcBase}.parts.json`;
      if (!fs.existsSync(metaPath)) return reject(new Error(`missing parts meta for ${srcBase}`));
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      const out = fs.createWriteStream(destPath);
      let i = 0;
      const writeNext = () => {
        if (i >= meta.chunks) {
          out.end(() => resolve(destPath));
          return;
        }
        const chunkPath = `${srcBase}.part${String(i).padStart(3, '0')}`;
        if (!fs.existsSync(chunkPath)) {
          out.destroy();
          reject(new Error(`missing chunk ${chunkPath}`));
          return;
        }
        const inp = fs.createReadStream(chunkPath);
        inp.on('error', reject);
        inp.on('end', () => { i++; writeNext(); });
        inp.pipe(out, { end: false });
      };
      out.on('error', reject);
      writeNext();
    });
  }

  _assetPath(relPath) {
    const bundled = path.join(this._bundledDir, relPath);
    if (fs.existsSync(bundled)) return bundled;
    const cached = path.join(this._cacheDir, relPath);
    if (fs.existsSync(cached)) return cached;
    return null;
  }

  async materializeAsset(relPath, onProgress) {
    const existing = this._assetPath(relPath);
    if (existing) return existing;
    const bundled = path.join(this._bundledDir, relPath);
    const dest = path.join(this._cacheDir, relPath);
    if (fs.existsSync(`${bundled}.parts.json`)) {
      if (onProgress) onProgress({ phase: 'assemble', file: path.basename(relPath) });
      console.log(`[MediaAssets] Assembling ${relPath} from installer chunks…`);
      await this._reassembleFromParts(bundled, dest);
      console.log(`[MediaAssets] Ready ${relPath}`);
      if (onProgress) onProgress({ phase: 'done', file: path.basename(relPath) });
      return dest;
    }
    return null;
  }

  async materializeProfile(profileId, onProgress) {
    if (this._inflight.has(`mat:${profileId}`)) return this._inflight.get(`mat:${profileId}`);
    const job = (async () => {
      for (const asset of listAssetsForProfile(profileId)) {
        await this.materializeAsset(asset.relPath, onProgress);
      }
    })().finally(() => this._inflight.delete(`mat:${profileId}`));
    this._inflight.set(`mat:${profileId}`, job);
    return job;
  }

  getProfileStatus(profileId) {
    const profile = MEDIA_ASSET_PROFILES[profileId];
    if (!profile) return { profileId, ready: false, assets: [] };
    const assets = profile.assets.map((asset) => {
      const resolved = this._assetPath(asset.relPath);
      const bundled = this._hasBundled(asset.relPath);
      return {
        id: asset.id,
        relPath: asset.relPath,
        ready: !!resolved || bundled,
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
    return { profileId, ...aux };
  }

  async ensureForModel(arch, modelType, onProgress) {
    const profileId = archToMediaProfile(arch, modelType);
    if (!profileId) return this.resolveAux(arch, modelType);
    await this.ensureProfile(profileId, onProgress);
    return this.resolveAux(arch, modelType);
  }

  ensureForModelBackground(arch, modelType, onProgress) {
    const profileId = archToMediaProfile(arch, modelType);
    if (!profileId) return Promise.resolve(this.resolveAux(arch, modelType));
    if (this._inflight.has(profileId)) return this._inflight.get(profileId);
    const job = this.ensureForModel(arch, modelType, onProgress)
      .finally(() => this._inflight.delete(profileId));
    this._inflight.set(profileId, job);
    return job;
  }

  async ensureProfile(profileId, onProgress) {
    const progress = onProgress || this.onProgress;
    await this.materializeProfile(profileId, progress);
    for (const asset of listAssetsForProfile(profileId)) {
      if (this._assetPath(asset.relPath)) continue;
      const dest = path.join(this._cacheDir, asset.relPath);
      const sizeMb = asset.bytes ? Math.round(asset.bytes / 1e6) : '?';
      console.log(`[MediaAssets] Downloading ${asset.relPath} (~${sizeMb}MB)`);
      if (progress) progress({ phase: 'start', asset: asset.id, file: path.basename(asset.relPath), total: asset.bytes || 0 });
      let lastLogPct = -1;
      await downloadFile(asset.url, dest, {
        expectedBytes: asset.bytes || undefined,
        onProgress: ({ received, total, file }) => {
          const t = total || asset.bytes || 0;
          const pct = t > 0 ? Math.floor((received / t) * 100) : 0;
          if (pct >= lastLogPct + 10) {
            lastLogPct = pct;
            console.log(`[MediaAssets] ${file}: ${pct}%`);
          }
          if (progress) progress({ phase: 'download', asset: asset.id, file, received, total: t });
        },
      });
      if (progress) progress({ phase: 'done', asset: asset.id, file: path.basename(asset.relPath) });
    }
    return this.getProfileStatus(profileId);
  }
}

module.exports = { MediaAssetsManager, downloadFile };

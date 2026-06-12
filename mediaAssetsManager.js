'use strict';

const fs = require('fs');
const path = require('path');
const {
  MEDIA_ASSET_PROFILES,
  archToMediaProfile,
  listAssetsForProfile,
} = require('./mediaAssetsCatalog');

function downloadHeaders(url, hfToken) {
  const headers = { 'User-Agent': 'guIDE-media-assets' };
  const token = hfToken || process.env.HF_TOKEN;
  if (token && /huggingface\.co/i.test(url)) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function http401Hint(url) {
  if (/huggingface\.co/i.test(url)) {
    return ' Add your Hugging Face token in Settings → Media (or set HF_TOKEN).';
  }
  return '';
}

async function downloadFileWithRetry(url, dest, { onProgress, expectedBytes, retries = 3, hfToken } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await downloadFile(url, dest, { onProgress, expectedBytes, hfToken });
    } catch (err) {
      lastErr = err;
      if (attempt < retries - 1) {
        const isRateLimit = /HTTP 429/i.test(String(err.message));
        const delayMs = isRateLimit ? 30000 * (attempt + 1) : 2000 * (attempt + 1);
        console.warn(`[MediaAssets] Download retry ${attempt + 2}/${retries} for ${path.basename(dest)}: ${err.message}`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

async function downloadFileWithMirrorRetry(urls, dest, opts = {}) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  let lastErr;
  for (let i = 0; i < list.length; i++) {
    const url = list[i];
    try {
      return await downloadFileWithRetry(url, dest, opts);
    } catch (err) {
      lastErr = err;
      const is401 = /HTTP 401/i.test(String(err.message));
      if (is401 && i === list.length - 1) {
        throw new Error(`${err.message}.${http401Hint(url)}`);
      }
      if (i < list.length - 1) {
        console.warn(`[MediaAssets] Mirror fallback for ${path.basename(dest)}: ${err.message}`);
      }
    }
  }
  throw lastErr;
}

async function downloadFile(url, dest, { onProgress, expectedBytes, hfToken } = {}) {
  const { Readable } = require('stream');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;

  if (fs.existsSync(dest)) {
    const got = fs.statSync(dest).size;
    if (!expectedBytes || got >= expectedBytes * 0.95) return dest;
  }

  let startAt = 0;
  if (fs.existsSync(tmp)) {
    startAt = fs.statSync(tmp).size;
    if (expectedBytes && startAt >= expectedBytes * 0.95) {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      fs.renameSync(tmp, dest);
      return dest;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60 * 60 * 1000);
  let received = startAt;
  let lastPct = -1;
  try {
    const headers = downloadHeaders(url, hfToken);
    if (startAt > 0) headers.Range = `bytes=${startAt}-`;

    const res = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });

    if (startAt > 0 && res.status === 416) {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      startAt = 0;
      return downloadFile(url, dest, { onProgress, expectedBytes, hfToken });
    }
    if (!res.ok && res.status !== 206) {
      throw new Error(`Download failed HTTP ${res.status}: ${url}`);
    }
    if (startAt > 0 && res.status === 200) {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      startAt = 0;
      received = 0;
    }

    const contentLen = Number(res.headers.get('content-length') || 0);
    const total = expectedBytes || (startAt > 0 ? startAt + contentLen : contentLen);
    const file = fs.createWriteStream(tmp, { flags: received > 0 ? 'a' : 'w' });
    await new Promise((resolve, reject) => {
      file.on('error', reject);
      file.on('open', resolve);
    });

    for await (const chunk of Readable.fromWeb(res.body)) {
      received += chunk.length;
      if (!file.write(chunk)) {
        await new Promise((resolve) => file.once('drain', resolve));
      }
      if (onProgress && total > 0) {
        const pct = Math.floor((received / total) * 100);
        if (pct >= lastPct + 10) {
          lastPct = pct;
          onProgress({ received, total, file: path.basename(dest) });
        }
      }
    }
    await new Promise((resolve, reject) => {
      file.end(() => resolve());
      file.on('error', reject);
    });
    if (expectedBytes && received < expectedBytes * 0.95) {
      throw new Error(
        `Download incomplete ${path.basename(dest)}: ${received} < ${expectedBytes}`,
      );
    }
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    fs.renameSync(tmp, dest);
    return dest;
  } catch (err) {
    throw err;
  } finally {
    clearTimeout(timeout);
  }
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
    return this.ensureForModelBackground(arch, modelType, onProgress);
  }

  ensureForModelBackground(arch, modelType, onProgress) {
    const profileId = archToMediaProfile(arch, modelType);
    if (!profileId) return Promise.resolve(this.resolveAux(arch, modelType));
    if (this._inflight.has(profileId)) return this._inflight.get(profileId);
    const job = this.ensureProfile(profileId, onProgress)
      .then(() => this.resolveAux(arch, modelType))
      .finally(() => this._inflight.delete(profileId));
    this._inflight.set(profileId, job);
    return job;
  }

  async _downloadAsset(asset, progress) {
    const key = `asset:${asset.relPath}`;
    if (this._inflight.has(key)) return this._inflight.get(key);
    const dest = path.join(this._cacheDir, asset.relPath);
    const sizeMb = asset.bytes ? Math.round(asset.bytes / 1e6) : '?';
    const job = (async () => {
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
        },
      });
      if (progress) progress({ phase: 'done', asset: asset.id, file: path.basename(asset.relPath) });
      return dest;
    })().finally(() => this._inflight.delete(key));
    this._inflight.set(key, job);
    return job;
  }

  async ensureProfile(profileId, onProgress) {
    const progress = onProgress || this.onProgress;
    await this.materializeProfile(profileId, progress);
    for (const asset of listAssetsForProfile(profileId)) {
      if (this._assetPath(asset.relPath)) continue;
      await this._downloadAsset(asset, progress);
    }
    return this.getProfileStatus(profileId);
  }
}

module.exports = {
  MediaAssetsManager,
  downloadFile,
  downloadFileWithRetry,
  downloadFileWithMirrorRetry,
  downloadHeaders,
  http401Hint,
};

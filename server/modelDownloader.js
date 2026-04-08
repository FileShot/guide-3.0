/**
 * guIDE — Model Downloader
 *
 * Search HuggingFace for GGUF models and download them with progress tracking.
 * Downloads stream to the models/ directory with real-time progress via callback.
 */
'use strict';

const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const log = require(path.join(__dirname, '..', 'logger'));

const HF_API = 'huggingface.co';
const HF_SEARCH_PATH = '/api/models';

class ModelDownloader extends EventEmitter {
  constructor(modelsDir) {
    super();
    this.modelsDir = modelsDir;
    this.activeDownloads = new Map(); // id → { controller, destPath, startedAt }
  }

  /* ── Search HuggingFace ────────────────────────────────────────── */

  async searchModels(query, limit = 20) {
    const params = new URLSearchParams({
      search: query,
      filter: 'gguf',
      sort: 'downloads',
      direction: '-1',
      limit: String(limit),
    });

    const data = await this._hfGet(`${HF_SEARCH_PATH}?${params}`);
    return data.map(m => ({
      id: m.modelId || m.id,
      author: m.modelId?.split('/')[0] || m.author || '',
      name: m.modelId?.split('/')[1] || m.id || '',
      downloads: m.downloads || 0,
      likes: m.likes || 0,
      lastModified: m.lastModified || null,
      tags: (m.tags || []).filter(t =>
        t.startsWith('quantized') || t.includes('gguf') || t.includes('llama') ||
        t.includes('qwen') || t.includes('mistral') || t.includes('gemma') ||
        t.includes('phi') || t.includes('deepseek')
      ).slice(0, 5),
      pipeline_tag: m.pipeline_tag || null,
    }));
  }

  /* ── List GGUF files in a repo ─────────────────────────────────── */

  async getRepoFiles(repoId) {
    const data = await this._hfGet(`${HF_SEARCH_PATH}/${encodeURIComponent(repoId)}`);
    const siblings = data.siblings || [];
    const ggufFiles = siblings
      .filter(f => f.rfilename && f.rfilename.endsWith('.gguf'))
      .map(f => ({
        name: f.rfilename,
        size: f.size || null,
        sizeFormatted: f.size ? _formatSize(f.size) : 'unknown',
        downloadUrl: `https://huggingface.co/${repoId}/resolve/main/${encodeURIComponent(f.rfilename)}`,
        quantization: _extractQuant(f.rfilename),
      }));

    ggufFiles.sort((a, b) => {
      const qa = _quantPriority(a.quantization);
      const qb = _quantPriority(b.quantization);
      return qa - qb;
    });

    return {
      repoId,
      modelName: data.modelId || repoId,
      files: ggufFiles,
    };
  }

  /* ── Download a model file ─────────────────────────────────────── */

  async downloadModel(downloadUrl, fileName) {
    const id = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const destPath = path.join(this.modelsDir, fileName);
    const tempPath = destPath + '.downloading';

    // Ensure models dir exists
    try { fs.mkdirSync(this.modelsDir, { recursive: true }); } catch {}

    // Check for existing file
    if (fs.existsSync(destPath)) {
      throw new Error(`File already exists: ${fileName}`);
    }

    const controller = { aborted: false };
    this.activeDownloads.set(id, { controller, destPath, tempPath, fileName, startedAt: Date.now() });

    this.emit('download-started', { id, fileName });

    // Start download in background
    this._doDownload(id, downloadUrl, tempPath, destPath, controller).catch(err => {
      if (!controller.aborted) {
        log.error('Download', `Failed: ${fileName}: ${err.message}`);
        this.emit('download-error', { id, fileName, error: err.message });
      }
      this.activeDownloads.delete(id);
      // Clean up temp file
      try { fs.unlinkSync(tempPath); } catch {}
    });

    return { id, fileName, destPath };
  }

  async _doDownload(id, url, tempPath, destPath, controller) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let totalBytes = 0;
      let downloadedBytes = 0;
      let lastEmit = 0;

      const makeRequest = (requestUrl, redirectCount = 0) => {
        if (redirectCount > 5) return reject(new Error('Too many redirects'));
        if (controller.aborted) return reject(new Error('Cancelled'));

        const parsed = new URL(requestUrl);
        const client = parsed.protocol === 'https:' ? https : http;

        const req = client.get(requestUrl, {
          headers: { 'User-Agent': 'guIDE/2.0' },
        }, (res) => {
          // Handle redirects
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return makeRequest(res.headers.location, redirectCount + 1);
          }

          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode}`));
          }

          totalBytes = parseInt(res.headers['content-length'], 10) || 0;
          const fileStream = fs.createWriteStream(tempPath);
          controller.request = req;

          res.on('data', (chunk) => {
            if (controller.aborted) {
              res.destroy();
              fileStream.close();
              return;
            }

            downloadedBytes += chunk.length;
            fileStream.write(chunk);

            // Emit progress at most every 500ms
            const now = Date.now();
            if (now - lastEmit > 500) {
              lastEmit = now;
              const elapsed = (now - startTime) / 1000;
              const speed = downloadedBytes / elapsed;
              const eta = totalBytes > 0 ? Math.round((totalBytes - downloadedBytes) / speed) : null;

              this.emit('download-progress', {
                id,
                fileName: path.basename(destPath),
                downloadedBytes,
                totalBytes,
                percent: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
                speed: _formatSize(speed) + '/s',
                eta: eta !== null ? _formatEta(eta) : null,
              });
            }
          });

          res.on('end', () => {
            fileStream.close(() => {
              if (controller.aborted) return;

              // Rename temp file to final
              try {
                fs.renameSync(tempPath, destPath);
              } catch (err) {
                return reject(new Error(`Failed to finalize: ${err.message}`));
              }

              this.activeDownloads.delete(id);
              this.emit('download-complete', {
                id,
                fileName: path.basename(destPath),
                destPath,
                size: downloadedBytes,
                sizeFormatted: _formatSize(downloadedBytes),
                duration: Math.round((Date.now() - startTime) / 1000),
              });
              resolve();
            });
          });

          res.on('error', (err) => {
            fileStream.close();
            reject(err);
          });
        });

        req.on('error', (err) => {
          if (!controller.aborted) reject(err);
        });
      };

      makeRequest(url);
    });
  }

  /* ── Cancel download ───────────────────────────────────────────── */

  cancelDownload(id) {
    const dl = this.activeDownloads.get(id);
    if (!dl) return false;

    dl.controller.aborted = true;
    if (dl.controller.request) {
      try { dl.controller.request.destroy(); } catch {}
    }

    // Clean up temp file
    try { fs.unlinkSync(dl.tempPath); } catch {}

    this.activeDownloads.delete(id);
    this.emit('download-cancelled', { id, fileName: dl.fileName });
    return true;
  }

  /* ── Status ────────────────────────────────────────────────────── */

  getActiveDownloads() {
    const result = [];
    for (const [id, dl] of this.activeDownloads) {
      result.push({ id, fileName: dl.fileName, startedAt: dl.startedAt });
    }
    return result;
  }

  /* ── HuggingFace API helper ────────────────────────────────────── */

  _hfGet(apiPath) {
    return new Promise((resolve, reject) => {
      const req = https.get({
        hostname: HF_API,
        path: apiPath,
        headers: { 'User-Agent': 'guIDE/2.0' },
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HuggingFace API returned ${res.statusCode}`));
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error('Invalid JSON from HuggingFace API')); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('HuggingFace API timeout')); });
    });
  }
}

/* ── Helpers ──────────────────────────────────────────────────────── */

function _formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes, i = 0;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return size.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function _formatEta(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function _extractQuant(filename) {
  const match = filename.match(/(Q[0-9]+_[A-Z_]+|[Ff]16|[Ff]32|[Bb][Ff]16|IQ[0-9]+_[A-Z]+)/i);
  return match ? match[1].toUpperCase() : 'unknown';
}

function _quantPriority(q) {
  const order = ['Q2_K', 'Q3_K_S', 'Q3_K_M', 'Q3_K_L', 'Q4_0', 'Q4_K_S', 'Q4_K_M',
    'Q5_0', 'Q5_K_S', 'Q5_K_M', 'Q6_K', 'Q8_0', 'F16', 'F32'];
  const idx = order.indexOf(q);
  return idx >= 0 ? idx : 99;
}

module.exports = { ModelDownloader };

'use strict';

const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

/**
 * VisionServer — manages a llama-server child process with --mmproj for
 * multimodal image captioning.
 *
 * Production flow:
 *   1. When a model loads, check if mmproj*.gguf exists in the SAME directory as the model
 *   2. If mmproj found, locate or auto-download llama-server binary, then start it
 *   3. When browser_screenshot or image attachments need vision, send to llama-server
 *   4. Text caption is returned and injected into the model context
 *   5. Model weights are shared via mmap (zero extra RAM for text model)
 *
 * Binary discovery (no hardcoded user paths):
 *   - App resources directory (bundled with installer)
 *   - App user data directory (auto-downloaded on first use)
 *   - System PATH
 *
 * Auto-download: if llama-server not found, downloads from llama.cpp GitHub releases
 * and caches in the app's user data directory.
 */

class VisionServer {
  constructor() {
    this._process = null;
    this._port = 0;
    this._modelPath = null;
    this._mmprojPath = null;
    this._starting = false;
    this._ready = false;
    this._requestId = 0;
    this._binaryPath = null;
    this._lastCaptionArgs = null; // { modelPath, options } for restart on demand
  }

  /**
   * Check if vision is available for the given model.
   * Returns { available: boolean, reason: string, mmprojPath: string|null }
   */
  checkAvailability(modelPath, options = {}) {
    console.log(`[VisionServer] Checking vision availability for: ${modelPath}`);
    if (!modelPath) {
      return { available: false, reason: 'No model path', mmprojPath: null };
    }

    const embeddingLength = options.embeddingLength ?? null;
    const mmprojPath = this._findMmproj(modelPath, embeddingLength);
    if (!mmprojPath) {
      console.log('[VisionServer] No mmproj file found in model directory — vision unavailable for this model');
      return { available: false, reason: 'No mmproj file found in model directory', mmprojPath: null };
    }

    console.log(`[VisionServer] Found mmproj: ${mmprojPath}`);
    // If model changed, clear previous start args so _ensureRunning uses the new model
    if (this._modelPath && this._modelPath !== modelPath) {
      console.log(`[VisionServer] Model changed (${path.basename(this._modelPath)} → ${path.basename(modelPath)}), clearing _lastCaptionArgs`);
      this._lastCaptionArgs = null;
    }
    this._mmprojPath = mmprojPath;
    this._modelPath = modelPath; // store for _ensureRunning first start
    return { available: true, reason: 'mmproj found', mmprojPath };
  }

  /**
   * Start the llama-server child process with the given model and mmproj.
   * Returns the port number on success, 0 on failure.
   */
  async start(modelPath, options = {}) {
    if (this._ready && this._modelPath === modelPath) {
      console.log(`[VisionServer] Already running on port ${this._port}`);
      return this._port;
    }
    if (this._starting) {
      console.log('[VisionServer] Already starting, waiting...');
      // Wait for existing start to complete
      while (this._starting) await new Promise(r => setTimeout(r, 200));
      return this._port;
    }

    this._starting = true;
    const mmprojPath = options.mmprojPath || this._mmprojPath || this._findMmproj(modelPath);

    if (!mmprojPath) {
      console.error('[VisionServer] No mmproj file found — cannot start vision server');
      this._starting = false;
      return 0;
    }

    // Find or auto-download llama-server binary
    let binaryPath = options.binaryPath || this._binaryPath || await this._findBinary();
    if (!binaryPath) {
      console.log('[VisionServer] llama-server binary not found — attempting auto-download');
      try {
        binaryPath = await this._downloadBinary();
      } catch (err) {
        console.error(`[VisionServer] Auto-download failed: ${err.message}`);
        this._starting = false;
        return 0;
      }
    }
    if (!binaryPath) {
      console.error('[VisionServer] llama-server binary unavailable — cannot start vision server');
      this._starting = false;
      return 0;
    }
    this._binaryPath = binaryPath;

    // Kill any existing process
    await this.stop();

    // Find a free port
    this._port = await this._findFreePort();
    const gpuType = options.gpuType || this._detectGpuFlag();

    // Compute GPU layers for vision server based on available VRAM.
    // The main model is already loaded and consuming most VRAM.
    // Using -ngl 99 blindly overflows VRAM, causing both vision server crash
    // AND main model context size reduction due to VRAM contention.
    const visionCtxSize = options.contextSize || 2048; // vision only needs small context
    let visionGpuLayers = options.gpuLayers; // explicit override from caller
    if (visionGpuLayers == null) {
      // Auto-compute: try to fit in available VRAM
      try {
        // Use nvidia-smi to get free VRAM (works on Windows/Linux)
        // Non-blocking: execFileAsync prevents event loop freeze on slow nvidia-smi
        const { stdout } = await execFileAsync('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000 });
        const freeVramMiB = parseInt(stdout.trim().split('\n')[0]);
        // Rough estimate: each model layer uses modelSize/totalLayers MiB
        // For a 4B Q4 model: ~2.7GB / 32 layers ≈ 84MB per layer
        // Leave 512MB for KV cache + activations
        const availableForLayers = freeVramMiB - 512;
        if (availableForLayers < 200) {
          // Less than 200MB free — run vision on CPU only
          visionGpuLayers = 0;
          console.log(`[VisionServer] Low VRAM (${freeVramMiB}MiB free) — running vision on CPU`);
        } else {
          // Assume ~100MB per layer as conservative estimate for vision model
          visionGpuLayers = Math.max(0, Math.min(Math.floor(availableForLayers / 100), 99));
          console.log(`[VisionServer] VRAM free: ${freeVramMiB}MiB — using ${visionGpuLayers} GPU layers for vision`);
        }
      } catch (e) {
        // nvidia-smi not available — use 0 GPU layers (CPU) as safe default
        visionGpuLayers = 0;
        console.log('[VisionServer] Cannot query VRAM — running vision on CPU (safe default)');
      }
    }

    const args = [
      '-m', modelPath,
      '--mmproj', mmprojPath,
      '--port', String(this._port),
      '--host', '127.0.0.1',
      '-c', String(visionCtxSize),
      '-ngl', String(visionGpuLayers),
      '--no-warmup',  // skip warmup to start faster
    ];

    // When running on CPU only, explicitly force --device none to prevent CUDA allocation.
    // Even with -ngl 0 and no GPU flag, llama-server auto-detects CUDA and allocates
    // ~1GB CUDA compute buffer for CLIP, stealing VRAM from the main model and
    // degrading inference speed from 15-20 tok/s to 2 tok/s.
    // --device none is the documented way to disable GPU offloading entirely.
    // ('cpu' is NOT a valid device name — causes "invalid device: cpu" error on startup)
    if (visionGpuLayers === 0) {
      args.push('--device', 'none');
      console.log('[VisionServer] Forced --device none — prevents CLIP CUDA buffer allocation to preserve VRAM');
    }

    if (gpuType && visionGpuLayers > 0) {
      args.unshift(gpuType);
    }

    console.log(`[VisionServer] Starting llama-server: ${binaryPath} ${args.join(' ')}`);

    try {
      this._process = spawn(binaryPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      this._process.stdout.on('data', (data) => {
        const line = data.toString().trim();
        if (line) console.log(`[VisionServer:stdout] ${line.substring(0, 300)}`);
      });

      this._process.stderr.on('data', (data) => {
        const line = data.toString().trim();
        if (line) console.log(`[VisionServer:stderr] ${line.substring(0, 300)}`);
      });

      this._process.on('exit', (code) => {
        console.log(`[VisionServer] Process exited with code ${code}`);
        this._ready = false;
        this._process = null;
      });

      this._process.on('error', (err) => {
        console.error(`[VisionServer] Process error: ${err.message}`);
        this._ready = false;
        this._process = null;
      });

      // Wait for server to be ready (health check)
      const ready = await this._waitForReady(30000);
      if (ready) {
        this._modelPath = modelPath;
        this._ready = true;
        console.log(`[VisionServer] ✅ Ready on port ${this._port}`);
      } else {
        console.error('[VisionServer] ❌ Failed to start — health check timed out');
        await this.stop();
      }
    } catch (err) {
      console.error(`[VisionServer] Failed to spawn: ${err.message}`);
    }

    this._starting = false;
    if (this._ready) {
      this._lastCaptionArgs = { modelPath, options };
    }
    return this._ready ? this._port : 0;
  }

  /**
   * Stop the llama-server child process.
   */
  async stop() {
    if (this._process) {
      console.log('[VisionServer] Stopping llama-server...');
      try {
        this._process.kill('SIGTERM');
        // Give it 3 seconds to shut down gracefully
        await new Promise(r => setTimeout(r, 3000));
        if (this._process) {
          this._process.kill('SIGKILL');
        }
      } catch (e) { /* already dead */ }
      this._process = null;
      this._ready = false;
      this._port = 0;
      // NOTE: do NOT clear _modelPath or _mmprojPath here — they are persistent
      // properties from checkAvailability() needed by _ensureRunning() for restart.
    }
  }

  /**
   * Ensure the vision server is running before captioning.
   * If it was stopped (e.g. session clear), restart it automatically.
   */
  async _ensureRunning() {
    if (this._ready) return true;
    // Restart from previous start args (server was stopped after caption)
    if (this._lastCaptionArgs) {
      console.log('[VisionServer] Restarting vision server on demand...');
      const port = await this.start(this._lastCaptionArgs.modelPath, this._lastCaptionArgs.options);
      return port > 0;
    }
    // First start: use modelPath + mmprojPath stored during checkAvailability()
    if (this._modelPath && this._mmprojPath) {
      console.log(`[VisionServer] First start on demand — model: ${this._modelPath}, mmproj: ${this._mmprojPath}`);
      const port = await this.start(this._modelPath, { mmprojPath: this._mmprojPath });
      return port > 0;
    }
    console.log('[VisionServer] Cannot start — no model path or mmproj known');
    return false;
  }

  /**
   * Caption an image using the vision server.
   * @param {Buffer|string} imageData - PNG/JPEG image data (Buffer) or base64 string
   * @param {string} mimeType - image MIME type (e.g. 'image/png')
   * @param {string} prompt - instruction for the vision model
   * @returns {string|null} text description, or null if vision unavailable
   */
  async captionImage(imageData, mimeType = 'image/png', prompt = 'Describe this screenshot in detail. List all visible text, buttons, links, and interactive elements.') {
    // Load on demand: start vision server only when an image needs captioning
    if (!this._ready) {
      const started = await this._ensureRunning();
      if (!started) {
        console.log('[VisionServer] Cannot start — cannot caption image');
        return null;
      }
    }

    const base64 = Buffer.isBuffer(imageData)
      ? imageData.toString('base64')
      : imageData;

    const requestId = ++this._requestId;
    const startTime = Date.now();

    console.log(`[VisionServer] ═══ CAPTION REQUEST #${requestId} ═══ image=${mimeType}, base64Len=${base64.length}, prompt="${prompt.substring(0, 100)}"`);

    const body = JSON.stringify({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${base64}`,
              },
            },
          ],
        },
      ],
      max_tokens: 256,
      temperature: 0.1,
    });

    try {
      const result = await this._httpPost(`/v1/chat/completions`, body, 180000);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (result?.choices?.[0]?.message?.content) {
        const caption = result.choices[0].message.content;
        console.log(`[VisionServer] ═══ CAPTION RESULT #${requestId} ═══ ${elapsed}s, ${caption.length} chars: "${caption.substring(0, 200)}"`);
        return caption;
      }

      // Qwen 3.5 reasoning models put the actual caption in reasoning_content, not content.
      // The content field is empty ("") while reasoning_content has the full description.
      // This is because llama-server uses the chat template with thinking=1 for Qwen models.
      if (result?.choices?.[0]?.message?.reasoning_content) {
        const caption = result.choices[0].message.reasoning_content;
        console.log(`[VisionServer] ═══ CAPTION RESULT #${requestId} (from reasoning_content) ═══ ${elapsed}s, ${caption.length} chars: "${caption.substring(0, 200)}"`);
        return caption;
      }

      console.log(`[VisionServer] Caption request #${requestId} returned unexpected format: ${JSON.stringify(result).substring(0, 300)}`);
      return null;
    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.error(`[VisionServer] Caption request #${requestId} FAILED after ${elapsed}s: ${err.message}`);
      return null;
    } finally {
      // Unload immediately after captioning — free VRAM for the main model.
      // Next image will trigger _ensureRunning() to reload on demand.
      // Model weights are shared via mmap so reload is fast (~2s vs ~12s cold start).
      if (this._ready) {
        console.log('[VisionServer] Caption complete — unloading to free VRAM for main model');
        this.stop().catch(() => {});
      }
    }
  }

  /**
   * Check if the vision server is ready.
   */
  get isReady() { return this._ready; }

  /**
   * Get the port the vision server is running on.
   */
  get port() { return this._port; }

  // ─── Private methods ──────────────────────────────────────────────

  /**
   * Find mmproj GGUF file in the same directory as the model.
   * mmproj files are named like: mmproj-*.gguf, *mmproj*.gguf, or *vision*.gguf
   * They are ALWAYS in the same directory as the model GGUF file.
   */
  /**
   * Read the n_embd (embedding_length) value from a GGUF file's metadata.
   * GGUF format: magic (4 bytes) + version (4 bytes) + tensor_count (8) + metadata_kv_count (8) + KV pairs.
   * Each KV: key_length (u64) + key (string) + value_type (u32) + value.
   * We scan for key "llama.embedding_length" or "qwen35.embedding_length" and read its value.
   */
  _readGgufEmbdLength(ggufPath) {
    try {
      const fd = fs.openSync(ggufPath, 'r');
      const header = Buffer.alloc(64);
      fs.readSync(fd, header, 0, 64, 0);
      // GGUF magic: 0x46475547 ('GGUF')
      if (header.readUInt32LE(0) !== 0x46475547) { fs.closeSync(fd); return null; }
      const version = header.readUInt32LE(4);
      if (version < 2 || version > 6) { fs.closeSync(fd); return null; }
      const tensorCount = Number(header.readBigUInt64LE(8));
      const metadataCount = Number(header.readBigUInt64LE(16));
      // Scan metadata KV pairs starting at offset 24
      let offset = 24;
      for (let i = 0; i < metadataCount && offset < 262144; i++) {
        const kvHeader = Buffer.alloc(12);
        const bytesRead = fs.readSync(fd, kvHeader, 0, 12, offset);
        if (bytesRead < 12) break;
        const keyLen = Number(kvHeader.readBigUInt64LE(0));
        const valueType = kvHeader.readUInt32LE(8);
        if (keyLen > 512 || keyLen === 0) break; // sanity check
        const keyBuf = Buffer.alloc(keyLen);
        fs.readSync(fd, keyBuf, 0, keyLen, offset + 12);
        const key = keyBuf.toString('utf8');
        // Value types: 0=GGUF_TYPE_STRING, 1=UINT8, 2=INT8, 3=UINT16, 4=INT16,
        //   5=UINT32, 6=INT32, 7=FLOAT32, 8=BOOL, 9=STRING, 10=ARRAY, 11=UINT64, 12=INT64, 13=FLOAT64
        let valueSize = 0;
        let embdValue = null;
        switch (valueType) {
          case 0: { // string
            const strLenBuf = Buffer.alloc(8);
            fs.readSync(fd, strLenBuf, 0, 8, offset + 12 + keyLen);
            const strLen = Number(strLenBuf.readBigUInt64LE(0));
            valueSize = 8 + strLen;
            break;
          }
          case 5: { // uint32
            const valBuf = Buffer.alloc(4);
            fs.readSync(fd, valBuf, 0, 4, offset + 12 + keyLen);
            embdValue = valBuf.readUInt32LE(0);
            valueSize = 4;
            break;
          }
          case 6: { // int32
            const valBuf = Buffer.alloc(4);
            fs.readSync(fd, valBuf, 0, 4, offset + 12 + keyLen);
            embdValue = valBuf.readInt32LE(0);
            valueSize = 4;
            break;
          }
          case 11: { // uint64
            const valBuf = Buffer.alloc(8);
            fs.readSync(fd, valBuf, 0, 8, offset + 12 + keyLen);
            embdValue = Number(valBuf.readBigUInt64LE(0));
            valueSize = 8;
            break;
          }
          case 12: { // int64
            const valBuf = Buffer.alloc(8);
            fs.readSync(fd, valBuf, 0, 8, offset + 12 + keyLen);
            embdValue = Number(valBuf.readBigInt64LE(0));
            valueSize = 8;
            break;
          }
          case 8: { // bool
            valueSize = 1;
            break;
          }
          case 7: { // float32
            valueSize = 4;
            break;
          }
          case 13: { // float64
            valueSize = 8;
            break;
          }
          case 10: { // array — must parse to skip past it
            const arrHeader = Buffer.alloc(12);
            const arrRead = fs.readSync(fd, arrHeader, 0, 12, offset + 12 + keyLen);
            if (arrRead < 12) { fs.closeSync(fd); return null; }
            const elemType = arrHeader.readUInt32LE(0);
            const arrLen = Number(arrHeader.readBigUInt64LE(4));
            if (elemType === 0 || elemType === 9) {
              // String array — compute size by reading all element length-prefixes.
              // tokenizer.ggml.tokens has ~150K entries (~2MB); read in one large buffer
              // to avoid 150K separate fs.readSync calls.
              const ESTIMATE = Math.min(arrLen * 24 + 4096, 16 * 1024 * 1024); // generous per-elem estimate
              const strBuf = Buffer.allocUnsafe(ESTIMATE);
              const strDataStart = offset + 12 + keyLen + 12; // past KV header + key + array header
              const bytesAvail = fs.readSync(fd, strBuf, 0, ESTIMATE, strDataStart);
              let pos = 0;
              let strOk = true;
              for (let s = 0; s < arrLen; s++) {
                if (pos + 8 > bytesAvail) { strOk = false; break; }
                const sLen = Number(strBuf.readBigUInt64LE(pos));
                if (sLen > 1e6) { strOk = false; break; } // sanity: no single token > 1MB
                pos += 8 + Number(sLen);
              }
              if (!strOk) { fs.closeSync(fd); return null; }
              valueSize = 12 + pos; // array header (12) + total string element bytes
              break;
            }
            let elemSize = 0;
            switch (elemType) {
              case 1: elemSize = 1; break;  // uint8
              case 2: elemSize = 1; break;  // int8
              case 3: elemSize = 2; break;  // uint16
              case 4: elemSize = 2; break;  // int16
              case 5: elemSize = 4; break;  // uint32
              case 6: elemSize = 4; break;  // int32
              case 7: elemSize = 4; break;  // float32
              case 8: elemSize = 1; break;  // bool
              case 11: elemSize = 8; break; // uint64
              case 12: elemSize = 8; break; // int64
              case 13: elemSize = 8; break; // float64
              default: elemSize = -1; break; // unknown element type
            }
            if (elemSize < 0) {
              offset = 262144; // force loop exit — can't determine array element size
              continue;
            }
            valueSize = 12 + (elemSize * arrLen);
            break;
          }
          default:
            // Unknown type — can't determine size, stop scanning
            // But DON'T return null — just break, we may have already found what we need
            offset = 262144; // force loop exit (matches loop limit)
            continue;
        }
        // Check if this key is the embedding length
        if (key.endsWith('.embedding_length') && embdValue !== null) {
          fs.closeSync(fd);
          return embdValue;
        }
        offset += 12 + keyLen + valueSize;
      }
      fs.closeSync(fd);
      return null;
    } catch (e) {
      return null;
    }
  }

  _findMmproj(modelPath, knownEmbeddingLength = null) {
    if (!modelPath) return null;
    try {
      const modelDir = path.dirname(modelPath);

      // Read the model's embedding dimension for mmproj compatibility validation
      const modelEmbdLen = knownEmbeddingLength || this._readGgufEmbdLength(modelPath);
      console.log(`[VisionServer] Model embedding_length: ${modelEmbdLen || 'unknown'} (from ${path.basename(modelPath)})`);

      // Without a known embedding dimension we cannot validate mmproj compatibility —
      // do not attach a random sibling mmproj (Bug 9).
      if (!modelEmbdLen) {
        console.log('[VisionServer] embedding_length unknown — vision unavailable until dimension is known');
        return null;
      }

      // Priority order: exact mmproj name patterns
      const patterns = [
        /^mmproj-/i,          // mmproj-modelname.gguf (Qwen convention)
        /^mmproj\./i,         // mmproj.gguf
        /-mmproj-/i,          // model-mmproj-Q4.gguf
        /mmproj/i,            // anything containing mmproj
        /vision/i,            // vision projector (some models use this naming)
      ];

      // Search directories in priority order: model dir, parent dir, sibling dirs
      const searchDirs = [modelDir];
      const parentDir = path.dirname(modelDir);
      try {
        const parentEntries = fs.readdirSync(parentDir, { withFileTypes: true });
        for (const entry of parentEntries) {
          if (entry.isDirectory() && path.join(parentDir, entry.name) !== modelDir) {
            searchDirs.push(path.join(parentDir, entry.name));
          }
        }
      } catch {}

      for (const dir of searchDirs) {
        try {
          const entries = fs.readdirSync(dir);
          for (const pattern of patterns) {
            const match = entries.find(e =>
              e.toLowerCase().endsWith('.gguf') && pattern.test(e)
            );
            if (match) {
              const fullPath = path.join(dir, match);
              const mmprojEmbdLen = this._readGgufEmbdLength(fullPath);
              if (mmprojEmbdLen && mmprojEmbdLen !== modelEmbdLen) {
                console.warn(`[VisionServer] mmproj ${path.basename(fullPath)} has n_embd=${mmprojEmbdLen} but model has n_embd=${modelEmbdLen} — SKIPPING (mismatch)`);
                continue;
              }
              if (!mmprojEmbdLen) {
                console.warn(`[VisionServer] mmproj ${path.basename(fullPath)} has unknown n_embd — SKIPPING`);
                continue;
              }
              console.log(`[VisionServer] Found compatible mmproj: ${fullPath}`);
              return fullPath;
            }
          }
        } catch {}
      }

      console.log(`[VisionServer] No compatible mmproj file found in ${modelDir} or sibling directories`);
      return null;
    } catch (err) {
      console.error(`[VisionServer] Error scanning for mmproj: ${err.message}`);
      return null;
    }
  }

  /**
   * Find a free TCP port on localhost.
   */
  async _findFreePort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
      server.on('error', reject);
    });
  }

  /**
   * Detect GPU availability for logging purposes.
   * Returns null — llama-server GPU offloading is handled by -ngl flag (already in args).
   * The binary itself is compiled for the specific GPU backend (CUDA/Vulkan/CPU).
   */
  _detectGpuFlag() {
    return null;
  }

  async _findBinary() {
    const candidates = [];

    // 1. App resources directory (bundled with installer)
    try {
      const resDir = process.resourcesPath || '';
      candidates.push(path.join(resDir, 'llama-server.exe'));
      if (process.platform !== 'win32') candidates.push(path.join(resDir, 'llama-server'));
    } catch (e) { /* no resourcesPath */ }

    // 2. App user data directory (auto-download cache)
    try {
      const { app } = require('electron');
      const dataDir = app.getPath('userData');
      candidates.push(path.join(dataDir, 'bin', process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'));
    } catch (e) {
      // Fallback: ~/.guide-ide/bin
      candidates.push(path.join(os.homedir(), '.guide-ide', 'bin', process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'));
    }

    // 3. Next to the running executable
    try {
      const exeDir = path.dirname(process.execPath);
      candidates.push(path.join(exeDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'));
    } catch (e) { /* no execPath */ }

    // 4. System PATH (non-blocking)
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      const arg = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
      const { stdout } = await execFileAsync(cmd, [arg], { encoding: 'utf8', timeout: 3000 });
      const firstLine = stdout.trim().split(/[\r\n]/)[0]?.trim();
      if (firstLine) candidates.push(firstLine);
    } catch (e) { /* not in PATH */ }

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          console.log(`[VisionServer] Found llama-server binary: ${candidate}`);
          return candidate;
        }
      } catch (e) { /* not accessible */ }
    }

    console.log('[VisionServer] llama-server binary not found in any search path');
    return null;
  }

  async _downloadBinary() {
    if (this._downloadPromise) return this._downloadPromise;
    this._downloadPromise = this._doDownloadBinary();
    try { return await this._downloadPromise; }
    finally { this._downloadPromise = null; }
  }

  async _doDownloadBinary() {
    let dataDir;
    try {
      const { app } = require('electron');
      dataDir = app.getPath('userData');
    } catch (e) {
      dataDir = path.join(os.homedir(), '.guide-ide');
    }

    const binDir = path.join(dataDir, 'bin');
    const binaryName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    const targetPath = path.join(binDir, binaryName);

    // Already downloaded?
    try {
      if (fs.existsSync(targetPath)) {
        console.log(`[VisionServer] Using cached binary: ${targetPath}`);
        return targetPath;
      }
    } catch (e) { /* not accessible */ }

    // Determine download URL based on platform
    const platform = process.platform;
    const arch = process.arch;

    let assetPattern;
    let cudartPattern = null; // companion CUDA DLLs (separate download)
    if (platform === 'win32' && arch === 'x64') {
      // MUST match llama-bNNNN-bin-win-cuda-12.4-x64.zip (has llama-server.exe)
      // MUST NOT match cudart-llama-bin-win-cuda-12.4-x64.zip (CUDA DLLs only, no binary)
      assetPattern = /^llama-b\d+-bin-win-cuda.*-x64\.zip$/;
      // Fallback: CPU-only build if no CUDA build available
      let cpuFallback = /^llama-b\d+-bin-win-cpu-x64\.zip$/;
      // Companion CUDA DLLs (needed by the CUDA build at runtime)
      cudartPattern = /^cudart-llama-bin-win-cuda-\d+\.\d+-x64\.zip$/;
    } else if (platform === 'darwin' && arch === 'arm64') {
      assetPattern = /llama-\d+-bin-mac-arm64\.zip$/;
    } else if (platform === 'darwin') {
      assetPattern = /llama-\d+-bin-mac-x64\.zip$/;
    } else if (platform === 'linux') {
      assetPattern = /llama-\d+-bin-linux-x64\.zip$/;
    } else {
      console.error(`[VisionServer] No prebuilt binary for ${platform}-${arch}`);
      return null;
    }

    console.log(`[VisionServer] Downloading llama-server for ${platform}-${arch}...`);

    try {
      const releaseInfo = await this._fetchJson('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest');
      // Find all matching assets, then pick the best one
      const matchingAssets = releaseInfo.assets?.filter(a => assetPattern.test(a.name)) || [];

      if (matchingAssets.length === 0) {
        console.error(`[VisionServer] No matching binary in latest release. Available: ${releaseInfo.assets?.map(a => a.name).slice(0, 10).join(', ')}`);
        return null;
      }

      // Prefer CUDA 12.x over 13.x for broader GPU compatibility on Windows
      matchingAssets.sort((a, b) => {
        const aCuda12 = a.name.includes('cuda-12');
        const bCuda12 = b.name.includes('cuda-12');
        if (aCuda12 && !bCuda12) return -1;
        if (!aCuda12 && bCuda12) return 1;
        return 0;
      });
      // If no CUDA build found, try CPU fallback
      let asset = matchingAssets[0];
      if (!asset && platform === 'win32') {
        const cpuAssets = releaseInfo.assets?.filter(a => cpuFallback.test(a.name)) || [];
        if (cpuAssets.length > 0) {
          asset = cpuAssets[0];
          console.log(`[VisionServer] No CUDA build found, falling back to CPU build: ${asset.name}`);
        }
      }
      if (!asset) {
        console.error(`[VisionServer] No matching binary in latest release. Available: ${releaseInfo.assets?.map(a => a.name).slice(0, 10).join(', ')}`);
        return null;
      }

      console.log(`[VisionServer] Downloading ${asset.name} (${(asset.size / 1e6).toFixed(1)}MB)...`);
      fs.mkdirSync(binDir, { recursive: true });

      const zipPath = path.join(binDir, asset.name);
      await this._downloadFile(asset.browser_download_url, zipPath);

      // On Windows CUDA: also download companion CUDA DLLs zip
      if (cudartPattern && asset.name.includes('cuda')) {
        const cudartAsset = releaseInfo.assets?.find(a => {
          if (!cudartPattern.test(a.name)) return false;
          // Match CUDA version (e.g. cuda-12.4)
          const cudaVer = asset.name.match(/cuda-(\d+\.\d+)/)?.[1];
          return cudaVer && a.name.includes(`cuda-${cudaVer}`);
        });
        if (cudartAsset) {
          console.log(`[VisionServer] Downloading companion CUDA DLLs: ${cudartAsset.name} (${(cudartAsset.size / 1e6).toFixed(1)}MB)...`);
          const cudartZipPath = path.join(binDir, cudartAsset.name);
          await this._downloadFile(cudartAsset.browser_download_url, cudartZipPath);
          // Extract CUDA DLLs into the same binDir
          if (platform === 'win32') {
            execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${cudartZipPath}' -DestinationPath '${binDir}' -Force"`, { timeout: 60000 });
          }
          try { fs.unlinkSync(cudartZipPath); } catch (e) { /* ignore */ }
        }
      }

      // Extract
      if (platform === 'win32') {
        execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${binDir}' -Force"`, { timeout: 60000 });
      } else {
        execSync(`unzip -o "${zipPath}" -d "${binDir}"`, { timeout: 60000 });
      }

      // Find the extracted binary
      const possiblePaths = [
        targetPath,
        path.join(binDir, binaryName),
        path.join(binDir, asset.name.replace(/\.zip$/, ''), binaryName),
        path.join(binDir, asset.name.replace(/\.zip$/, ''), 'build', 'bin', binaryName),
        path.join(binDir, 'build', 'bin', binaryName),
        path.join(binDir, 'bin', binaryName),
      ];

      // Also search recursively
      try {
        const findResult = execSync(
          platform === 'win32' ? `dir /s /b "${binDir}\\llama-server.exe" 2>nul` : `find "${binDir}" -name llama-server -type f 2>/dev/null`,
          { encoding: 'utf8', timeout: 10000 }
        ).trim();
        if (findResult) {
          const first = findResult.split(/[\r\n]/)[0].trim();
          if (first && !possiblePaths.includes(first)) possiblePaths.push(first);
        }
      } catch (e) { /* find failed */ }

      for (const p of possiblePaths) {
        try {
          if (fs.existsSync(p)) {
            if (p !== targetPath) fs.copyFileSync(p, targetPath);
            if (platform !== 'win32') { try { fs.chmodSync(targetPath, 0o755); } catch (e) { /* ignore */ } }
            console.log(`[VisionServer] ✅ llama-server ready: ${targetPath}`);
            try { fs.unlinkSync(zipPath); } catch (e) { /* ignore */ }
            return targetPath;
          }
        } catch (e) { /* not accessible */ }
      }

      console.error('[VisionServer] Binary not found in extracted zip');
      return null;
    } catch (err) {
      console.error(`[VisionServer] Download failed: ${err.message}`);
      return null;
    }
  }

  async _fetchJson(url) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: { 'User-Agent': 'guIDE-vision-server' },
        timeout: 15000,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return this._fetchJson(res.headers.location).then(resolve).catch(reject);
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`Invalid JSON from ${url}`)); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  async _downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      const req = https.get(url, {
        headers: { 'User-Agent': 'guIDE-vision-server' },
        timeout: 120000,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          return this._downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
        }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      });
      req.on('error', (err) => {
        file.close();
        try { fs.unlinkSync(destPath); } catch (e) { /* ignore */ }
        reject(err);
      });
      req.on('timeout', () => {
        req.destroy();
        file.close();
        try { fs.unlinkSync(destPath); } catch (e) { /* ignore */ }
        reject(new Error('download timeout'));
      });
    });
  }

  async _waitForReady(timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const result = await this._httpGet('/health');
        if (result?.status === 'ok' || result?.status === 'loading') {
          if (result.status === 'ok') return true;
        }
      } catch (e) { /* not ready yet */ }
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }

  _httpGet(path) {
    return new Promise((resolve, reject) => {
      const req = http.get({
        hostname: '127.0.0.1',
        port: this._port,
        path,
        timeout: 5000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { resolve({ raw: data }); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  _httpPost(urlPath, body, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const data = Buffer.from(body, 'utf8');
      const req = http.request({
        hostname: '127.0.0.1',
        port: this._port,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
        },
        timeout: timeoutMs,
      }, (res) => {
        let responseData = '';
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(responseData)); }
          catch (e) { reject(new Error(`Invalid JSON response: ${responseData.substring(0, 200)}`)); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
      req.write(data);
      req.end();
    });
  }
}

// Singleton
const visionServer = new VisionServer();

module.exports = { VisionServer, visionServer };

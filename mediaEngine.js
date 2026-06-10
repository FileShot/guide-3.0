'use strict';

const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { spawn } = require('child_process');
const { readGgufMetadata, detectModelTypeFromGguf } = require('./modelDetection');

/** VRAM tiers (MB) for automatic media memory policy. */
const VRAM_TIGHT_MB = 8192;
const VRAM_LOW_MB = 6144;

/** Windows STATUS_DLL_NOT_FOUND when sd.exe cannot load bundled CUDA DLLs. */
const WIN_DLL_NOT_FOUND = 3221225781;

/**
 * Query total GPU VRAM in MB (0 if unknown or no NVIDIA GPU).
 */
function queryGpuVramMB() {
  try {
    const { execSync } = require('child_process');
    const out = execSync(
      'nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits',
      { timeout: 5000 },
    ).toString().trim();
    return parseInt(out.split('\n')[0], 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * stable-diffusion.cpp uses component-level offload (VAE/T5/diffusion weights), not
 * per-transformer-block layers like llama.cpp. Map user settings + VRAM to sd.cpp flags.
 */
function resolveMediaMemoryFlags(settings = {}, vramMB = 0) {
  if (settings.gpuPreference === 'cpu' || settings.mediaOffloadPolicy === 'max') {
    return {
      offloadToCpu: true,
      vaeOnCpu: true,
      clipOnCpu: true,
      diffusionFa: true,
      vaeConvDirect: !!settings.mediaTaePath,
    };
  }
  if (settings.mediaOffloadPolicy === 'off') {
    return {
      offloadToCpu: false,
      vaeOnCpu: false,
      clipOnCpu: false,
      diffusionFa: true,
      vaeConvDirect: false,
    };
  }
  const vram = vramMB > 0 ? vramMB : queryGpuVramMB();
  const low = vram > 0 && vram <= VRAM_LOW_MB;
  const tight = vram > 0 && vram <= VRAM_TIGHT_MB;
  return {
    offloadToCpu: low || tight,
    vaeOnCpu: low,
    clipOnCpu: low,
    diffusionFa: true,
    vaeConvDirect: low && !!settings.mediaTaePath,
  };
}

/** Smaller defaults on low VRAM — video activations scale with frames × resolution. */
function getDefaultMediaDimensions(vramMB, isVideo) {
  const vram = vramMB > 0 ? vramMB : queryGpuVramMB();
  if (!isVideo) {
    if (vram > 0 && vram <= VRAM_LOW_MB) return { width: 384, height: 384, videoFrames: 1 };
    return { width: 512, height: 512, videoFrames: 1 };
  }
  if (vram > 0 && vram <= VRAM_LOW_MB) return { width: 384, height: 384, videoFrames: 17 };
  if (vram > 0 && vram <= VRAM_TIGHT_MB) return { width: 480, height: 480, videoFrames: 25 };
  return { width: 512, height: 512, videoFrames: 33 };
}

function _applyMemoryCliArgs(args, mem) {
  if (!mem) return;
  if (mem.diffusionFa) args.push('--diffusion-fa');
  if (mem.offloadToCpu) args.push('--offload-to-cpu');
  if (mem.vaeOnCpu) args.push('--vae-on-cpu');
  if (mem.clipOnCpu) args.push('--clip-on-cpu');
  if (mem.vaeConvDirect) args.push('--vae-conv-direct');
}

function formatSdExitError(code, stderr) {
  const tail = (stderr || '').trim();
  const excerpt = tail ? tail.slice(-2048) : '';
  if (code === WIN_DLL_NOT_FOUND || code === -1073741515) {
    return 'stable-diffusion.cpp could not start (missing GPU runtime DLLs). '
      + 'Reinstall guIDE or set Settings → Media → sd.cpp path to a local sd.exe with its DLLs.'
      + (excerpt ? `\n\n${excerpt}` : '');
  }
  if (excerpt) return excerpt;
  if (code != null) return `sd exited with code ${code}`;
  return 'sd generation failed';
}

function _isLaunchFailure(code) {
  return code === WIN_DLL_NOT_FOUND || code === -1073741515;
}

class MediaEngine {
  constructor(options = {}) {
    this.rootDir = options.rootDir || __dirname;
    this.userDataPath = options.userDataPath || require('os').tmpdir();
    this.getSettings = options.getSettings || (() => ({}));
    this.isPackaged = options.isPackaged || false;
    this.resourcesPath = options.resourcesPath || null;
    this.installVariant = options.installVariant || 'cpu';
    this.modelPath = null;
    this.ggufArchitecture = null;
    this.modelType = null;
    this._generating = false;
    this._outputDir = path.join(this.userDataPath, 'guide-media');
    this._sdBinaryPath = null;
  }

  getStatus() {
    const primary = this._resolveSdBinaryCandidates()[0] || null;
    return {
      loaded: !!this.modelPath,
      modelPath: this.modelPath,
      ggufArchitecture: this.ggufArchitecture,
      modelType: this.modelType,
      sdBinary: primary,
      sdBinaryFound: !!primary,
    };
  }

  async load(modelPath) {
    const meta = await readGgufMetadata(modelPath);
    const type = meta ? detectModelTypeFromGguf(meta) : 'unknown';
    if (type !== 'diffusion' && type !== 'video') {
      throw new Error(
        `Not a media GGUF (arch=${meta?.general?.architecture || 'unknown'}, type=${type}). `
        + 'Load a diffusion/video model with proper GGUF metadata.',
      );
    }
    this.modelPath = modelPath;
    this.ggufArchitecture = (meta?.general?.architecture || '').toLowerCase();
    this.modelType = type;
    return this.getStatus();
  }

  async unload() {
    this.modelPath = null;
    this.ggufArchitecture = null;
    this.modelType = null;
  }

  _collectSdBinaryPaths() {
    const candidates = [];
    const push = (p) => {
      if (!p) return;
      const abs = path.resolve(p);
      if (fs.existsSync(abs) && !candidates.includes(abs)) candidates.push(abs);
    };

    const settings = this.getSettings();
    if (settings.sdCppPath) push(settings.sdCppPath);
    if (process.env.GUIDE_SD_CPP_PATH) push(process.env.GUIDE_SD_CPP_PATH);

    const rootDir = path.resolve(this.rootDir);
    const binDir = path.join(rootDir, 'bin');
    for (const name of [process.platform === 'win32' ? 'sd.exe' : 'sd', 'sd-cli.exe']) {
      push(path.join(binDir, name));
    }

    if (this.isPackaged && this.resourcesPath) {
      const resRoot = path.resolve(this.resourcesPath);
      for (const sub of ['sd-cpp', 'sd-cpp-cpu']) {
        for (const name of ['sd.exe', 'sd-cli.exe', 'sd']) {
          push(path.join(resRoot, sub, name));
        }
      }
    }

    for (const sub of ['win-x64-cuda', 'win-x64-cpu']) {
      for (const name of ['sd.exe', 'sd-cli.exe', 'sd']) {
        push(path.join(rootDir, 'resources', 'sd-cpp', sub, name));
      }
    }

    return candidates;
  }

  _resolveSdBinaryCandidates() {
    if (this._sdBinaryPath && fs.existsSync(this._sdBinaryPath)) {
      const rest = this._collectSdBinaryPaths().filter((p) => p !== this._sdBinaryPath);
      return [this._sdBinaryPath, ...rest];
    }
    return this._collectSdBinaryPaths();
  }

  _resolveSdBinary() {
    return this._resolveSdBinaryCandidates()[0] || null;
  }

  _getAuxPaths() {
    const s = this.getSettings();
    const pick = (settingKey) => {
      const custom = s[settingKey];
      return custom && fs.existsSync(custom) ? custom : null;
    };
    const clip = pick('mediaClipPath');
    return {
      vae: pick('mediaVaePath'),
      tae: pick('mediaTaePath'),
      clip,
      t5: pick('mediaT5Path'),
      llm: clip,
    };
  }

  _pushOptionalAux(args, aux, mem) {
    if (aux.tae) {
      args.push('--tae', aux.tae);
      if (mem?.vaeConvDirect) args.push('--vae-conv-direct');
    } else if (aux.vae) {
      args.push('--vae', aux.vae);
    }
    if (aux.t5) args.push('--t5xxl', aux.t5);
    const enc = aux.llm || aux.clip;
    if (enc) args.push('--llm', enc);
  }

  _buildSdArgs(opts) {
    const aux = this._getAuxPaths();
    const isVideo = this.modelType === 'video';
    const mem = opts.memoryFlags || {};
    const args = [];

    if (isVideo) {
      args.push('-M', 'vid_gen');
    }

    args.push('-m', opts.model);
    this._pushOptionalAux(args, aux, mem);
    args.push('-p', opts.prompt);
    args.push('-o', opts.output);
    args.push('-W', String(opts.width));
    args.push('-H', String(opts.height));
    args.push('--steps', String(opts.steps));
    args.push('-s', String(opts.seed));

    if (isVideo) {
      args.push('--video-frames', String(opts.videoFrames || 33));
      args.push('--flow-shift', '3.0');
    }

    _applyMemoryCliArgs(args, mem);
    return { args, isVideo, missing: [] };
  }

  async generate(prompt, options = {}) {
    if (!this.modelPath) {
      return { success: false, error: 'No media model loaded. Load a diffusion/video GGUF first.' };
    }
    if (!prompt?.trim()) {
      return { success: false, error: 'No prompt provided' };
    }
    if (this._generating) {
      return { success: false, error: 'Generation already in progress' };
    }

    const sdCandidates = this._resolveSdBinaryCandidates();
    if (sdCandidates.length === 0) {
      return {
        success: false,
        error: 'stable-diffusion.cpp binary not found. Run: node scripts/fetch-sd-cpp.js',
        architecture: this.ggufArchitecture,
      };
    }

    const settings = this.getSettings();
    const vramMB = options.vramMB || 0;
    const isVideo = this.modelType === 'video';
    const defaults = getDefaultMediaDimensions(vramMB, isVideo);
    const memoryFlags = options.memoryFlags || resolveMediaMemoryFlags(settings, vramMB);
    const width = options.width || defaults.width;
    const height = options.height || defaults.height;
    const steps = options.steps || 20;
    const seed = options.seed != null ? options.seed : Math.floor(Math.random() * 2147483647);
    const videoFrames = options.videoFrames || defaults.videoFrames;

    await fsp.mkdir(this._outputDir, { recursive: true });
    const ext = isVideo ? 'mp4' : 'png';
    const outFile = path.join(this._outputDir, `guide-${Date.now()}.${ext}`);

    const built = this._buildSdArgs({
      model: this.modelPath,
      prompt: prompt.trim().substring(0, 2000),
      width,
      height,
      steps,
      seed,
      output: outFile,
      videoFrames,
      memoryFlags,
    });

    this._generating = true;
    try {
      const cmdLine = built.args.join(' ');
      console.log(`[MediaEngine] sd ${cmdLine}`);
      const runResult = await this._runSdWithFallback(sdCandidates, built.args);
      if (!runResult.ok) {
        return { success: false, error: runResult.error, architecture: this.ggufArchitecture };
      }
      const buf = await fsp.readFile(outFile);
      const mimeType = built.isVideo ? 'video/mp4' : 'image/png';
      const b64 = buf.toString('base64');
      return {
        success: true,
        imageBase64: b64,
        videoBase64: built.isVideo ? b64 : undefined,
        mimeType,
        path: outFile,
        provider: 'stable-diffusion.cpp',
        model: path.basename(this.modelPath),
        width,
        height,
        seed,
        mediaType: built.isVideo ? 'video' : 'image',
      };
    } catch (e) {
      return { success: false, error: e.message || String(e) };
    } finally {
      this._generating = false;
    }
  }

  async _runSdWithFallback(sdCandidates, args) {
    let lastError = 'sd generation failed';
    for (let i = 0; i < sdCandidates.length; i++) {
      const sdBin = sdCandidates[i];
      const result = await this._runSdOnce(sdBin, args);
      if (result.ok) {
        this._sdBinaryPath = sdBin;
        return result;
      }
      lastError = result.error;
      const canRetry = i < sdCandidates.length - 1 && _isLaunchFailure(result.code);
      if (canRetry) {
        console.warn(`[MediaEngine] sd launch failed (${result.code}) — trying fallback binary: ${sdCandidates[i + 1]}`);
        continue;
      }
      break;
    }
    return { ok: false, error: lastError };
  }

  _runSdOnce(sdBin, args) {
    return new Promise((resolve) => {
      const binDir = path.dirname(sdBin);
      const env = { ...process.env };
      env.PATH = `${binDir}${path.delimiter}${env.PATH || ''}`;

      const proc = spawn(sdBin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: binDir,
        env,
        windowsHide: true,
      });

      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (err) => {
        resolve({ ok: false, error: err.message, code: null, stderr });
      });
      proc.on('close', (code) => {
        const outIdx = args.indexOf('-o');
        const out = outIdx >= 0 ? args[outIdx + 1] : null;
        if (code === 0 && out && fs.existsSync(out)) {
          resolve({ ok: true });
          return;
        }
        if (stderr.trim()) console.error(`[MediaEngine] sd stderr: ${stderr.trim().slice(-2000)}`);
        resolve({
          ok: false,
          code,
          stderr,
          error: formatSdExitError(code, stderr),
        });
      });
    });
  }
}

module.exports = {
  MediaEngine,
  queryGpuVramMB,
  resolveMediaMemoryFlags,
  getDefaultMediaDimensions,
  formatSdExitError,
  WIN_DLL_NOT_FOUND,
  VRAM_LOW_MB,
  VRAM_TIGHT_MB,
};

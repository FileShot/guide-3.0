'use strict';

const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { spawn } = require('child_process');
const { readGgufMetadata, detectModelTypeFromGguf } = require('./modelDetection');

const FLUX_ARCHS = new Set(['flux', 'flux2', 'chroma', 'chroma-radiance']);
const LUMINA_ARCHS = new Set(['lumina', 'lumina2', 'lumina-mgpt', 'z-image', 'zimage']);
const SD_ARCHS = new Set(['sd', 'sd2', 'sd2.5', 'sd3', 'stable-diffusion', 'stable_diffusion', 'unet']);
const WAN_ARCHS = new Set(['wan', 'wan2']);

/** VRAM tiers (MB) for automatic media memory policy. */
const VRAM_TIGHT_MB = 8192;
const VRAM_LOW_MB = 6144;

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
    this.assetsManager = options.assetsManager || null;
    this.onAssetsProgress = options.onAssetsProgress || null;
  }

  getStatus() {
    return {
      loaded: !!this.modelPath,
      modelPath: this.modelPath,
      ggufArchitecture: this.ggufArchitecture,
      modelType: this.modelType,
      sdBinary: this._resolveSdBinary(),
      sdBinaryFound: !!this._resolveSdBinary(),
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

  _resolveSdBinary() {
    if (this._sdBinaryPath && fs.existsSync(this._sdBinaryPath)) return this._sdBinaryPath;
    const settings = this.getSettings();
    if (settings.sdCppPath && fs.existsSync(settings.sdCppPath)) {
      this._sdBinaryPath = settings.sdCppPath;
      return this._sdBinaryPath;
    }
    if (process.env.GUIDE_SD_CPP_PATH && fs.existsSync(process.env.GUIDE_SD_CPP_PATH)) {
      this._sdBinaryPath = process.env.GUIDE_SD_CPP_PATH;
      return this._sdBinaryPath;
    }
    const binDir = path.join(this.rootDir, 'bin');
    for (const name of [process.platform === 'win32' ? 'sd.exe' : 'sd', 'sd-cli.exe']) {
      const devBin = path.join(binDir, name);
      if (fs.existsSync(devBin)) {
        this._sdBinaryPath = devBin;
        return this._sdBinaryPath;
      }
    }
    if (this.isPackaged && this.resourcesPath) {
      for (const name of ['sd.exe', 'sd-cli.exe']) {
        const bundled = path.join(this.resourcesPath, 'sd-cpp', name);
        if (fs.existsSync(bundled)) {
          this._sdBinaryPath = bundled;
          return this._sdBinaryPath;
        }
      }
    }
    return null;
  }

  _resolveSdCwd() {
    const bin = this._resolveSdBinary();
    return bin ? path.dirname(bin) : this.rootDir;
  }

  _getAuxPaths() {
    const s = this.getSettings();
    const pick = (settingKey) => {
      const custom = s[settingKey];
      return custom && fs.existsSync(custom) ? custom : null;
    };
    const llm = pick('mediaClipPath');
    return {
      vae: pick('mediaVaePath'),
      tae: pick('mediaTaePath'),
      clip: llm,
      t5: pick('mediaT5Path'),
      llm,
    };
  }

  _pushVaeOrTae(args, aux, mem) {
    if (aux.tae && fs.existsSync(aux.tae)) {
      args.push('--tae', aux.tae);
      if (mem?.vaeConvDirect) args.push('--vae-conv-direct');
    } else if (aux.vae && fs.existsSync(aux.vae)) {
      args.push('--vae', aux.vae);
    }
  }

  _validateAux() {
    return [];
  }

  _buildSdArgs(opts) {
    const arch = (this.ggufArchitecture || '').toLowerCase();
    const aux = this._getAuxPaths();
    const isVideo = this.modelType === 'video' || WAN_ARCHS.has(arch) || arch.startsWith('wan');
    const mem = opts.memoryFlags || {};
    const args = [];

    if (isVideo) {
      args.push('-M', 'vid_gen');
      args.push('--diffusion-model', opts.model);
      this._pushVaeOrTae(args, aux, mem);
      if (aux.t5) args.push('--t5xxl', aux.t5);
      args.push('-p', opts.prompt);
      args.push('-o', opts.output);
      args.push('-W', String(opts.width));
      args.push('-H', String(opts.height));
      args.push('--steps', String(opts.steps));
      args.push('-s', String(opts.seed));
      args.push('--video-frames', String(opts.videoFrames || 33));
      args.push('--flow-shift', '3.0');
      _applyMemoryCliArgs(args, mem);
      return { args, isVideo: true, missing: this._validateAux(arch, aux, true) };
    }

    if (LUMINA_ARCHS.has(arch) || arch.startsWith('lumina') || arch.includes('z-image') || arch.includes('zimage')) {
      args.push('--diffusion-model', opts.model);
      this._pushVaeOrTae(args, aux, mem);
      const enc = aux.llm && fs.existsSync(aux.llm) ? aux.llm : aux.clip;
      if (enc && fs.existsSync(enc)) args.push('--llm', enc);
      args.push('-p', opts.prompt);
      args.push('-o', opts.output);
      args.push('-W', String(opts.width));
      args.push('-H', String(opts.height));
      args.push('--steps', String(opts.steps));
      args.push('-s', String(opts.seed));
      _applyMemoryCliArgs(args, mem);
      return { args, isVideo: false, missing: this._validateAux(arch, aux, false) };
    }

    if (FLUX_ARCHS.has(arch) || arch.includes('flux')) {
      args.push('--diffusion-model', opts.model);
      this._pushVaeOrTae(args, aux, mem);
      const enc = aux.clip && fs.existsSync(aux.clip) ? aux.clip : aux.llm;
      if (enc && fs.existsSync(enc)) args.push('--llm', enc);
      args.push('-p', opts.prompt);
      args.push('-o', opts.output);
      args.push('-W', String(opts.width));
      args.push('-H', String(opts.height));
      args.push('--steps', String(opts.steps));
      args.push('-s', String(opts.seed));
      _applyMemoryCliArgs(args, mem);
      return { args, isVideo: false, missing: this._validateAux(arch, aux, false) };
    }

    if (SD_ARCHS.has(arch) || arch.includes('sd')) {
      args.push('--diffusion-model', opts.model);
      this._pushVaeOrTae(args, aux, mem);
      args.push('-p', opts.prompt);
      args.push('-o', opts.output);
      args.push('-W', String(opts.width));
      args.push('-H', String(opts.height));
      args.push('--steps', String(opts.steps));
      args.push('-s', String(opts.seed));
      _applyMemoryCliArgs(args, mem);
      return { args, isVideo: false, missing: this._validateAux(arch, aux, false) };
    }

    args.push('-m', opts.model);
    args.push('-p', opts.prompt);
    args.push('-o', opts.output);
    args.push('-W', String(opts.width));
    args.push('-H', String(opts.height));
    args.push('--steps', String(opts.steps));
    args.push('-s', String(opts.seed));
    return { args, isVideo: false, missing: this._validateAux(arch, aux, false) };
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

    const sdBin = this._resolveSdBinary();
    if (!sdBin) {
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

    if (built.missing.length > 0) {
      return {
        success: false,
        error: `Missing auxiliary models: ${built.missing.join('; ')}. Configure in Settings → Media.`,
        architecture: this.ggufArchitecture,
        missing: built.missing,
      };
    }

    this._generating = true;
    try {
      await this._runSd(sdBin, built.args);
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

  _runSd(sdBin, args) {
    return new Promise((resolve, reject) => {
      const proc = spawn(sdBin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this._resolveSdCwd(),
      });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (err) => reject(err));
      proc.on('close', (code) => {
        const out = args[args.indexOf('-o') + 1];
        if (code === 0 && out && fs.existsSync(out)) resolve();
        else reject(new Error(stderr.trim() || `sd exited with code ${code}`));
      });
    });
  }
}

module.exports = {
  MediaEngine,
  FLUX_ARCHS,
  SD_ARCHS,
  WAN_ARCHS,
  queryGpuVramMB,
  resolveMediaMemoryFlags,
  getDefaultMediaDimensions,
  VRAM_LOW_MB,
  VRAM_TIGHT_MB,
};

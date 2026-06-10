'use strict';

const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { spawn } = require('child_process');
const { readGgufMetadata, detectModelTypeFromGguf } = require('./modelDetection');
const {
  LUMINA_ARCHS,
  WAN_ARCHS,
  archToMediaProfile,
  WAN_5D_INCOMPAT_MSG,
  isWanIncompatibleStderr,
  getRequiredAuxKeys,
} = require('./mediaAssetsCatalog');

/** VRAM tiers (MB) for automatic media memory policy. */
const VRAM_TIGHT_MB = 8192;
const VRAM_LOW_MB = 6144;

/** Windows STATUS_DLL_NOT_FOUND when sd.exe cannot load bundled CUDA DLLs. */
const WIN_DLL_NOT_FOUND = 3221225781;

const WAN_DEFAULT_NEGATIVE =
  '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，'
  + 'JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，'
  + '形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走';

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

function resolveMediaMemoryFlags(settings = {}, vramMB = 0) {
  if (settings.gpuPreference === 'cpu' || settings.mediaOffloadPolicy === 'max') {
    return {
      offloadToCpu: true,
      vaeOnCpu: true,
      clipOnCpu: true,
      diffusionFa: true,
      vaeConvDirect: !!settings.mediaTaePath,
      vaeTiling: true,
    };
  }
  if (settings.mediaOffloadPolicy === 'off') {
    return {
      offloadToCpu: false,
      vaeOnCpu: false,
      clipOnCpu: false,
      diffusionFa: true,
      vaeConvDirect: false,
      vaeTiling: false,
    };
  }
  const vram = vramMB > 0 ? vramMB : queryGpuVramMB();
  const low = vram > 0 && vram <= VRAM_LOW_MB;
  const tight = vram > 0 && vram <= VRAM_TIGHT_MB;
  const unknownVram = vram <= 0;
  return {
    offloadToCpu: low || tight || unknownVram,
    vaeOnCpu: low || unknownVram,
    clipOnCpu: low || unknownVram,
    diffusionFa: true,
    vaeConvDirect: (low || unknownVram) && !!settings.mediaTaePath,
    vaeTiling: low || unknownVram,
  };
}

function getDefaultMediaDimensions(vramMB, isVideo) {
  const vram = vramMB > 0 ? vramMB : queryGpuVramMB();
  const conservative = vram <= 0 || vram <= VRAM_LOW_MB;
  const tight = vram > 0 && vram <= VRAM_TIGHT_MB;
  if (!isVideo) {
    if (conservative) return { width: 384, height: 384, videoFrames: 1 };
    return { width: 512, height: 512, videoFrames: 1 };
  }
  if (conservative) return { width: 384, height: 384, videoFrames: 17 };
  if (tight) return { width: 480, height: 480, videoFrames: 25 };
  return { width: 512, height: 512, videoFrames: 33 };
}

function _applyMemoryCliArgs(args, mem) {
  if (!mem) return;
  if (mem.diffusionFa) args.push('--diffusion-fa');
  if (mem.offloadToCpu) args.push('--offload-to-cpu');
  if (mem.vaeOnCpu) args.push('--vae-on-cpu');
  if (mem.clipOnCpu) args.push('--clip-on-cpu');
  if (mem.vaeConvDirect) args.push('--vae-conv-direct');
  if (mem.vaeTiling) {
    args.push('--vae-tiling');
    args.push('--vae-tile-size', '64');
  }
}

function _isLuminaArch(arch) {
  const a = (arch || '').toLowerCase();
  return LUMINA_ARCHS.has(a) || a.startsWith('lumina') || a.includes('z-image') || a.includes('zimage');
}

function _isWanArch(arch) {
  const a = (arch || '').toLowerCase();
  return WAN_ARCHS.has(a) || a.startsWith('wan');
}

function formatSdExitError(code, stderr) {
  const raw = (stderr || '').trim();
  const lines = raw.split(/\r?\n/).filter((line) => {
    const t = line.trim();
    if (!t) return false;
    if (/^ggml_vulkan:/i.test(t)) return false;
    if (/^\[INFO\]/i.test(t)) return false;
    return true;
  });

  const errorLines = lines
    .filter((l) => /\[ERROR\]/i.test(l))
    .map((l) => l.replace(/^\[ERROR\]\s*/i, '').trim());

  if (isWanIncompatibleStderr(stderr) || errorLines.some((l) => isWanIncompatibleStderr(l))) {
    return WAN_5D_INCOMPAT_MSG;
  }
  if (errorLines.some((l) => /not in model file/i.test(l)) && errorLines.some((l) => /first_stage_model/i.test(l))) {
    return 'Wrong VAE file for this video model. guIDE will fetch wan2.2_vae or wan_2.1_vae on generate — retry, or set Settings → Media → VAE override.';
  }
  if (errorLines.some((l) => /not in model file/i.test(l))) {
    return 'This model file is missing required diffusion components (VAE or text encoder). '
      + 'Retry generate to fetch companions, or place files beside your GGUF / Settings → Media.';
  }
  if (errorLines.some((l) => /get sd version from file failed/i.test(l))) {
    return 'Could not load model file. Ensure you are using a stable-diffusion.cpp compatible image/video GGUF.';
  }

  const excerpt = (errorLines.length ? errorLines.slice(-5) : lines.slice(-6)).join('\n');

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
    this.auxResolver = options.auxResolver || null;
    this.onAuxProgress = options.onAuxProgress || null;
    this.modelPath = null;
    this.ggufArchitecture = null;
    this.modelType = null;
    this._generating = false;
    this._outputDir = path.join(this.userDataPath, 'guide-media');
    this._sdBinaryPath = null;
    this._resolvedAux = null;
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
    const arch = (meta?.general?.architecture || '').toLowerCase();
    const profileId = archToMediaProfile(arch, type, modelPath);
    if (!profileId) {
      throw new Error(
        `Unsupported media architecture "${arch || 'unknown'}" for generation. `
        + 'guIDE supports stable-diffusion.cpp image/video arches (flux, lumina/z-image, wan, sd3, pixart, …).',
      );
    }
    this.modelPath = modelPath;
    this.ggufArchitecture = arch;
    this.modelType = type;
    this._resolvedAux = null;

    if (_isWanArch(arch)) {
      await this._probeWanCompatibility(modelPath);
    }

    return this.getStatus();
  }

  async _probeWanCompatibility(modelPath) {
    const sdCandidates = this._resolveSdBinaryCandidates();
    if (!sdCandidates.length) return;

    let aux = {};
    if (this.auxResolver) {
      try {
        aux = await this.auxResolver.ensureForGenerate({
          arch: this.ggufArchitecture,
          modelType: this.modelType,
          modelPath,
          settings: this.getSettings(),
          vramMB: queryGpuVramMB(),
        });
      } catch (e) {
        console.warn(`[MediaEngine] Wan probe: aux not ready (${e.message})`);
      }
    }

    const probeDir = path.join(this.userDataPath, 'guide-media');
    await fsp.mkdir(probeDir, { recursive: true });
    const probeOut = path.join(probeDir, `.probe-${Date.now()}.png`);

    const args = [
      '-M', 'vid_gen',
      '--diffusion-model', modelPath,
      '-p', 'probe',
      '-o', probeOut,
      '-W', '64', '-H', '64',
      '--steps', '1',
      '-s', '1',
      '--video-frames', '1',
      '--offload-to-cpu',
    ];
    if (aux.vae) args.push('--vae', aux.vae);
    if (aux.tae) args.push('--tae', aux.tae);
    if (aux.t5) args.push('--t5xxl', aux.t5);

    const result = await this._runSdWithFallback(sdCandidates, args);
    try { await fsp.unlink(probeOut); } catch { /* ignore */ }

    if (!result.ok && isWanIncompatibleStderr(result.error || '')) {
      throw new Error(WAN_5D_INCOMPAT_MSG);
    }
  }

  async unload() {
    this.modelPath = null;
    this.ggufArchitecture = null;
    this.modelType = null;
    this._resolvedAux = null;
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
    const all = this._collectSdBinaryPaths();
    if (this._sdBinaryPath && fs.existsSync(this._sdBinaryPath)) {
      const rest = all.filter((p) => p !== this._sdBinaryPath);
      return [this._sdBinaryPath, ...rest];
    }
    if (this.installVariant === 'cuda') {
      const vulkan = [];
      const cuda = [];
      const other = [];
      const seen = new Set();
      for (const p of all) {
        const key = path.resolve(p);
        if (seen.has(key)) continue;
        seen.add(key);
        if (/sd-cpp-cpu|win-x64-cpu|vulkan/i.test(p)) vulkan.push(p);
        else if (/sd-cpp|win-x64-cuda|cuda/i.test(p)) cuda.push(p);
        else other.push(p);
      }
      if (cuda.length && vulkan.length) return [cuda[0], vulkan[0], ...cuda.slice(1), ...vulkan.slice(1), ...other];
      return [...cuda, ...vulkan, ...other];
    }
    return all;
  }

  _collectSdPathDirs() {
    const dirs = new Set();
    for (const bin of this._collectSdBinaryPaths()) {
      dirs.add(path.dirname(bin));
    }
    if (this.isPackaged && this.resourcesPath) {
      const resRoot = path.resolve(this.resourcesPath);
      for (const sub of ['sd-cpp', 'sd-cpp-cpu']) {
        const d = path.join(resRoot, sub);
        if (fs.existsSync(d)) dirs.add(d);
      }
    }
    return [...dirs];
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
    const aux = opts.aux || {};
    const arch = (this.ggufArchitecture || '').toLowerCase();
    const isVideo = this.modelType === 'video';
    const mem = opts.memoryFlags || {};
    const args = [];

    if (isVideo) {
      args.push('-M', 'vid_gen');
    }

    args.push('--diffusion-model', opts.model);
    this._pushOptionalAux(args, aux, mem);
    args.push('-p', opts.prompt);
    args.push('-o', opts.output);
    args.push('-W', String(opts.width));
    args.push('-H', String(opts.height));
    args.push('--steps', String(opts.steps));
    args.push('-s', String(opts.seed));

    if (_isLuminaArch(arch)) {
      args.push('--cfg-scale', '1.0');
    } else if (isVideo && _isWanArch(arch)) {
      args.push('--cfg-scale', '6.0');
      args.push('-n', WAN_DEFAULT_NEGATIVE);
    }

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

    let aux = this._resolvedAux || {};
    if (this.auxResolver) {
      try {
        aux = await this.auxResolver.ensureForGenerate({
          arch: this.ggufArchitecture,
          modelType: this.modelType,
          modelPath: this.modelPath,
          settings,
          vramMB,
          onProgress: this.onAuxProgress,
        });
        this._resolvedAux = aux;
      } catch (e) {
        return { success: false, error: e.message || String(e), architecture: this.ggufArchitecture };
      }
    }

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
      aux,
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

  _runSdOnce(sdBin, args, timeoutMs = 0) {
    return new Promise((resolve) => {
      const binDir = path.dirname(sdBin);
      const env = { ...process.env };
      const pathDirs = this._collectSdPathDirs();
      if (!pathDirs.includes(binDir)) pathDirs.unshift(binDir);
      env.PATH = [...pathDirs, env.PATH || ''].filter(Boolean).join(path.delimiter);

      const proc = spawn(sdBin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: binDir,
        env,
        windowsHide: true,
      });

      let stderr = '';
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          try { proc.kill(); } catch { /* ignore */ }
        }, timeoutMs);
      }

      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ ok: false, error: err.message, code: null, stderr });
      });
      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
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

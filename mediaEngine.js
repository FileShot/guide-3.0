'use strict';

const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { spawn } = require('child_process');
const { readGgufMetadata, detectModelTypeFromGguf } = require('./modelDetection');
const {
  archToMediaProfile,
  getProfileGen,
  TENSOR_5D_MSG,
  is5dTensorStderr,
} = require('./mediaAssetsCatalog');
const { needs5dFix, apply5dFix, is5dCompatArch } = require('./gguf5dCompat');
const { VRAM_TIGHT_MB, VRAM_LOW_MB, WIN_DLL_NOT_FOUND, WIN_STACK_OVERRUN } = require('./mediaConstants');
const streamTrace = require('./streamTrace');
const {
  resolveSdCppDir,
  COMPONENT_IDS,
} = require('./optionalComponentPaths');

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

function getDefaultMediaDimensions(vramMB, isVideo, settings = {}) {
  const vram = vramMB > 0 ? vramMB : queryGpuVramMB();
  const conservative = vram <= 0 || vram <= VRAM_LOW_MB;
  const tight = vram > 0 && vram <= VRAM_TIGHT_MB;
  const preset = settings.mediaVideoResolution || 'auto';

  let width = 512;
  let height = 512;
  let videoFrames = 33;

  if (preset === 'fast' || (preset === 'auto' && conservative)) {
    width = 384;
    height = 384;
    videoFrames = 17;
  } else if (preset === 'balanced' || (preset === 'auto' && tight)) {
    width = 480;
    height = 480;
    videoFrames = 25;
  } else if (preset === 'quality') {
    width = 512;
    height = 512;
    videoFrames = 49;
  }

  if (settings.mediaVideoFrames > 0) videoFrames = settings.mediaVideoFrames;

  if (!isVideo) {
    if (conservative && preset === 'auto') return { width: 384, height: 384, videoFrames: 1 };
    return { width, height, videoFrames: 1 };
  }
  return { width, height, videoFrames };
}

const WAN_VIDEO_FPS = 16;

function estimateVideoDurationSec(frames) {
  return Math.round((frames / WAN_VIDEO_FPS) * 10) / 10;
}

async function tryRemuxVideoToMp4(inputPath) {
  if (!inputPath || !fs.existsSync(inputPath)) return inputPath;
  const lower = inputPath.toLowerCase();
  if (lower.endsWith('.mp4') && !lower.endsWith('.mp4.avi')) return inputPath;
  const outPath = inputPath.replace(/\.(mp4\.avi|avi)$/i, '.mp4');
  if (outPath === inputPath) return inputPath;
  try {
    const { spawn } = require('child_process');
    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', ['-y', '-i', inputPath, '-c', 'copy', outPath], { windowsHide: true });
      proc.on('error', reject);
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
    });
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
      console.log(`[MediaEngine] remuxed video → ${outPath}`);
      return outPath;
    }
  } catch (e) {
    console.warn(`[MediaEngine] ffmpeg remux skipped: ${e.message}`);
  }
  return inputPath;
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

  if (is5dTensorStderr(stderr) || errorLines.some((l) => is5dTensorStderr(l))) {
    return TENSOR_5D_MSG;
  }
  if (errorLines.some((l) => /not in model file/i.test(l))) {
    return 'This model file is missing required diffusion components (VAE and/or text encoders). '
      + 'guIDE will auto-download companions for supported profiles on first generate. '
      + 'Otherwise place files beside your GGUF or set paths in Settings → Media.';
  }
  if (errorLines.some((l) => /get sd version from file failed/i.test(l))) {
    return 'Could not load model file. Ensure you are using a stable-diffusion.cpp compatible image/video GGUF.';
  }

  const excerpt = (errorLines.length ? errorLines.slice(-5) : lines.slice(-6)).join('\n');

  if (code === WIN_STACK_OVERRUN || code === -1073740791) {
    return 'stable-diffusion.cpp crashed (stack buffer overrun). '
      + 'Try a smaller resolution, fewer steps, or Settings → Media → Max save VRAM policy.'
      + (excerpt ? `\n\n${excerpt}` : '');
  }
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
  if (code == null) return false;
  if (code === WIN_STACK_OVERRUN || code === -1073740791) return false;
  return code === WIN_DLL_NOT_FOUND || code === -1073741515;
}

function mimeForOutputPath(filePath, isVideo) {
  if (!isVideo) return 'image/png';
  const lower = String(filePath || '').toLowerCase();
  if (lower.endsWith('.avi') || lower.endsWith('.mp4.avi')) return 'video/x-msvideo';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  return 'video/mp4';
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
    this.optionalComponentsManager = options.optionalComponentsManager || null;
    this.onAuxProgress = options.onAuxProgress || null;
    this.onGenProgress = options.onGenProgress || null;
    this.modelPath = null;
    this._mediaReadiness = null;
    this.ggufArchitecture = null;
    this.modelType = null;
    this._profileId = null;
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
      profileId: this._profileId,
      mediaReadiness: this._mediaReadiness,
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
        `Unsupported media architecture "${arch || 'unknown'}". `
        + 'Use a stable-diffusion.cpp compatible image/video GGUF.',
      );
    }
    this.modelPath = modelPath;
    this.ggufArchitecture = arch;
    this.modelType = type;
    this._profileId = profileId;
    this._resolvedAux = null;

    if (this.auxResolver) {
      const settings = this.getSettings();
      const vramMB = queryGpuVramMB();
      this._mediaReadiness = this.auxResolver.preflight({
        arch, modelType: type, modelPath, settings, vramMB,
      });
    } else {
      this._mediaReadiness = { profileId, ready: true, missing: [] };
    }

    return this.getStatus();
  }

  async unload() {
    this.modelPath = null;
    this.ggufArchitecture = null;
    this.modelType = null;
    this._profileId = null;
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

    if (this.userDataPath) {
      for (const variant of ['cuda', 'cpu']) {
        const dir = resolveSdCppDir(this.userDataPath, this.resourcesPath, variant);
        for (const name of ['sd.exe', 'sd-cli.exe', 'sd']) {
          push(path.join(dir, name));
        }
      }
    }

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
    if (this.installVariant === 'cuda') {
      if (cuda.length && vulkan.length) return [cuda[0], vulkan[0], ...cuda.slice(1), ...vulkan.slice(1), ...other];
      return [...cuda, ...vulkan, ...other];
    }
    if (vulkan.length) return [...vulkan, ...cuda, ...other];
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
    if (this.userDataPath) {
      for (const variant of ['cuda', 'cpu']) {
        const d = resolveSdCppDir(this.userDataPath, this.resourcesPath, variant);
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
    if (aux.clip_l) args.push('--clip_l', aux.clip_l);
    if (aux.clip_g) args.push('--clip_g', aux.clip_g);
    if (aux.t5) args.push('--t5xxl', aux.t5);
    if (aux.llm) args.push('--llm', aux.llm);
    else if (aux.clip && !aux.clip_l) args.push('--llm', aux.clip);
  }

  _buildSdArgs(opts) {
    const aux = opts.aux || {};
    const profileId = opts.profileId || this._profileId;
    const gen = getProfileGen(profileId);
    const isVideo = gen.video === true || this.modelType === 'video';
    const mem = opts.memoryFlags || {};
    const args = [];

    if (isVideo) args.push('-M', 'vid_gen');

    args.push('--diffusion-model', opts.model);
    this._pushOptionalAux(args, aux, mem);
    args.push('-p', opts.prompt);
    args.push('-o', opts.output);
    args.push('-W', String(opts.width));
    args.push('-H', String(opts.height));
    args.push('--steps', String(opts.steps));
    args.push('-s', String(opts.seed));

    if (gen.cfgScale != null) args.push('--cfg-scale', String(gen.cfgScale));
    if (gen.negativePrompt) args.push('-n', gen.negativePrompt);

    if (isVideo) {
      args.push('--video-frames', String(opts.videoFrames || 33));
      if (gen.flowShift != null) args.push('--flow-shift', String(gen.flowShift));
    }

    _applyMemoryCliArgs(args, mem);
    return { args, isVideo };
  }

  async generate(prompt, options = {}) {
    if (!this.modelPath) {
      return { success: false, error: 'No media model loaded. Load a diffusion/video GGUF first.' };
    }
    if (!prompt?.trim()) {
      return { success: false, error: 'No prompt provided' };
    }
    if (this._generating) {
      return { success: false, error: 'Generation already in progress — wait for the current job to finish.' };
    }

    if (this.optionalComponentsManager) {
      const primaryId = this.installVariant === 'cuda' ? COMPONENT_IDS.SD_CUDA : COMPONENT_IDS.SD_CPU;
      let ready = await this.optionalComponentsManager.ensureReady(primaryId);
      if (!ready && this.installVariant === 'cuda') {
        ready = await this.optionalComponentsManager.ensureReady(COMPONENT_IDS.SD_CPU);
      }
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
    const defaults = getDefaultMediaDimensions(vramMB, isVideo, settings);
    const memoryFlags = options.memoryFlags || resolveMediaMemoryFlags(settings, vramMB);
    const width = options.width || defaults.width;
    const height = options.height || defaults.height;
    const steps = options.steps || (settings.mediaVideoSteps > 0 ? settings.mediaVideoSteps : 20);
    const seed = options.seed != null ? options.seed : Math.floor(Math.random() * 2147483647);
    const videoFrames = options.videoFrames || defaults.videoFrames;
    const genStartedAt = Date.now();
    const emitGenProgress = (fields) => {
      if (this.onGenProgress) {
        this.onGenProgress({
          phase: 'generating',
          elapsedMs: Date.now() - genStartedAt,
          width,
          height,
          videoFrames: isVideo ? videoFrames : undefined,
          estDurationSec: isVideo ? estimateVideoDurationSec(videoFrames) : undefined,
          sdCpuFallback: !!this._lastSdCpuFallback,
          ...fields,
        });
      }
    };
    emitGenProgress({ label: isVideo ? `Generating video (${videoFrames} frames ≈ ${estimateVideoDurationSec(videoFrames)}s)` : 'Generating image…' });

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

    const buildRun = (modelPath) => this._buildSdArgs({
      model: modelPath,
      profileId: this._profileId,
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
      let modelForRun = this.modelPath;
      let builtForRun = buildRun(modelForRun);
      console.log(`[MediaEngine] sd ${builtForRun.args.join(' ')}`);
      let runResult = await this._runSdWithFallback(sdCandidates, builtForRun.args, emitGenProgress);
      let outputPath = runResult.outputPath || outFile;

      const sd5dFailure = !runResult.ok
        && (needs5dFix(runResult.stderr) || needs5dFix(runResult.error))
        && is5dCompatArch(this.ggufArchitecture);
      if (sd5dFailure) {
        try {
          const cacheDir = path.join(this.userDataPath, 'media-cache');
          const fixed = await apply5dFix({
            srcGguf: this.modelPath,
            arch: this.ggufArchitecture,
            modelPath: this.modelPath,
            cacheDir,
            onProgress: (msg) => {
              console.log(`[MediaEngine] 5D compat: ${msg}`);
              streamTrace.trace('stream', 'media-progress', { phase: '5d-fix', message: msg });
              if (this.onAuxProgress) this.onAuxProgress({ phase: '5d-fix', message: msg });
            },
          });
          modelForRun = fixed;
          builtForRun = buildRun(modelForRun);
          console.log(`[MediaEngine] retrying with 5D-patched GGUF: ${path.basename(fixed)}`);
          runResult = await this._runSdWithFallback(sdCandidates, builtForRun.args, emitGenProgress);
          if (runResult.outputPath) outputPath = runResult.outputPath;
        } catch (fixErr) {
          console.error(`[MediaEngine] 5D auto-patch failed: ${fixErr.message}`);
          return {
            success: false,
            error: `${TENSOR_5D_MSG}\n\n${fixErr.message}`,
            architecture: this.ggufArchitecture,
          };
        }
      }

      if (!runResult.ok) {
        return { success: false, error: runResult.error, architecture: this.ggufArchitecture };
      }
      if (builtForRun.isVideo) {
        outputPath = await tryRemuxVideoToMp4(outputPath);
      }
      const buf = await fsp.readFile(outputPath);
      const mimeType = mimeForOutputPath(outputPath, builtForRun.isVideo);
      console.log(`[MediaEngine] generate OK ${builtForRun.isVideo ? 'video' : 'image'} path=${outputPath} mime=${mimeType} bytes=${buf.length}`);
      const b64 = buf.toString('base64');
      return {
        success: true,
        imageBase64: b64,
        videoBase64: builtForRun.isVideo ? b64 : undefined,
        mimeType,
        path: outputPath,
        provider: 'stable-diffusion.cpp',
        model: path.basename(modelForRun),
        width,
        height,
        seed,
        videoFrames: builtForRun.isVideo ? videoFrames : undefined,
        sdCpuFallback: !!this._lastSdCpuFallback,
        mediaType: builtForRun.isVideo ? 'video' : 'image',
      };
    } catch (e) {
      return { success: false, error: e.message || String(e) };
    } finally {
      this._generating = false;
    }
  }

  async _runSdWithFallback(sdCandidates, args, onProgress) {
    let lastError = 'sd generation failed';
    let lastStderr = '';
    let lastCode = null;
    this._lastSdCpuFallback = false;
    for (let i = 0; i < sdCandidates.length; i++) {
      const sdBin = sdCandidates[i];
      const result = await this._runSdOnce(sdBin, args, onProgress);
      if (result.ok) {
        this._sdBinaryPath = sdBin;
        this._lastSdCpuFallback = /sd-cpp-cpu/i.test(sdBin);
        return result;
      }
      lastError = result.error;
      lastStderr = result.stderr || lastStderr;
      lastCode = result.code;
      const canRetry = i < sdCandidates.length - 1 && _isLaunchFailure(result.code);
      if (canRetry) {
        console.warn(`[MediaEngine] sd launch failed (${result.code}) — trying fallback binary: ${sdCandidates[i + 1]}`);
        this._lastSdCpuFallback = true;
        if (onProgress) onProgress({ label: 'CUDA unavailable — generating on CPU (slower, lower quality)' });
        continue;
      }
      break;
    }
    return { ok: false, error: lastError, stderr: lastStderr, code: lastCode, outputPath: null };
  }

  _resolveSdOutputPath(requestedOut) {
    if (!requestedOut) return null;
    if (fs.existsSync(requestedOut)) return requestedOut;
    const candidates = [
      `${requestedOut}.avi`,
      requestedOut.replace(/\.mp4$/i, '.mp4.avi'),
      requestedOut.replace(/\.(mp4|png)$/i, '.avi'),
    ];
    for (const p of candidates) {
      if (p && fs.existsSync(p)) return p;
    }
    return null;
  }

  _runSdOnce(sdBin, args, onProgress, timeoutMs = 0) {
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
      const startedAt = Date.now();
      let lastProgressAt = 0;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          try { proc.kill(); } catch { /* ignore */ }
        }, timeoutMs);
      }

      proc.stderr.on('data', (d) => {
        stderr += d.toString();
        if (!onProgress) return;
        const now = Date.now();
        if (now - lastProgressAt < 2000) return;
        lastProgressAt = now;
        const stepMatch = stderr.match(/step\s+(\d+)\s*\/\s*(\d+)/i);
        onProgress({
          elapsedMs: now - startedAt,
          step: stepMatch ? parseInt(stepMatch[1], 10) : undefined,
          totalSteps: stepMatch ? parseInt(stepMatch[2], 10) : undefined,
        });
      });
      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ ok: false, error: err.message, code: null, stderr });
      });
      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        const outIdx = args.indexOf('-o');
        const requestedOut = outIdx >= 0 ? args[outIdx + 1] : null;
        const actualOut = this._resolveSdOutputPath(requestedOut);
        if (actualOut) {
          try {
            const stat = fs.statSync(actualOut);
            if (stat.size > 0) {
              if (code !== 0 && code != null) {
                console.warn(`[MediaEngine] sd exited ${code} but output exists (${stat.size} bytes): ${actualOut}`);
              }
              resolve({ ok: true, outputPath: actualOut, code });
              return;
            }
          } catch (_) { /* fall through */ }
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
  estimateVideoDurationSec,
  formatSdExitError,
  WAN_VIDEO_FPS,
  WIN_DLL_NOT_FOUND,
  WIN_STACK_OVERRUN,
  VRAM_LOW_MB,
  VRAM_TIGHT_MB,
};

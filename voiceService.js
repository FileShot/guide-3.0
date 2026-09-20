'use strict';

/**
 * VoiceService — offline-only whisper.cpp STT (chunked streaming from renderer).
 * No cloud / Web Speech fallback.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const os = require('os');
const https = require('https');
const {
  resolveWhisperModelPath,
  resolveWhisperCliPath,
  hasWhisperRuntime,
  COMPONENT_IDS,
} = require('./optionalComponentPaths');

const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';

class VoiceService {
  constructor(userDataPath, settingsManager, optionalComponentsManager = null) {
    this.userDataPath = userDataPath;
    this.settingsManager = settingsManager;
    this.optionalComponentsManager = optionalComponentsManager;
    this.modelsDir = path.join(userDataPath, 'whisper-models');
    this._whisperBin = null;
    this._modelPath = null;
    this._queue = Promise.resolve();
    this._detectWhisper();
  }

  _resourcesPath() {
    try {
      return process.resourcesPath || null;
    } catch {
      return null;
    }
  }

  _detectWhisper() {
    const isWin = process.platform === 'win32';
    const binNames = isWin
      ? ['whisper-cli.exe', 'whisper.exe', 'main.exe']
      : ['whisper-cli', 'whisper', 'main'];

    const cachedCli = resolveWhisperCliPath(this.userDataPath, this._resourcesPath());
    if (cachedCli) {
      this._whisperBin = cachedCli;
    }

    if (!this._whisperBin) {
      for (const name of binNames) {
        try {
          execSync(isWin ? `where ${name}` : `which ${name}`, { stdio: 'pipe' });
          this._whisperBin = name;
          break;
        } catch (_) {}
      }
    }

    const local = path.join(this.modelsDir, 'bin', isWin ? 'whisper-cli.exe' : 'whisper-cli');
    if (!this._whisperBin && fs.existsSync(local)) this._whisperBin = local;

    this._modelPath = this._resolveModelPath();
  }

  _resolveModelPath() {
    const resolved = resolveWhisperModelPath(this.userDataPath, this._resourcesPath());
    if (fs.existsSync(resolved)) return resolved;
    return null;
  }

  async _ensureReady() {
    const runtimeOk = !!(this._whisperBin && hasWhisperRuntime(this._whisperBin));
    if (this.optionalComponentsManager && (!runtimeOk || !this._modelPath)) {
      await this.optionalComponentsManager.ensureReady(COMPONENT_IDS.WHISPER);
      this._detectWhisper();
    }
    if (!this._whisperBin || !hasWhisperRuntime(this._whisperBin)) {
      throw new Error('Local Whisper binary not found (or missing runtime DLLs). Retry Voice component install.');
    }
    if (this._modelPath && fs.existsSync(this._modelPath)) return this._modelPath;

    fs.mkdirSync(this.modelsDir, { recursive: true });
    const dest = path.join(this.modelsDir, 'ggml-base.en.bin');
    if (fs.existsSync(dest)) {
      this._modelPath = dest;
      return dest;
    }
    await this._downloadFile(MODEL_URL, dest);
    this._modelPath = dest;
    return dest;
  }

  _downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const file = fs.createWriteStream(dest);
      const req = (u) => {
        https.get(u, { headers: { 'User-Agent': 'guIDE-voice' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            file.close();
            fs.unlink(dest, () => {});
            return req(res.headers.location);
          }
          if (res.statusCode !== 200) {
            file.close();
            fs.unlink(dest, () => {});
            return reject(new Error(`Model download HTTP ${res.statusCode}`));
          }
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve(dest)));
        }).on('error', reject);
      };
      req(url);
    });
  }

  getStatus() {
    return {
      localWhisper: !!this._whisperBin,
      whisperPath: this._whisperBin,
      modelReady: !!(this._modelPath && fs.existsSync(this._modelPath)),
      voiceProvider: 'local',
      cloudAvailable: false,
      webSpeechFallback: false,
      streaming: true,
    };
  }

  async transcribe(audioBuffer, opts = {}) {
    // Serialize chunked streaming jobs so whisper-cli isn't flooded.
    const run = this._queue.then(() => this._transcribeLocal(audioBuffer, opts));
    this._queue = run.catch(() => {});
    return run;
  }

  async _transcribeLocal(audioBuffer, opts = {}) {
    const format = opts.format || 'wav';
    let model;
    try {
      model = await this._ensureReady();
    } catch (e) {
      return { success: false, error: e.message };
    }

    if (!this._whisperBin) {
      return { success: false, error: 'Local Whisper binary not found' };
    }

    const ext = format === 'webm' ? 'webm' : 'wav';
    const inFile = path.join(os.tmpdir(), `guide-voice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`);
    const outBase = path.join(os.tmpdir(), `guide-voice-out-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.writeFileSync(inFile, Buffer.from(audioBuffer));

    const binDir = path.dirname(path.resolve(this._whisperBin));
    try {
      const args = ['-m', model, '-f', inFile, '-otxt', '-of', outBase, '--no-timestamps', '-l', 'en', '-t', '2'];
      await new Promise((resolve, reject) => {
        const proc = spawn(this._whisperBin, args, {
          stdio: 'pipe',
          cwd: binDir,
          windowsHide: true,
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
          },
        });
        let stderr = '';
        proc.stderr?.on('data', (d) => { stderr += d.toString(); });
        proc.on('error', (err) => {
          reject(new Error(
            err.code === 'ENOENT'
              ? 'Whisper executable missing'
              : `Whisper failed to start: ${err.message}. Missing DLL beside whisper-cli?`,
          ));
        });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(stderr.trim() || `whisper exit ${code}`));
        });
      });
      const txtPath = `${outBase}.txt`;
      const text = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf8').trim() : '';
      try { fs.unlinkSync(txtPath); } catch (_) {}
      return { success: true, text, source: 'local' };
    } catch (e) {
      return { success: false, error: e.message };
    } finally {
      try { fs.unlinkSync(inFile); } catch (_) {}
    }
  }
}

module.exports = { VoiceService };

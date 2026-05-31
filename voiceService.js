'use strict';

/**
 * VoiceService — bundled whisper.cpp (offline-first) + OpenAI Whisper cloud fallback.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const os = require('os');
const https = require('https');

const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';

class VoiceService {
  constructor(userDataPath, settingsManager) {
    this.userDataPath = userDataPath;
    this.settingsManager = settingsManager;
    this.modelsDir = path.join(userDataPath, 'whisper-models');
    this._whisperBin = null;
    this._modelPath = null;
    this._detectWhisper();
  }

  _appRoots() {
    const roots = [];
    try {
      if (process.resourcesPath) {
        roots.push(path.join(process.resourcesPath, 'whisper'));
        roots.push(path.join(process.resourcesPath, 'app', 'resources', 'whisper'));
      }
    } catch (_) {}
    roots.push(path.join(__dirname, 'resources', 'whisper'));
    roots.push(path.join(__dirname, 'whisper'));
    return [...new Set(roots)];
  }

  _detectWhisper() {
    const isWin = process.platform === 'win32';
    const binNames = isWin
      ? ['whisper-cli.exe', 'whisper.exe', 'main.exe']
      : ['whisper-cli', 'whisper', 'main'];

    for (const root of this._appRoots()) {
      const platDir = path.join(root, process.platform === 'win32' ? 'win32' : process.platform);
      for (const name of binNames) {
        const p = path.join(platDir, name);
        if (fs.existsSync(p)) {
          this._whisperBin = p;
          break;
        }
      }
      if (this._whisperBin) break;
      for (const name of binNames) {
        const p = path.join(root, name);
        if (fs.existsSync(p)) {
          this._whisperBin = p;
          break;
        }
      }
      if (this._whisperBin) break;
    }

    if (!this._whisperBin) {
      for (const name of binNames) {
        try {
          execSync(isWin ? `where ${name}` : `which ${name}`, { stdio: 'pipe' });
          this._whisperBin = name;
          return;
        } catch (_) {}
      }
    }

    const local = path.join(this.modelsDir, 'bin', isWin ? 'whisper-cli.exe' : 'whisper-cli');
    if (fs.existsSync(local)) this._whisperBin = local;

    this._modelPath = this._resolveModelPath();
  }

  _resolveModelPath() {
    for (const root of this._appRoots()) {
      const bundled = path.join(root, 'ggml-base.en.bin');
      if (fs.existsSync(bundled)) return bundled;
    }
    const userModel = path.join(this.modelsDir, 'ggml-base.en.bin');
    if (fs.existsSync(userModel)) return userModel;
    return null;
  }

  async _ensureModel() {
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

  _voiceProvider() {
    return this.settingsManager?.get?.('voiceProvider') || 'auto';
  }

  async _isOnline() {
    return new Promise((resolve) => {
      const req = https.request(
        { hostname: 'api.openai.com', port: 443, path: '/', method: 'HEAD', timeout: 3000 },
        () => resolve(true),
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  }

  getStatus() {
    return {
      localWhisper: !!this._whisperBin,
      whisperPath: this._whisperBin,
      modelReady: !!(this._modelPath && fs.existsSync(this._modelPath)),
      voiceProvider: this._voiceProvider(),
      cloudAvailable: !!(this.settingsManager?.hasApiKey?.('openai')),
      webSpeechFallback: true,
    };
  }

  async transcribe(audioBuffer, opts = {}) {
    const provider = opts.provider || this._voiceProvider();
    const format = opts.format || 'wav';
    const tryCloud = provider === 'cloud' || provider === 'auto';
    const tryLocal = provider === 'local' || provider === 'auto';

    if (tryCloud && this.settingsManager?.hasApiKey?.('openai')) {
      const online = await this._isOnline();
      if (online) {
        try {
          const cloud = await this._transcribeCloud(audioBuffer, format);
          if (cloud.success) return cloud;
        } catch (e) {
          if (provider === 'cloud') {
            return { success: false, error: e.message, useWebSpeech: true };
          }
        }
      } else if (provider === 'cloud') {
        return { success: false, error: 'Offline — cloud STT unavailable', useWebSpeech: false };
      }
    }

    if (tryLocal) {
      const local = await this._transcribeLocal(audioBuffer, format);
      if (local.success) return local;
      if (provider === 'local') return local;
    }

    return { success: false, error: 'Transcription unavailable', useWebSpeech: true };
  }

  async _transcribeCloud(audioBuffer, format) {
    const key = this.settingsManager.getApiKey('openai');
    if (!key) return { success: false, error: 'No OpenAI API key configured' };

    const ext = format === 'webm' ? 'webm' : 'wav';
    const blob = new Blob([audioBuffer], { type: ext === 'webm' ? 'audio/webm' : 'audio/wav' });
    const form = new FormData();
    form.append('file', blob, `audio.${ext}`);
    form.append('model', 'whisper-1');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { success: false, error: `Cloud STT failed (${res.status}): ${errText.slice(0, 200)}` };
    }
    const data = await res.json();
    return { success: true, text: (data.text || '').trim(), source: 'cloud' };
  }

  async _transcribeLocal(audioBuffer, format) {
    if (!this._whisperBin) {
      return { success: false, error: 'Local Whisper binary not found', useWebSpeech: true };
    }

    let model;
    try {
      model = await this._ensureModel();
    } catch (e) {
      return { success: false, error: `Model download failed: ${e.message}`, useWebSpeech: true };
    }

    const ext = format === 'webm' ? 'webm' : 'wav';
    const inFile = path.join(os.tmpdir(), `guide-voice-${Date.now()}.${ext}`);
    const outBase = path.join(os.tmpdir(), `guide-voice-out-${Date.now()}`);
    fs.writeFileSync(inFile, audioBuffer);

    try {
      const args = ['-m', model, '-f', inFile, '-otxt', '-of', outBase, '--no-timestamps'];
      await new Promise((resolve, reject) => {
        const proc = spawn(this._whisperBin, args, { stdio: 'pipe' });
        let stderr = '';
        proc.stderr?.on('data', (d) => { stderr += d.toString(); });
        proc.on('error', reject);
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
      return { success: false, error: e.message, useWebSpeech: true };
    } finally {
      try { fs.unlinkSync(inFile); } catch (_) {}
    }
  }
}

module.exports = { VoiceService };

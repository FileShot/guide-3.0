'use strict';

/**
 * VoiceService — local Whisper when available; renderer uses Web Speech API as fallback.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const os = require('os');

class VoiceService {
  constructor(userDataPath) {
    this.modelsDir = path.join(userDataPath, 'whisper-models');
    this._whisperBin = null;
    this._detectWhisper();
  }

  _detectWhisper() {
    const names = process.platform === 'win32' ? ['whisper.exe', 'whisper-cli.exe', 'main.exe'] : ['whisper', 'whisper-cli', 'main'];
    for (const name of names) {
      try {
        execSync(process.platform === 'win32' ? `where ${name}` : `which ${name}`, { stdio: 'pipe' });
        this._whisperBin = name;
        return;
      } catch (_) {}
    }
    const local = path.join(this.modelsDir, 'bin', process.platform === 'win32' ? 'whisper.exe' : 'whisper');
    if (fs.existsSync(local)) this._whisperBin = local;
  }

  getStatus() {
    return {
      localWhisper: !!this._whisperBin,
      whisperPath: this._whisperBin,
      webSpeechFallback: true,
    };
  }

  /**
   * Transcribe WAV/WEBM buffer via whisper CLI if installed.
   * @param {Buffer} audioBuffer
   * @param {{ format?: string }} opts
   */
  async transcribe(audioBuffer, opts = {}) {
    if (!this._whisperBin) {
      return { success: false, error: 'Local Whisper not installed', useWebSpeech: true };
    }
    fs.mkdirSync(this.modelsDir, { recursive: true });
    const ext = opts.format === 'webm' ? 'webm' : 'wav';
    const inFile = path.join(os.tmpdir(), `guide-voice-${Date.now()}.${ext}`);
    const outBase = path.join(os.tmpdir(), `guide-voice-out-${Date.now()}`);
    fs.writeFileSync(inFile, audioBuffer);
    try {
      const model = path.join(this.modelsDir, 'ggml-base.en.bin');
      const args = ['-m', fs.existsSync(model) ? model : 'base.en', '-f', inFile, '-otxt', '-of', outBase];
      await new Promise((resolve, reject) => {
        const proc = spawn(this._whisperBin, args, { stdio: 'pipe' });
        proc.on('error', reject);
        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`whisper exit ${code}`))));
      });
      const txtPath = `${outBase}.txt`;
      const text = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf8').trim() : '';
      return { success: true, text };
    } catch (e) {
      return { success: false, error: e.message, useWebSpeech: true };
    } finally {
      try { fs.unlinkSync(inFile); } catch (_) {}
    }
  }
}

module.exports = { VoiceService };

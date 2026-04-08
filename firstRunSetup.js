/**
 * guIDE 2.0 — First Run Setup
 *
 * Detects whether this is the first launch. Gathers system info
 * (GPU, VRAM, RAM, OS, CPU) to guide the onboarding wizard.
 * Marks setup as complete in settingsManager so it only runs once.
 */
'use strict';

const os = require('os');
const { execSync } = require('child_process');

class FirstRunSetup {
  /**
   * @param {import('./settingsManager').SettingsManager} settingsManager
   */
  constructor(settingsManager) {
    this._settingsManager = settingsManager;
    this._systemInfo = null;
  }

  /** True if the user has never completed the onboarding wizard. */
  isFirstRun() {
    return !this._settingsManager.get('setupCompleted');
  }

  /** Mark onboarding as done. */
  markComplete() {
    this._settingsManager.set('setupCompleted', true);
  }

  /**
   * Detect GPU, VRAM, RAM, OS, and CPU info.
   * Cached after first call.
   * @returns {{ gpu: string, vramMB: number, ramGB: number, os: string, arch: string, cpuModel: string, cpuCores: number }}
   */
  getSystemInfo() {
    if (this._systemInfo) return this._systemInfo;

    const ramGB = Math.round(os.totalmem() / (1024 ** 3));
    const cpus = os.cpus();
    const cpuModel = cpus.length > 0 ? cpus[0].model.trim() : 'Unknown';
    const cpuCores = cpus.length;

    let gpu = 'None detected';
    let vramMB = 0;

    // Try NVIDIA first
    try {
      const out = execSync(
        'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits',
        { timeout: 5000, windowsHide: true }
      ).toString().trim();
      const parts = out.split('\n')[0].split(',').map(s => s.trim());
      if (parts.length >= 2) {
        gpu = parts[0];
        vramMB = parseInt(parts[1], 10) || 0;
      }
    } catch {
      // No NVIDIA GPU or driver not installed
    }

    this._systemInfo = {
      gpu,
      vramMB,
      ramGB,
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      cpuModel,
      cpuCores,
    };

    return this._systemInfo;
  }

  /**
   * Recommend initial settings based on system capabilities.
   * @returns {{ gpuLayers: number, contextSize: number, maxModelGB: number, recommendation: string }}
   */
  recommendSettings() {
    const info = this.getSystemInfo();
    const vramGB = info.vramMB / 1024;

    let gpuLayers = -1; // -1 = auto (let node-llama-cpp decide)
    let contextSize = 16384;
    let recommendation = '';

    if (info.vramMB === 0) {
      // CPU-only
      gpuLayers = 0;
      contextSize = 4096;
      recommendation = 'No GPU detected. Using CPU inference with a small context window. A 0.6B-1.7B model is recommended.';
    } else if (vramGB < 4) {
      contextSize = 4096;
      recommendation = `${info.gpu} with ${Math.round(vramGB)}GB VRAM. A 0.6B-1.7B Q8 model fits well.`;
    } else if (vramGB < 8) {
      contextSize = 8192;
      recommendation = `${info.gpu} with ${Math.round(vramGB)}GB VRAM. A 4B Q8 or 8B Q4 model is recommended.`;
    } else if (vramGB < 16) {
      contextSize = 16384;
      recommendation = `${info.gpu} with ${Math.round(vramGB)}GB VRAM. An 8B-14B model works well.`;
    } else if (vramGB < 32) {
      contextSize = 32768;
      recommendation = `${info.gpu} with ${Math.round(vramGB)}GB VRAM. A 14B-32B model is recommended.`;
    } else {
      contextSize = 65536;
      recommendation = `${info.gpu} with ${Math.round(vramGB)}GB VRAM. Large models (32B+) are available.`;
    }

    const maxModelGB = info.vramMB > 0 ? Math.floor((info.vramMB * 0.85) / 1024) : 4;

    return { gpuLayers, contextSize, maxModelGB, recommendation };
  }

  /**
   * Apply recommended settings to the settings manager.
   * Called when user clicks "Use recommended" in the wizard.
   */
  applyRecommended() {
    const rec = this.recommendSettings();
    this._settingsManager.set('gpuLayers', rec.gpuLayers);
    this._settingsManager.set('contextSize', rec.contextSize);
  }

  /**
   * Register API routes on the Express app.
   * @param {import('express').Application} app
   */
  registerRoutes(app) {
    // Get first-run status + system info
    app.get('/api/setup/status', (req, res) => {
      res.json({
        isFirstRun: this.isFirstRun(),
        systemInfo: this.getSystemInfo(),
        recommended: this.recommendSettings(),
      });
    });

    // Mark setup as complete (optionally apply settings)
    app.post('/api/setup/complete', (req, res) => {
      const { applyRecommended, settings } = req.body || {};

      if (applyRecommended) {
        this.applyRecommended();
      }

      // Apply any explicit settings the wizard collected
      if (settings && typeof settings === 'object') {
        for (const [key, value] of Object.entries(settings)) {
          // Only allow known setting keys
          if (key in this._settingsManager.getAll()) {
            this._settingsManager.set(key, value);
          }
        }
      }

      this.markComplete();
      res.json({ success: true });
    });
  }
}

module.exports = { FirstRunSetup };

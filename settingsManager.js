/**
 * guIDE 2.0 — Settings Manager
 *
 * Centralized settings persistence with encrypted API key storage.
 * Two stores:
 *   1. settings.json — user preferences (plain JSON)
 *   2. api-keys.enc — API keys (AES-256-GCM encrypted)
 *
 * Follows the same debounced-save pattern as MemoryStore/SessionStore.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const EventEmitter = require('events');

// ─── Defaults ────────────────────────────────────────────
const SETTINGS_DEFAULTS = {
  // LLM / Inference
  temperature: 0.4,
  maxResponseTokens: 0, // 0 = auto (use all available context space)
  contextSize: 0, // 0 = auto (hardware-aware ceiling); fixed values like 16000 also work
  topP: 0.95,
  topK: 40,
  repeatPenalty: 1.1,
  seed: -1,
  // Thinking & Reasoning
  thinkingBudget: 2048,
  reasoningEffort: 'medium',
  enableThinking: true,        // Pass enable_thinking=true to chat template (Qwen 3.5 small models disable thinking by default; this activates it)
  enableThinkingFilter: false,
  thinkingMode: 'C',           // Chat wrapper mode: 'C'=ThinkingOpen prefix injection (default), 'B'=raw Jinja no prefix, 'auto'=node-llama-cpp auto, 'off'=Jinja thinking disabled
  toolsEnabled: true,          // When false, no tool definitions are passed to the model — useful for testing thinking display without tools
  // Agentic Behavior
  maxIterations: 0,
  generationTimeoutSec: 0,
  enableGrammar: false,
  enableNativeFC: false,         // Default OFF: models use prose tool calls parsed by toolParser.js unless user enables native FC.
  enableContextSummarizer: true,  // When true, generates a progress summary from dropped context during context shifts using the loaded model (sub-context pattern)
  debugStreamDiag: false,         // When true, logs verbose [StreamDiag] token/FC traces to guide-main.log (no effect on generation)
  streamTraceEnabled: true,       // Full verbatim diagnostic trace to stream/ipc/ui/api-trace.log files
  streamTraceLevel: 'full',       // Only 'full' supported during diagnostic period
  // Command Execution Policy
  // 'disabled' = all commands require approval, 'allowlist' = only allowlisted auto-execute,
  // 'auto' = agent judges safety (default), 'turbo' = all auto-execute except denylisted
  executionPolicy: 'auto',
  // When false (default), all tools auto-execute without approval popups.
  // When true, destructive tools and policy-blocked commands show the approval banner.
  requireToolApproval: false,
  enableSubAgents: true,
  // Browser automation engine for agent browser_* tools
  browserEngine: 'chromium', // 'chromium' | 'tor'
  torBrowserPath: '',
  geckodriverPath: '',
  debugTorBrowser: false,
  browserControl: 'auto', // viewport display: 'auto' | 'screencast' | 'playwright'
  // Default shell for run_command on Windows (cmd vs PowerShell). Ignored on Unix.
  commandShell: 'powershell',
  commandAllowList: ['git status', 'git log', 'git diff', 'git branch', 'ls', 'dir', 'pwd', 'echo', 'cat', 'type', 'node --version', 'npm --version', 'python --version', 'pip --version', 'npm list', 'npm run', 'npm test', 'npm start', 'npm run build', 'npm run lint', 'npx tsc --noEmit'],
  commandDenyList: ['rm -rf /', 'rm -rf ~', 'rm -rf C:\\', 'format C:', 'mkfs', 'shutdown', 'reboot', 'poweroff', 'dd of=/dev/', 'curl | sh', 'wget | sh'],
  // System Prompt
  systemPrompt: '',
  customInstructions: '',
  // Hardware
  gpuPreference: 'auto',
  gpuLayers: -1,
  requireMinContextForGpu: false,
  gpuConstrainedContext: true,  // When GPU layers < 30% of total, cap context to VRAM-bounded size for faster generation
  vramBalance: 'balanced', // auto gpuLayers=-1: balanced | speed | context
  kvCacheType: 'q8_0', // KV cache quantization — q8_0 provides ~2x memory reduction vs f16 with nearly imperceptible quality delta, giving significantly more context capacity. f16 enables the fastest fused flash-attention path on NVIDIA GPUs but consumes more VRAM; q4_0 saves even more VRAM at a measurable speed/quality cost. User-overridable.
  // Editor
  fontSize: 14,
  fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
  tabSize: 2,
  wordWrap: 'on',
  minimap: true,
  lineNumbers: 'on',
  bracketPairColorization: true,
  formatOnPaste: false,
  formatOnType: false,
  // Cloud AI
  lastCloudProvider: null,
  lastCloudModel: null,
  voiceProvider: 'auto', // 'local' | 'cloud' | 'auto' — offline-first with cloud when online
  // Setup
  setupCompleted: false,
  // Account
  sessionToken: null,
  accountUser: null,
  licenseData: null,
  // Auto-update — opt-in, off by default to honour the offline-first principle.
  // 0 = disabled (no automatic check). >0 = check every N hours. The minimum sane
  // value is 1; values below 1 are clamped to 1 by the periodic-check scheduler.
  // The user can still manually trigger a check from the UI regardless of this value.
  autoUpdateCheckHours: 24,
  // UI State
  lastModelPath: null,
  lastImageModelPath: null,
  mediaVaePath: null,
  mediaTaePath: null,
  mediaClipPath: null,
  mediaClipGPath: null,
  mediaT5Path: null,
  mediaOffloadPolicy: 'auto', // auto | max | off — maps to sd.cpp CPU offload flags (not llama gpuLayers)
  mediaVideoFrames: 0, // 0 = auto by VRAM tier
  mediaVideoResolution: 'auto', // auto | fast | balanced | quality
  mediaVideoSteps: 0, // 0 = default 20
  unloadLlmForMedia: true,
  reloadLlmAfterMedia: true,
  lastProjectPath: null,
  sidebarWidth: 260,
  panelHeight: 200,
};

// ─── Encryption helpers ──────────────────────────────────

function deriveKey() {
  // Machine-specific key derivation: hostname + username + static salt
  // This means keys are only decryptable on the same machine by the same user
  const identity = `${os.hostname()}:${os.userInfo().username}:guide-ide-keystore-v1`;
  return crypto.pbkdf2Sync(identity, 'guide-ide-salt-2026', 100000, 32, 'sha256');
}

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv (12) + tag (16) + ciphertext
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(encoded, key) {
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < 28) return null; // iv(12) + tag(16) minimum
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return decipher.update(ciphertext, null, 'utf8') + decipher.final('utf8');
  } catch {
    return null; // Decryption failed (wrong machine, corrupted, etc.)
  }
}

// ─── SettingsManager class ───────────────────────────────

class SettingsManager extends EventEmitter {
  /**
   * @param {string} userDataPath — e.g. %APPDATA%/guide-ide
   */
  constructor(userDataPath) {
    super();
    this._userDataPath = userDataPath;
    this._settingsPath = path.join(userDataPath, 'settings.json');
    this._keysPath = path.join(userDataPath, 'api-keys.enc');
    this._encKey = deriveKey();
    this._settings = { ...SETTINGS_DEFAULTS };
    this._apiKeys = {};
    this._saveTimer = null;
    this._keysSaveTimer = null;

    this._load();
  }

  /* ── Lifecycle ─────────────────────────────────────────── */

  _load() {
    // Ensure directory exists
    try { fs.mkdirSync(this._userDataPath, { recursive: true }); } catch (_) {}

    // Load settings
    try {
      if (fs.existsSync(this._settingsPath)) {
        const raw = JSON.parse(fs.readFileSync(this._settingsPath, 'utf8'));
        // Merge with defaults (new keys get defaults, removed keys get dropped)
        this._settings = { ...SETTINGS_DEFAULTS, ...raw };
        // Migration v2026-04-07: generationTimeoutSec default changed from 120→0.
        // If stored value is exactly 120 (old default), reset to 0 (disabled).
        // Preserves any custom timeout a user deliberately set (e.g. 60, 300).
        if (this._settings.generationTimeoutSec === 120) {
          this._settings.generationTimeoutSec = 0;
          this._scheduleSave(); // write corrected value back to disk immediately
        }
        // Migration: fixed context used for server/dev testing (TEST_MAX_CONTEXT / manual 8k) → auto
        const legacyFixedCtx = new Set([8000, 8192]);
        if (legacyFixedCtx.has(this._settings.contextSize)) {
          this._settings.contextSize = 0;
          this._scheduleSave();
        }
        // Migration: legacy guIDE KV defaults (q3_0, q4_0, f16) → q8_0. q8_0 provides ~2x memory
        // reduction vs f16 with nearly imperceptible quality delta, giving significantly more context.
        // Users who explicitly want f16 (fastest flash-attention) or q4_0 (max context) can set them
        // via settings — only legacy guIDE defaults are swept.
        if (this._settings.kvCacheType === 'q3_0' || this._settings.kvCacheType === 'q4_0' || this._settings.kvCacheType === 'f16') {
          this._settings.kvCacheType = 'q8_0';
          this._scheduleSave();
        }
      }
    } catch (e) {
      console.warn('[SettingsManager] Failed to load settings:', e.message);
    }

    // Load encrypted API keys
    try {
      if (fs.existsSync(this._keysPath)) {
        const encrypted = fs.readFileSync(this._keysPath, 'utf8').trim();
        const decrypted = decrypt(encrypted, this._encKey);
        if (decrypted) {
          this._apiKeys = JSON.parse(decrypted);
        } else {
          console.warn('[SettingsManager] Could not decrypt API keys (machine changed?)');
        }
      }
    } catch (e) {
      console.warn('[SettingsManager] Failed to load API keys:', e.message);
    }
  }

  /* ── Settings (plain JSON) ─────────────────────────────── */

  get(key) {
    return key in this._settings ? this._settings[key] : SETTINGS_DEFAULTS[key];
  }

  set(key, value) {
    const prev = this._settings[key];
    this._settings[key] = value;
    console.log(`[SettingsManager] set ${key}: ${JSON.stringify(prev)} -> ${JSON.stringify(value)}`);
    this._scheduleSave();
    this.emit('change', key, value);
  }

  getAll() {
    return { ...this._settings };
  }

  setAll(obj) {
    const prev = { ...this._settings };
    // Patch-merge: do not re-apply SETTINGS_DEFAULTS for omitted keys (e.g. setupCompleted).
    this._settings = { ...this._settings, ...obj };
    for (const k of Object.keys(this._settings)) {
      if (prev[k] !== this._settings[k]) {
        console.log(`[SettingsManager] setAll diff ${k}: ${JSON.stringify(prev[k])} -> ${JSON.stringify(this._settings[k])}`);
      }
    }
    console.log(`[SettingsManager] setAll done thinkingMode=${this._settings.thinkingMode} toolsEnabled=${this._settings.toolsEnabled}`);
    this._scheduleSave();
    this.emit('change', null, this._settings);
  }

  reset() {
    this._settings = { ...SETTINGS_DEFAULTS };
    this._scheduleSave();
    this.emit('change', null, this._settings);
  }

  /* ── API Keys (encrypted) ──────────────────────────────── */

  getApiKey(provider) {
    return this._apiKeys[provider] || '';
  }

  setApiKey(provider, key) {
    if (key && key.trim()) {
      this._apiKeys[provider] = key;
    } else {
      delete this._apiKeys[provider];
    }
    this._scheduleKeysSave();
  }

  getAllApiKeys() {
    return { ...this._apiKeys };
  }

  removeApiKey(provider) {
    delete this._apiKeys[provider];
    this._scheduleKeysSave();
  }

  hasApiKey(provider) {
    return !!(this._apiKeys[provider] && this._apiKeys[provider].trim());
  }

  /* ── Persistence ───────────────────────────────────────── */

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._saveSettings(), 3000);
  }

  _scheduleKeysSave() {
    if (this._keysSaveTimer) clearTimeout(this._keysSaveTimer);
    this._keysSaveTimer = setTimeout(() => this._saveKeys(), 1000); // Keys save faster
  }

  _saveSettings() {
    try {
      fs.writeFileSync(this._settingsPath, JSON.stringify(this._settings, null, 2), 'utf8');
    } catch (e) {
      console.error('[SettingsManager] Failed to save settings:', e.message);
    }
  }

  _saveKeys() {
    try {
      const json = JSON.stringify(this._apiKeys);
      const encrypted = encrypt(json, this._encKey);
      fs.writeFileSync(this._keysPath, encrypted, 'utf8');
    } catch (e) {
      console.error('[SettingsManager] Failed to save API keys:', e.message);
    }
  }

  /** Flush all pending saves immediately (call on shutdown). */
  flush() {
    console.log(`[SettingsManager] flush thinkingMode=${this._settings.thinkingMode} toolsEnabled=${this._settings.toolsEnabled}`);
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this._saveSettings();
    }
    if (this._keysSaveTimer) {
      clearTimeout(this._keysSaveTimer);
      this._keysSaveTimer = null;
      this._saveKeys();
    }
  }

  /** Return the defaults for external use (e.g. reset endpoint). */
  static get DEFAULTS() {
    return { ...SETTINGS_DEFAULTS };
  }
}

module.exports = { SettingsManager };

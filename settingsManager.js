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
  maxResponseTokens: 2048,
  contextSize: 16384,
  topP: 0.95,
  topK: 40,
  repeatPenalty: 1.1,
  seed: -1,
  // Thinking & Reasoning
  thinkingBudget: 2048,
  reasoningEffort: 'medium',
  // Agentic Behavior
  maxIterations: 25,
  generationTimeoutSec: 180,
  snapshotMaxChars: 8000,
  enableThinkingFilter: false,
  enableGrammar: false,
  // System Prompt
  systemPrompt: '',
  customInstructions: '',
  // Hardware
  gpuPreference: 'auto',
  gpuLayers: -1,
  requireMinContextForGpu: false,
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
  // Setup
  setupCompleted: false,
  // Account
  sessionToken: null,
  accountUser: null,
  licenseData: null,
  // UI State
  lastModelPath: null,
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
    this._settings[key] = value;
    this._scheduleSave();
    this.emit('change', key, value);
  }

  getAll() {
    return { ...this._settings };
  }

  setAll(obj) {
    this._settings = { ...SETTINGS_DEFAULTS, ...obj };
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

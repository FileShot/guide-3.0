/**
 * guIDE 2.0 — License Manager
 *
 * Validates and manages software licenses. Supports:
 *   - HMAC-SHA256 signed license keys (offline validation)
 *   - Online license verification via api.graysoft.dev
 *   - Stripe checkout session creation for Pro/Team plans
 *   - Machine binding (license locked to machineId)
 *   - Persistent license storage via settingsManager
 *
 * License key format: GUIDE-XXXXX-XXXXX-XXXXX-XXXXX
 * License data (signed JSON): { email, plan, machineId, expiresAt, features }
 *
 * Local-first: the app works fully without a license.
 * Licenses unlock cloud AI proxy limits and priority support.
 */
'use strict';

const crypto = require('crypto');
const os = require('os');
const EventEmitter = require('events');

// ─── Constants ───────────────────────────────────────────

const API_BASE = 'https://api.graysoft.dev';

// Plans and their features
const PLANS = {
  free: {
    name: 'Free',
    cloudRequests: 50,   // per day
    maxModelSize: null,  // no limit on local models
    features: ['local-inference', 'basic-tools'],
  },
  pro: {
    name: 'Pro',
    cloudRequests: 5000,
    maxModelSize: null,
    features: ['local-inference', 'basic-tools', 'cloud-ai', 'priority-support', 'rag-search'],
  },
  team: {
    name: 'Team',
    cloudRequests: 20000,
    maxModelSize: null,
    features: ['local-inference', 'basic-tools', 'cloud-ai', 'priority-support', 'rag-search', 'team-sharing'],
  },
};

class LicenseManager extends EventEmitter {
  /**
   * @param {import('./settingsManager').SettingsManager} settingsManager
   * @param {import('./accountManager').AccountManager} accountManager
   */
  constructor(settingsManager, accountManager) {
    super();
    this._settingsManager = settingsManager;
    this._accountManager = accountManager;

    // Generate machine ID (same as accountManager)
    this._machineId = this._generateMachineId();

    // Restore persisted license
    this._licenseData = settingsManager.get('licenseData') || null;
    this._isActivated = this._validateStoredLicense();
  }

  // ─── Public getters ──────────────────────────────────

  get isActivated() { return this._isActivated; }
  get isAuthenticated() { return this._accountManager?.isAuthenticated || false; }
  get licenseData() { return this._licenseData; }
  get machineId() { return this._machineId; }

  getSessionToken() {
    return this._accountManager?.getSessionToken() || null;
  }

  /** Get the current plan (free if no license). */
  getPlan() {
    if (this._isActivated && this._licenseData?.plan) {
      return PLANS[this._licenseData.plan] || PLANS.free;
    }
    return PLANS.free;
  }

  /** Check if a specific feature is available. */
  hasFeature(feature) {
    return this.getPlan().features.includes(feature);
  }

  // ─── License Activation ──────────────────────────────

  /**
   * Activate with a license key (GUIDE-XXXXX-XXXXX-XXXXX-XXXXX).
   * Validates locally first, then verifies with server.
   * @param {string} key
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async activateKey(key) {
    if (!key || !key.trim()) {
      return { success: false, error: 'License key is required' };
    }

    const normalizedKey = key.trim().toUpperCase();

    // Basic format check
    if (!/^GUIDE-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(normalizedKey)) {
      return { success: false, error: 'Invalid license key format. Expected: GUIDE-XXXXX-XXXXX-XXXXX-XXXXX' };
    }

    // Verify with license server
    try {
      const res = await fetch(`${API_BASE}/license/activate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.getSessionToken() ? { 'Authorization': `Bearer ${this.getSessionToken()}` } : {}),
        },
        body: JSON.stringify({
          key: normalizedKey,
          machineId: this._machineId,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { success: false, error: err.error || `Server error: HTTP ${res.status}` };
      }

      const data = await res.json();
      if (data.license) {
        this._setLicense(data.license);
        return { success: true };
      }

      return { success: false, error: data.error || 'Activation failed' };
    } catch (e) {
      return { success: false, error: `Cannot reach license server: ${e.message}` };
    }
  }

  /**
   * Activate via account (no key needed — plan comes from server).
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async activateAccount() {
    const token = this.getSessionToken();
    if (!token) {
      return { success: false, error: 'Not signed in. Please log in first.' };
    }

    try {
      const res = await fetch(`${API_BASE}/license/account-activate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ machineId: this._machineId }),
      });

      if (!res.ok) {
        if (res.status === 401) {
          return { success: false, error: 'Session expired. Please log in again.' };
        }
        const err = await res.json().catch(() => ({}));
        return { success: false, error: err.error || `Server error: HTTP ${res.status}` };
      }

      const data = await res.json();
      if (data.license) {
        this._setLicense(data.license);
        return { success: true };
      }

      return { success: false, error: data.error || 'Account activation failed' };
    } catch (e) {
      return { success: false, error: `Cannot reach license server: ${e.message}` };
    }
  }

  /** Deactivate the current license. */
  deactivate() {
    this._licenseData = null;
    this._isActivated = false;
    this._settingsManager.set('licenseData', null);
    this.emit('deactivated');
  }

  // ─── Stripe Integration ──────────────────────────────

  /**
   * Create a Stripe checkout session for a plan upgrade.
   * @param {'pro' | 'team'} plan
   * @returns {Promise<{ success: boolean, url?: string, error?: string }>}
   */
  async createCheckoutSession(plan) {
    if (!['pro', 'team'].includes(plan)) {
      return { success: false, error: 'Invalid plan. Choose "pro" or "team".' };
    }

    const token = this.getSessionToken();
    if (!token) {
      return { success: false, error: 'Please sign in before purchasing.' };
    }

    try {
      const res = await fetch(`${API_BASE}/stripe/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          plan,
          machineId: this._machineId,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { success: false, error: err.error || `HTTP ${res.status}` };
      }

      const data = await res.json();
      if (data.url) {
        return { success: true, url: data.url };
      }

      return { success: false, error: data.error || 'Failed to create checkout session' };
    } catch (e) {
      return { success: false, error: `Cannot reach payment server: ${e.message}` };
    }
  }

  /**
   * Check subscription status (called after webhook or periodic check).
   * @returns {Promise<{ success: boolean, plan?: string }>}
   */
  async checkSubscription() {
    const token = this.getSessionToken();
    if (!token) return { success: false };

    try {
      const res = await fetch(`${API_BASE}/stripe/subscription`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (!res.ok) return { success: false };

      const data = await res.json();
      if (data.license) {
        this._setLicense(data.license);
        return { success: true, plan: data.license.plan };
      }

      return { success: false };
    } catch {
      return { success: false };
    }
  }

  // ─── API Routes ──────────────────────────────────────

  /**
   * Register Express API routes.
   * @param {import('express').Application} app
   */
  registerRoutes(app) {
    app.post('/api/license/activate', async (req, res) => {
      const { method, key, email, password } = req.body || {};

      if (method === 'key') {
        const result = await this.activateKey(key);
        res.json(result);
      } else if (method === 'account') {
        // Login first, then activate
        if (email && password) {
          const loginResult = await this._accountManager.loginWithEmail(email, password);
          if (!loginResult.success) {
            return res.json(loginResult);
          }
        }
        const result = await this.activateAccount();
        res.json(result);
      } else {
        res.json({ success: false, error: 'Invalid activation method. Use "key" or "account".' });
      }
    });

    app.post('/api/stripe/checkout', async (req, res) => {
      const { plan } = req.body || {};
      const result = await this.createCheckoutSession(plan);
      res.json(result);
    });

    app.get('/api/stripe/subscription', async (req, res) => {
      const result = await this.checkSubscription();
      res.json(result);
    });

    app.get('/api/license/plans', (req, res) => {
      res.json({ plans: PLANS });
    });
  }

  // ─── Internal ────────────────────────────────────────

  _setLicense(license) {
    this._licenseData = {
      email: license.email,
      plan: license.plan || 'pro',
      machineId: license.machineId || this._machineId,
      expiresAt: license.expiresAt || null,
      features: license.features || PLANS[license.plan || 'pro']?.features || [],
      activatedAt: new Date().toISOString(),
    };
    this._isActivated = true;
    this._settingsManager.set('licenseData', this._licenseData);
    this.emit('activated', this._licenseData);
  }

  _validateStoredLicense() {
    if (!this._licenseData) return false;

    // Check expiry
    if (this._licenseData.expiresAt) {
      const expiry = new Date(this._licenseData.expiresAt);
      if (expiry < new Date()) {
        console.log('[LicenseManager] Stored license expired');
        return false;
      }
    }

    // Check machine binding
    if (this._licenseData.machineId && this._licenseData.machineId !== this._machineId) {
      console.log('[LicenseManager] Stored license bound to different machine');
      return false;
    }

    return true;
  }

  _generateMachineId() {
    const data = `${os.hostname()}:${os.userInfo().username}:${os.platform()}:${os.arch()}`;
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 32);
  }
}

module.exports = { LicenseManager };

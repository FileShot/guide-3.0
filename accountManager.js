/**
 * guIDE 2.0 — Account Manager
 *
 * Manages user authentication state, OAuth flows, and account sessions.
 * Supports:
 *   - Email/password login via the guIDE cloud API
 *   - Google OAuth (redirect flow)
 *   - GitHub OAuth (redirect flow)
 *   - Session persistence via settingsManager
 *   - Machine ID generation for license binding
 *
 * Local-first: the app works 100% without an account.
 * Authentication is only needed for cloud AI proxy and license features.
 */
'use strict';

const crypto = require('crypto');
const os = require('os');
const EventEmitter = require('events');

// ─── Constants ───────────────────────────────────────────

const API_BASE = 'https://api.graysoft.dev';
const OAUTH_REDIRECT_BASE = 'https://graysoft.dev/auth/callback';

class AccountManager extends EventEmitter {
  /**
   * @param {import('./settingsManager').SettingsManager} settingsManager
   */
  constructor(settingsManager) {
    super();
    this._settingsManager = settingsManager;
    this._machineId = this._generateMachineId();

    // Restore persisted session
    this._sessionToken = settingsManager.get('sessionToken') || null;
    this._user = settingsManager.get('accountUser') || null;
    this._isAuthenticated = !!this._sessionToken;
  }

  // ─── Public getters ──────────────────────────────────

  get isAuthenticated() { return this._isAuthenticated; }
  get user() { return this._user; }
  get machineId() { return this._machineId; }

  getSessionToken() {
    return this._sessionToken;
  }

  // ─── Login methods ───────────────────────────────────

  /**
   * Login with email and password.
   * @param {string} email
   * @param {string} password
   * @returns {Promise<{ success: boolean, error?: string, user?: object }>}
   */
  async loginWithEmail(email, password) {
    if (!email || !password) {
      return { success: false, error: 'Email and password are required' };
    }

    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, machineId: this._machineId }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { success: false, error: err.error || `HTTP ${res.status}` };
      }

      const data = await res.json();
      if (data.token && data.user) {
        this._setSession(data.token, data.user);
        return { success: true, user: this._user };
      }

      return { success: false, error: data.error || 'Login failed' };
    } catch (e) {
      return { success: false, error: `Cannot reach authentication server: ${e.message}` };
    }
  }

  /**
   * Register a new account with email and password.
   * @param {string} email
   * @param {string} password
   * @param {string} [name]
   * @returns {Promise<{ success: boolean, error?: string, user?: object }>}
   */
  async register(email, password, name) {
    if (!email || !password) {
      return { success: false, error: 'Email and password are required' };
    }

    try {
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name: name || email.split('@')[0], machineId: this._machineId }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { success: false, error: err.error || `HTTP ${res.status}` };
      }

      const data = await res.json();
      if (data.token && data.user) {
        this._setSession(data.token, data.user);
        return { success: true, user: this._user };
      }

      return { success: false, error: data.error || 'Registration failed' };
    } catch (e) {
      return { success: false, error: `Cannot reach authentication server: ${e.message}` };
    }
  }

  /**
   * Get the OAuth redirect URL for the given provider.
   * @param {'google' | 'github'} provider
   * @returns {{ url: string, state: string }}
   */
  getOAuthURL(provider) {
    const state = crypto.randomBytes(16).toString('hex');
    this._oauthState = state;

    const params = new URLSearchParams({
      provider,
      state,
      machineId: this._machineId,
      redirect: OAUTH_REDIRECT_BASE,
    });

    return {
      url: `${API_BASE}/auth/oauth/${provider}?${params}`,
      state,
    };
  }

  /**
   * Complete OAuth flow with the callback code/state.
   * @param {string} code
   * @param {string} state
   * @returns {Promise<{ success: boolean, error?: string, user?: object }>}
   */
  async completeOAuth(code, state) {
    if (!code || !state) {
      return { success: false, error: 'Missing OAuth callback parameters' };
    }

    if (this._oauthState && state !== this._oauthState) {
      return { success: false, error: 'OAuth state mismatch — possible CSRF attack' };
    }

    try {
      const res = await fetch(`${API_BASE}/auth/oauth/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, state, machineId: this._machineId }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { success: false, error: err.error || `HTTP ${res.status}` };
      }

      const data = await res.json();
      if (data.token && data.user) {
        this._setSession(data.token, data.user);
        return { success: true, user: this._user };
      }

      return { success: false, error: data.error || 'OAuth failed' };
    } catch (e) {
      return { success: false, error: `Cannot reach authentication server: ${e.message}` };
    }
  }

  /**
   * Refresh the session token.
   * @returns {Promise<{ success: boolean }>}
   */
  async refreshSession() {
    if (!this._sessionToken) return { success: false };

    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._sessionToken}`,
        },
        body: JSON.stringify({ machineId: this._machineId }),
      });

      if (!res.ok) {
        // Token expired or invalid — clear session
        if (res.status === 401) this.logout();
        return { success: false };
      }

      const data = await res.json();
      if (data.token) {
        this._sessionToken = data.token;
        this._settingsManager.set('sessionToken', data.token);
        return { success: true };
      }

      return { success: false };
    } catch {
      return { success: false };
    }
  }

  /** Logout — clear session. */
  logout() {
    this._sessionToken = null;
    this._user = null;
    this._isAuthenticated = false;
    this._settingsManager.set('sessionToken', null);
    this._settingsManager.set('accountUser', null);
    this.emit('logout');
  }

  // ─── API routes ──────────────────────────────────────

  /**
   * Register Express API routes.
   * @param {import('express').Application} app
   */
  registerRoutes(app) {
    app.get('/api/account/status', (req, res) => {
      res.json({
        isAuthenticated: this._isAuthenticated,
        user: this._user,
        machineId: this._machineId,
      });
    });

    app.post('/api/account/login', async (req, res) => {
      const { email, password } = req.body || {};
      const result = await this.loginWithEmail(email, password);
      res.json(result);
    });

    app.post('/api/account/register', async (req, res) => {
      const { email, password, name } = req.body || {};
      const result = await this.register(email, password, name);
      res.json(result);
    });

    app.post('/api/account/oauth/start', (req, res) => {
      const { provider } = req.body || {};
      if (!provider || !['google', 'github'].includes(provider)) {
        return res.json({ success: false, error: 'Invalid OAuth provider' });
      }
      const { url, state } = this.getOAuthURL(provider);
      res.json({ success: true, url, state });
    });

    app.post('/api/account/oauth/callback', async (req, res) => {
      const { code, state } = req.body || {};
      const result = await this.completeOAuth(code, state);
      res.json(result);
    });

    app.post('/api/account/logout', (req, res) => {
      this.logout();
      res.json({ success: true });
    });

    app.post('/api/account/refresh', async (req, res) => {
      const result = await this.refreshSession();
      res.json(result);
    });
  }

  // ─── Internal ────────────────────────────────────────

  _setSession(token, user) {
    this._sessionToken = token;
    this._user = {
      id: user.id,
      email: user.email,
      name: user.name || user.email?.split('@')[0],
      avatar: user.avatar || null,
      plan: user.plan || 'free',
    };
    this._isAuthenticated = true;
    this._settingsManager.set('sessionToken', token);
    this._settingsManager.set('accountUser', this._user);
    this.emit('login', this._user);
  }

  _generateMachineId() {
    const data = `${os.hostname()}:${os.userInfo().username}:${os.platform()}:${os.arch()}`;
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 32);
  }
}

module.exports = { AccountManager };

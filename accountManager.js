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

const APP_ORIGIN = 'https://graysoft.dev';
const API_BASE = `${APP_ORIGIN}/api`;
/** OAuth return URL — graysoft callbacks append ?guide_token=JWT (trusted hostname). */
const OAUTH_RETURN_URL = `${APP_ORIGIN}/auth/callback`;

class AccountManager extends EventEmitter {
  /**
   * @param {import('./settingsManager').SettingsManager} settingsManager
   */
  constructor(settingsManager) {
    super();
    this._settingsManager = settingsManager;
    this._machineId = this._generateMachineId();

    this._sessionToken = settingsManager.get('sessionToken') || null;
    this._user = settingsManager.get('accountUser') || null;
    this._isAuthenticated = !!this._sessionToken;
  }

  get isAuthenticated() { return this._isAuthenticated; }
  get user() { return this._user; }
  get machineId() { return this._machineId; }

  getSessionToken() {
    return this._sessionToken;
  }

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

      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        return { success: false, error: data.error || `HTTP ${res.status}` };
      }

      if (!data.token) {
        return { success: false, error: data.error || 'Login failed — no session token' };
      }

      await this._hydrateSessionFromToken(data.token, { email });
      return { success: true, user: this._user, licenseKey: data.licenseKey, plan: data.plan };
    } catch (e) {
      return { success: false, error: `Cannot reach authentication server: ${e.message}` };
    }
  }

  async register(email, password, name) {
    if (!email || !password) {
      return { success: false, error: 'Email and password are required' };
    }

    try {
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          name: name || email.split('@')[0],
          machineId: this._machineId,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        return { success: false, error: data.error || `HTTP ${res.status}` };
      }

      return this.loginWithEmail(email, password);
    } catch (e) {
      return { success: false, error: `Cannot reach authentication server: ${e.message}` };
    }
  }

  /**
   * OAuth start URL — uses graysoft.dev /api/auth/google|github (not legacy /auth/oauth/*).
   */
  getOAuthURL(provider) {
    const path = provider === 'github' ? '/api/auth/github' : '/api/auth/google';
    const params = new URLSearchParams({
      return: OAUTH_RETURN_URL,
    });
    return {
      url: `${APP_ORIGIN}${path}?${params}`,
      state: null,
    };
  }

  /**
   * Complete OAuth using guide_token from the redirect URL (graysoft.dev desktop flow).
   */
  async completeOAuthWithToken(guideToken) {
    if (!guideToken) {
      return { success: false, error: 'Missing session token from sign-in' };
    }
    try {
      await this._hydrateSessionFromToken(guideToken);
      return { success: true, user: this._user };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to validate sign-in token' };
    }
  }

  async refreshSession() {
    if (!this._sessionToken) return { success: false };

    try {
      const profile = await this._fetchProfile(this._sessionToken);
      if (!profile) {
        this.logout();
        return { success: false };
      }
      this._applyProfile(this._sessionToken, profile);
      return { success: true };
    } catch {
      return { success: false };
    }
  }

  logout() {
    this._sessionToken = null;
    this._user = null;
    this._isAuthenticated = false;
    this._settingsManager.set('sessionToken', null);
    this._settingsManager.set('accountUser', null);
    this.emit('logout');
  }

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
      res.json(await this.loginWithEmail(email, password));
    });

    app.post('/api/account/register', async (req, res) => {
      const { email, password, name } = req.body || {};
      res.json(await this.register(email, password, name));
    });

    app.post('/api/account/oauth/start', async (req, res) => {
      const { provider } = req.body || {};
      if (!provider || !['google', 'github'].includes(provider)) {
        return res.json({ success: false, error: 'Invalid OAuth provider' });
      }
      const { url } = this.getOAuthURL(provider);
      res.json({ success: true, url });
    });

    app.post('/api/account/logout', (req, res) => {
      this.logout();
      res.json({ success: true });
    });

    app.post('/api/account/refresh', async (req, res) => {
      res.json(await this.refreshSession());
    });
  }

  async _hydrateSessionFromToken(token, hints = {}) {
    const profile = await this._fetchProfile(token);
    if (profile?.user) {
      this._applyProfile(token, profile);
      return;
    }
    const email = hints.email || profile?.email || 'user@graysoft.dev';
    this._setSession(token, {
      id: hints.id,
      email,
      name: hints.name || email.split('@')[0],
      avatar: null,
      plan: hints.plan || 'free',
    });
  }

  async _fetchProfile(token) {
    const res = await fetch(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) return null;
    return data;
  }

  _applyProfile(token, profile) {
    const u = profile.user;
    this._setSession(token, {
      id: u.id,
      email: u.email,
      name: u.name || u.email?.split('@')[0],
      avatar: u.avatar || null,
      plan: u.license?.plan || 'free',
    });
  }

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

module.exports = { AccountManager, API_BASE, OAUTH_RETURN_URL, APP_ORIGIN };

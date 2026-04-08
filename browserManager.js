/**
 * guIDE 2.0 — Browser Manager
 *
 * Manages the browser preview lifecycle:
 *   1. Live server (static file serving with hot-reload) — via liveServer.js
 *   2. Playwright browser automation (optional) — if installed
 *   3. Preview URL management for BrowserPanel
 *
 * Used by:
 *   - mcpToolServer (AI browser tool calls)
 *   - /api/preview/* REST endpoints in server/main.js
 *   - BrowserPanel (frontend component)
 */
'use strict';

const EventEmitter = require('events');
const path = require('path');

class BrowserManager extends EventEmitter {
  /**
   * @param {{ liveServer: object, parentWindow: object }} options
   */
  constructor(options = {}) {
    super();
    this.liveServer = options.liveServer || null;
    this.parentWindow = options.parentWindow || null;
    this._previewUrl = null;
    this._previewPort = null;
    this._wsPort = null;
    this._playwright = null;
    this._browser = null;
    this._page = null;
  }

  /* ── Live Preview ──────────────────────────────────────── */

  /**
   * Start the live preview server for a project directory.
   * @param {string} rootPath — directory to serve
   * @returns {Promise<{ success: boolean, url?: string, port?: number, error?: string }>}
   */
  async startPreview(rootPath) {
    if (!this.liveServer) {
      return { success: false, error: 'Live server module not available' };
    }
    const result = await this.liveServer.start(rootPath);
    if (result.success) {
      this._previewUrl = result.url;
      this._previewPort = result.port;
      this._wsPort = result.wsPort;
      this.emit('preview-started', { url: result.url, port: result.port });
      // Notify frontend via mainWindow
      if (this.parentWindow?.webContents) {
        this.parentWindow.webContents.send('preview-started', {
          url: result.url, port: result.port,
        });
      }
    }
    return result;
  }

  /**
   * Stop the live preview server.
   */
  async stopPreview() {
    if (!this.liveServer) return { success: false, error: 'No live server' };
    await this.liveServer.stop();
    this._previewUrl = null;
    this._previewPort = null;
    this._wsPort = null;
    this.emit('preview-stopped');
    if (this.parentWindow?.webContents) {
      this.parentWindow.webContents.send('preview-stopped');
    }
    return { success: true };
  }

  /**
   * Trigger a reload on all connected preview clients.
   */
  reloadPreview() {
    if (this.liveServer?.notifyReload) {
      this.liveServer.notifyReload();
    }
  }

  /**
   * Get current preview status.
   */
  getPreviewStatus() {
    return {
      active: !!this._previewUrl,
      url: this._previewUrl,
      port: this._previewPort,
      wsPort: this._wsPort,
    };
  }

  /* ── Navigation (used by browser tool calls) ───────────── */

  /**
   * Navigate to a URL. Uses Playwright if available, otherwise opens in preview.
   */
  async navigate(url) {
    if (this._page) {
      try {
        await this._page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        return { success: true, url: this._page.url() };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    // No Playwright — send URL to frontend for iframe navigation
    if (this.parentWindow?.webContents) {
      this.parentWindow.webContents.send('preview-navigate', { url });
    }
    return { success: true, url, method: 'frontend-iframe' };
  }

  /* ── Playwright Integration (optional) ─────────────────── */

  /**
   * Launch Playwright browser. Returns false if Playwright is not installed.
   */
  async launchPlaywright() {
    if (this._browser) return { success: true, message: 'Already launched' };
    try {
      this._playwright = require('playwright');
    } catch {
      return { success: false, error: 'Playwright not installed. Run: npm i playwright' };
    }
    try {
      this._browser = await this._playwright.chromium.launch({ headless: true });
      this._page = await this._browser.newPage();
      return { success: true };
    } catch (e) {
      return { success: false, error: `Failed to launch browser: ${e.message}` };
    }
  }

  /**
   * Close Playwright browser.
   */
  async closePlaywright() {
    if (this._page) { try { await this._page.close(); } catch {} }
    if (this._browser) { try { await this._browser.close(); } catch {} }
    this._page = null;
    this._browser = null;
    this._playwright = null;
    return { success: true };
  }

  /**
   * Take a screenshot of the current page.
   * @returns {Promise<{ success: boolean, screenshot?: string, error?: string }>}
   */
  async screenshot() {
    if (!this._page) return { success: false, error: 'No browser page open' };
    try {
      const buffer = await this._page.screenshot({ type: 'png' });
      return { success: true, screenshot: buffer.toString('base64') };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Get a text snapshot of the current page.
   */
  async getSnapshot() {
    if (!this._page) return { success: false, error: 'No browser page open' };
    try {
      const text = await this._page.evaluate(() => document.body?.innerText || '');
      const title = await this._page.title();
      const url = this._page.url();
      return { success: true, title, url, text: text.substring(0, 5000) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Click an element by selector.
   */
  async click(selector) {
    if (!this._page) return { success: false, error: 'No browser page open' };
    try {
      await this._page.click(selector, { timeout: 5000 });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Evaluate JavaScript in the browser page.
   */
  async evaluate(code) {
    if (!this._page) return { success: false, error: 'No browser page open' };
    try {
      const result = await this._page.evaluate(code);
      return { success: true, result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /* ── Helpers ───────────────────────────────────────────── */

  isLaunched() {
    return !!this._browser;
  }

  /** Clean up on shutdown. */
  async dispose() {
    await this.stopPreview();
    await this.closePlaywright();
  }
}

module.exports = { BrowserManager };

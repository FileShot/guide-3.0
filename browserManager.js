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
    this._navHistory = []; // [{url, title, timestamp, action}] — tracks what the model already did
    this._lastSnapshotUrl = null;
    this._lastSnapshotTime = 0;
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
    const ok = await this._ensurePage();
    if (!ok) return { success: false, error: 'Could not launch browser' };
    if (this._page) {
      try {
        await this._page.goto(url, { waitUntil: 'load', timeout: 20000 });
        // Wait for SPAs to render — load event fires after initial render,
        // but SPAs need extra time for JS-driven content
        try { await this._page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}); } catch {}
        const finalUrl = this._page.url();
        const title = await this._page.title().catch(() => '');
        this._navHistory.push({ url: finalUrl, title, timestamp: Date.now(), action: 'navigate' });
        if (this._navHistory.length > 30) this._navHistory = this._navHistory.slice(-30);
        // Auto-snapshot: include page content so the model can see what's on the page
        // without needing a separate browser_snapshot call
        const snapshot = await this.getSnapshot();
        if (snapshot.success) {
          return { success: true, url: finalUrl, title, snapshot: snapshot.text };
        }
        return { success: true, url: finalUrl, title };
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
    if (this._browser && this._page) {
      // Verify the page is actually alive
      try { await this._page.evaluate(() => true); return { success: true, message: 'Already launched' }; } catch {}
      // Page is dead — clean up and relaunch
      await this.closePlaywright();
    }
    try {
      this._playwright = require('playwright');
    } catch {
      return { success: false, error: 'Playwright not installed. Run: npm i playwright' };
    }
    try {
      this._browser = await this._playwright.chromium.launch({ headless: false });
      this._page = await this._browser.newPage();
      // Register disconnect handler so we know when browser dies
      this._browser.on('disconnected', () => {
        console.log('[BrowserManager] Browser disconnected — clearing references');
        this._page = null;
        this._browser = null;
      });
      return { success: true };
    } catch (e) {
      return { success: false, error: `Failed to launch browser: ${e.message}` };
    }
  }

  /**
   * Ensure a live Playwright page exists. Auto-reconnects if the browser died.
   * @returns {Promise<boolean>} true if page is ready
   */
  async _ensurePage() {
    if (this._page) {
      try { await this._page.evaluate(() => true); return true; } catch {}
      // Page is dead — clear stale references
      this._page = null;
      this._browser = null;
    }
    const result = await this.launchPlaywright();
    return result.success;
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
    if (!(await this._ensurePage())) return { success: false, error: 'No browser page open' };
    try {
      const buffer = await this._page.screenshot({ type: 'png' });
      return { success: true, screenshot: buffer.toString('base64') };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Inject data-ref attributes into all interactive elements on the current page.
   * Returns the array of element descriptions. Called by getSnapshot and by
   * click/type before resolving a ref selector (data-ref attrs are lost on
   * page navigation/reload, causing [data-ref="N"] selectors to fail).
   */
  async _ensureRefs() {
    if (!this._page) return null;
    return this._page.evaluate(() => {
      const selectors = [
        'input', 'button', 'a', 'select', 'textarea',
        '[role="button"]', '[role="link"]', '[role="textbox"]',
        '[role="combobox"]', '[role="checkbox"]', '[role="radio"]',
        '[role="tab"]', '[role="menuitem"]', '[role="option"]',
        '[contenteditable]', 'summary', 'details',
        'iframe', 'form',
      ];
      const all = [...document.querySelectorAll(selectors.join(','))]
        .filter(el => {
          if (el.offsetParent !== null) return true;
          if (el.type === 'hidden') return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          if (style.position === 'fixed' || style.position === 'sticky') return true;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
      const lines = [];
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        el.setAttribute('data-ref', String(i));
        const tag = el.tagName.toLowerCase();
        const type = el.type || '';
        const name = el.name || el.id || '';
        const placeholder = el.placeholder || '';
        const value = el.value || '';
        const text = (el.textContent || '').trim().substring(0, 80);
        const href = el.href || '';
        const role = el.getAttribute('role') || '';
        const ariaLabel = el.getAttribute('aria-label') || '';
        const titleAttr = el.getAttribute('title') || '';
        const imgAlt = (!text && el.querySelector)
          ? (el.querySelector('img')?.getAttribute('alt') || '') : '';
        let desc = `[ref=${i}] <${tag}`;
        if (type) desc += ` type="${type}"`;
        if (name) desc += ` name="${name}"`;
        if (role) desc += ` role="${role}"`;
        if (ariaLabel) desc += ` aria-label="${ariaLabel}"`;
        if (titleAttr) desc += ` title="${titleAttr.substring(0, 80)}"`;
        if (placeholder) desc += ` placeholder="${placeholder}"`;
        if (value && type !== 'password') desc += ` value="${value.substring(0, 50)}"`;
        if (href) desc += ` href="${href.substring(0, 80)}"`;
        desc += '>';
        if (text && type !== 'password' && tag !== 'input') desc += ` ${text}`;
        else if (imgAlt) desc += ` [img: ${imgAlt.substring(0, 80)}]`;
        lines.push(desc);
      }
      const pageText = (document.body?.innerText || '').substring(0, 50000);
      return { elementList: lines.join('\n'), pageText };
    });
  }

  async getSnapshot() {
    if (!(await this._ensurePage())) return { success: false, error: 'No browser page open' };
    try {
      const title = await this._page.title();
      const url = this._page.url();

      // Inject data-ref attributes and build a numbered element list
      const snapshotData = await this._ensureRefs();

      const result = `Page: ${title}\nURL: ${url}\n\nInteractive elements:\n${snapshotData.elementList}\n\nPage text:\n${snapshotData.pageText}`;
      // Include navigation history so the model knows what it already did
      let historySection = '';
      if (this._navHistory.length > 0) {
        const recentHistory = this._navHistory.slice(-8);
        historySection = '\n\nNavigation history (DO NOT repeat these actions — move to the NEXT step):\n'
          + recentHistory.map((h, i) => `${i + 1}. ${h.action}: ${h.url}${h.title ? ` (${h.title})` : ''}`).join('\n');
      }
      this._lastSnapshotUrl = url;
      this._lastSnapshotTime = Date.now();
      // No total cap — the model needs the full snapshot to make correct decisions.
      // Truncation was the root cause of repeated wrong clicks (elements below the fold invisible).
      return { success: true, title, url, text: result + historySection };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Resolve a ref string (e.g. "[ref=1]", "1", or CSS selector) to a valid Playwright selector.
   * Accessibility snapshots use [ref=N] format — we convert to [aria-ref="N"] or
   * fall back to nth-child indexing.
   */
  _resolveRef(ref) {
    if (!ref || typeof ref !== 'string' || !ref.trim()) {
      // Return a sentinel that will fail with a clear message instead of a cryptic CSS parser error
      return null;
    }
    const trimmed = ref.trim();
    // Match [ref=N] format from accessibility snapshots
    const refMatch = trimmed.match(/^\[ref=(\d+)\]$/);
    if (refMatch) {
      return `[data-ref="${refMatch[1]}"], [aria-ref="${refMatch[1]}"]`;
    }
    // Match "ref=N" format (without brackets) — models often output elementId="ref=6"
    const bareRefMatch = trimmed.match(/^ref=(\d+)$/);
    if (bareRefMatch) {
      return `[data-ref="${bareRefMatch[1]}"], [aria-ref="${bareRefMatch[1]}"]`;
    }
    // Bare number like "1" — treat as index-based selector
    if (/^\d+$/.test(trimmed)) {
      const idx = parseInt(trimmed);
      return `[data-ref="${idx}"], [aria-ref="${idx}"]`;
    }
    // Non-numeric string like "username" — resolve as name/id/placeholder attribute.
    // Models often pass elementId="username" which gets normalized to ref="username".
    // Treating "username" as a CSS tag selector (<username>) always fails.
    // Instead, look up by name, id, or placeholder attributes.
    if (/^[a-zA-Z_][a-zA-Z0-9_\-]*$/.test(trimmed)) {
      return `[name="${trimmed}"], [id="${trimmed}"], [data-ref="${trimmed}"], [placeholder="${trimmed}"]`;
    }
    // Already a valid CSS selector (contains brackets, dots, hash, etc.) — return as-is
    return ref;
  }

  /**
   * Click an element by selector.
   */
  async click(selector) {
    if (!(await this._ensurePage())) return { success: false, error: 'No browser page open' };
    // Re-inject data-ref attrs before resolving — they're lost on page navigation/reload
    await this._ensureRefs();
    const resolved = this._resolveRef(selector);
    if (!resolved) {
      return { success: false, error: `Invalid element ref "${selector}". Use the [ref=N] number from the snapshot, e.g. browser_click({"ref":"5"}). Call browser_snapshot first if you need fresh refs.` };
    }
    try {
      const urlBefore = this._page.url();
      // Get the element text before clicking — include title/alt for image-only links
      let clickedText = '';
      try {
        const loc = this._page.locator(resolved).first();
        clickedText = await loc.textContent({ timeout: 2000 }).then(t => t?.trim()?.substring(0, 60) || '');
        if (!clickedText) {
          // Image-only link — get title attribute or child img alt
          clickedText = await loc.getAttribute('title', { timeout: 1000 }).then(t => t || '') ||
            await loc.locator('img').first().getAttribute('alt', { timeout: 1000 }).then(t => t || '') || '';
        }
      } catch {}

      // Listen for new tab/popup BEFORE clicking — target=_blank links open new tabs
      // which don't change the current page URL, causing the model to think the click failed
      const popupPromise = this._page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
      await this._page.click(resolved, { timeout: 5000 });
      const newPage = await popupPromise;

      if (newPage) {
        // A new tab opened — switch to it and close old tabs to prevent accumulation
        try { await newPage.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}); } catch {}
        // Close all other tabs except the new one
        const context = this._page.context();
        const allPages = context.pages();
        for (const p of allPages) {
          if (p !== newPage) { try { await p.close(); } catch {} }
        }
        this._page = newPage;
        const snapshot = await this.getSnapshot();
        if (snapshot.success) {
          return { success: true, url: newPage.url(), clicked: clickedText || selector, navigated: true, newTab: true, snapshot: snapshot.text };
        }
        return { success: true, url: newPage.url(), clicked: clickedText || selector, navigated: true, newTab: true };
      }

      // No new tab — check if same-page navigation happened
      try { await this._page.waitForTimeout(800); } catch {}
      const urlAfter = this._page.url();
      const navigated = urlAfter !== urlBefore;
      if (navigated) {
        try { await this._page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}); } catch {}
      }
      // Always snapshot so model sees DOM changes
      const snapshot = await this.getSnapshot();
      if (snapshot.success) {
        return { success: true, url: urlAfter, clicked: clickedText || selector, navigated, snapshot: snapshot.text };
      }
      return { success: true, url: urlAfter, clicked: clickedText || selector, navigated };
    } catch (e) {
      // If ref-based selector failed, try JS click fallback by element index
      // Uses the SAME selector list and visibility filter as _ensureRefs() so indices match the snapshot
      const refMatch = selector?.match?.(/^\[ref=(\d+)\]$/) || (typeof selector === 'string' && /^\d+$/.test(selector.trim()) && [null, selector.trim()]);
      if (refMatch) {
        try {
          const idx = parseInt(refMatch[1]);
          const result = await this._page.evaluate((i) => {
            const selectors = [
              'input', 'button', 'a', 'select', 'textarea',
              '[role="button"]', '[role="link"]', '[role="textbox"]',
              '[role="combobox"]', '[role="checkbox"]', '[role="radio"]',
              '[role="tab"]', '[role="menuitem"]', '[role="option"]',
              '[contenteditable]', 'summary', 'details',
              'iframe', 'form',
            ];
            const all = [...document.querySelectorAll(selectors.join(','))].filter(el => {
              if (el.offsetParent !== null) return true;
              if (el.type === 'hidden') return false;
              const s = window.getComputedStyle(el);
              if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
              if (s.position === 'fixed' || s.position === 'sticky') return true;
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            });
            if (all[i]) { const txt = (all[i].textContent || '').trim().substring(0, 60); all[i].click(); return { success: true, clicked: txt || `element[${i}]` }; }
            return { success: false, error: `No interactive element at index ${i} (found ${all.length} visible elements)` };
          }, idx);
          if (result.success) {
            try { await this._page.waitForTimeout(800); } catch {}
            const snapshot = await this.getSnapshot();
            if (snapshot.success) return { success: true, url: this._page.url(), snapshot: snapshot.text };
          }
          if (result.success) return result;
        } catch (_) {}
      }
      return { success: false, error: e.message };
    }
  }

  /**
   * Evaluate JavaScript in the browser page.
   */
  async evaluate(code) {
    if (!(await this._ensurePage())) return { success: false, error: 'No browser page open' };
    try {
      const result = await this._page.evaluate(code);
      return { success: true, result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Type text into an element by selector/ref.
   */
  async type(ref, text, options = {}) {
    if (!(await this._ensurePage())) return { success: false, error: 'No browser page open' };
    // Re-inject data-ref attrs before resolving — they're lost on page navigation/reload
    await this._ensureRefs();
    const resolved = this._resolveRef(ref);
    if (!resolved) {
      return { success: false, error: `Invalid element ref "${ref}". Use the [ref=N] number from the snapshot, e.g. browser_type({"ref":"3","text":"hello"}). Call browser_snapshot first if you need fresh refs.` };
    }
    try {
      const locator = this._page.locator(resolved).first();
      await locator.fill(text, { timeout: 5000 });
      if (options.submit) {
        await this._page.keyboard.press('Enter');
        // Wait for navigation after form submit
        try { await this._page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}); } catch {}
        try { await this._page.waitForTimeout(1000); } catch {}
        // After submit, page likely changed — auto-snapshot
        const snapshot = await this.getSnapshot();
        if (snapshot.success) {
          return { success: true, url: this._page.url(), snapshot: snapshot.text };
        }
      }
      return { success: true };
    } catch (e) {
      // JS fallback: find visible input by index
      const refMatch = ref?.match?.(/^\[ref=(\d+)\]$/) || (typeof ref === 'string' && /^\d+$/.test(ref.trim()) && [null, ref.trim()]);
      if (refMatch) {
        try {
          const idx = parseInt(refMatch[1]);
          const result = await this._page.evaluate(({ i, t }) => {
            const inputs = [...document.querySelectorAll('input, textarea, [contenteditable]')].filter(el => el.offsetParent !== null);
            const el = inputs[i];
            if (!el) return { success: false, error: `No input at index ${i}` };
            const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
              || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
            if (nativeSet) nativeSet.call(el, t);
            else el.value = t;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { success: true };
          }, { i: idx, t: text });
          if (result.success) {
            if (options.submit) {
              await this._page.keyboard.press('Enter');
              try { await this._page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}); } catch {}
              try { await this._page.waitForTimeout(1000); } catch {}
              const snapshot = await this.getSnapshot();
              if (snapshot.success) return { success: true, url: this._page.url(), snapshot: snapshot.text };
            }
            return result;
          }
        } catch (_) {}
      }
      return { success: false, error: e.message };
    }
  }

  /**
   * Select options in a dropdown by selector/ref.
   */
  async selectOption(ref, values) {
    if (!(await this._ensurePage())) return { success: false, error: 'No browser page open' };
    await this._ensureRefs();
    const resolved = this._resolveRef(ref);
    if (!resolved) return { success: false, error: `Invalid element ref "${ref}". Use the [ref=N] number from the snapshot.` };
    try {
      await this._page.selectOption(resolved, values, { timeout: 5000 });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Get text content or HTML of the page or a selector.
   */
  async getContent(selector, html = false) {
    if (!(await this._ensurePage())) return { success: false, error: 'No browser page open' };
    try {
      const target = selector ? this._page.locator(selector).first() : this._page;
      if (html) {
        const content = await target.evaluate(el => el.outerHTML);
        return { success: true, content };
      }
      const content = await target.evaluate(el => el.innerText || el.textContent || '');
      return { success: true, content: content.substring(0, 20000) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Navigate back in browser history.
   */
  async goBack() {
    if (!(await this._ensurePage())) return { success: false, error: 'No browser page open' };
    try {
      await this._page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
      return { success: true, url: this._page.url() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Press a keyboard key.
   */
  async pressKey(key) {
    if (!(await this._ensurePage())) return { success: false, error: 'No browser page open' };
    try {
      await this._page.keyboard.press(key);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Hover over an element by selector/ref.
   */
  async hover(ref) {
    if (!(await this._ensurePage())) return { success: false, error: 'No browser page open' };
    await this._ensureRefs();
    const resolved = this._resolveRef(ref);
    if (!resolved) return { success: false, error: `Invalid element ref "${ref}". Use the [ref=N] number from the snapshot.` };
    try {
      await this._page.hover(resolved, { timeout: 5000 });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Wait for a CSS selector to appear.
   */
  async waitForSelector(selector, options = {}) {
    if (!(await this._ensurePage())) return { success: false, error: 'No browser page open' };
    try {
      await this._page.waitForSelector(selector, { timeout: options.timeout || 10000 });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Fill multiple form fields at once.
   */
  async fillForm(fields) {
    if (!(await this._ensurePage())) return { success: false, error: 'No browser page open' };
    await this._ensureRefs();
    try {
      for (const field of fields) {
        const refVal = field.ref || field.selector;
        const resolved = this._resolveRef(refVal);
        if (!resolved) continue;
        const locator = this._page.locator(resolved).first();
        const type = field.type || 'textbox';
        if (type === 'checkbox') {
          const checked = field.value === 'true' || field.value === true;
          if (checked) await locator.check({ timeout: 5000 });
          else await locator.uncheck({ timeout: 5000 });
        } else if (type === 'radio') {
          await locator.check({ timeout: 5000 });
        } else if (type === 'combobox' || type === 'select') {
          await locator.selectOption(field.value, { timeout: 5000 });
        } else {
          await locator.fill(String(field.value), { timeout: 5000 });
        }
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Drag and drop between two elements.
   */
  async drag(startRef, endRef) {
    if (!(await this._ensurePage())) return { success: false, error: 'No browser page open' };
    try {
      const source = this._page.locator(startRef).first();
      const target = this._page.locator(endRef).first();
      await source.dragTo(target, { timeout: 5000 });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Manage browser tabs: list, new, close, select.
   */
  async tabs(action, index) {
    if (!(await this._ensurePage())) return { success: false, error: 'No browser open' };
    try {
      const pages = this._browser.contexts()[0]?.pages() || [];
      if (action === 'list') {
        return { success: true, tabs: pages.map((p, i) => ({ index: i, url: p.url(), title: '' })) };
      }
      if (action === 'new') {
        const page = await this._browser.newPage();
        this._page = page;
        return { success: true, index: pages.length };
      }
      if (action === 'close' && index != null && pages[index]) {
        await pages[index].close();
        return { success: true };
      }
      if (action === 'select' && index != null && pages[index]) {
        this._page = pages[index];
        await pages[index].bringToFront();
        return { success: true, url: pages[index].url() };
      }
      return { success: false, error: `Unknown tab action: ${action}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Handle a browser dialog.
   */
  async handleDialog(accept, promptText) {
    // This needs a dialog event handler set up beforehand
    // For now, accept/dismiss the currently pending dialog
    if (!this._page) return { success: false, error: 'No browser page open' };
    try {
      this._page.once('dialog', async dialog => {
        if (accept) await dialog.accept(promptText || '');
        else await dialog.dismiss();
      });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Get console messages from the page.
   */
  async consoleMessages(level = 'info') {
    if (!this._page) return { success: false, error: 'No browser page open' };
    // Playwright doesn't store console messages by default — capture via CDP
    try {
      const messages = [];
      this._page.on('console', msg => messages.push({ type: msg.type(), text: msg.text() }));
      // Return empty — messages are captured asynchronously
      return { success: true, messages: [] };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Upload files to a file input element.
   */
  async fileUpload(ref, paths) {
    if (!this._page) return { success: false, error: 'No browser page open' };
    try {
      await this._page.setInputFiles(ref, paths);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Resize the browser viewport.
   */
  async resize(width, height) {
    if (!this._page) return { success: false, error: 'No browser page open' };
    try {
      await this._page.setViewportSize({ width, height });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Get the current URL and title.
   */
  async getUrl() {
    if (!this._page) return { success: false, error: 'No browser page open' };
    try {
      return { success: true, url: this._page.url(), title: await this._page.title() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Get all links from the page.
   */
  async getLinks(selector) {
    if (!this._page) return { success: false, error: 'No browser page open' };
    try {
      const container = selector ? this._page.locator(selector).first() : this._page;
      const links = await container.evaluate(el => {
        const root = el || document;
        return [...(root.querySelectorAll || document.querySelectorAll.bind(document))('a')]
          .slice(0, 100)
          .map(a => ({ href: a.href, text: a.textContent?.trim()?.slice(0, 100), title: a.title }));
      });
      return { success: true, links };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Scroll the page.
   */
  async scroll(direction, amount) {
    if (!this._page) return { success: false, error: 'No browser page open' };
    try {
      const pixels = (amount || 3) * 300;
      const dy = direction === 'up' ? -pixels : pixels;
      await this._page.evaluate(`window.scrollBy(0, ${dy})`);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Wait for text, selector, or time.
   */
  async waitFor(options = {}) {
    if (!this._page) return { success: false, error: 'No browser page open' };
    try {
      if (options.time) {
        const ms = Math.min(60000, Math.max(100, (options.time || 1) * 1000));
        await new Promise(r => setTimeout(r, ms));
        return { success: true, waited: ms };
      }
      if (options.text) {
        await this._page.waitForSelector(`text=${options.text}`, { timeout: 15000 });
        return { success: true };
      }
      if (options.textGone) {
        await this._page.waitForSelector(`text=${options.textGone}`, { state: 'hidden', timeout: 15000 });
        return { success: true };
      }
      if (options.selector) {
        await this._page.waitForSelector(options.selector, { timeout: 15000 });
        return { success: true };
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Close the browser (alias for closePlaywright, matches tool interface).
   */
  async close() {
    return this.closePlaywright();
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

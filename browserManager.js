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
    console.log('[BrowserManager] constructor START');
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
    this._refFrameMap = new Map(); // ref number → owning Playwright Frame
    console.log('[BrowserManager] constructor DONE');
  }

  /* ── Live Preview ──────────────────────────────────────── */

  /**
   * Start the live preview server for a project directory.
   * @param {string} rootPath — directory to serve
   * @returns {Promise<{ success: boolean, url?: string, port?: number, error?: string }>}
   */
  async startPreview(rootPath) {
    console.log(`[BrowserManager] startPreview START: rootPath=${rootPath}`);
    if (!this.liveServer) {
      console.warn('[BrowserManager] startPreview: no liveServer');
      return { success: false, error: 'Live server module not available' };
    }
    const result = await this.liveServer.start(rootPath);
    console.log(`[BrowserManager] startPreview: liveServer result success=${result.success}`);
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
    console.log('[BrowserManager] startPreview DONE');
    return result;
  }

  /**
   * Stop the live preview server.
   */
  async stopPreview() {
    console.log('[BrowserManager] stopPreview START');
    if (!this.liveServer) {
      console.warn('[BrowserManager] stopPreview: no liveServer');
      return { success: false, error: 'No live server' };
    }
    await this.liveServer.stop();
    this._previewUrl = null;
    this._previewPort = null;
    this._wsPort = null;
    this.emit('preview-stopped');
    if (this.parentWindow?.webContents) {
      this.parentWindow.webContents.send('preview-stopped');
    }
    console.log('[BrowserManager] stopPreview DONE');
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
    console.log(`[BrowserManager] navigate START: url=${url}`);
    const ok = await this._ensurePage();
    if (!ok) {
      console.warn('[BrowserManager] navigate: could not launch browser');
      return { success: false, error: 'Could not launch browser' };
    }
    if (this._page) {
      try {
        // Use page.goto() return value to get the HTTP response object
        console.log(`[BrowserManager] navigate: page.goto ${url}`);
        const response = await this._page.goto(url, { waitUntil: 'load', timeout: 90000 });
        // Wait for SPAs to render — load event fires after initial render,
        // but SPAs need extra time for JS-driven content
        try { await this._page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}); } catch {}
        // Brief pause for any post-networkidle JS rendering
        try { await this._page.waitForTimeout(500).catch(() => {}); } catch {}
        const finalUrl = this._page.url();
        const title = await this._page.title().catch(() => '');
        this._navHistory.push({ url: finalUrl, title, timestamp: Date.now(), action: 'navigate' });
        if (this._navHistory.length > 30) this._navHistory = this._navHistory.slice(-30);
        // Check HTTP status code from the navigation response (not title keywords)
        const httpStatus = response ? response.status() : 0;
        console.log(`[BrowserManager] navigate: httpStatus=${httpStatus}, finalUrl=${finalUrl}`);
        if (httpStatus >= 400) {
          const snapshot = await this.getSnapshot();
          const snapshotText = snapshot.success ? snapshot.text : '';
          console.warn(`[BrowserManager] navigate: HTTP error ${httpStatus}`);
          return {
            success: false,
            url: finalUrl,
            title,
            httpStatus,
            error: `HTTP ${httpStatus}: ${response?.statusText() || 'Error'}`,
            snapshot: snapshotText || undefined,
          };
        }
        // Auto-snapshot: include page content so the model can see what's on the page
        // without needing a separate browser_snapshot call
        const snapshot = await this.getSnapshot();
        if (snapshot.success) {
          console.log(`[BrowserManager] navigate DONE: success, url=${finalUrl}, snapshotLen=${snapshot.text?.length || 0}`);
          return { success: true, url: finalUrl, title, httpStatus, snapshot: snapshot.text };
        }
        console.log(`[BrowserManager] navigate DONE: success, url=${finalUrl}`);
        return { success: true, url: finalUrl, title, httpStatus };
      } catch (e) {
        console.error(`[BrowserManager] navigate ERROR: ${e.message}`);
        return { success: false, error: e.message };
      }
    }
    // No Playwright — send URL to frontend for iframe navigation
    if (this.parentWindow?.webContents) {
      this.parentWindow.webContents.send('preview-navigate', { url });
    }
    console.log('[BrowserManager] navigate: frontend-iframe fallback');
    return { success: true, url, method: 'frontend-iframe' };
  }

  /* ── Playwright Integration (optional) ─────────────────── */

  /**
   * Launch Playwright browser. Returns false if Playwright is not installed.
   */
  async launchPlaywright() {
    console.log('[BrowserManager] launchPlaywright START');
    if (this._browser && this._page) {
      // Verify the page is actually alive
      try { await this._page.evaluate(() => true); console.log('[BrowserManager] launchPlaywright: already alive'); return { success: true, message: 'Already launched' }; } catch {}
      // Page is dead — clean up and relaunch
      console.log('[BrowserManager] launchPlaywright: page dead, closing');
      await this.closePlaywright();
    }
    try {
      this._playwright = require('playwright');
    } catch {
      console.warn('[BrowserManager] launchPlaywright: Playwright not installed');
      return { success: false, error: 'Playwright not installed. Run: npm i playwright' };
    }
    try {
      this._browser = await this._playwright.chromium.launch({ headless: false });
      this._page = await this._browser.newPage();
      console.log('[BrowserManager] launchPlaywright: Chromium launched, new page created');
      // Register disconnect handler so we know when browser dies
      this._browser.on('disconnected', () => {
        console.log('[BrowserManager] Browser disconnected — clearing references');
        this._page = null;
        this._browser = null;
      });
      console.log('[BrowserManager] launchPlaywright DONE');
      return { success: true };
    } catch (e) {
      console.error(`[BrowserManager] launchPlaywright FAILED: ${e.message}`);
      return { success: false, error: `Failed to launch browser: ${e.message}` };
    }
  }

  /**
   * Ensure a live Playwright page exists. Auto-reconnects if the browser died.
   * @returns {Promise<boolean>} true if page is ready
   */
  async _ensurePage() {
    console.log('[BrowserManager] _ensurePage START');
    if (this._page) {
      try { await this._page.evaluate(() => true); console.log('[BrowserManager] _ensurePage: page alive'); return true; } catch {}
      // Page is dead — clear stale references
      console.log('[BrowserManager] _ensurePage: page dead, clearing refs');
      this._page = null;
      this._browser = null;
    }
    const result = await this.launchPlaywright();
    console.log(`[BrowserManager] _ensurePage DONE: success=${result.success}`);
    return result.success;
  }

  /**
   * Close Playwright browser.
   */
  async closePlaywright() {
    console.log('[BrowserManager] closePlaywright START');
    if (this._page) { try { await this._page.close(); } catch (e) { console.warn('[BrowserManager] closePlaywright page close failed:', e.message); } }
    if (this._browser) { try { await this._browser.close(); } catch (e) { console.warn('[BrowserManager] closePlaywright browser close failed:', e.message); } }
    this._page = null;
    this._browser = null;
    this._playwright = null;
    console.log('[BrowserManager] closePlaywright DONE');
    return { success: true };
  }

  /**
   * Take a screenshot of the current page.
   * @returns {Promise<{ success: boolean, screenshot?: string, error?: string }>}
   */
  async screenshot() {
    console.log('[BrowserManager] screenshot START');
    if (!(await this._ensurePage())) {
      console.warn('[BrowserManager] screenshot: no page');
      return { success: false, error: 'No browser page open' };
    }
    try {
      const buffer = await this._page.screenshot({ type: 'png' });
      const base64 = buffer.toString('base64');
      console.log(`[BrowserManager] screenshot DONE: ${base64.length} chars`);
      return { success: true, screenshot: base64 };
    } catch (e) {
      console.error(`[BrowserManager] screenshot ERROR: ${e.message}`);
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
        const isSubmit = (type === 'submit' && tag === 'input') || (tag === 'button' && el.form !== null && type !== 'button' && type !== 'reset');
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
        if (isSubmit) desc += ' [SUBMIT]';
        lines.push(desc);
      }
      const pageText = (document.body?.innerText || '').substring(0, 50000);

      // Extract visible text from same-origin iframes.
      // Many web apps render their main content inside iframes.
      // Without this, the snapshot only shows "<iframe>" elements and the model
      // cannot see or interact with the content.
      const iframeTexts = [];
      try {
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
          try {
            const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
            if (iframeDoc && iframeDoc.body) {
              const src = iframe.src || iframe.getAttribute('src') || '';
              const iframeText = (iframeDoc.body.innerText || '').trim();
              if (iframeText.length > 0) {
                const iframeInteractive = iframeDoc.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"]');
                const iframeElCount = iframeInteractive.length;
                iframeTexts.push(`--- iframe content (${iframeElCount} interactive elements, src="${src.substring(0, 120)}") ---\n${iframeText.substring(0, 20000)}`);
              }
            }
          } catch (e) {
            // Cross-origin iframe — cannot access content (CORS)
            const src = iframe.src || iframe.getAttribute('src') || '';
            if (src) iframeTexts.push(`--- iframe (cross-origin, cannot access content, src="${src.substring(0, 120)}") ---`);
          }
        }
      } catch {}

      const fullPageText = iframeTexts.length > 0
        ? pageText + '\n\n' + iframeTexts.join('\n\n')
        : pageText;

      return { elementList: lines.join('\n'), pageText: fullPageText };
    });
  }

  async getSnapshot() {
    console.log('[BrowserManager] getSnapshot START');
    if (!(await this._ensurePage())) {
      console.warn('[BrowserManager] getSnapshot: no page');
      return { success: false, error: 'No browser page open' };
    }
    try {
      const title = await this._page.title();
      const url = this._page.url();
      console.log(`[BrowserManager] getSnapshot: title=${title}, url=${url}`);

      // Inject data-ref attributes and build a numbered element list
      const snapshotData = await this._ensureRefs();

      // Build ref→frame map. Main frame refs are already numbered by _ensureRefs.
      // Now inject data-ref into child frames with CONTINUING ref numbers so the model
      // sees a single unified [ref=N] namespace across all frames.
      this._refFrameMap.clear();
      const mainFrameElementCount = snapshotData.elementList ? snapshotData.elementList.split('\n').length : 0;
      // All main frame refs map to the main frame
      const mainFrame = this._page.mainFrame();
      for (let i = 0; i < mainFrameElementCount; i++) {
        this._refFrameMap.set(i, mainFrame);
      }

      // Extract content from ALL frames (including cross-origin iframes).
      // Playwright's page.frames() bypasses CORS — it can read cross-origin frame content
      // that the DOM-level iframe extraction in _ensureRefs() cannot access.
      // This is critical for sites that render content in cross-origin iframes.
      let frameTexts = [];
      let iframeElementLines = []; // [ref=N] lines for iframe elements
      let nextRef = mainFrameElementCount; // continuing ref counter for iframe elements
      try {
        const frames = this._page.frames();
        for (const frame of frames) {
          if (frame === this._page.mainFrame()) continue; // skip main frame (already in snapshotData)
          const frameUrl = frame.url();
          try {
            const frameBody = await frame.evaluate((startRef) => {
              const body = document.body;
              if (!body) return { text: '', interactive: [], refLines: [], nextRef: startRef };
              const text = (body.innerText || '').trim();
              const interactive = [...document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="combobox"]')].map(el => {
                const tag = el.tagName.toLowerCase();
                const text = (el.textContent || '').trim().substring(0, 60);
                const href = el.href || '';
                const type = el.type || '';
                const name = el.name || el.id || '';
                const placeholder = el.placeholder || '';
                return `[${tag}${type ? ` type="${type}"` : ''}${name ? ` name="${name}"` : ''}${placeholder ? ` placeholder="${placeholder}"` : ''}${href ? ` href="${href.substring(0, 80)}"` : ''}] ${text}`;
              });
              // Inject data-ref attributes into iframe interactive elements with continuing refs
              const refLines = [];
              const allInteractive = [...document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="option"], [contenteditable]')].filter(el => {
                if (el.offsetParent !== null) return true;
                if (el.type === 'hidden') return false;
                const s = window.getComputedStyle(el);
                if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
                if (s.position === 'fixed' || s.position === 'sticky') return true;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
              });
              let refIdx = startRef;
              for (const el of allInteractive) {
                el.setAttribute('data-ref', String(refIdx));
                const tag = el.tagName.toLowerCase();
                const type = el.type || '';
                const name = el.name || el.id || '';
                const placeholder = el.placeholder || '';
                const value = el.value || '';
                const text2 = (el.textContent || '').trim().substring(0, 80);
                const href = el.href || '';
                const role = el.getAttribute('role') || '';
                const ariaLabel = el.getAttribute('aria-label') || '';
                let desc = `[ref=${refIdx}] <${tag}`;
                if (type) desc += ` type="${type}"`;
                if (name) desc += ` name="${name}"`;
                if (role) desc += ` role="${role}"`;
                if (ariaLabel) desc += ` aria-label="${ariaLabel}"`;
                if (placeholder) desc += ` placeholder="${placeholder}"`;
                if (value && type !== 'password') desc += ` value="${value.substring(0, 50)}"`;
                if (href) desc += ` href="${href.substring(0, 80)}"`;
                desc += '>';
                if (text2 && type !== 'password' && tag !== 'input') desc += ` ${text2}`;
                refLines.push(desc);
                refIdx++;
              }
              return { text, interactive, refLines, nextRef: refIdx };
            }, nextRef);
            // Store ref→frame mapping for each iframe element
            for (let r = nextRef; r < frameBody.nextRef; r++) {
              this._refFrameMap.set(r, frame);
            }
            nextRef = frameBody.nextRef;
            if (frameBody.refLines.length > 0) {
              iframeElementLines.push(...frameBody.refLines);
            }
            if (frameBody.text.length > 0 || frameBody.interactive.length > 0) {
              const parts = [];
              if (frameBody.interactive.length > 0) {
                parts.push(`Interactive elements in this frame:\n${frameBody.interactive.join('\n')}`);
              }
              if (frameBody.text.length > 0) {
                parts.push(`Frame text:\n${frameBody.text.substring(0, 15000)}`);
              }
              frameTexts.push(`--- iframe content (src="${frameUrl.substring(0, 120)}") ---\n${parts.join('\n\n')}`);
            }
          } catch (e) {
            // Frame may be detached or inaccessible
            if (frameUrl) frameTexts.push(`--- iframe (could not access content, src="${frameUrl.substring(0, 120)}") ---`);
          }
        }
      } catch {}

      // Merge iframe element lines into the main element list
      const fullElementList = iframeElementLines.length > 0
        ? snapshotData.elementList + '\n' + iframeElementLines.join('\n')
        : snapshotData.elementList;

      const fullPageText = frameTexts.length > 0
        ? snapshotData.pageText + '\n\n' + frameTexts.join('\n\n')
        : snapshotData.pageText;

      // Navigation history at TOP of snapshot — model reads top-down and needs
      // to see what it already did BEFORE choosing the next element to click.
      let historySection = '';
      if (this._navHistory.length > 0) {
        const recentHistory = this._navHistory.slice(-8);
        historySection = `Navigation history (DO NOT repeat these — move to NEXT step):\n`
          + recentHistory.map((h, i) => `${i + 1}. ${h.action}: ${h.url}${h.title ? ` (${h.title})` : ''}`).join('\n')
          + '\n\n';
      }

      const result = `${historySection}Page: ${title}\nURL: ${url}\n\nInteractive elements (use the [ref=N] number as the "ref" param, e.g. {"ref":"2"} or {"ref":"[ref=2]"}):\n${fullElementList}\n\nPage text:\n${fullPageText}`;
      this._lastSnapshotUrl = url;
      this._lastSnapshotTime = Date.now();
      // No total cap — the model needs the full snapshot to make correct decisions.
      // Truncation was the root cause of repeated wrong clicks (elements below the fold invisible).
      console.log(`[BrowserManager] getSnapshot DONE: elementCount=${fullElementList?.split('\n')?.length || 0}, textLen=${fullPageText?.length || 0}`);
      return { success: true, title, url, text: result };
    } catch (e) {
      console.error(`[BrowserManager] getSnapshot ERROR: ${e.message}`);
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
      return null;
    }
    const trimmed = ref.trim();

    // ─── All known ref formats that models output after seeing [ref=N] in snapshots ───
    // Every format resolves to [data-ref="N"] or [aria-ref="N"] which maps to the
    // data-ref attribute injected by _ensureRefs(). If a format isn't recognized,
    // it falls through to CSS selector validation below.

    // [ref=N] — exact format from snapshot output
    let m = trimmed.match(/^\[ref\s*=\s*(\d+)\]$/);
    if (m) return `[data-ref="${m[1]}"], [aria-ref="${m[1]}"]`;
    // [ref="N"] or [ref='N'] — quoted value variant
    m = trimmed.match(/^\[ref\s*=\s*["'](\d+)["']\]$/);
    if (m) return `[data-ref="${m[1]}"], [aria-ref="${m[1]}"]`;
    // [N] — bare bracket number (most common model drift from [ref=N])
    m = trimmed.match(/^\[(\d+)\]$/);
    if (m) return `[data-ref="${m[1]}"], [aria-ref="${m[1]}"]`;
    // ref=N — without brackets
    m = trimmed.match(/^ref=(\d+)$/);
    if (m) return `[data-ref="${m[1]}"], [aria-ref="${m[1]}"]`;
    // element[N] — some models wrap in "element"
    m = trimmed.match(/^element\[(\d+)\]$/i);
    if (m) return `[data-ref="${m[1]}"], [aria-ref="${m[1]}"]`;
    // #ref-N or #N — hash-prefixed
    m = trimmed.match(/^#ref-(\d+)$/i);
    if (m) return `[data-ref="${m[1]}"], [aria-ref="${m[1]}"]`;
    m = trimmed.match(/^#(\d+)$/);
    if (m) return `[data-ref="${m[1]}"], [aria-ref="${m[1]}"]`;
    // Bare number like "2"
    if (/^\d+$/.test(trimmed)) {
      return `[data-ref="${trimmed}"], [aria-ref="${trimmed}"]`;
    }
    // Non-numeric identifier like "username" — resolve as name/id/placeholder
    if (/^[a-zA-Z_][a-zA-Z0-9_\-]*$/.test(trimmed)) {
      return `[name="${trimmed}"], [id="${trimmed}"], [data-ref="${trimmed}"], [placeholder="${trimmed}"]`;
    }

    // ─── Fallback: treat as CSS selector, but validate first ───
    // If the selector is not valid CSS, returning it as-is causes querySelectorAll
    // syntax errors that the model cannot recover from, creating infinite loops.
    // We can't use document.querySelector in Node.js, so check for known-invalid patterns.
    // Valid CSS selectors: .class, #id, tag, [attr=val], :pseudo, tag.class, tag > child, etc.
    // Invalid: //xpath, >>> combinator, bare [N] (handled above), unbalanced brackets, etc.
    if (trimmed.startsWith('//') || trimmed.startsWith('..')) {
      // XPath — not supported by Playwright's CSS selector engine
      return null;
    }
    if (trimmed.includes('>>>')) {
      // Deprecated deep pierce combinator — not valid
      return null;
    }
    // Check for unbalanced brackets (e.g. "[2" or "ref=2]" without matching pair)
    const opens = (trimmed.match(/\[/g) || []).length;
    const closes = (trimmed.match(/\]/g) || []).length;
    if (opens !== closes) {
      return null;
    }
    // Check for unbalanced quotes
    const singleQuotes = (trimmed.match(/'/g) || []).length;
    const doubleQuotes = (trimmed.match(/"/g) || []).length;
    if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0) {
      return null;
    }
    // Looks like a valid CSS selector — pass through.
    // Playwright's try/catch in the calling method will handle any remaining edge cases
    // and the error message will be caught and returned to the model.
    return ref;
  }

  /**
   * Extract the numeric ref from a selector string (e.g. "[ref=5]" → 5, "3" → 3).
   * Returns null if the selector is not a ref-based selector.
   */
  _extractRefNumber(selector) {
    if (!selector || typeof selector !== 'string') return null;
    const trimmed = selector.trim();
    let m = trimmed.match(/^\[ref\s*=\s*(\d+)\]$/);
    if (m) return parseInt(m[1]);
    m = trimmed.match(/^\[(\d+)\]$/);
    if (m) return parseInt(m[1]);
    m = trimmed.match(/^ref=(\d+)$/);
    if (m) return parseInt(m[1]);
    if (/^\d+$/.test(trimmed)) return parseInt(trimmed);
    return null;
  }

  async click(selector) {
    console.log(`[BrowserManager] click START: selector=${selector}`);
    if (!(await this._ensurePage())) {
      console.warn('[BrowserManager] click: no page');
      return { success: false, error: 'No browser page open' };
    }
    // Re-inject data-ref attrs before resolving — they're lost on page navigation/reload
    await this._ensureRefs();

    // If this ref maps to a child frame, click directly in that frame.
    // This replaces the blind frame iteration fallback that mismatched element indices.
    const refNum = this._extractRefNumber(selector);
    if (refNum !== null && this._refFrameMap.has(refNum)) {
      const targetFrame = this._refFrameMap.get(refNum);
      // Verify the frame is still attached — after navigation, child frames
      // may be detached and using a stale frame reference throws.
      const currentFrames = this._page.frames();
      if (!currentFrames.includes(targetFrame)) {
        this._refFrameMap.delete(refNum);
        // Fall through to main page click logic
      } else {
        const refSelector = `[data-ref="${refNum}"]`;
        if (targetFrame !== this._page.mainFrame()) {
        // Element is in a child frame — click directly there
        try {
          const urlBefore = this._page.url();
          let clickedText = '';
          try {
            clickedText = await targetFrame.evaluate((sel) => {
              const el = document.querySelector(sel);
              return el ? (el.textContent || '').trim().substring(0, 60) : '';
            }, refSelector);
          } catch {}
          await targetFrame.click(refSelector, { timeout: 5000 });
          try { await this._page.waitForTimeout(800); } catch {}
          const urlAfter = this._page.url();
          const navigated = urlAfter !== urlBefore;
          const snapshot = await this.getSnapshot();
          const pageState = navigated
            ? 'PAGE NAVIGATED — you are now on a new page. Call browser_snapshot to see the new page before taking any action.'
            : 'SAME PAGE — the click succeeded but the URL did not change. The page may have updated (dialog opened, content changed, etc.). Use the snapshot below to see what changed.';
          console.log(`[BrowserManager] Clicked ref=${refNum} in child frame directly`);
          if (snapshot.success) {
            return { success: true, url: urlAfter, clicked: clickedText || selector, navigated, pageState, snapshot: snapshot.text };
          }
          return { success: true, url: urlAfter, clicked: clickedText || selector, navigated, pageState };
        } catch (frameErr) {
          console.warn(`[BrowserManager] Direct frame click failed for ref=${refNum}: ${frameErr.message}`);
          // Fall through to main page click logic below
        }
      }
    }
    }

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
        try {
          await newPage.waitForURL(url => url !== 'about:blank' && url !== '', { timeout: 10000 }).catch(() => {});
          await newPage.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
        } catch {}
        // Close all other tabs except the new one
        const context = this._page.context();
        const allPages = context.pages();
        for (const p of allPages) {
          if (p !== newPage) { try { await p.close(); } catch {} }
        }
        this._page = newPage;
        // Wait for new tab to fully load before snapshotting.
        // Without this, snapshot returns about:blank because the new tab
        // hasn't finished its redirect chain yet.
        try { await this._page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); } catch {}
        try { await this._page.waitForTimeout(1000); } catch {}
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
      // Clear page state messaging — tell the model exactly what happened
      // so it doesn't guess or retry the same action blindly
      const pageState = navigated
        ? 'PAGE NAVIGATED — you are now on a new page. Call browser_snapshot to see the new page before taking any action.'
        : 'SAME PAGE — the click succeeded but the URL did not change. The page may have updated (dialog opened, content changed, etc.). Use the snapshot below to see what changed.';
      if (snapshot.success) {
        console.log(`[BrowserManager] click DONE: success, url=${urlAfter}, navigated=${navigated}`);
        return { success: true, url: urlAfter, clicked: clickedText || selector, navigated, pageState, snapshot: snapshot.text };
      }
      console.log(`[BrowserManager] click DONE: success (no snapshot), url=${urlAfter}, navigated=${navigated}`);
      return { success: true, url: urlAfter, clicked: clickedText || selector, navigated, pageState };
    } catch (e) {
      console.error(`[BrowserManager] click ERROR: ${e.message}`);
      // If ref-based selector failed on main page, try finding the element in child frames.
      // Some sites render interactive content inside cross-origin iframes.
      // Playwright's page.frames() can access all frames regardless of origin.
      const refMatch = selector?.match?.(/^\[ref\s*=\s*(\d+)\]$/) || selector?.match?.(/^\[(\d+)\]$/) || (typeof selector === 'string' && /^\d+$/.test(selector.trim()) && [null, selector.trim()]);
      if (refMatch) {
        // First try JS click fallback on main page (existing logic)
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

        // Main page click failed — try clicking in child frames
        try {
          const frames = this._page.frames();
          for (const frame of frames) {
            if (frame === this._page.mainFrame()) continue; // already tried
            try {
              const frameResult = await frame.evaluate((i) => {
                const selectors = [
                  'input', 'button', 'a', 'select', 'textarea',
                  '[role="button"]', '[role="link"]', '[role="textbox"]',
                  '[role="combobox"]', '[role="checkbox"]', '[role="radio"]',
                  '[role="tab"]', '[role="menuitem"]', '[role="option"]',
                  '[contenteditable]', 'summary', 'details',
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
                if (all[i]) { const txt = (all[i].textContent || '').trim().substring(0, 60); all[i].click(); return { success: true, clicked: txt || `frame-element[${i}]`, frameUrl: location.href }; }
                return null;
              }, parseInt(refMatch[1]));
              if (frameResult?.success) {
                console.log(`[BrowserManager] Clicked element in frame: ${frameResult.frameUrl}`);
                try { await this._page.waitForTimeout(800); } catch {}
                const snapshot = await this.getSnapshot();
                return { success: true, url: this._page.url(), clicked: frameResult.clicked, navigated: false, snapshot: snapshot.success ? snapshot.text : undefined };
              }
            } catch (_) { /* frame not accessible */ }
          }
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

    // If this ref maps to a child frame, type directly in that frame.
    const refNum = this._extractRefNumber(ref);
    if (refNum !== null && this._refFrameMap.has(refNum)) {
      const targetFrame = this._refFrameMap.get(refNum);
      // Verify frame is still attached (same check as click())
      const currentFrames = this._page.frames();
      if (!currentFrames.includes(targetFrame)) {
        this._refFrameMap.delete(refNum);
        // Fall through to main page logic
      } else {
        const refSelector = `[data-ref="${refNum}"]`;
        if (targetFrame !== this._page.mainFrame()) {
        try {
          const locator = targetFrame.locator(refSelector).first();
          await locator.fill(text, { timeout: 5000 });
          if (options.submit) {
            await this._page.keyboard.press('Enter');
            try { await this._page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}); } catch {}
            try { await this._page.waitForTimeout(1000); } catch {}
            const snapshot = await this.getSnapshot();
            if (snapshot.success) return { success: true, url: this._page.url(), snapshot: snapshot.text };
          }
          console.log(`[BrowserManager] Typed into ref=${refNum} in child frame directly`);
          return { success: true };
        } catch (frameErr) {
          console.warn(`[BrowserManager] Direct frame type failed for ref=${refNum}: ${frameErr.message}`);
          // Fall through to main page logic below
        }
      }
    }
    }

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
      const refMatch = ref?.match?.(/^\[ref\s*=\s*(\d+)\]$/) || ref?.match?.(/^\[(\d+)\]$/) || (typeof ref === 'string' && /^\d+$/.test(ref.trim()) && [null, ref.trim()]);
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
    const failed = [];
    try {
      for (const field of fields) {
        const refVal = field.ref || field.selector;
        const resolved = this._resolveRef(refVal);
        if (!resolved) {
          failed.push(`ref "${refVal}" could not be resolved — call browser_snapshot first`);
          continue;
        }
        try {
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
        } catch (e) {
          failed.push(`ref "${refVal}": ${e.message}`);
        }
      }
      if (failed.length > 0 && failed.length === fields.length) {
        return { success: false, error: `All fields failed: ${failed.join('; ')}` };
      }
      if (failed.length > 0) {
        return { success: true, warnings: failed };
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

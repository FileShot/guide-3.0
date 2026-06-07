'use strict';

const { Builder, By, until } = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');
const { buildSnapshotInPage } = require('./snapshotScript');
const { extractRefNumber, resolveRef, isStaleRef, redactPathForLog } = require('./refUtils');
const { resolveGeckodriver, validateTorBrowserPath, DEFAULT_GECKODRIVER_VERSION } = require('./geckodriverResolver');
const { resolveTorBrowserExecutable } = require('./torBrowserResolver');
const { applyTorAutoConnectPrefs, ensureTorBootstrap, writeTorProfileDefaults } = require('./torBootstrap');

class TorBrowserBackend {
  constructor(options = {}) {
    this.userDataPath = options.userDataPath || null;
    this.parentWindow = options.parentWindow || null;
    this.engine = 'tor';
    this._driver = null;
    this._geckodriverPath = null;
    this._torBrowserPath = '';
    this._geckodriverOverride = '';
    this._verbose = false;
    this._snapshotGen = 0;
    this._refGenMap = new Map();
    this._pollTimer = null;
    this._pollIntervalMs = 400;
    this._launchError = null;
    this._torBootstrapped = false;
  }

  configure({ torBrowserPath, geckodriverPath, debugTorBrowser } = {}) {
    this._torBrowserPath = torBrowserPath || '';
    this._geckodriverOverride = geckodriverPath || '';
    this._verbose = !!debugTorBrowser;
  }

  getEngineName() {
    return 'tor';
  }

  _logVerbose(msg) {
    if (this._verbose) console.log(`[TorBrowserBackend] ${msg}`);
  }

  async _resolveDriverBinary() {
    const gecko = await resolveGeckodriver({
      userDataPath: this.userDataPath,
      torBrowserPath: this._torBrowserPath,
      geckodriverPath: this._geckodriverOverride,
    });
    if (!gecko.success) {
      return gecko;
    }
    this._geckodriverPath = gecko.path;
    return gecko;
  }

  async launch() {
    console.log('[TorBrowserBackend] launch START');
    let pathCheck = validateTorBrowserPath(this._torBrowserPath);
    if (!pathCheck.pathValid) {
      const resolved = await resolveTorBrowserExecutable({
        configuredPath: this._torBrowserPath,
        userDataPath: this.userDataPath,
        autoDownload: true,
      });
      if (resolved.success && resolved.path) {
        this._torBrowserPath = resolved.path;
        pathCheck = validateTorBrowserPath(this._torBrowserPath);
      }
    }
    if (!pathCheck.pathValid) {
      this._launchError = pathCheck.error;
      console.warn(`[TorBrowserBackend] launch FAILED: ${pathCheck.error}`);
      return {
        success: false,
        error: `${pathCheck.error || 'Tor Browser not available'}. guIDE auto-downloads Tor on first browse when online.`,
        diagnosticHint: 'See guide-main.log for [TorBrowserBackend] launch FAILED',
      };
    }

    const gecko = await this._resolveDriverBinary();
    if (!gecko.success) {
      this._launchError = gecko.error;
      console.warn(`[TorBrowserBackend] launch FAILED: geckodriver — ${gecko.error}`);
      return {
        success: false,
        error: `geckodriver unavailable: ${gecko.error}. Required geckodriver ${DEFAULT_GECKODRIVER_VERSION} for Tor Browser 15.x.`,
        diagnosticHint: 'See guide-main.log for [TorBrowserBackend] launch FAILED',
      };
    }

    if (this._driver) {
      try {
        await this._driver.getCurrentUrl();
        console.log('[TorBrowserBackend] launch DONE: reusing existing session');
        return { success: true, message: 'Already launched' };
      } catch {
        this._driver = null;
      }
    }

    const t0 = Date.now();
    try {
      writeTorProfileDefaults(this.userDataPath, pathCheck.normalizedPath);

      const service = new firefox.ServiceBuilder(gecko.path);
      const options = new firefox.Options();
      options.setBinary(pathCheck.normalizedPath);
      options.setPreference('browser.shell.checkDefaultBrowser', false);
      options.setPreference('dom.webnotifications.enabled', false);
      applyTorAutoConnectPrefs(options);

      this._driver = await new Builder()
        .forBrowser('firefox')
        .setFirefoxOptions(options)
        .setFirefoxService(service)
        .build();

      await this._driver.manage().setTimeouts({ pageLoad: 90000, script: 30000, implicit: 0 });
      await this._driver.manage().window().setRect({ width: 1280, height: 800 });

      const bootstrap = await this._ensureTorReady();
      if (!bootstrap.success) {
        this._launchError = bootstrap.error;
        try { await this._driver.quit(); } catch {}
        this._driver = null;
        console.warn(`[TorBrowserBackend] launch FAILED: ${bootstrap.error}`);
        return { success: false, error: bootstrap.error, diagnosticHint: 'See guide-main.log for Tor bootstrap timeout' };
      }

      console.log(`[TorBrowserBackend] launch DONE: tb=${redactPathForLog(pathCheck.normalizedPath)} geckodriver=${redactPathForLog(gecko.path)} ms=${Date.now() - t0}`);
      return { success: true };
    } catch (e) {
      this._launchError = e.message;
      this._driver = null;
      console.error(`[TorBrowserBackend] launch FAILED: ${e.message}`);
      return {
        success: false,
        error: `Failed to launch Tor Browser: ${e.message}`,
        diagnosticHint: 'See guide-main.log for [TorBrowserBackend] launch FAILED',
      };
    }
  }

  _emitAgentStatus(payload) {
    if (!this.parentWindow?.webContents) return;
    this.parentWindow.webContents.send('browser-agent-status', {
      url: payload.url,
      title: payload.title || '',
      message: payload.message || 'Tor Browser session active. Use browser_snapshot to analyze this page.',
      reason: payload.reason || '',
      engine: 'tor',
    });
  }

  _emitFrame(base64Png, url) {
    if (!this.parentWindow?.webContents || !base64Png) return;
    this.parentWindow.webContents.send('browser-frame', {
      data: base64Png,
      url: url || '',
      engine: 'tor',
    });
  }

  _startScreenshotPoll() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(async () => {
      if (!this._driver) return;
      try {
        const url = await this._driver.getCurrentUrl();
        const png = await this._driver.takeScreenshot();
        this._emitFrame(png, url);
        this._logVerbose(`screenshot poll: bytes=${png?.length || 0}`);
      } catch (e) {
        this._logVerbose(`screenshot poll error: ${e.message}`);
      }
    }, this._pollIntervalMs);
    console.log('[TorBrowserBackend] screenshot poll START');
  }

  _stopScreenshotPoll() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
      console.log('[TorBrowserBackend] screenshot poll STOP');
    }
  }

  async _ensureTorReady(force = false) {
    if (!this._driver) return { success: false, error: 'Tor Browser not launched' };
    if (this._torBootstrapped && !force) return { success: true };
    const bootstrap = await ensureTorBootstrap(this._driver, {
      log: (msg) => console.log(`[TorBrowserBackend] ${msg}`),
    });
    if (bootstrap.success) this._torBootstrapped = true;
    return bootstrap;
  }

  async _ensureDriver() {
    if (this._driver) {
      try {
        await this._driver.getCurrentUrl();
        const bootstrap = await this._ensureTorReady();
        if (!bootstrap.success) {
          this._torBootstrapped = false;
          return bootstrap;
        }
        return { success: true };
      } catch {
        this._driver = null;
        this._torBootstrapped = false;
      }
    }
    const launched = await this.launch();
    return launched;
  }

  _formatSnapshotText(title, url, snapshotData) {
    const header = `Page: ${title || '(no title)'}\nURL: ${url}\n\nInteractive elements:\n${snapshotData.elementList || '(none)'}\n\nPage text:\n${snapshotData.pageText || ''}`;
    return header.substring(0, 80000);
  }

  async getSnapshot() {
    console.log('[TorBrowserBackend] getSnapshot START');
    const ready = await this._ensureDriver();
    if (!ready.success) return ready;

    try {
      const title = await this._driver.getTitle();
      const url = await this._driver.getCurrentUrl();
      const snapshotData = await this._driver.executeScript(buildSnapshotInPage);
      this._snapshotGen++;
      this._refGenMap.clear();
      for (let i = 0; i < (snapshotData.refCount || 0); i++) {
        this._refGenMap.set(i, this._snapshotGen);
      }
      const text = this._formatSnapshotText(title, url, snapshotData);
      console.log(`[TorBrowserBackend] getSnapshot DONE: elements=${snapshotData.elementCount || 0} refs=${snapshotData.refCount || 0} textLen=${text.length}`);
      return { success: true, text, title, url };
    } catch (e) {
      console.error(`[TorBrowserBackend] getSnapshot FAILED: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  async navigate(url) {
    const t0 = Date.now();
    let logUrl = url;
    try {
      const host = new URL(url).hostname;
      logUrl = host.endsWith('.onion') ? '*.onion' : url;
    } catch {}
    console.log(`[TorBrowserBackend] navigate START: url=${logUrl}`);

    const ready = await this._ensureDriver();
    if (!ready.success) return ready;

    try {
      const bootstrap = await this._ensureTorReady();
      if (!bootstrap.success) return bootstrap;

      await this._driver.get(url);
      try {
        await this._driver.wait(until.elementLocated(By.css('body')), 15000);
      } catch {}
      await new Promise((r) => setTimeout(r, 800));

      const finalUrl = await this._driver.getCurrentUrl();
      const title = await this._driver.getTitle();
      this._startScreenshotPoll();
      this._emitAgentStatus({
        url: finalUrl,
        title,
        message: 'Tor Browser session active. Use browser_snapshot to analyze this page.',
        engine: 'tor',
      });

      const snapshot = await this.getSnapshot();
      const elapsed = Date.now() - t0;
      console.log(`[TorBrowserBackend] navigate DONE: ms=${elapsed} finalUrl=${finalUrl}`);
      if (snapshot.success) {
        return { success: true, url: finalUrl, title, snapshot: snapshot.text };
      }
      return { success: true, url: finalUrl, title };
    } catch (e) {
      if (/proxyConnectFailure|proxy/i.test(e.message)) {
        console.warn('[TorBrowserBackend] navigate: proxy error, retrying after Tor bootstrap');
        this._torBootstrapped = false;
        const retry = await this._ensureTorReady(true);
        if (retry.success) {
          try {
            await this._driver.get(url);
            const finalUrl = await this._driver.getCurrentUrl();
            const title = await this._driver.getTitle();
            this._startScreenshotPoll();
            const snapshot = await this.getSnapshot();
            return snapshot.success
              ? { success: true, url: finalUrl, title, snapshot: snapshot.text }
              : { success: true, url: finalUrl, title };
          } catch (retryErr) {
            console.error(`[TorBrowserBackend] navigate FAILED (retry): ${retryErr.message}`);
            return { success: false, error: retryErr.message, diagnosticHint: 'See guide-main.log for [TorBrowserBackend] navigate FAILED' };
          }
        }
      }
      console.error(`[TorBrowserBackend] navigate FAILED: ${e.message}`);
      return { success: false, error: e.message, diagnosticHint: 'See guide-main.log for [TorBrowserBackend] navigate FAILED' };
    }
  }

  async _findElement(ref) {
    const staleErr = isStaleRef(ref, this._refGenMap, this._snapshotGen);
    if (staleErr) throw new Error(staleErr);

    await this._driver.executeScript(buildSnapshotInPage);
    const resolved = resolveRef(ref);
    if (!resolved) {
      throw new Error(`Invalid element ref "${ref}". Use [ref=N] from browser_snapshot.`);
    }

    if (typeof resolved === 'string') {
      const num = extractRefNumber(ref);
      if (num !== null) {
        this._logVerbose(`findElement data-ref=${num}`);
        return this._driver.findElement(By.css(`[data-ref="${num}"]`));
      }
      return this._driver.findElement(By.css(resolved.split(',')[0].trim()));
    }
    if (resolved.type === 'xpath') {
      return this._driver.findElement(By.xpath(resolved.selector));
    }
    return this._driver.findElement(By.css(resolved.selector));
  }

  async click(ref) {
    console.log(`[TorBrowserBackend] click START: ref=${ref}`);
    const ready = await this._ensureDriver();
    if (!ready.success) return ready;
    try {
      const urlBefore = await this._driver.getCurrentUrl();
      const el = await this._findElement(ref);
      let clickedText = '';
      try {
        clickedText = (await el.getText()).trim().substring(0, 60);
      } catch {}
      await el.click();
      await new Promise((r) => setTimeout(r, 800));
      const urlAfter = await this._driver.getCurrentUrl();
      const snapshot = await this.getSnapshot();
      console.log(`[TorBrowserBackend] click DONE: ref=${ref}`);
      const base = {
        success: true,
        url: urlAfter,
        clicked: clickedText || ref,
        navigated: urlAfter !== urlBefore,
      };
      if (snapshot.success) base.snapshot = snapshot.text;
      return base;
    } catch (e) {
      if (/proxyConnectFailure|proxy/i.test(e.message)) {
        this._torBootstrapped = false;
        const retry = await this._ensureTorReady(true);
        if (retry.success) {
          try {
            const urlBefore = await this._driver.getCurrentUrl();
            const el = await this._findElement(ref);
            await el.click();
            await new Promise((r) => setTimeout(r, 800));
            const urlAfter = await this._driver.getCurrentUrl();
            const snapshot = await this.getSnapshot();
            return snapshot.success
              ? { success: true, url: urlAfter, clicked: ref, navigated: urlAfter !== urlBefore, snapshot: snapshot.text }
              : { success: true, url: urlAfter, clicked: ref, navigated: urlAfter !== urlBefore };
          } catch (retryErr) {
            console.error(`[TorBrowserBackend] click FAILED (retry): ref=${ref} ${retryErr.message}`);
            return { success: false, error: retryErr.message };
          }
        }
      }
      console.error(`[TorBrowserBackend] click FAILED: ref=${ref} ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  async type(ref, text, options = {}) {
    console.log(`[TorBrowserBackend] type START: ref=${ref} textLen=${String(text).length}`);
    const ready = await this._ensureDriver();
    if (!ready.success) return ready;
    try {
      const el = await this._findElement(ref);
      if (options.clear !== false) {
        try { await el.clear(); } catch {}
      }
      await el.sendKeys(String(text));
      if (options.submit) {
        await el.sendKeys('\n');
        await new Promise((r) => setTimeout(r, 800));
      }
      const snapshot = await this.getSnapshot();
      console.log('[TorBrowserBackend] type DONE');
      const result = { success: true };
      if (snapshot.success) result.snapshot = snapshot.text;
      return result;
    } catch (e) {
      console.error(`[TorBrowserBackend] type FAILED: ref=${ref} ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  async screenshot(options = {}) {
    console.log('[TorBrowserBackend] screenshot START');
    const ready = await this._ensureDriver();
    if (!ready.success) return ready;
    try {
      const png = await this._driver.takeScreenshot();
      console.log(`[TorBrowserBackend] screenshot DONE: bytes=${png?.length || 0}`);
      return { success: true, screenshot: png };
    } catch (e) {
      console.error(`[TorBrowserBackend] screenshot FAILED: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  async goBack() {
    const ready = await this._ensureDriver();
    if (!ready.success) return ready;
    try {
      await this._driver.navigate().back();
      await new Promise((r) => setTimeout(r, 500));
      const snapshot = await this.getSnapshot();
      return snapshot.success ? { success: true, snapshot: snapshot.text } : { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async pressKey(key) {
    const ready = await this._ensureDriver();
    if (!ready.success) return ready;
    try {
      const { Key } = require('selenium-webdriver');
      const keyMap = {
        Enter: Key.ENTER,
        Tab: Key.TAB,
        Escape: Key.ESCAPE,
        Backspace: Key.BACK_SPACE,
        ArrowDown: Key.ARROW_DOWN,
        ArrowUp: Key.ARROW_UP,
        ArrowLeft: Key.ARROW_LEFT,
        ArrowRight: Key.ARROW_RIGHT,
      };
      const mapped = keyMap[key] || key;
      await this._driver.actions().sendKeys(mapped).perform();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async evaluate(code) {
    const ready = await this._ensureDriver();
    if (!ready.success) return ready;
    try {
      const result = await this._driver.executeScript(code);
      return { success: true, result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async scroll(direction = 'down', amount = 400) {
    const ready = await this._ensureDriver();
    if (!ready.success) return ready;
    const delta = direction === 'up' ? -Math.abs(amount) : Math.abs(amount);
    try {
      await this._driver.executeScript((dy) => window.scrollBy(0, dy), delta);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async resize(width, height) {
    const ready = await this._ensureDriver();
    if (!ready.success) return ready;
    try {
      await this._driver.manage().window().setRect({ width, height });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async fillForm(fields) {
    const results = [];
    for (const field of fields || []) {
      const ref = field.ref || field.selector;
      const value = field.value ?? field.text ?? '';
      const r = await this.type(ref, value, { clear: true, submit: false });
      results.push(r);
      if (!r.success) return { success: false, error: r.error, results };
    }
    const snapshot = await this.getSnapshot();
    return snapshot.success ? { success: true, snapshot: snapshot.text, results } : { success: true, results };
  }

  async selectOption(ref, values) {
    const ready = await this._ensureDriver();
    if (!ready.success) return ready;
    try {
      const el = await this._findElement(ref);
      const val = Array.isArray(values) ? values[0] : values;
      await el.sendKeys(String(val));
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async getContent(selector) {
    const ready = await this._ensureDriver();
    if (!ready.success) return ready;
    try {
      const content = selector
        ? await this._driver.findElement(By.css(selector)).getText()
        : await this._driver.findElement(By.css('body')).getText();
      return { success: true, content };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async hover(ref) {
    const ready = await this._ensureDriver();
    if (!ready.success) return ready;
    try {
      const el = await this._findElement(ref);
      await this._driver.actions().move({ origin: el }).perform();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  _unsupported(method) {
    return { success: false, error: `${method} is not supported on Tor Browser backend yet` };
  }

  async drag() { return this._unsupported('browser_drag'); }
  async tabs() { return this._unsupported('browser_tabs'); }
  async handleDialog() { return this._unsupported('browser_handle_dialog'); }
  async consoleMessages() { return this._unsupported('browser_console_messages'); }
  async fileUpload() { return this._unsupported('browser_file_upload'); }
  async waitForSelector(selector) {
    const ready = await this._ensureDriver();
    if (!ready.success) return ready;
    try {
      await this._driver.wait(until.elementLocated(By.css(selector)), 15000);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async getUrl() {
    const ready = await this._ensureDriver();
    if (!ready.success) return ready;
    try {
      return { success: true, url: await this._driver.getCurrentUrl() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async close() {
    console.log('[TorBrowserBackend] teardown START');
    this._stopScreenshotPoll();
    if (this._driver) {
      try {
        await this._driver.quit();
      } catch (e) {
        console.warn(`[TorBrowserBackend] teardown quit error: ${e.message}`);
      }
      this._driver = null;
    }
    this._torBootstrapped = false;
    console.log('[TorBrowserBackend] teardown DONE');
    return { success: true };
  }

  getStatus() {
    return {
      engine: 'tor',
      active: !!this._driver,
      torBrowserPath: this._torBrowserPath,
      geckodriverPath: this._geckodriverPath,
      launchError: this._launchError,
    };
  }
}

module.exports = { TorBrowserBackend };

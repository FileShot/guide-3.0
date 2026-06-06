'use strict';

const { ChromiumBackend } = require('./ChromiumBackend');
const { TorBrowserBackend } = require('./TorBrowserBackend');
const { isOnionUrl, redactPathForLog } = require('./refUtils');
const { resolveGeckodriver, validateTorBrowserPath, DEFAULT_GECKODRIVER_VERSION } = require('./geckodriverResolver');
const { resolveTorBrowserExecutable } = require('./torBrowserResolver');

class BrowserRouter {
  constructor({ browserManager, userDataPath, parentWindow } = {}) {
    this._config = {
      browserEngine: 'chromium',
      torBrowserPath: '',
      geckodriverPath: '',
      debugTorBrowser: false,
    };
    this._activeEngine = null;
    this._chromium = new ChromiumBackend(browserManager);
    this._tor = new TorBrowserBackend({ userDataPath, parentWindow });
  }

  updateConfig(partial = {}, reason = 'settings_changed') {
    const prevEngine = this._config.browserEngine;
    this._config = {
      ...this._config,
      ...partial,
    };
    this._tor.configure({
      torBrowserPath: this._config.torBrowserPath,
      geckodriverPath: this._config.geckodriverPath,
      debugTorBrowser: this._config.debugTorBrowser,
    });

    if (partial.browserEngine !== undefined) {
      console.log(`[BrowserRouter] browserEngine=${this._config.browserEngine} (${redactPathForLog(this._config.torBrowserPath)})`);
    }
    if (partial.torBrowserPath !== undefined) {
      console.log(`[electron-main] torBrowserPath changed: ${redactPathForLog(partial.torBrowserPath)}`);
    }
    if (partial.geckodriverPath !== undefined && partial.geckodriverPath) {
      console.log(`[electron-main] geckodriverPath changed: ${redactPathForLog(partial.geckodriverPath)}`);
    }
    if (partial.debugTorBrowser !== undefined) {
      console.log(`[electron-main] debugTorBrowser=${!!partial.debugTorBrowser}`);
    }

    if (prevEngine !== this._config.browserEngine) {
      return this._switchEngine(prevEngine, this._config.browserEngine, reason);
    }
    return Promise.resolve({ success: true });
  }

  getConfig() {
    return { ...this._config };
  }

  getEngine() {
    return this._config.browserEngine || 'chromium';
  }

  getActiveBackend() {
    const engine = this.getEngine();
    if (engine === 'tor') return this._tor;
    return this._chromium;
  }

  async _switchEngine(fromEngine, toEngine, reason) {
    if (fromEngine === toEngine && this._activeEngine === toEngine) {
      return { success: true };
    }
    console.log(`[BrowserRouter] engine switch: ${fromEngine || 'none'} → ${toEngine} reason=${reason}`);
    if (this._activeEngine === 'chromium') {
      console.log('[BrowserRouter] teardown START engine=chromium');
      await this._chromium.close();
      console.log('[BrowserRouter] teardown DONE engine=chromium');
    } else if (this._activeEngine === 'tor') {
      console.log('[BrowserRouter] teardown START engine=tor');
      await this._tor.close();
      console.log('[BrowserRouter] teardown DONE engine=tor');
    }
    this._activeEngine = null;
    return { success: true };
  }

  async _resolveTorPath() {
    const resolved = await resolveTorBrowserExecutable({
      configuredPath: this._config.torBrowserPath,
      userDataPath: this._tor.userDataPath,
      autoDownload: true,
    });
    if (resolved.success && resolved.path) {
      this._tor.configure({
        torBrowserPath: resolved.path,
        geckodriverPath: this._config.geckodriverPath,
        debugTorBrowser: this._config.debugTorBrowser,
      });
      this._resolvedTorPath = resolved.path;
      this._resolvedTorSource = resolved.source;
    }
    return resolved;
  }

  async ensureBackend(reason = 'first_tool_call') {
    const engine = this.getEngine();
    console.log(`[BrowserRouter] engine selected: ${engine}`);

    if (engine === 'tor') {
      const resolved = await this._resolveTorPath();
      if (!resolved.success) {
        console.warn('[BrowserRouter] tor not configured: auto-resolve failed');
        return {
          success: false,
          error: resolved.error || 'Tor Browser is not available. guIDE will auto-download on first use when online — try again or check Settings → Browser.',
          diagnosticHint: resolved.diagnosticHint || 'See guide-main.log for [TorBrowserBackend] tor download FAILED',
        };
      }
    }

    if (this._activeEngine && this._activeEngine !== engine) {
      await this._switchEngine(this._activeEngine, engine, reason);
    }

    this._activeEngine = engine;
    const backend = this.getActiveBackend();

    const launch = await backend.launch();
    if (!launch.success) return launch;

    return { success: true, engine, backend };
  }

  validateNavigateUrl(url) {
    const engine = this.getEngine();
    if (isOnionUrl(url) && engine !== 'tor') {
      let host = url;
      try { host = new URL(url).hostname; } catch {}
      console.warn(`[BrowserRouter] blocked .onion on chromium engine urlHost=${host}`);
      return {
        ok: false,
        error: 'Switch Agent browser engine to Tor Browser in Settings to open .onion URLs.',
      };
    }
    return { ok: true };
  }

  logToolDispatch(toolName) {
    console.log(`[BrowserRouter] tool routed: ${toolName} engine=${this.getEngine()}`);
  }

  async validateTorStatus() {
    const resolved = await resolveTorBrowserExecutable({
      configuredPath: this._config.torBrowserPath,
      userDataPath: this._tor.userDataPath,
      autoDownload: false,
    });
    const torBrowserPath = resolved.path || this._config.torBrowserPath || '';
    const configured = !!(this._config.torBrowserPath || '').trim();
    const pathCheck = resolved.pathValid
      ? { pathValid: true, normalizedPath: torBrowserPath }
      : validateTorBrowserPath(torBrowserPath);
    let geckodriverReady = false;
    let geckodriverVersion = DEFAULT_GECKODRIVER_VERSION;
    let geckodriverPath = null;
    let error = pathCheck.pathValid ? null : (resolved.error || pathCheck.error);

    if (pathCheck.pathValid) {
      const gecko = await resolveGeckodriver({
        userDataPath: this._tor.userDataPath,
        torBrowserPath,
        geckodriverPath: this._config.geckodriverPath,
      });
      geckodriverReady = gecko.success;
      geckodriverPath = gecko.path || null;
      geckodriverVersion = gecko.version || DEFAULT_GECKODRIVER_VERSION;
      if (!gecko.success) error = gecko.error;
    }

    const autoReady = !configured && resolved.source === 'discovered';

    const result = {
      configured,
      pathValid: pathCheck.pathValid,
      geckodriverReady,
      tbVersion: 'Tor Browser (Firefox ESR)',
      geckodriverVersion,
      geckodriverPath,
      resolvedPath: torBrowserPath || null,
      source: resolved.source || (configured ? 'configured' : 'none'),
      autoDetected: autoReady,
      willAutoDownload: !pathCheck.pathValid && !configured,
      error,
      ready: pathCheck.pathValid && geckodriverReady,
    };
    console.log(`[electron-main] tor-browser-status: ${JSON.stringify({ ...result, geckodriverPath: redactPathForLog(geckodriverPath), resolvedPath: redactPathForLog(result.resolvedPath) })}`);
    return result;
  }

  async prewarmTor() {
    if (this.getEngine() !== 'tor') return { success: true, skipped: true };
    console.log('[BrowserRouter] tor prewarm START');
    const resolved = await this._resolveTorPath();
    if (!resolved.success) {
      console.warn(`[BrowserRouter] tor prewarm: ${resolved.error}`);
      return resolved;
    }
    const gecko = await resolveGeckodriver({
      userDataPath: this._tor.userDataPath,
      torBrowserPath: resolved.path,
      geckodriverPath: this._config.geckodriverPath,
    });
    console.log(`[BrowserRouter] tor prewarm DONE source=${resolved.source} geckodriver=${gecko.success}`);
    return { success: true, ...resolved, geckodriverReady: gecko.success };
  }

  async closeAll() {
    await this._chromium.close();
    await this._tor.close();
    this._activeEngine = null;
    return { success: true };
  }
}

module.exports = { BrowserRouter };

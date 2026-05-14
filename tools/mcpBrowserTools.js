'use strict';

// Browser automation methods — mixed onto MCPToolServer.prototype
// All methods use `this` to access playwrightBrowser, browserManager, projectPath

const path = require('path');

async function _browserNavigate(url) {
  if (!url) return { success: false, error: 'No URL provided' };

  // Clean URL
  url = String(url).trim().replace(/^['"]|['"]$/g, '');

  // Translate workspace URIs to real paths
  if (url.startsWith('file:///workspace/') && this.projectPath) {
    url = 'file:///' + path.join(this.projectPath, url.slice(18)).replace(/\\/g, '/');
  }

  // Block dangerous schemes
  const scheme = url.split(':')[0]?.toLowerCase();
  if (['javascript', 'data', 'ftp', 'vbscript'].includes(scheme)) {
    return { success: false, error: `Blocked scheme: ${scheme}` };
  }

  // SSRF guard — only block truly dangerous targets (metadata, link-local)
  // Allow private IPs and localhost since user-initiated browsing needs school/work networks
  try {
    const urlObj = new URL(url);
    const host = urlObj.hostname;
    if (/^169\.254\./.test(host)) {
      return { success: false, error: 'Blocked: link-local metadata endpoint' };
    }
  } catch {}

  // Auto-prepend https if no scheme
  if (!/^https?:\/\//i.test(url) && !url.startsWith('file://')) {
    url = 'https://' + url;
  }

  // Use browserManager (has Playwright integration with auto-launch)
  if (this.browserManager) {
    if (this.browserManager.parentWindow) {
      this.browserManager.parentWindow.webContents.send('show-viewport-browser');
    }
    // Auto-launch Playwright on first use so browser_snapshot and DOM tools work
    if (!this.browserManager._page) {
      await this.browserManager.launchPlaywright();
    }
    return this.browserManager.navigate(url);
  }
  // Legacy: external Playwright instance (if set)
  if (this.playwrightBrowser) {
    if (!this.playwrightBrowser.isLaunched?.()) await this.playwrightBrowser.launch?.();
    return this.playwrightBrowser.navigate(url);
  }
  return { success: false, error: 'No browser available' };
}

async function _browserClick(refStr, options = {}) {
  const browser = this._getBrowser();
  if (!browser) return { success: false, error: 'No browser available' };

  try {
    return await browser.click(refStr, options);
  } catch (err) {
    // If the ref is stale, tell the model to refresh — don't guess.
    if (err.message?.includes('stale') || err.message?.includes('resolved to') || err.message?.includes('not found')) {
      return { success: false, error: `Element ref "${refStr}" is no longer valid. The page may have changed. Call browser_snapshot to get fresh refs, then retry with the new ref.` };
    }
    return { success: false, error: err.message || `Click failed on ref ${refStr}` };
  }
}

async function _browserType(refStr, text, options = {}) {
  const browser = this._getBrowser();
  if (!browser) return { success: false, error: 'No browser available' };

  try {
    return await browser.type(refStr, text, options);
  } catch (err) {
    // If the ref is stale, tell the model to refresh — don't guess.
    if (err.message?.includes('stale') || err.message?.includes('resolved to') || err.message?.includes('not found')) {
      return { success: false, error: `Element ref "${refStr}" is no longer valid. The page may have changed. Call browser_snapshot to get fresh refs, then retry with the new ref.` };
    }
    return { success: false, error: err.message || `Type failed on ref ${refStr}` };
  }
}

async function _browserFillForm(fields) {
  const browser = this._getBrowser();
  if (!browser) return { success: false, error: 'No browser available' };
  // Normalize fields
  const normalized = Array.isArray(fields)
    ? fields.map(f => (typeof f === 'object' ? f : {}))
    : Object.entries(fields || {}).map(([ref, value]) => ({ ref, value }));
  return browser.fillForm(normalized);
}

async function _browserSelectOption(refStr, values) {
  const browser = this._getBrowser();
  if (!browser) return { success: false, error: 'No browser available' };
  return browser.selectOption(refStr, values);
}

async function _browserSnapshot() {
  const browser = this._getBrowser();
  if (!browser) return { success: false, error: 'No browser available' };
  return browser.getSnapshot();
}

async function _browserScreenshot(options = {}) {
  const browser = this._getBrowser();
  if (!browser) return { success: false, error: 'No browser available' };
  return browser.screenshot({ ...options, fullPage: options.fullPage ?? true });
}

async function _browserGetContent(selector, html = false) {
  const browser = this._getBrowser();
  if (!browser) return { success: false, error: 'No browser available' };
  return browser.getContent(selector, html);
}

async function _browserEvaluate(code, ref) {
  const browser = this._getBrowser();
  if (!browser) return { success: false, error: 'No browser available' };
  return browser.evaluate(code);
}

async function _browserBack() {
  const browser = this._getBrowser();
  if (!browser) return { success: false, error: 'No browser available' };
  return browser.goBack();
}

async function _browserPressKey(key) {
  const browser = this._getBrowser();
  if (!browser) return { success: false, error: 'No browser available' };
  return browser.pressKey(key);
}

async function _browserHover(refStr) {
  const browser = this._getBrowser();
  if (!browser) return { success: false, error: 'No browser available' };
  return browser.hover(refStr);
}

async function _browserDrag(startRef, endRef) {
  const browser = this._getBrowser();
  if (!browser) return { success: false, error: 'No browser available' };
  return browser.drag(startRef, endRef);
}

async function _browserTabs(action, index) {
  const browser = this._getBrowser();
  if (!browser) return { success: false, error: 'No browser available' };
  return browser.tabs(action, index);
}

async function _browserHandleDialog(accept, promptText) {
  const browser = this._getBrowser();
  if (!browser) return { success: false, error: 'No browser available' };
  return browser.handleDialog(accept, promptText);
}

async function _browserConsoleMessages(level) {
  const browser = this._getBrowser();
  if (!browser) return { success: false, error: 'No browser available' };
  return browser.consoleMessages(level);
}

async function _browserFileUpload(refStr, paths) {
  const browser = this._getBrowser();
  if (!browser) return { success: false, error: 'No browser available' };
  return browser.fileUpload(refStr, paths);
}

async function _browserResize(width, height) {
  const browser = this._getBrowser();
  if (!browser) return { success: false, error: 'No browser available' };
  return browser.resize(width, height);
}

async function _browserClose() {
  if (this.playwrightBrowser) {
    try { await this.playwrightBrowser.close(); } catch {}
  }
  if (this.browserManager) {
    try { await this.browserManager.closePlaywright(); } catch {}
  }
  return { success: true };
}

async function _browserWaitFor(options = {}) {
  const browser = this._getBrowser();
  if (!browser) return { success: false, error: 'No browser available' };

  if (options.time) {
    const ms = Math.min(60000, Math.max(100, (options.time || 1) * 1000));
    await new Promise(r => setTimeout(r, ms));
    return { success: true, waited: ms };
  }

  if (options.selector && browser.waitForSelector) return browser.waitForSelector(options.selector);
  return browser.waitFor ? browser.waitFor(options) : { success: true };
}

async function _browserScroll(direction, amount) {
  const browser = this._getBrowser();
  if (!browser) return { success: false, error: 'No browser available' };
  if (browser.scroll) return browser.scroll(direction, amount);
  const pixels = (amount || 3) * 300;
  const dy = direction === 'up' ? -pixels : pixels;
  return browser.evaluate(`window.scrollBy(0, ${dy})`);
}

async function _browserWait(ms = 2000) {
  ms = Math.min(30000, Math.max(100, ms));
  await new Promise(r => setTimeout(r, ms));
  return { success: true, waited: ms };
}

async function _browserGetUrl() {
  const browser = this._getBrowser();
  if (!browser) return { success: false, error: 'No browser available' };
  if (browser.getUrl) return browser.getUrl();
  return { success: false, error: 'Cannot get URL' };
}

async function _browserGetLinks(selector) {
  const browser = this._getBrowser();
  if (!browser) return { success: false, error: 'No browser available' };

  if (browser.getLinks) return browser.getLinks(selector);

  // Fallback: evaluate to extract links
  if (browser.evaluate) {
    const result = await browser.evaluate(`
      (() => {
        const container = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document'};
        if (!container) return { success: false, error: 'Selector not found' };
        const links = [...(container.querySelectorAll || document.querySelectorAll.bind(document))('a')]
          .slice(0, 100)
          .map(a => ({ href: a.href, text: a.textContent?.trim()?.slice(0, 100), title: a.title }));
        return { success: true, links };
      })()
    `);
    return result;
  }
  return { success: false, error: 'Cannot extract links' };
}

module.exports = {
  _browserNavigate, _browserClick, _browserType, _browserFillForm,
  _browserSelectOption, _browserSnapshot, _browserScreenshot, _browserGetContent,
  _browserEvaluate, _browserBack, _browserPressKey, _browserHover,
  _browserDrag, _browserTabs, _browserHandleDialog, _browserConsoleMessages,
  _browserFileUpload, _browserResize, _browserClose, _browserWaitFor,
  _browserScroll, _browserWait, _browserGetUrl, _browserGetLinks,
};

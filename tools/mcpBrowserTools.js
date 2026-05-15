'use strict';

// Browser automation methods — mixed onto MCPToolServer.prototype
// All methods use `this` to access playwrightBrowser, browserManager, projectPath

const path = require('path');

async function _browserNavigate(url) {
  console.log(`[mcpBrowserTools] _browserNavigate START: url=${url}`);
  if (!url) {
    console.warn('[mcpBrowserTools] _browserNavigate: no URL provided');
    return { success: false, error: 'No URL provided' };
  }

  // Clean URL
  url = String(url).trim().replace(/^['"]|['"]$/g, '');

  // Translate workspace URIs to real paths
  if (url.startsWith('file:///workspace/') && this.projectPath) {
    url = 'file:///' + path.join(this.projectPath, url.slice(18)).replace(/\\/g, '/');
  }

  // Block dangerous schemes
  const scheme = url.split(':')[0]?.toLowerCase();
  if (['javascript', 'data', 'ftp', 'vbscript'].includes(scheme)) {
    console.warn(`[mcpBrowserTools] _browserNavigate: blocked scheme ${scheme}`);
    return { success: false, error: `Blocked scheme: ${scheme}` };
  }

  // SSRF guard — only block truly dangerous targets (metadata, link-local)
  // Allow private IPs and localhost since user-initiated browsing needs school/work networks
  try {
    const urlObj = new URL(url);
    const host = urlObj.hostname;
    if (/^169\.254\./.test(host)) {
      console.warn('[mcpBrowserTools] _browserNavigate: blocked link-local');
      return { success: false, error: 'Blocked: link-local metadata endpoint' };
    }
  } catch {}

  // Auto-prepend https if no scheme
  if (!/^https?:\/\//i.test(url) && !url.startsWith('file://')) {
    url = 'https://' + url;
  }

  // Use browserManager (has Playwright integration with auto-launch)
  if (this.browserManager) {
    console.log('[mcpBrowserTools] _browserNavigate: using browserManager');
    if (this.browserManager.parentWindow) {
      this.browserManager.parentWindow.webContents.send('show-viewport-browser');
    }
    // Auto-launch Playwright on first use so browser_snapshot and DOM tools work
    if (!this.browserManager._page) {
      console.log('[mcpBrowserTools] _browserNavigate: auto-launching Playwright');
      await this.browserManager.launchPlaywright();
    }
    const result = await this.browserManager.navigate(url);
    console.log(`[mcpBrowserTools] _browserNavigate DONE: success=${result.success}, url=${result.url || '?'}`);
    return result;
  }
  // Legacy: external Playwright instance (if set)
  if (this.playwrightBrowser) {
    console.log('[mcpBrowserTools] _browserNavigate: using legacy playwrightBrowser');
    if (!this.playwrightBrowser.isLaunched?.()) await this.playwrightBrowser.launch?.();
    return this.playwrightBrowser.navigate(url);
  }
  console.warn('[mcpBrowserTools] _browserNavigate: no browser available');
  return { success: false, error: 'No browser available' };
}

async function _browserClick(refStr, options = {}) {
  console.log(`[mcpBrowserTools] _browserClick START: ref=${refStr}`);
  const browser = this._getBrowser();
  if (!browser) {
    console.warn('[mcpBrowserTools] _browserClick: no browser');
    return { success: false, error: 'No browser available' };
  }

  try {
    const result = await browser.click(refStr, options);
    console.log(`[mcpBrowserTools] _browserClick DONE: success=${result?.success}, clicked=${result?.clicked || '?'}`);
    return result;
  } catch (err) {
    console.error(`[mcpBrowserTools] _browserClick ERROR: ${err.message}`);
    // If the ref is stale, tell the model to refresh — don't guess.
    if (err.message?.includes('stale') || err.message?.includes('resolved to') || err.message?.includes('not found')) {
      return { success: false, error: `Element ref "${refStr}" is no longer valid. The page may have changed. Call browser_snapshot to get fresh refs, then retry with the new ref.` };
    }
    return { success: false, error: err.message || `Click failed on ref ${refStr}` };
  }
}

async function _browserType(refStr, text, options = {}) {
  console.log(`[mcpBrowserTools] _browserType START: ref=${refStr}, textLen=${String(text).length}`);
  const browser = this._getBrowser();
  if (!browser) {
    console.warn('[mcpBrowserTools] _browserType: no browser');
    return { success: false, error: 'No browser available' };
  }

  try {
    const result = await browser.type(refStr, text, options);
    console.log(`[mcpBrowserTools] _browserType DONE: success=${result?.success}`);
    return result;
  } catch (err) {
    console.error(`[mcpBrowserTools] _browserType ERROR: ${err.message}`);
    // If the ref is stale, tell the model to refresh — don't guess.
    if (err.message?.includes('stale') || err.message?.includes('resolved to') || err.message?.includes('not found')) {
      return { success: false, error: `Element ref "${refStr}" is no longer valid. The page may have changed. Call browser_snapshot to get fresh refs, then retry with the new ref.` };
    }
    return { success: false, error: err.message || `Type failed on ref ${refStr}` };
  }
}

async function _browserFillForm(fields) {
  console.log(`[mcpBrowserTools] _browserFillForm START: fieldCount=${Array.isArray(fields) ? fields.length : Object.keys(fields || {}).length}`);
  const browser = this._getBrowser();
  if (!browser) {
    console.warn('[mcpBrowserTools] _browserFillForm: no browser');
    return { success: false, error: 'No browser available' };
  }
  // Normalize fields
  const normalized = Array.isArray(fields)
    ? fields.map(f => (typeof f === 'object' ? f : {}))
    : Object.entries(fields || {}).map(([ref, value]) => ({ ref, value }));
  const result = await browser.fillForm(normalized);
  console.log(`[mcpBrowserTools] _browserFillForm DONE: success=${result?.success}`);
  return result;
}

async function _browserSelectOption(refStr, values) {
  console.log(`[mcpBrowserTools] _browserSelectOption START: ref=${refStr}`);
  const browser = this._getBrowser();
  if (!browser) {
    console.warn('[mcpBrowserTools] _browserSelectOption: no browser');
    return { success: false, error: 'No browser available' };
  }
  const result = await browser.selectOption(refStr, values);
  console.log(`[mcpBrowserTools] _browserSelectOption DONE: success=${result?.success}`);
  return result;
}

async function _browserSnapshot() {
  console.log('[mcpBrowserTools] _browserSnapshot START');
  const browser = this._getBrowser();
  if (!browser) {
    console.warn('[mcpBrowserTools] _browserSnapshot: no browser');
    return { success: false, error: 'No browser available' };
  }
  const result = await browser.getSnapshot();
  console.log(`[mcpBrowserTools] _browserSnapshot DONE: success=${result?.success}, textLen=${result?.text?.length || 0}`);
  return result;
}

async function _browserScreenshot(options = {}) {
  console.log(`[mcpBrowserTools] _browserScreenshot START: fullPage=${options.fullPage ?? true}`);
  const browser = this._getBrowser();
  if (!browser) {
    console.warn('[mcpBrowserTools] _browserScreenshot: no browser');
    return { success: false, error: 'No browser available' };
  }
  const result = await browser.screenshot({ ...options, fullPage: options.fullPage ?? true });
  console.log(`[mcpBrowserTools] _browserScreenshot DONE: success=${result?.success}, screenshotLen=${result?.screenshot?.length || 0}`);
  return result;
}

async function _browserGetContent(selector, html = false) {
  console.log(`[mcpBrowserTools] _browserGetContent START: selector=${selector}, html=${html}`);
  const browser = this._getBrowser();
  if (!browser) {
    console.warn('[mcpBrowserTools] _browserGetContent: no browser');
    return { success: false, error: 'No browser available' };
  }
  const result = await browser.getContent(selector, html);
  console.log(`[mcpBrowserTools] _browserGetContent DONE: success=${result?.success}, contentLen=${result?.content?.length || 0}`);
  return result;
}

async function _browserEvaluate(code, ref) {
  console.log(`[mcpBrowserTools] _browserEvaluate START: codeLen=${String(code).length}`);
  const browser = this._getBrowser();
  if (!browser) {
    console.warn('[mcpBrowserTools] _browserEvaluate: no browser');
    return { success: false, error: 'No browser available' };
  }
  const result = await browser.evaluate(code);
  console.log(`[mcpBrowserTools] _browserEvaluate DONE: success=${result?.success}`);
  return result;
}

async function _browserBack() {
  console.log('[mcpBrowserTools] _browserBack START');
  const browser = this._getBrowser();
  if (!browser) {
    console.warn('[mcpBrowserTools] _browserBack: no browser');
    return { success: false, error: 'No browser available' };
  }
  const result = await browser.goBack();
  console.log(`[mcpBrowserTools] _browserBack DONE: success=${result?.success}`);
  return result;
}

async function _browserPressKey(key) {
  console.log(`[mcpBrowserTools] _browserPressKey START: key=${key}`);
  const browser = this._getBrowser();
  if (!browser) {
    console.warn('[mcpBrowserTools] _browserPressKey: no browser');
    return { success: false, error: 'No browser available' };
  }
  const result = await browser.pressKey(key);
  console.log(`[mcpBrowserTools] _browserPressKey DONE: success=${result?.success}`);
  return result;
}

async function _browserHover(refStr) {
  console.log(`[mcpBrowserTools] _browserHover START: ref=${refStr}`);
  const browser = this._getBrowser();
  if (!browser) {
    console.warn('[mcpBrowserTools] _browserHover: no browser');
    return { success: false, error: 'No browser available' };
  }
  const result = await browser.hover(refStr);
  console.log(`[mcpBrowserTools] _browserHover DONE: success=${result?.success}`);
  return result;
}

async function _browserDrag(startRef, endRef) {
  console.log(`[mcpBrowserTools] _browserDrag START: startRef=${startRef}, endRef=${endRef}`);
  const browser = this._getBrowser();
  if (!browser) {
    console.warn('[mcpBrowserTools] _browserDrag: no browser');
    return { success: false, error: 'No browser available' };
  }
  const result = await browser.drag(startRef, endRef);
  console.log(`[mcpBrowserTools] _browserDrag DONE: success=${result?.success}`);
  return result;
}

async function _browserTabs(action, index) {
  console.log(`[mcpBrowserTools] _browserTabs START: action=${action}, index=${index}`);
  const browser = this._getBrowser();
  if (!browser) {
    console.warn('[mcpBrowserTools] _browserTabs: no browser');
    return { success: false, error: 'No browser available' };
  }
  const result = await browser.tabs(action, index);
  console.log(`[mcpBrowserTools] _browserTabs DONE: success=${result?.success}`);
  return result;
}

async function _browserHandleDialog(accept, promptText) {
  console.log(`[mcpBrowserTools] _browserHandleDialog START: accept=${accept}`);
  const browser = this._getBrowser();
  if (!browser) {
    console.warn('[mcpBrowserTools] _browserHandleDialog: no browser');
    return { success: false, error: 'No browser available' };
  }
  const result = await browser.handleDialog(accept, promptText);
  console.log(`[mcpBrowserTools] _browserHandleDialog DONE: success=${result?.success}`);
  return result;
}

async function _browserConsoleMessages(level) {
  console.log(`[mcpBrowserTools] _browserConsoleMessages START: level=${level}`);
  const browser = this._getBrowser();
  if (!browser) {
    console.warn('[mcpBrowserTools] _browserConsoleMessages: no browser');
    return { success: false, error: 'No browser available' };
  }
  const result = await browser.consoleMessages(level);
  console.log(`[mcpBrowserTools] _browserConsoleMessages DONE: success=${result?.success}, count=${result?.messages?.length || 0}`);
  return result;
}

async function _browserFileUpload(refStr, paths) {
  console.log(`[mcpBrowserTools] _browserFileUpload START: ref=${refStr}, paths=${Array.isArray(paths) ? paths.length : 0}`);
  const browser = this._getBrowser();
  if (!browser) {
    console.warn('[mcpBrowserTools] _browserFileUpload: no browser');
    return { success: false, error: 'No browser available' };
  }
  const result = await browser.fileUpload(refStr, paths);
  console.log(`[mcpBrowserTools] _browserFileUpload DONE: success=${result?.success}`);
  return result;
}

async function _browserResize(width, height) {
  console.log(`[mcpBrowserTools] _browserResize START: ${width}x${height}`);
  const browser = this._getBrowser();
  if (!browser) {
    console.warn('[mcpBrowserTools] _browserResize: no browser');
    return { success: false, error: 'No browser available' };
  }
  const result = await browser.resize(width, height);
  console.log(`[mcpBrowserTools] _browserResize DONE: success=${result?.success}`);
  return result;
}

async function _browserClose() {
  console.log('[mcpBrowserTools] _browserClose START');
  if (this.playwrightBrowser) {
    try { await this.playwrightBrowser.close(); } catch (e) { console.warn('[mcpBrowserTools] _browserClose legacy close failed:', e.message); }
  }
  if (this.browserManager) {
    try { await this.browserManager.closePlaywright(); } catch (e) { console.warn('[mcpBrowserTools] _browserClose browserManager close failed:', e.message); }
  }
  console.log('[mcpBrowserTools] _browserClose DONE');
  return { success: true };
}

async function _browserWaitFor(options = {}) {
  console.log(`[mcpBrowserTools] _browserWaitFor START: time=${options.time}, selector=${options.selector || 'none'}`);
  const browser = this._getBrowser();
  if (!browser) {
    console.warn('[mcpBrowserTools] _browserWaitFor: no browser');
    return { success: false, error: 'No browser available' };
  }

  if (options.time) {
    const ms = Math.min(60000, Math.max(100, (options.time || 1) * 1000));
    await new Promise(r => setTimeout(r, ms));
    console.log(`[mcpBrowserTools] _browserWaitFor DONE: waited ${ms}ms`);
    return { success: true, waited: ms };
  }

  if (options.selector && browser.waitForSelector) {
    const result = await browser.waitForSelector(options.selector);
    console.log(`[mcpBrowserTools] _browserWaitFor DONE: selector result success=${result?.success}`);
    return result;
  }
  const result = browser.waitFor ? await browser.waitFor(options) : { success: true };
  console.log(`[mcpBrowserTools] _browserWaitFor DONE: success=${result?.success}`);
  return result;
}

async function _browserScroll(direction, amount) {
  console.log(`[mcpBrowserTools] _browserScroll START: direction=${direction}, amount=${amount}`);
  const browser = this._getBrowser();
  if (!browser) {
    console.warn('[mcpBrowserTools] _browserScroll: no browser');
    return { success: false, error: 'No browser available' };
  }
  if (browser.scroll) {
    const result = await browser.scroll(direction, amount);
    console.log(`[mcpBrowserTools] _browserScroll DONE: success=${result?.success}`);
    return result;
  }
  const pixels = (amount || 3) * 300;
  const dy = direction === 'up' ? -pixels : pixels;
  const result = await browser.evaluate(`window.scrollBy(0, ${dy})`);
  console.log(`[mcpBrowserTools] _browserScroll DONE (eval): success=${result?.success}`);
  return result;
}

async function _browserWait(ms = 2000) {
  console.log(`[mcpBrowserTools] _browserWait START: ${ms}ms`);
  ms = Math.min(30000, Math.max(100, ms));
  await new Promise(r => setTimeout(r, ms));
  console.log(`[mcpBrowserTools] _browserWait DONE: waited ${ms}ms`);
  return { success: true, waited: ms };
}

async function _browserGetUrl() {
  console.log('[mcpBrowserTools] _browserGetUrl START');
  const browser = this._getBrowser();
  if (!browser) {
    console.warn('[mcpBrowserTools] _browserGetUrl: no browser');
    return { success: false, error: 'No browser available' };
  }
  if (browser.getUrl) {
    const result = await browser.getUrl();
    console.log(`[mcpBrowserTools] _browserGetUrl DONE: url=${result?.url || '?'}`);
    return result;
  }
  console.warn('[mcpBrowserTools] _browserGetUrl: getUrl not available');
  return { success: false, error: 'Cannot get URL' };
}

async function _browserGetLinks(selector) {
  console.log(`[mcpBrowserTools] _browserGetLinks START: selector=${selector || 'document'}`);
  const browser = this._getBrowser();
  if (!browser) {
    console.warn('[mcpBrowserTools] _browserGetLinks: no browser');
    return { success: false, error: 'No browser available' };
  }

  if (browser.getLinks) {
    const result = await browser.getLinks(selector);
    console.log(`[mcpBrowserTools] _browserGetLinks DONE: success=${result?.success}, linkCount=${result?.links?.length || 0}`);
    return result;
  }

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
    console.log(`[mcpBrowserTools] _browserGetLinks DONE (eval): success=${result?.success}, linkCount=${result?.links?.length || 0}`);
    return result;
  }
  console.warn('[mcpBrowserTools] _browserGetLinks: no getLinks or evaluate available');
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

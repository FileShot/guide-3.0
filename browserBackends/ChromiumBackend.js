'use strict';

/**
 * Thin delegate to existing BrowserManager (Playwright/Chromium).
 */
class ChromiumBackend {
  constructor(browserManager) {
    this._browserManager = browserManager;
    this.engine = 'chromium';
  }

  getEngineName() {
    return 'chromium';
  }

  async launch() {
    return this._browserManager.launchPlaywright();
  }

  async navigate(url) {
    return this._browserManager.navigate(url);
  }

  async getSnapshot() {
    return this._browserManager.getSnapshot();
  }

  async click(ref, options) {
    return this._browserManager.click(ref, options);
  }

  async type(ref, text, options) {
    return this._browserManager.type(ref, text, options);
  }

  async screenshot(options) {
    return this._browserManager.screenshot(options);
  }

  async fillForm(fields) {
    return this._browserManager.fillForm(fields);
  }

  async selectOption(ref, values) {
    return this._browserManager.selectOption(ref, values);
  }

  async getContent(selector, html) {
    return this._browserManager.getContent(selector, html);
  }

  async evaluate(code) {
    return this._browserManager.evaluate(code);
  }

  async goBack() {
    return this._browserManager.goBack();
  }

  async pressKey(key) {
    return this._browserManager.pressKey(key);
  }

  async hover(ref) {
    return this._browserManager.hover(ref);
  }

  async drag(startRef, endRef) {
    return this._browserManager.drag(startRef, endRef);
  }

  async tabs(action, index) {
    return this._browserManager.tabs(action, index);
  }

  async handleDialog(accept, promptText) {
    return this._browserManager.handleDialog(accept, promptText);
  }

  async consoleMessages(level) {
    return this._browserManager.consoleMessages(level);
  }

  async fileUpload(ref, paths) {
    return this._browserManager.fileUpload(ref, paths);
  }

  async resize(width, height) {
    return this._browserManager.resize(width, height);
  }

  async scroll(direction, amount) {
    return this._browserManager.scroll(direction, amount);
  }

  async waitForSelector(selector) {
    return this._browserManager.waitForSelector(selector);
  }

  async waitFor(options) {
    return this._browserManager.waitFor(options);
  }

  async close() {
    console.log('[ChromiumBackend] teardown START');
    await this._browserManager.closePlaywright();
    console.log('[ChromiumBackend] teardown DONE');
    return { success: true };
  }

  getStatus() {
    return {
      engine: 'chromium',
      active: !!(this._browserManager._page),
      url: this._browserManager._page?.url?.() || null,
    };
  }
}

module.exports = { ChromiumBackend };

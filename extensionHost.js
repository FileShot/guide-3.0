'use strict';

/**
 * guIDE Native Extension Host (Tier A) — executes extension main.js in isolated vm context.
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

class ExtensionHost extends EventEmitter {
  constructor(extensionManager) {
    super();
    this._extensionManager = extensionManager;
    this._contexts = new Map(); // extId -> { sandbox, api }
    this._commands = new Map(); // commandId -> { extId, handler }
  }

  /** Load and activate all enabled extensions */
  activateAll() {
    const exts = this._extensionManager.listExtensions?.() || [];
    for (const ext of exts) {
      if (ext.enabled !== false) this.activate(ext.id || ext.name, ext);
    }
  }

  activate(extId, manifest) {
    const mainPath = manifest.main || manifest.entry || 'main.js';
    const extDir = manifest.path || manifest.installPath;
    if (!extDir) return { success: false, error: 'No extension path' };

    const fullMain = path.join(extDir, mainPath);
    if (!fs.existsSync(fullMain)) return { success: false, error: `main.js not found: ${fullMain}` };

    const code = fs.readFileSync(fullMain, 'utf8');
    const api = this._createApi(extId, manifest);
    const sandbox = {
      module: { exports: {} },
      exports: {},
      require: (mod) => {
        if (mod === 'guide' || mod === 'guide-api') return api;
        throw new Error(`Extension require('${mod}') not allowed — use guide API only`);
      },
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    };
    sandbox.module.exports = sandbox.exports;

    try {
      vm.runInNewContext(code, sandbox, { filename: fullMain, timeout: 5000 });
      const activateFn = sandbox.module.exports.activate || sandbox.exports.activate;
      if (typeof activateFn === 'function') activateFn(api);
      this._contexts.set(extId, { sandbox, api, manifest });
      this.emit('activated', { extId });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  _createApi(extId, manifest) {
    const self = this;
    return {
      extensionId: extId,
      manifest,
      registerCommand(id, handler) {
        const fullId = `${extId}.${id}`;
        self._commands.set(fullId, { extId, handler });
        self.emit('commandRegistered', { id: fullId, extId });
      },
      registerTool(name, def) {
        self.emit('toolRegistered', { extId, name, def });
      },
      registerPanel(id, def) {
        self.emit('panelRegistered', { extId, id, def });
      },
      getSettings() {
        return {};
      },
    };
  }

  executeCommand(commandId, ...args) {
    const entry = this._commands.get(commandId);
    if (!entry?.handler) return { success: false, error: 'Command not found' };
    try {
      const result = entry.handler(...args);
      return { success: true, result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  listCommands() {
    return [...this._commands.entries()].map(([id, entry]) => ({
      id,
      extId: entry.extId,
      label: id.includes('.') ? id.split('.').slice(1).join('.') : id,
    }));
  }

  deactivate(extId) {
    const ctx = this._contexts.get(extId);
    if (ctx) {
      const deactivateFn = ctx.sandbox.module.exports?.deactivate;
      if (typeof deactivateFn === 'function') {
        try { deactivateFn(); } catch (_) {}
      }
    }
    for (const [cmdId, entry] of this._commands) {
      if (entry.extId === extId) this._commands.delete(cmdId);
    }
    this._contexts.delete(extId);
  }
}

module.exports = { ExtensionHost };

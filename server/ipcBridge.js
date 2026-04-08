/**
 * IPC Bridge — Replaces Electron's ipcMain and BrowserWindow for non-Electron environments.
 *
 * The existing pipeline code (agenticChat.js, streamHandler.js, mcpToolServer.js, etc.)
 * was written for Electron and calls:
 *   - ipcMain.handle(channel, handler)  — to register request handlers
 *   - mainWindow.webContents.send(event, data)  — to push events to the frontend
 *   - mainWindow.isDestroyed()  — to check if the window is still alive
 *
 * This module provides drop-in replacements that route everything over WebSocket.
 * The pipeline code does not need to know it's not running in Electron.
 *
 * Architecture:
 *   Frontend → WebSocket message {type:'invoke', channel, args} → ipcBridge
 *   ipcBridge calls the registered handler → returns result via WebSocket
 *   Pipeline calls mainWindow.webContents.send(event, data) → ipcBridge
 *   ipcBridge sends {type:'event', event, data} over WebSocket → Frontend
 */
'use strict';

const { EventEmitter } = require('events');

/**
 * Fake ipcMain — drop-in replacement for Electron's ipcMain.
 * Stores handler functions registered by agenticChat.js and other modules.
 * When a WebSocket message arrives with type:'invoke', the corresponding handler is called.
 */
class IpcMainBridge extends EventEmitter {
  constructor() {
    super();
    this._handlers = new Map();    // channel → async handler(event, ...args)
    this._onListeners = new Map(); // channel → [handler, ...]
  }

  /**
   * Register a handler for an IPC channel (replaces ipcMain.handle).
   * The handler receives (event, ...args) and returns a result.
   */
  handle(channel, handler) {
    this._handlers.set(channel, handler);
  }

  /**
   * Remove a handler (replaces ipcMain.removeHandler).
   */
  removeHandler(channel) {
    this._handlers.delete(channel);
  }

  /**
   * Register a listener for an IPC channel (replaces ipcMain.on).
   */
  on(channel, handler) {
    if (!this._onListeners.has(channel)) {
      this._onListeners.set(channel, []);
    }
    this._onListeners.get(channel).push(handler);
    return this;
  }

  /**
   * Invoke a registered handler. Called when a WebSocket message arrives.
   * @param {string} channel — The IPC channel name (e.g. 'ai-chat')
   * @param  {...any} args — Arguments from the frontend
   * @returns {Promise<any>} — The handler's return value
   */
  async invoke(channel, ...args) {
    const handler = this._handlers.get(channel);
    if (!handler) {
      throw new Error(`No handler registered for IPC channel: ${channel}`);
    }
    // Create a fake event object (Electron passes this as the first arg)
    const fakeEvent = { sender: null, returnValue: undefined };
    return handler(fakeEvent, ...args);
  }

  /**
   * Emit to on() listeners. Called for fire-and-forget messages.
   */
  send(channel, ...args) {
    const listeners = this._onListeners.get(channel);
    if (listeners) {
      const fakeEvent = { sender: null };
      for (const handler of listeners) {
        try { handler(fakeEvent, ...args); } catch (e) {
          console.error(`[IpcBridge] Error in on('${channel}') listener:`, e.message);
        }
      }
    }
  }
}

/**
 * Fake BrowserWindow.webContents — drop-in replacement for Electron's mainWindow.
 *
 * The pipeline calls mainWindow.webContents.send(event, data) to push streaming
 * tokens, tool progress, context usage, and other events to the frontend.
 * This replacement routes those calls over WebSocket.
 */
class MainWindowBridge {
  constructor() {
    this._destroyed = false;
    this._wsSender = null; // Set by transport when a client connects
    this._hasEverConnected = false; // Suppress warnings before first client connects
    this.webContents = {
      send: (event, data) => {
        if (this._destroyed) return;
        this._sendToFrontend(event, data);
      },
      isDestroyed: () => this._destroyed,
    };
  }

  /**
   * Set the WebSocket sender function.
   * Called by the transport layer when a client connects.
   * @param {Function} sender — (event, data) => void
   */
  setSender(sender) {
    this._wsSender = sender;
    this._destroyed = false;
    this._hasEverConnected = true;
  }

  /**
   * Clear the sender (client disconnected).
   */
  clearSender() {
    this._wsSender = null;
  }

  /**
   * Check if the window is destroyed (client disconnected).
   */
  isDestroyed() {
    return this._destroyed || !this._wsSender;
  }

  /**
   * Internal: send an event to the frontend via WebSocket.
   */
  _sendToFrontend(event, data) {
    if (!this._wsSender) {
      // Only warn if we previously had a connection (lost connection = real problem).
      // Before first connection, this is expected (model auto-load fires before WebSocket connects).
      if (this._hasEverConnected && event !== 'llm-token' && event !== 'llm-thinking-token' && event !== 'context-usage') {
        console.warn(`[MainWindowBridge] _sendToFrontend: no sender for event '${event}' — dropped`);
      }
      return;
    }
    try {
      this._wsSender(event, data);
    } catch (e) {
      // WebSocket may be closed — don't crash the pipeline
      if (e.message?.includes('CLOSED') || e.message?.includes('not open')) {
        this._wsSender = null;
      }
    }
  }

  /**
   * Destroy the window bridge (cleanup).
   */
  destroy() {
    this._destroyed = true;
    this._wsSender = null;
  }
}

/**
 * Fake Electron app module — provides getPath() for pathValidator.js and other modules.
 * Returns OS-appropriate paths without requiring Electron.
 */
function createAppBridge(userDataPath) {
  const os = require('os');
  const path = require('path');

  const homedir = os.homedir();
  const appData = process.env.APPDATA || path.join(homedir, '.config');
  const userData = userDataPath || path.join(appData, 'guide-ide');
  const documents = path.join(homedir, 'Documents');
  const desktop = path.join(homedir, 'Desktop');
  const downloads = path.join(homedir, 'Downloads');
  const temp = os.tmpdir();

  const pathMap = {
    home: homedir,
    appData: appData,
    userData: userData,
    documents: documents,
    desktop: desktop,
    downloads: downloads,
    temp: temp,
    logs: path.join(userData, 'logs'),
    crashDumps: path.join(userData, 'crashes'),
  };

  return {
    getPath: (name) => {
      const p = pathMap[name];
      if (!p) {
        console.warn(`[AppBridge] Unknown path name: ${name}, returning userData`);
        return userData;
      }
      return p;
    },
    getName: () => 'guide-ide',
    getVersion: () => '2.0.0',
    isPackaged: false,
    quit: () => process.exit(0),
  };
}

module.exports = { IpcMainBridge, MainWindowBridge, createAppBridge };

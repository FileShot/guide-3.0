/**
 * guIDE 2.0 — Auto-Updater
 *
 * Wraps electron-updater for automatic update checking, downloading,
 * and installation. Falls back gracefully when electron-updater is
 * not installed (dev mode, web-only mode).
 *
 * Usage:
 *   const updater = new AutoUpdater(mainWindow);
 *   updater.checkForUpdates();
 *   updater.registerIPC();      // Electron IPC handlers
 *   updater.registerRoutes(app); // Express API for web UI fallback
 */
'use strict';

const EventEmitter = require('events');

class AutoUpdater extends EventEmitter {
  /**
   * @param {Electron.BrowserWindow | null} mainWindow
   * @param {{ feedUrl?: string, autoDownload?: boolean, autoInstallOnAppQuit?: boolean }} opts
   */
  constructor(mainWindow, opts) {
    super();
    this._mainWindow = mainWindow;
    this._autoUpdater = null;
    this._available = false;
    this._status = 'idle'; // idle | checking | available | downloading | downloaded | error
    this._updateInfo = null;
    this._progress = null;
    this._error = null;

    this._init(opts || {});
  }

  _init(opts) {
    try {
      const { autoUpdater } = require('electron-updater');
      this._autoUpdater = autoUpdater;
      this._available = true;

      // Configure
      autoUpdater.autoDownload = opts.autoDownload !== undefined ? opts.autoDownload : false;
      autoUpdater.autoInstallOnAppQuit = opts.autoInstallOnAppQuit !== undefined ? opts.autoInstallOnAppQuit : true;
      autoUpdater.allowDowngrade = false;

      if (opts.feedUrl) {
        autoUpdater.setFeedURL(opts.feedUrl);
      }

      // Wire events
      autoUpdater.on('checking-for-update', () => {
        this._status = 'checking';
        this._sendToRenderer('update-status', { status: 'checking' });
        this.emit('checking');
      });

      autoUpdater.on('update-available', (info) => {
        this._status = 'available';
        this._updateInfo = info;
        this._sendToRenderer('update-status', { status: 'available', info });
        this.emit('available', info);
      });

      autoUpdater.on('update-not-available', (info) => {
        this._status = 'idle';
        this._updateInfo = null;
        this._sendToRenderer('update-status', { status: 'up-to-date', info });
        this.emit('up-to-date', info);
      });

      autoUpdater.on('download-progress', (progress) => {
        this._status = 'downloading';
        this._progress = progress;
        this._sendToRenderer('update-status', {
          status: 'downloading',
          progress: {
            percent: Math.round(progress.percent),
            transferred: progress.transferred,
            total: progress.total,
            bytesPerSecond: progress.bytesPerSecond,
          },
        });
        this.emit('progress', progress);
      });

      autoUpdater.on('update-downloaded', (info) => {
        this._status = 'downloaded';
        this._updateInfo = info;
        this._progress = null;
        this._sendToRenderer('update-status', { status: 'downloaded', info });
        this.emit('downloaded', info);
      });

      autoUpdater.on('error', (err) => {
        this._status = 'error';
        this._error = err.message;
        this._sendToRenderer('update-status', { status: 'error', error: err.message });
        this.emit('error', err);
      });

    } catch {
      // electron-updater not installed (dev mode or web-only)
      this._available = false;
      console.log('[AutoUpdater] electron-updater not available — updates disabled');
    }
  }

  _sendToRenderer(channel, data) {
    try {
      if (this._mainWindow && !this._mainWindow.isDestroyed()) {
        this._mainWindow.webContents.send(channel, data);
      }
    } catch {
      // Window may have been closed
    }
  }

  /** Check for updates. No-op if electron-updater is not available. */
  checkForUpdates() {
    if (!this._available || !this._autoUpdater) return;
    this._autoUpdater.checkForUpdates().catch((err) => {
      this._status = 'error';
      this._error = err.message;
    });
  }

  /** Download an available update. */
  downloadUpdate() {
    if (!this._available || !this._autoUpdater) return;
    this._autoUpdater.downloadUpdate().catch((err) => {
      this._status = 'error';
      this._error = err.message;
    });
  }

  /** Quit and install the downloaded update. */
  quitAndInstall() {
    if (!this._available || !this._autoUpdater) return;
    this._autoUpdater.quitAndInstall();
  }

  /** Get current updater state. */
  getStatus() {
    return {
      available: this._available,
      status: this._status,
      updateInfo: this._updateInfo,
      progress: this._progress,
      error: this._error,
    };
  }

  /**
   * Register Electron IPC handlers.
   * @param {Electron.IpcMain} ipcMain
   */
  registerIPC(ipcMain) {
    ipcMain.handle('updater-check', () => {
      this.checkForUpdates();
      return this.getStatus();
    });

    ipcMain.handle('updater-download', () => {
      this.downloadUpdate();
      return { ok: true };
    });

    ipcMain.handle('updater-install', () => {
      this.quitAndInstall();
      return { ok: true };
    });

    ipcMain.handle('updater-status', () => {
      return this.getStatus();
    });
  }

  /**
   * Register Express API routes (fallback for web UI when not running in Electron).
   * @param {import('express').Application} app
   */
  registerRoutes(app) {
    app.get('/api/updater/status', (req, res) => {
      res.json(this.getStatus());
    });

    app.post('/api/updater/check', (req, res) => {
      this.checkForUpdates();
      res.json({ triggered: true, status: this._status });
    });

    app.post('/api/updater/download', (req, res) => {
      this.downloadUpdate();
      res.json({ triggered: true });
    });

    app.post('/api/updater/install', (req, res) => {
      this.quitAndInstall();
      res.json({ triggered: true });
    });
  }
}

module.exports = { AutoUpdater };

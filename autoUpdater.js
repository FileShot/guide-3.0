/**
 * guIDE — Auto-Updater
 *
 * Wraps electron-updater for automatic update checking, downloading,
 * and installation. Falls back gracefully when electron-updater is
 * not installed (dev mode, web-only mode).
 */
'use strict';

const EventEmitter = require('events');
const { getInstallVariant, getUpdateChannel, getGithubFeedConfig } = require('./updateVariant');

class AutoUpdater extends EventEmitter {
  /**
   * @param {Electron.BrowserWindow | null} mainWindow
   * @param {{ feedUrl?: object, autoDownload?: boolean, autoInstallOnAppQuit?: boolean, channel?: string|null }} opts
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
    this._periodicTimer = null;
    this._periodicHours = 0;
    this._autoDownload = opts.autoDownload !== undefined ? opts.autoDownload : true;
    this._channel = opts.channel !== undefined ? opts.channel : getUpdateChannel();
    this._installVariant = getInstallVariant();

    this._init(opts || {});
  }

  _init(opts) {
    try {
      const { autoUpdater } = require('electron-updater');
      this._autoUpdater = autoUpdater;
      this._available = true;

      autoUpdater.autoDownload = this._autoDownload;
      autoUpdater.autoInstallOnAppQuit = opts.autoInstallOnAppQuit !== undefined ? opts.autoInstallOnAppQuit : false;
      autoUpdater.allowDowngrade = false;

      if (this._channel) {
        autoUpdater.channel = this._channel;
      }

      const feed = opts.feedUrl || getGithubFeedConfig();
      autoUpdater.setFeedURL(feed);

      autoUpdater.on('checking-for-update', () => {
        this._status = 'checking';
        this._error = null;
        this._sendStatus();
        this.emit('checking');
      });

      autoUpdater.on('update-available', (info) => {
        this._status = 'available';
        this._updateInfo = info;
        this._sendStatus();
        this.emit('available', info);
        if (this._autoDownload) {
          this.downloadUpdate();
        }
      });

      autoUpdater.on('update-not-available', (info) => {
        this._status = 'idle';
        this._updateInfo = info;
        this._sendStatus({ status: 'up-to-date' });
        this.emit('up-to-date', info);
      });

      autoUpdater.on('download-progress', (progress) => {
        this._status = 'downloading';
        this._progress = progress;
        this._sendStatus({
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
        this._sendStatus();
        this.emit('downloaded', info);
      });

      autoUpdater.on('error', (err) => {
        this._handleError(err?.message || String(err));
      });

      console.log(`[AutoUpdater] ready variant=${this._installVariant} channel=${this._channel || 'default'}`);
    } catch {
      this._available = false;
      console.log('[AutoUpdater] electron-updater not available — updates disabled');
    }
  }

  _handleError(message) {
    this._status = 'error';
    this._error = message;
    this._sendStatus({ error: message });
    this.emit('error', new Error(message));
  }

  _sendStatus(overrides = {}) {
    const payload = {
      status: overrides.status || this._status,
      info: overrides.info !== undefined ? overrides.info : this._updateInfo,
      progress: overrides.progress !== undefined ? overrides.progress : (
        this._progress ? {
          percent: Math.round(this._progress.percent),
          transferred: this._progress.transferred,
          total: this._progress.total,
          bytesPerSecond: this._progress.bytesPerSecond,
        } : null
      ),
      error: overrides.error !== undefined ? overrides.error : this._error,
      available: this._available,
      channel: this._channel,
      installVariant: this._installVariant,
    };
    this._sendToRenderer('update-status', payload);
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
      this._handleError(err.message);
    });
  }

  /** Download an available update. */
  downloadUpdate() {
    if (!this._available || !this._autoUpdater) return;
    this._autoUpdater.downloadUpdate().catch((err) => {
      this._handleError(err.message);
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
      progress: this._progress ? {
        percent: Math.round(this._progress.percent),
        transferred: this._progress.transferred,
        total: this._progress.total,
        bytesPerSecond: this._progress.bytesPerSecond,
      } : null,
      error: this._error,
      periodicCheckHours: this._periodicHours,
      channel: this._channel,
      installVariant: this._installVariant,
    };
  }

  /**
   * Schedule a periodic background check.
   * @param {number} hours - check interval in hours. 0 disables.
   */
  startPeriodicCheck(hours) {
    this.stopPeriodicCheck();
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0) {
      this._periodicHours = 0;
      return;
    }
    this._periodicHours = Math.max(1, Math.floor(h));
    const intervalMs = this._periodicHours * 60 * 60 * 1000;
    this._periodicTimer = setInterval(() => {
      try { this.checkForUpdates(); }
      catch (e) { console.warn('[AutoUpdater] periodic check failed:', e.message); }
    }, intervalMs);
    if (this._periodicTimer && typeof this._periodicTimer.unref === 'function') {
      this._periodicTimer.unref();
    }
    console.log(`[AutoUpdater] periodic check scheduled every ${this._periodicHours}h`);
  }

  /** Cancel the periodic background check. */
  stopPeriodicCheck() {
    if (this._periodicTimer) {
      clearInterval(this._periodicTimer);
      this._periodicTimer = null;
      console.log('[AutoUpdater] periodic check cancelled');
    }
    this._periodicHours = 0;
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
}

module.exports = { AutoUpdater };

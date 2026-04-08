/**
 * guIDE — Extension Manager
 *
 * Manages community extensions: install, uninstall, enable, disable.
 * Extensions live in <userData>/extensions/ as folders with manifest.json.
 * State (enabled/disabled) persisted in <userData>/extensions.json.
 *
 * Extension Format:
 *   <extensionDir>/<extension-id>/
 *     manifest.json   — { id, name, version, description, author, category, icon, main, homepage, repository }
 *     main.js         — entry point (not executed yet — future feature)
 *     icon.png        — optional icon
 *     README.md       — optional readme
 */
'use strict';

const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { EventEmitter } = require('events');
const log = require('./logger');

const MANIFEST_REQUIRED_FIELDS = ['id', 'name', 'version'];

class ExtensionManager extends EventEmitter {
  constructor(userDataPath) {
    super();
    this.userDataPath = userDataPath;
    this.extensionsDir = path.join(userDataPath, 'extensions');
    this.statePath = path.join(userDataPath, 'extensions.json');
    this.extensions = [];       // { ...manifest, enabled, path, builtin }
    this._state = {};           // { [id]: { enabled: bool } }
  }

  /* ── Lifecycle ─────────────────────────────────────────────────── */

  async initialize() {
    try { await fs.mkdir(this.extensionsDir, { recursive: true }); } catch {}
    await this._loadState();
    await this.scanExtensions();
    log.info(`[ExtensionManager] Initialized — ${this.extensions.length} extensions found`);
    return this.extensions;
  }

  /* ── Scanning ──────────────────────────────────────────────────── */

  async scanExtensions() {
    this.extensions = [];

    // Scan user extensions directory
    await this._scanDir(this.extensionsDir, false);

    this.emit('extensions-updated', this.extensions);
    return this.extensions;
  }

  async _scanDir(dir, builtin) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const extPath = path.join(dir, entry.name);
      const manifestPath = path.join(extPath, 'manifest.json');

      try {
        const raw = await fs.readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(raw);

        // Validate required fields
        const missing = MANIFEST_REQUIRED_FIELDS.filter(f => !manifest[f]);
        if (missing.length > 0) {
          log.warn(`[ExtensionManager] Skipping ${entry.name}: missing fields: ${missing.join(', ')}`);
          continue;
        }

        // Sanitize ID — must be lowercase alphanumeric with hyphens
        const id = manifest.id.replace(/[^a-z0-9-]/gi, '-').toLowerCase();

        const state = this._state[id] || { enabled: true };

        this.extensions.push({
          id,
          name: manifest.name || id,
          version: manifest.version || '0.0.0',
          description: manifest.description || '',
          author: manifest.author || 'Unknown',
          category: manifest.category || 'other',
          icon: manifest.icon || null,
          main: manifest.main || null,
          homepage: manifest.homepage || null,
          repository: manifest.repository || null,
          enabled: state.enabled,
          path: extPath,
          builtin: !!builtin,
        });
      } catch (err) {
        log.warn(`[ExtensionManager] Failed to read manifest for ${entry.name}: ${err.message}`);
      }
    }
  }

  /* ── Install / Uninstall ──────────────────────────────────────── */

  /**
   * Install an extension from an extracted directory.
   * Expects `srcDir` to contain a manifest.json.
   */
  async installFromDir(srcDir) {
    const manifestPath = path.join(srcDir, 'manifest.json');
    const raw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);

    const missing = MANIFEST_REQUIRED_FIELDS.filter(f => !manifest[f]);
    if (missing.length > 0) {
      throw new Error(`Invalid extension: missing ${missing.join(', ')}`);
    }

    const id = manifest.id.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    const targetDir = path.join(this.extensionsDir, id);

    // Remove existing version if present
    try { await fs.rm(targetDir, { recursive: true, force: true }); } catch {}

    // Copy extension directory
    await this._copyDir(srcDir, targetDir);

    // Enable by default
    this._state[id] = { enabled: true };
    await this._saveState();

    await this.scanExtensions();
    return { id, name: manifest.name };
  }

  /**
   * Install extension from an uploaded zip buffer.
   * Extracts to a temp dir, validates manifest, then moves to extensions dir.
   */
  async installFromZip(zipBuffer, originalName) {
    const os = require('os');
    const tmpDir = path.join(os.tmpdir(), `guide-ext-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });

    try {
      // Extract zip using built-in Node.js zlib + tar, or fallback to manual extraction
      // For .zip files, we use a simple unzip approach
      const AdmZip = await this._getAdmZip();
      if (AdmZip) {
        const zip = new AdmZip(zipBuffer);
        zip.extractAllTo(tmpDir, true);
      } else {
        // Fallback: write buffer to tmp file and use system unzip
        const tmpZip = path.join(tmpDir, 'extension.zip');
        await fs.writeFile(tmpZip, zipBuffer);
        const { execSync } = require('child_process');
        try {
          // Try PowerShell Expand-Archive on Windows, unzip on Unix
          if (process.platform === 'win32') {
            execSync(`powershell -Command "Expand-Archive -Path '${tmpZip}' -DestinationPath '${tmpDir}' -Force"`, { timeout: 30000 });
          } else {
            execSync(`unzip -o "${tmpZip}" -d "${tmpDir}"`, { timeout: 30000 });
          }
        } catch (unzipErr) {
          throw new Error(`Failed to extract zip: ${unzipErr.message}`);
        }
      }

      // Find the manifest.json — could be at root or one level deep
      let manifestDir = tmpDir;
      const hasRootManifest = fsSync.existsSync(path.join(tmpDir, 'manifest.json'));
      if (!hasRootManifest) {
        // Check one level deep (common in zips: folder/manifest.json)
        const entries = await fs.readdir(tmpDir, { withFileTypes: true });
        const subDir = entries.find(e => e.isDirectory() && fsSync.existsSync(path.join(tmpDir, e.name, 'manifest.json')));
        if (subDir) {
          manifestDir = path.join(tmpDir, subDir.name);
        } else {
          throw new Error('No manifest.json found in the extension package');
        }
      }

      return await this.installFromDir(manifestDir);
    } finally {
      // Clean up tmp
      try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  async uninstall(extensionId) {
    const ext = this.extensions.find(e => e.id === extensionId);
    if (!ext) throw new Error(`Extension not found: ${extensionId}`);
    if (ext.builtin) throw new Error('Cannot uninstall built-in extensions');

    await fs.rm(ext.path, { recursive: true, force: true });
    delete this._state[extensionId];
    await this._saveState();
    await this.scanExtensions();
    return { id: extensionId };
  }

  /* ── Enable / Disable ──────────────────────────────────────────── */

  async enable(extensionId) {
    const ext = this.extensions.find(e => e.id === extensionId);
    if (!ext) throw new Error(`Extension not found: ${extensionId}`);

    this._state[extensionId] = { enabled: true };
    await this._saveState();
    ext.enabled = true;
    this.emit('extensions-updated', this.extensions);
    return { id: extensionId, enabled: true };
  }

  async disable(extensionId) {
    const ext = this.extensions.find(e => e.id === extensionId);
    if (!ext) throw new Error(`Extension not found: ${extensionId}`);

    this._state[extensionId] = { enabled: false };
    await this._saveState();
    ext.enabled = false;
    this.emit('extensions-updated', this.extensions);
    return { id: extensionId, enabled: false };
  }

  /* ── Getters ───────────────────────────────────────────────────── */

  getInstalled() {
    return this.extensions;
  }

  getExtension(id) {
    return this.extensions.find(e => e.id === id) || null;
  }

  getEnabled() {
    return this.extensions.filter(e => e.enabled);
  }

  getCategories() {
    const cats = new Set(this.extensions.map(e => e.category));
    return ['all', ...Array.from(cats).sort()];
  }

  /* ── Persistence ───────────────────────────────────────────────── */

  async _loadState() {
    try {
      const raw = await fs.readFile(this.statePath, 'utf8');
      this._state = JSON.parse(raw);
    } catch {
      this._state = {};
    }
  }

  async _saveState() {
    await fs.writeFile(this.statePath, JSON.stringify(this._state, null, 2));
  }

  /* ── Helpers ───────────────────────────────────────────────────── */

  async _copyDir(src, dest) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await this._copyDir(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }

  async _getAdmZip() {
    try {
      return require('adm-zip');
    } catch {
      return null;
    }
  }
}

module.exports = { ExtensionManager };

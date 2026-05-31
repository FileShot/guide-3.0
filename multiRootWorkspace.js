'use strict';

/**
 * multiRootWorkspace — manage multiple project roots in one workspace.
 */
const fs = require('fs');
const path = require('path');

class MultiRootWorkspace {
  constructor(userDataPath) {
    this._statePath = path.join(userDataPath, 'workspace-roots.json');
    this._roots = [];
    this._primary = null;
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this._statePath, 'utf8');
      const data = JSON.parse(raw);
      this._roots = Array.isArray(data.roots) ? data.roots : [];
      this._primary = data.primary || this._roots[0] || null;
    } catch {
      this._roots = [];
      this._primary = null;
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this._statePath), { recursive: true });
    fs.writeFileSync(this._statePath, JSON.stringify({
      roots: this._roots,
      primary: this._primary,
    }, null, 2));
  }

  getRoots() {
    return { roots: [...this._roots], primary: this._primary };
  }

  addRoot(rootPath) {
    const resolved = path.resolve(rootPath);
    if (!fs.existsSync(resolved)) throw new Error('Directory not found');
    if (!this._roots.includes(resolved)) this._roots.push(resolved);
    if (!this._primary) this._primary = resolved;
    this._save();
    return this.getRoots();
  }

  removeRoot(rootPath) {
    const resolved = path.resolve(rootPath);
    this._roots = this._roots.filter(r => r !== resolved);
    if (this._primary === resolved) this._primary = this._roots[0] || null;
    this._save();
    return this.getRoots();
  }

  setPrimary(rootPath) {
    const resolved = path.resolve(rootPath);
    if (!this._roots.includes(resolved)) throw new Error('Root not in workspace');
    this._primary = resolved;
    this._save();
    return this.getRoots();
  }

  syncWithProject(projectPath) {
    if (projectPath && !this._roots.includes(projectPath)) {
      this._roots.unshift(projectPath);
      if (!this._primary) this._primary = projectPath;
      this._save();
    }
  }
}

module.exports = { MultiRootWorkspace };

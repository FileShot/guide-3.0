/**
 * guIDE 2.0 — Git Manager
 *
 * Wraps git CLI commands into a class used by both:
 *   1. mcpToolServer (AI tool calls via setGitManager)
 *   2. /api/git/* REST endpoints in server/main.js
 *
 * Uses child_process.execFile where possible for safety (no shell injection).
 * Falls back to execSync for complex pipelines.
 */
'use strict';

const { execFileSync, execSync } = require('child_process');
const path = require('path');

class GitManager {
  constructor() {
    this._projectPath = null;
  }

  /** Set the working directory for all git commands. */
  setProjectPath(projectPath) {
    this._projectPath = projectPath;
  }

  get projectPath() {
    return this._projectPath;
  }

  /* ── Status ────────────────────────────────────────────── */

  /**
   * Get repository status: branch, staged, modified, untracked files.
   * @param {string} [cwd] — override project path
   * @returns {{ branch: string, staged: string[], modified: string[], untracked: string[] }}
   */
  getStatus(cwd) {
    const dir = cwd || this._projectPath;
    if (!dir) return { error: 'No project path set', branch: '', staged: [], modified: [], untracked: [] };
    const opts = { cwd: dir, encoding: 'utf8', timeout: 5000 };

    let branch = '';
    try {
      branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts).trim();
    } catch (_) {}

    if (!branch) {
      return { error: 'Not a git repository', branch: '', staged: [], modified: [], untracked: [] };
    }

    let statusOutput = '';
    try {
      statusOutput = execFileSync('git', ['status', '--porcelain'], opts);
    } catch (_) {}

    const staged = [];
    const modified = [];
    const untracked = [];

    for (const line of statusOutput.split('\n')) {
      if (!line.trim()) continue;
      const x = line[0], y = line[1];
      const file = line.substring(3).trim();
      if (x === '?' && y === '?') untracked.push(file);
      else if (x !== ' ' && x !== '?') staged.push(file);
      if (y !== ' ' && y !== '?') modified.push(file);
    }

    return { branch, staged, modified, untracked };
  }

  /* ── Staging ───────────────────────────────────────────── */

  /**
   * Stage all changes.
   * @param {string} [cwd]
   */
  stageAll(cwd) {
    const dir = cwd || this._projectPath;
    if (!dir) throw new Error('No project path set');
    execFileSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', timeout: 10000 });
    return { success: true };
  }

  /**
   * Stage specific files.
   * @param {string[]} files
   * @param {string} [cwd]
   */
  stageFiles(files, cwd) {
    const dir = cwd || this._projectPath;
    if (!dir) throw new Error('No project path set');
    for (const f of files) {
      execFileSync('git', ['add', f], { cwd: dir, encoding: 'utf8', timeout: 10000 });
    }
    return { success: true };
  }

  /**
   * Unstage all files.
   * @param {string} [cwd]
   */
  unstageAll(cwd) {
    const dir = cwd || this._projectPath;
    if (!dir) throw new Error('No project path set');
    execFileSync('git', ['reset', 'HEAD'], { cwd: dir, encoding: 'utf8', timeout: 10000 });
    return { success: true };
  }

  /**
   * Unstage specific files.
   * @param {string[]} files
   * @param {string} [cwd]
   */
  unstageFiles(files, cwd) {
    const dir = cwd || this._projectPath;
    if (!dir) throw new Error('No project path set');
    for (const f of files) {
      execFileSync('git', ['reset', 'HEAD', f], { cwd: dir, encoding: 'utf8', timeout: 10000 });
    }
    return { success: true };
  }

  /* ── Commit ────────────────────────────────────────────── */

  /**
   * Commit staged changes.
   * @param {string} message
   * @param {string} [cwd]
   */
  commit(message, cwd) {
    const dir = cwd || this._projectPath;
    if (!dir) throw new Error('No project path set');
    if (!message || !message.trim()) throw new Error('Commit message required');
    const output = execFileSync('git', ['commit', '-m', message.trim()],
      { cwd: dir, encoding: 'utf8', timeout: 15000 });
    return { success: true, output };
  }

  /* ── Diff ──────────────────────────────────────────────── */

  /**
   * Get diff output.
   * @param {{ staged?: boolean, file?: string }} [options]
   * @param {string} [cwd]
   */
  getDiff(options = {}, cwd) {
    const dir = cwd || this._projectPath;
    if (!dir) throw new Error('No project path set');
    const args = ['diff'];
    if (options.staged) args.push('--cached');
    if (options.file) { args.push('--'); args.push(options.file); }
    const diff = execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 10000 });
    return { success: true, diff };
  }

  /* ── Discard ───────────────────────────────────────────── */

  /**
   * Discard changes in specific files (checkout from HEAD).
   * @param {string[]} files
   * @param {string} [cwd]
   */
  discardFiles(files, cwd) {
    const dir = cwd || this._projectPath;
    if (!dir) throw new Error('No project path set');
    for (const f of files) {
      execFileSync('git', ['checkout', '--', f], { cwd: dir, encoding: 'utf8', timeout: 10000 });
    }
    return { success: true };
  }

  /* ── Log ───────────────────────────────────────────────── */

  /**
   * Get commit log.
   * @param {number} [count=20]
   * @param {string} [cwd]
   */
  getLog(count = 20, cwd) {
    const dir = cwd || this._projectPath;
    if (!dir) throw new Error('No project path set');
    count = Math.min(100, Math.max(1, parseInt(count) || 20));
    const result = execFileSync('git',
      ['log', '--oneline', `--format=%h|%s|%an|%ar`, `-${count}`],
      { cwd: dir, encoding: 'utf8', timeout: 10000 });
    const entries = result.split('\n').filter(Boolean).map(line => {
      const [hash, message, author, date] = line.split('|');
      return { hash, message, author, date };
    });
    return { success: true, entries };
  }

  /* ── Branches ──────────────────────────────────────────── */

  /**
   * List local branches.
   * @param {string} [cwd]
   */
  getBranches(cwd) {
    const dir = cwd || this._projectPath;
    if (!dir) throw new Error('No project path set');
    const result = execFileSync('git', ['branch'],
      { cwd: dir, encoding: 'utf8', timeout: 5000 });
    const branches = result.split('\n').filter(Boolean).map(line => ({
      name: line.replace(/^\*?\s*/, '').trim(),
      current: line.startsWith('*'),
    }));
    return { success: true, branches };
  }

  /**
   * Checkout (switch to) a branch.
   * @param {string} branch
   * @param {{ create?: boolean }} [options]
   * @param {string} [cwd]
   */
  checkout(branch, options = {}, cwd) {
    const dir = cwd || this._projectPath;
    if (!dir) throw new Error('No project path set');
    if (!branch || !branch.trim()) throw new Error('Branch name required');
    const args = ['checkout'];
    if (options.create) args.push('-b');
    args.push(branch.trim());
    const output = execFileSync('git', args,
      { cwd: dir, encoding: 'utf8', timeout: 15000 });
    return { success: true, output };
  }

  /* ── Stash ─────────────────────────────────────────────── */

  /**
   * Stash operations.
   * @param {'push'|'pop'|'list'|'drop'} action
   * @param {string} [message] — for push
   * @param {string} [cwd]
   */
  stash(action = 'push', message, cwd) {
    const dir = cwd || this._projectPath;
    if (!dir) throw new Error('No project path set');
    const args = ['stash'];
    switch (action) {
      case 'push':
        args.push('push');
        if (message) { args.push('-m'); args.push(message); }
        break;
      case 'pop': args.push('pop'); break;
      case 'list': args.push('list'); break;
      case 'drop': args.push('drop'); break;
      default: break;
    }
    const output = execFileSync('git', args,
      { cwd: dir, encoding: 'utf8', timeout: 10000 });
    return { success: true, output };
  }

  /* ── Push / Pull ───────────────────────────────────────── */

  /**
   * Push to remote.
   * @param {string} [remote='origin']
   * @param {string} [branch]
   * @param {string} [cwd]
   */
  push(remote = 'origin', branch, cwd) {
    const dir = cwd || this._projectPath;
    if (!dir) throw new Error('No project path set');
    const args = ['push', remote];
    if (branch) args.push(branch);
    const output = execFileSync('git', args,
      { cwd: dir, encoding: 'utf8', timeout: 30000 });
    return { success: true, output };
  }

  /**
   * Pull from remote.
   * @param {string} [remote='origin']
   * @param {string} [branch]
   * @param {string} [cwd]
   */
  pull(remote = 'origin', branch, cwd) {
    const dir = cwd || this._projectPath;
    if (!dir) throw new Error('No project path set');
    const args = ['pull', remote];
    if (branch) args.push(branch);
    const output = execFileSync('git', args,
      { cwd: dir, encoding: 'utf8', timeout: 30000 });
    return { success: true, output };
  }

  /* ── Init ──────────────────────────────────────────────── */

  /**
   * Initialize a new git repository.
   * @param {string} [cwd]
   */
  init(cwd) {
    const dir = cwd || this._projectPath;
    if (!dir) throw new Error('No project path set');
    const output = execFileSync('git', ['init'],
      { cwd: dir, encoding: 'utf8', timeout: 5000 });
    return { success: true, output };
  }
}

module.exports = { GitManager };

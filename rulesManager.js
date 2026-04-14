/**
 * rulesManager.js — Project-level rules/skills for the AI agent.
 *
 * Reads rules from:
 *   1. <projectRoot>/.guide/rules/*.md   (individual rule files)
 *   2. <projectRoot>/AGENTS.md           (project-wide agent instructions)
 *
 * Rules are injected into the system prompt at chat start.
 * The agent can create/update rules via the save_rule tool.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./logger');

class RulesManager {
  constructor() {
    this._projectPath = null;
    this._rulesDir = null;
    this._cache = null;
    this._cacheTime = 0;
  }

  initialize(projectPath) {
    this._projectPath = projectPath;
    this._rulesDir = projectPath ? path.join(projectPath, '.guide', 'rules') : null;
    this._cache = null;
    this._cacheTime = 0;
  }

  /**
   * Load all rules and return as a single prompt string.
   * Cached for 10 seconds to avoid repeated disk reads.
   */
  getRulesPrompt() {
    if (!this._projectPath) return '';
    if (this._cache && Date.now() - this._cacheTime < 10000) return this._cache;

    const sections = [];

    // 1. Read AGENTS.md from project root
    const agentsMd = path.join(this._projectPath, 'AGENTS.md');
    try {
      if (fs.existsSync(agentsMd)) {
        const content = fs.readFileSync(agentsMd, 'utf-8').trim();
        if (content) sections.push(`## Project Instructions (AGENTS.md)\n${content}`);
      }
    } catch (e) {
      log.warn('Rules', `Failed to read AGENTS.md: ${e.message}`);
    }

    // 2. Read .guide/rules/*.md
    if (this._rulesDir) {
      try {
        if (fs.existsSync(this._rulesDir)) {
          const files = fs.readdirSync(this._rulesDir)
            .filter(f => f.endsWith('.md'))
            .sort();
          for (const file of files) {
            try {
              const content = fs.readFileSync(path.join(this._rulesDir, file), 'utf-8').trim();
              if (content) {
                const name = file.replace(/\.md$/, '');
                sections.push(`## Rule: ${name}\n${content}`);
              }
            } catch (e) {
              log.warn('Rules', `Failed to read rule ${file}: ${e.message}`);
            }
          }
        }
      } catch (e) {
        log.warn('Rules', `Failed to scan rules directory: ${e.message}`);
      }
    }

    if (sections.length === 0) {
      this._cache = '';
      this._cacheTime = Date.now();
      return '';
    }

    this._cache = `\n\n# Project Rules & Skills\nThe following rules and instructions have been set for this project. Follow them.\n\n${sections.join('\n\n')}\n`;
    this._cacheTime = Date.now();
    return this._cache;
  }

  /**
   * Save or update a rule file.
   * @param {string} name - Rule name (used as filename, .md appended)
   * @param {string} content - Rule content (markdown)
   * @returns {{ success: boolean, path?: string, error?: string }}
   */
  saveRule(name, content) {
    if (!this._projectPath) return { success: false, error: 'No project open' };
    if (!name || !content) return { success: false, error: 'Name and content are required' };

    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
    const rulesDir = path.join(this._projectPath, '.guide', 'rules');
    const filePath = path.join(rulesDir, `${safeName}.md`);

    try {
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.writeFileSync(filePath, content.trim() + '\n', 'utf-8');
      this._cache = null;
      log.info('Rules', `Saved rule: ${safeName}`);
      return { success: true, path: filePath };
    } catch (e) {
      return { success: false, error: `Failed to save rule: ${e.message}` };
    }
  }

  /**
   * Delete a rule file.
   */
  deleteRule(name) {
    if (!this._projectPath) return { success: false, error: 'No project open' };
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
    const filePath = path.join(this._projectPath, '.guide', 'rules', `${safeName}.md`);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this._cache = null;
        return { success: true };
      }
      return { success: false, error: 'Rule not found' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * List all rule names.
   */
  listRules() {
    const rules = [];
    if (!this._projectPath) return rules;

    const agentsMd = path.join(this._projectPath, 'AGENTS.md');
    if (fs.existsSync(agentsMd)) {
      rules.push({ name: 'AGENTS.md', type: 'project', path: agentsMd });
    }

    if (this._rulesDir && fs.existsSync(this._rulesDir)) {
      try {
        const files = fs.readdirSync(this._rulesDir).filter(f => f.endsWith('.md')).sort();
        for (const f of files) {
          rules.push({ name: f.replace(/\.md$/, ''), type: 'rule', path: path.join(this._rulesDir, f) });
        }
      } catch { /* ignore */ }
    }

    return rules;
  }
}

module.exports = { RulesManager };

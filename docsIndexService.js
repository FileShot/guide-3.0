'use strict';

/**
 * Docs index — lightweight markdown/doc search for @docs mentions.
 */
const fs = require('fs');
const path = require('path');

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst']);
const DOC_DIR_NAMES = new Set(['docs', 'doc', 'documentation', 'wiki']);
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv',
]);

function tokenize(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9_$]+/g) || [];
}

class DocsIndexService {
  constructor() {
    this.projectPath = null;
    this._entries = [];
  }

  async index(projectPath) {
    this.projectPath = projectPath || null;
    this._entries = [];
    if (!projectPath) return { count: 0 };

    const rootDocs = [];
    const nestedDocs = [];

    const walk = (dir, relBase, inDocDir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.') continue;
        const full = path.join(dir, entry.name);
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          walk(full, rel, inDocDir || DOC_DIR_NAMES.has(entry.name.toLowerCase()));
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          const isRootReadme = !relBase && /^readme/i.test(entry.name);
          if (!DOC_EXTENSIONS.has(ext) && !isRootReadme) continue;
          if (!inDocDir && !isRootReadme && relBase) continue;
          try {
            const content = fs.readFileSync(full, 'utf8');
            if (content.length > 512 * 1024) continue;
            const title = this._extractTitle(content, entry.name);
            const item = {
              path: rel.replace(/\\/g, '/'),
              title,
              content,
              tokens: tokenize(`${title} ${content}`),
            };
            if (!relBase || inDocDir) nestedDocs.push(item);
            else rootDocs.push(item);
          } catch (_) {}
        }
      }
    };

    walk(projectPath, '', false);
    this._entries = [...rootDocs, ...nestedDocs];
    return { count: this._entries.length };
  }

  _extractTitle(content, fileName) {
    const m = content.match(/^#\s+(.+)$/m);
    if (m) return m[1].trim();
    return fileName.replace(/\.[^.]+$/, '');
  }

  search(query, maxResults = 12) {
    const q = tokenize(query);
    if (!q.length || !this._entries.length) return [];

    const scored = this._entries.map((entry) => {
      let score = 0;
      const titleTokens = tokenize(entry.title);
      const pathLower = entry.path.toLowerCase();
      for (const t of q) {
        if (titleTokens.includes(t)) score += 8;
        if (pathLower.includes(t)) score += 4;
        if (entry.tokens.includes(t)) score += 1;
      }
      return { ...entry, score, snippet: entry.content.slice(0, 240).replace(/\s+/g, ' ').trim() };
    });

    return scored
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(({ path: docPath, title, snippet, score }) => ({ path: docPath, title, snippet, score }));
  }
}

module.exports = { DocsIndexService };

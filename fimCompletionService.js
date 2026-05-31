'use strict';

/**
 * FIM (Fill-In-the-Middle) Tab completion — prefix/suffix aware, fast path.
 * Uses dedicated FIM prompt template; avoids full chat history.
 */
class FimCompletionService {
  constructor(chatEngine) {
    this._chatEngine = chatEngine;
    this._cache = new Map();
    this._cacheMax = 200;
  }

  _cacheKey(ctx) {
    const { prefix = '', suffix = '', language = '' } = ctx || {};
    return `${language}:${prefix.slice(-120)}|${suffix.slice(0, 80)}`;
  }

  /**
   * FIM-style completion — insert text between prefix and suffix.
   */
  async complete(ctx) {
    const { prefix = '', suffix = '', language = 'text', filePath } = ctx || {};
    const key = this._cacheKey(ctx);
    if (this._cache.has(key)) return this._cache.get(key);

    if (!this._chatEngine?.isReady) {
      const h = this._heuristicFim(prefix, suffix, language);
      return h;
    }

    try {
      const fimPrompt = [
        'You are a code completion engine. Fill in the middle between PREFIX and SUFFIX.',
        'Output ONLY the text to insert at the cursor. No quotes, markdown, or explanation.',
        'Stop at a natural boundary; do not repeat PREFIX or SUFFIX.',
        filePath ? `File: ${filePath}` : '',
        `Language: ${language}`,
        '',
        '<|fim_prefix|>',
        prefix.slice(-1200),
        '<|fim_suffix|>',
        suffix.slice(0, 400),
        '<|fim_middle|>',
      ].filter(Boolean).join('\n');

      const result = await this._chatEngine.completeOnce(fimPrompt, {
        maxTokens: 96,
        temperature: 0.1,
      });
      let text = (result?.text || '').trim();
      text = this._sanitizeFimOutput(text, prefix, suffix);
      if (text && text.length <= 800) {
        const out = { text };
        this._setCache(key, out);
        return out;
      }
    } catch (_) {}

    return this._heuristicFim(prefix, suffix, language);
  }

  _sanitizeFimOutput(text, prefix, suffix) {
    if (!text) return '';
    if (text.startsWith('```')) {
      text = text.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
    }
    if (suffix && text.endsWith(suffix.slice(0, Math.min(20, suffix.length)))) {
      text = text.slice(0, -Math.min(20, suffix.length));
    }
    const plines = prefix.split('\n');
    const lastPrefixLine = plines[plines.length - 1] || '';
    if (text.startsWith(lastPrefixLine) && lastPrefixLine.length > 3) {
      text = text.slice(lastPrefixLine.length);
    }
    return text.trimEnd();
  }

  _heuristicFim(prefix, suffix, language) {
    const lines = prefix.split('\n');
    const current = lines[lines.length - 1] || '';
    const trimmed = current.trimStart();
    const indent = current.slice(0, current.length - trimmed.length);

    if (language === 'javascript' || language === 'typescript') {
      if (trimmed.endsWith('console.')) return { text: 'log()' };
      if (trimmed.endsWith('import ')) return { text: " { } from '';" };
      if (trimmed.endsWith('const ')) return { text: 'name = ' };
      if (trimmed.endsWith('function ')) return { text: 'name() {\n  \n}' };
    }
    if (language === 'python') {
      if (trimmed.endsWith('def ')) return { text: 'name():\n    pass' };
      if (trimmed === 'import ') return { text: 'module' };
    }
    if (trimmed.endsWith('{') && suffix.trimStart().startsWith('}')) {
      return { text: `\n${indent}  \n${indent}` };
    }
    if (suffix.startsWith(')') && trimmed.endsWith('(')) return { text: '' };
    return null;
  }

  _setCache(key, val) {
    if (this._cache.size >= this._cacheMax) {
      const first = this._cache.keys().next().value;
      this._cache.delete(first);
    }
    this._cache.set(key, val);
  }
}

module.exports = { FimCompletionService };

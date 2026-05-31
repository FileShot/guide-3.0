'use strict';

/**
 * Inline / Tab completion service (Tier 2) — fast prefix completion from local model or heuristics.
 */
class CompletionService {
  constructor(chatEngine) {
    this._chatEngine = chatEngine;
  }

  /**
   * @param {{ filePath, language, prefix, suffix, line, column }} ctx
   * @returns {Promise<{ text: string, range?: object } | null>}
   */
  async complete(ctx) {
    const { prefix = '', suffix = '', language = 'text' } = ctx || {};
    // Heuristic fallback when model not ready
    if (!this._chatEngine?.isReady) {
      return this._heuristicComplete(prefix, language);
    }
    try {
      const prompt = `Complete the following ${language} code. Output ONLY the completion text to insert at the cursor, no explanation.\n\nPREFIX:\n${prefix.slice(-800)}\n\nSUFFIX:\n${suffix.slice(0, 200)}\n\nCOMPLETION:`;
      const result = await this._chatEngine.completeOnce?.(prompt, { maxTokens: 64, temperature: 0.2 });
      const text = (result?.text || '').trim();
      if (text && text.length < 500) return { text };
    } catch (_) {}
    return this._heuristicComplete(prefix, language);
  }

  _heuristicComplete(prefix, language) {
    const lines = prefix.split('\n');
    const current = lines[lines.length - 1] || '';
    const trimmed = current.trimStart();
    const indent = current.slice(0, current.length - trimmed.length);

    if (language === 'javascript' || language === 'typescript') {
      if (trimmed.endsWith('console.')) return { text: 'log()' };
      if (trimmed.endsWith('function ')) return { text: 'name() {\n  \n}' };
      if (trimmed === 'import ') return { text: " { } from '';" };
    }
    if (language === 'python') {
      if (trimmed.endsWith('def ')) return { text: 'name():\n    pass' };
      if (trimmed === 'import ') return { text: 'module' };
    }
    if (trimmed.endsWith('{')) return { text: `\n${indent}  \n${indent}}` };
    return null;
  }
}

module.exports = { CompletionService };

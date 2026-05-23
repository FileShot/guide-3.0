'use strict';

const { stripToolCallText } = require('./toolParser');

/**
 * Stream filter for cloud (and reusable elsewhere): suppress tool-call JSON from the UI
 * by diffing stripToolCallText() over the growing raw buffer. When stripped text shrinks
 * (tool JSON completed), emits llm-replace-last so the frontend drops leaked JSON.
 */
function createStripBasedStreamFilter({ onToken, onStreamEvent } = {}) {
  let rawBuf = '';
  let lastClean = '';
  let visibleChars = 0;

  const sync = () => {
    const clean = stripToolCallText(rawBuf);
    if (clean.length < visibleChars) {
      if (onStreamEvent) {
        onStreamEvent('llm-replace-last', {
          originalLength: visibleChars,
          replacement: clean,
        });
      }
      visibleChars = clean.length;
      lastClean = clean;
      return;
    }
    const delta = clean.slice(lastClean.length);
    if (delta && onToken) {
      onToken(delta);
      visibleChars += delta.length;
    }
    lastClean = clean;
  };

  return {
    processChunk(chunk) {
      if (!chunk) return;
      rawBuf += chunk;
      sync();
    },
    flush() {
      sync();
    },
    resetRound() {
      rawBuf = '';
      lastClean = '';
      visibleChars = 0;
    },
    getVisibleChars: () => visibleChars,
    getCleanText: () => stripToolCallText(rawBuf),
    getRawBuffer: () => rawBuf,
  };
}

module.exports = { createStripBasedStreamFilter };

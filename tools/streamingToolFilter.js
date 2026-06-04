'use strict';

const {
  stripToolCallText,
  looksLikeToolAttempt,
  isVisibleToolArtifact,
  findToolCallRanges,
} = require('./toolParser');

/** Mirror chatEngine thinking bailout — tool/file bytes must not go to Thought UI. */
function looksLikeToolOrFilePayload(text) {
  if (!text || typeof text !== 'string') return false;
  const sample = text.length > 4096 ? text.slice(0, 4096) : text;
  return /"filePath"|"content"\s*:|className=|<\/\w+>|"tool"\s*:|"params"\s*:|<!DOCTYPE/i.test(sample);
}

/** True when buffer may contain incomplete tool JSON/fences — hold until complete. */
function shouldHoldToolBuffer(rawBuf) {
  if (!rawBuf || typeof rawBuf !== 'string') return false;

  const unclosedFenceRe = /```(?:json|tool_call|tool)\s*\n[\s\S]*$/i;
  const fenceMatch = unclosedFenceRe.exec(rawBuf);
  if (fenceMatch) {
    const tail = fenceMatch[0];
    const closes = (tail.match(/```/g) || []).length;
    if (closes < 2) return true;
  }

  if (looksLikeToolOrFilePayload(rawBuf) && looksLikeToolAttempt(rawBuf)) {
    const clean = stripToolCallText(rawBuf);
    if (clean.length < rawBuf.trim().length) return true;
  }

  if (!looksLikeToolAttempt(rawBuf)) return false;

  const clean = stripToolCallText(rawBuf);
  if (clean.length < rawBuf.trim().length) return true;

  const tailStart = Math.max(0, rawBuf.length - 12000);
  const tail = rawBuf.slice(tailStart);
  if (!/"tool"\s*:\s*"/.test(tail) && !/"\s*,\s*"params"\s*:/.test(tail)) return false;

  const lastOpen = rawBuf.lastIndexOf('{');
  if (lastOpen < 0) return false;

  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = lastOpen; i < rawBuf.length; i++) {
    const ch = rawBuf[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inStr) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  if (depth > 0) return true;

  const ranges = findToolCallRanges(rawBuf);
  if (ranges.length === 0) return true;

  let covered = 0;
  for (const [s, e] of ranges) covered += e - s;
  if (covered < rawBuf.trim().length) return true;

  return false;
}

function forwardChunk(chunk, onToken) {
  if (!chunk) return 0;
  if (/^\s*```[a-z0-9_-]*\s*$/i.test(chunk)) return 0;
  if (isVisibleToolArtifact(chunk)) return 0;
  if (onToken) onToken(chunk);
  return chunk.length;
}

/**
 * Append-only stream filter: route prose/thinking to UI; hold tool bytes in rawBuf for parse.
 * Never shrinks or replaces visible display text (no llm-replace-last).
 */
function createStripBasedStreamFilter({ onToken, channel = 'text' } = {}) {
  let rawBuf = '';
  let lastClean = '';
  let visibleChars = 0;

  const forwardCleanDelta = () => {
    const clean = stripToolCallText(rawBuf);
    if (clean.length < lastClean.length) {
      // Invariant: display must never shrink — keep lastClean, do not retract.
      return;
    }
    const delta = clean.slice(lastClean.length);
    if (delta) {
      const added = forwardChunk(delta, onToken);
      visibleChars += added;
      lastClean = clean;
    }
  };

  const sync = ({ forceFlush = false } = {}) => {
    if (!forceFlush) {
      if (shouldHoldToolBuffer(rawBuf)) return;
      if (looksLikeToolOrFilePayload(rawBuf)) return;
    }
    forwardCleanDelta();
  };

  return {
    processChunk(chunk) {
      if (!chunk) return;
      rawBuf += chunk;
      sync();
    },
    flush() {
      sync({ forceFlush: true });
    },
    resetRound() {
      rawBuf = '';
      lastClean = '';
      visibleChars = 0;
    },
    getVisibleChars: () => visibleChars,
    getCleanText: () => stripToolCallText(rawBuf),
    getRawBuffer: () => rawBuf,
    getLastClean: () => lastClean,
  };
}

/** Prose + thinking stream routers for cloud (separate UI sinks, append-only). */
function createCloudStreamFilters({ onToken, onThinkingToken } = {}) {
  const proseFilter = createStripBasedStreamFilter({
    channel: 'text',
    onToken,
  });
  const thinkingFilter = createStripBasedStreamFilter({
    channel: 'thinking',
    onToken: onThinkingToken,
  });

  return {
    proseFilter,
    thinkingFilter,
    processContentChunk(chunk) {
      proseFilter.processChunk(chunk);
    },
    processThinkingChunk(chunk) {
      thinkingFilter.processChunk(chunk);
    },
    flush() {
      proseFilter.flush();
      thinkingFilter.flush();
    },
    resetRound() {
      proseFilter.resetRound();
      thinkingFilter.resetRound();
    },
    getCombinedRawBuffer() {
      return proseFilter.getRawBuffer() + thinkingFilter.getRawBuffer();
    },
    getProseCleanText() {
      return proseFilter.getCleanText();
    },
    getThinkingCleanText() {
      return thinkingFilter.getCleanText();
    },
    getProseVisibleChars: () => proseFilter.getVisibleChars(),
    getThinkingVisibleChars: () => thinkingFilter.getVisibleChars(),
  };
}

module.exports = {
  createStripBasedStreamFilter,
  createCloudStreamFilters,
  shouldHoldToolBuffer,
  looksLikeToolOrFilePayload,
};

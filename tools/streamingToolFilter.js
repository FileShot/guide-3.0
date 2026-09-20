'use strict';

const {
  stripToolCallText,
  looksLikeToolAttempt,
  isVisibleToolArtifact,
  findToolCallRanges,
  extractPartialWriteFileFromToolJson,
} = require('./toolParser');

/** Mirror chatEngine thinking bailout — tool JSON must not go to Thought UI. */
function looksLikeToolOrFilePayload(text) {
  if (!text || typeof text !== 'string') return false;
  const sample = text.length > 4096 ? text.slice(0, 4096) : text;
  return /"filePath"|"content"\s*:|"tool"\s*:|"params"\s*:/i.test(sample)
    && looksLikeToolAttempt(sample);
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
  // Drop only tool-fence openers; markdown/code fences must reach the UI live.
  if (/^\s*```(?:json|tool|tool_call)\s*$/i.test(chunk)) return 0;
  if (isVisibleToolArtifact(chunk)) return 0;
  if (onToken) onToken(chunk);
  return chunk.length;
}

/**
 * Append-only stream filter: route prose/thinking to UI; hold tool bytes in rawBuf for parse.
 * Never shrinks or replaces visible display text (no llm-replace-last).
 */
function createStripBasedStreamFilter({ onToken, channel = 'text', onStreamEvent } = {}) {
  let rawBuf = '';
  let lastClean = '';
  let visibleChars = 0;
  let fileStarted = false;
  let filePath = '';
  let fileLen = 0;

  const emitPartialFile = () => {
    if (!onStreamEvent) return;
    const partial = extractPartialWriteFileFromToolJson(rawBuf, { stripCompleteSuffix: true });
    if (!partial) return;
    const fp = partial.filePath;
    if (fp && !fileStarted) {
      const fileName = fp.split(/[\\/]/).pop() || fp;
      const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
      onStreamEvent('file-content-start', {
        filePath: fp,
        fileName,
        language: ext,
        fileKey: fp,
        op: partial.isEdit ? 'edit' : 'write',
      });
      fileStarted = true;
      filePath = fp;
      fileLen = 0;
    }
    if (!fileStarted) return;
    const content = partial.content || '';
    if (content.length > fileLen) {
      onStreamEvent('file-content-token', content.slice(fileLen));
      fileLen = content.length;
    }
  };

  const endPartialFile = () => {
    if (fileStarted && onStreamEvent && filePath) {
      onStreamEvent('file-content-end', { filePath, fileKey: filePath });
    }
    fileStarted = false;
    filePath = '';
    fileLen = 0;
  };

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
    }
    forwardCleanDelta();
  };

  return {
    processChunk(chunk) {
      if (!chunk) return;
      rawBuf += chunk;
      emitPartialFile();
      sync();
    },
    flush() {
      emitPartialFile();
      endPartialFile();
      sync({ forceFlush: true });
    },
    resetRound() {
      endPartialFile();
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
function createCloudStreamFilters({ onToken, onThinkingToken, onStreamEvent } = {}) {
  const proseFilter = createStripBasedStreamFilter({
    channel: 'text',
    onToken,
    onStreamEvent,
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

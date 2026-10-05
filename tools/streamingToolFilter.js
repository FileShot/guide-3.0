'use strict';

const {
  stripToolCallText,
  looksLikeToolAttempt,
  isVisibleToolArtifact,
  findToolCallRanges,
  extractPartialWriteFileFromToolJson,
} = require('./toolParser');
const { stripContentLanguageFencesForDisplay, trailingIncompleteFenceOpenHold } = require('./agentRoundEnd');

/** Mirror chatEngine thinking bailout — tool JSON must not go to Thought UI. */
function looksLikeToolOrFilePayload(text) {
  if (!text || typeof text !== 'string') return false;
  const sample = text.length > 4096 ? text.slice(0, 4096) : text;
  return /"filePath"|"content"\s*:|"tool"\s*:|"function"\s*:|"function\s*=|"params"\s*:|<tool_call\b/i.test(sample)
    && looksLikeToolAttempt(sample);
}

/** True when buffer may contain incomplete tool JSON/fences — hold until complete. */
function holdTrailingToolTag(rawBuf) {
  const i = rawBuf.lastIndexOf('<');
  if (i < 0) return false;
  if (rawBuf.indexOf('>', i) !== -1) return false;
  const tail = rawBuf.slice(i).toLowerCase();
  const names = ['<invoke', '</invoke', '<parameter', '</parameter', '<function', '</function'];
  return names.some((name) => name.startsWith(tail));
}

function holdIncompleteToolJson(rawBuf) {
  const idx = rawBuf.lastIndexOf('{');
  if (idx < 0) return false;
  const tail = rawBuf.slice(idx);
  const compact = tail.replace(/\s+/g, '');
  // Do NOT treat {"name" as a tool start — every package.json begins with {"name":...}
  // and that false hold freezes the UI after the model prints "package.json".
  const targets = ['{"tool"', '{"function"', '{"function='];
  if (targets.some((target) => target.startsWith(compact))) return true;
  // {"tool":...} / {"function":...} OR {"function=name"} — never bare "name"
  if (!/^\{\s*"(?:tool|function)"\s*:/i.test(tail) && !/^\{\s*"function\s*=/i.test(tail)) return false;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inStr) { escaped = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  return depth > 0;
}

function holdOpenToolCallTag(rawBuf) {
  const open = rawBuf.lastIndexOf('<tool_call');
  if (open < 0) return false;
  const after = rawBuf.slice(open);
  if (/<\/tool_call>/i.test(after)) return false;
  return true;
}

/**
 * write_file / edit_file payloads: brace-depth hold is unreliable when the model emits
 * unescaped quotes or raw newlines inside "content" (live 2026-09-30 styles.css JSON
 * painted into chat with proseLive≈17k while toolsParsed=1).
 * Sticky-hold until stripToolCallText removes the tool object.
 */
function isFormingFileWritePayload(rawBuf) {
  if (!rawBuf || typeof rawBuf !== 'string') return false;
  if (!/"tool"\s*:\s*"(?:write_file|edit_file|create_file|append_to_file|replace_in_file)"/i.test(rawBuf)) {
    return false;
  }
  return /"filePath"\s*:/.test(rawBuf) || /"content"\s*:/.test(rawBuf) || /"params"\s*:/.test(rawBuf);
}

function shouldHoldToolBuffer(rawBuf) {
  if (!rawBuf || typeof rawBuf !== 'string') return false;
  if (holdTrailingToolTag(rawBuf)) return true;
  if (holdOpenToolCallTag(rawBuf)) return true;
  // Divert (not hide): while an open tool_call / incomplete tool JSON is forming, bytes go to
  // the tool card via emitFormingTool — not deleted. Release when ranges parse cleanly.
  if (holdIncompleteToolJson(rawBuf)) return true;

  // Sticky file-write hold (before early release via depth=0 false negatives).
  // WriteStripLeak2: also hold while strip left a naked HTML/file body (unescaped
  // quotes made findToolCallRanges miss; chat painted CodeBlock + file card).
  if (isFormingFileWritePayload(rawBuf)) {
    const clean = stripToolCallText(rawBuf);
    if (/"tool"\s*:\s*"(?:write_file|edit_file|create_file|append_to_file|replace_in_file)"/i.test(clean)) {
      return true;
    }
    if (/"filePath"\s*:/.test(clean) && /"content"\s*:/.test(clean) && clean.length > 80) {
      return true;
    }
    if (/^\s*<!doctype html/i.test(clean) || /^\s*<html[\s>]/i.test(clean)) {
      return true;
    }
    if (clean.trim().length < rawBuf.trim().length) {
      // Tool was stripped; allow remaining short prose through.
    } else if (findToolCallRanges(rawBuf).length === 0) {
      return true;
    }
  }

  const trimmed = rawBuf.trim();
  if (trimmed && trimmed.length <= '(tool calls)'.length && '(tool calls)'.startsWith(trimmed)) return true;

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
  if (!/"tool"\s*:\s*"/.test(tail) && !/"function"\s*:\s*"/.test(tail) && !/"\s*,\s*"params"\s*:/.test(tail)) return false;

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

const WRITE_FILE_TOOLS = new Set([
  'write_file', 'edit_file', 'create_file', 'append_to_file', 'replace_in_file',
]);

/**
 * MultiToolCard1: last tool name in a multi-tool hold buffer.
 * First-match painted update_todo while write_file bytes grew in the same rawBuf
 * (guide-main 2026-10-03T20:20:23Z update_todo×3 + write_file).
 */
function extractFormingToolName(rawBuf) {
  if (!rawBuf || typeof rawBuf !== 'string') return '';
  let last = '';
  const jsonRe = /"(?:tool|name|function)"\s*:\s*"([a-zA-Z0-9_]+)"/gi;
  let m;
  while ((m = jsonRe.exec(rawBuf)) !== null) last = m[1];
  const eqRe = /\{\s*"function\s*=\s*([a-zA-Z0-9_]+)"/gi;
  while ((m = eqRe.exec(rawBuf)) !== null) last = m[1];
  const xmlRe = /<function\s*=\s*([a-zA-Z0-9_]+)>/gi;
  while ((m = xmlRe.exec(rawBuf)) !== null) last = m[1];
  return last;
}

/** Slice from the last tool-name marker to end — params belong to the active tool only. */
function sliceCurrentToolBuf(rawBuf) {
  if (!rawBuf || typeof rawBuf !== 'string') return '';
  let lastIdx = -1;
  const markRe = /"(?:tool|name|function)"\s*:\s*"[a-zA-Z0-9_]+"|\{\s*"function\s*=\s*[a-zA-Z0-9_]+"|<function\s*=\s*[a-zA-Z0-9_]+>/gi;
  let m;
  while ((m = markRe.exec(rawBuf)) !== null) lastIdx = m.index;
  if (lastIdx < 0) return rawBuf;
  return rawBuf.slice(lastIdx);
}

/**
 * LiveParams1: structural partial params from held tool JSON so the UI is not stuck on {}.
 * Only copies completed JSON string fields (closed quotes) — never invents from English.
 * MultiToolCard1: scoped to the active (last) tool slice; filePath only on write tools.
 */
function extractFormingToolParams(rawBuf, toolName = '') {
  if (!rawBuf || typeof rawBuf !== 'string') return {};
  const slice = sliceCurrentToolBuf(rawBuf);
  const name = toolName || extractFormingToolName(rawBuf);
  const params = {};
  const takeClosedString = (key, outKey = key) => {
    const re = new RegExp('"' + key + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"');
    const m = slice.match(re);
    if (!m) return;
    try {
      params[outKey] = JSON.parse('"' + m[1] + '"');
    } catch {
      params[outKey] = m[1];
    }
  };
  // Todo / generic ids first — never pull write_file paths onto update_todo.
  takeClosedString('id');
  takeClosedString('status');
  takeClosedString('text');
  takeClosedString('command');
  takeClosedString('cmd', 'command');
  takeClosedString('query');
  takeClosedString('url');
  takeClosedString('dirPath');
  if (!name || WRITE_FILE_TOOLS.has(name)) {
    takeClosedString('filePath');
    takeClosedString('file_path', 'filePath');
    takeClosedString('path', 'filePath');
    takeClosedString('filename', 'filePath');
    const partial = extractPartialWriteFileFromToolJson(slice, { stripCompleteSuffix: true });
    if (partial?.filePath && !params.filePath) params.filePath = partial.filePath;
    if (partial?.content != null && String(partial.content).length > 0) {
      const c = String(partial.content);
      params.contentChars = c.length;
      params.contentPreview = c.length > 240 ? (c.slice(0, 240) + '\u2026') : c;
    }
  }
  return params;
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
 * While held, emit file/tool formatting surfaces so Stop is never silent (format, not hide).
 * Never shrinks or replaces visible display text (no llm-replace-last).
 */
/* ToolHoldProgress1 */
function createStripBasedStreamFilter({ onToken, channel = 'text', onStreamEvent, holdToolPayloads = true } = {}) {
  let rawBuf = '';
  let lastClean = '';
  let lastForwardedDisplay = '';
  let visibleChars = 0;
  let fileStarted = false;
  let filePath = '';
  let fileLen = 0;
  let formingToolName = '';
  let formingToolCallId = '';
  let toolCallSeq = 0;
  let holdNoticeSent = false;
  let holdStartedAt = 0;
  let lastHoldProgressAt = 0;
  const nextToolCallId = () => {
    toolCallSeq += 1;
    return `tc-${Date.now()}-${toolCallSeq}`;
  };

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
      holdNoticeSent = true;
    }
    if (!fileStarted) return;
    const content = partial.content || '';
    if (content.length > fileLen) {
      onStreamEvent('file-content-token', content.slice(fileLen));
      fileLen = content.length;
    }
  };

  const emitFormingTool = () => {
    if (!onStreamEvent || !holdToolPayloads) return;
    if (!shouldHoldToolBuffer(rawBuf)) return;
    const name = extractFormingToolName(rawBuf);
    const now = Date.now();
    if (name && name !== formingToolName) {
      formingToolName = name;
      formingToolCallId = nextToolCallId();
      holdStartedAt = now;
      lastHoldProgressAt = 0;
      onStreamEvent('tool-generating', {
        tool: name,
        toolCallId: formingToolCallId,
        forming: true,
        params: extractFormingToolParams(rawBuf, name),
      });
      holdNoticeSent = true;
    }
    // CursorParity1: no "Receiving tool output…" chat spam — tool-generating card is enough.
    if (!holdNoticeSent && !fileStarted) {
      holdNoticeSent = true;
      if (!holdStartedAt) holdStartedAt = now;
      if (name) {
        if (!formingToolCallId) formingToolCallId = nextToolCallId();
        onStreamEvent('tool-generating', { tool: name, toolCallId: formingToolCallId, forming: true });
      }
    }
    // LiveParams2: progress while holding tool JSON or streaming a file card (never silent for minutes).
    // MultiToolCard1: progressTool follows last name so write_file is not labeled update_todo.
    const progressTool = name || formingToolName || (fileStarted ? (filePath ? 'write_file' : 'tool') : '');
    if (name && name !== formingToolName) formingToolName = name;
    const shouldTickProgress = (progressTool || fileStarted || rawBuf.length > 64)
      && now - lastHoldProgressAt >= 1000;
    if (shouldTickProgress) {
      lastHoldProgressAt = now;
      const liveParams = extractFormingToolParams(rawBuf, progressTool);
      const fp = WRITE_FILE_TOOLS.has(progressTool)
        ? (liveParams.filePath || filePath || undefined)
        : undefined;
      const activeSliceLen = sliceCurrentToolBuf(rawBuf).length;
      onStreamEvent('tool-generating-progress', {
        tool: progressTool || 'tool',
        toolCallId: formingToolCallId || undefined,
        fenceChars: activeSliceLen || rawBuf.length,
        fileContentChars: fileLen > 0 ? fileLen : undefined,
        elapsedMs: holdStartedAt ? now - holdStartedAt : 0,
        filePath: fp,
        params: {
          ...liveParams,
          ...(fp && !liveParams.filePath ? { filePath: fp } : {}),
          ...(fileLen > 0 && WRITE_FILE_TOOLS.has(progressTool)
            ? { contentChars: Math.max(liveParams.contentChars || 0, fileLen) }
            : {}),
          bytesHeld: activeSliceLen || rawBuf.length,
        },
      });
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
    // Never paint forming write_file JSON even if hold briefly drops (brace-depth miss).
    if (isFormingFileWritePayload(clean)) return;
    if (clean.length < lastClean.length) {
      // Invariant: display must never shrink — keep lastClean, do not retract.
      return;
    }
    lastClean = clean;
    // ThinkFenceSilent2 / NoDupFence1: content-language fences must not paint as
    // chat CodeBlocks (Wrote file card + ```game / ```html CodeBlock twin).
    let display = onStreamEvent
      ? stripContentLanguageFencesForDisplay(clean)
      : clean;
    if (onStreamEvent) {
      const hold = trailingIncompleteFenceOpenHold(display);
      if (hold > 0) display = display.slice(0, display.length - hold);
    }
    if (display.length < lastForwardedDisplay.length) {
      // NoDupFence1: strip removed a fence that never-shrink had already painted —
      // stop forwarding more fence body; FE also strips on render.
      return;
    }
    if (display.length === lastForwardedDisplay.length) return;
    const delta = display.slice(lastForwardedDisplay.length);
    if (delta) {
      const added = forwardChunk(delta, onToken);
      visibleChars += added;
      lastForwardedDisplay = display;
    }
  };

  const sync = ({ forceFlush = false } = {}) => {
    if (holdToolPayloads && shouldHoldToolBuffer(rawBuf)) {
      emitFormingTool();
      if (!forceFlush) return;
      // Flush while still holding: paint only strip-clean prose — never raw tool JSON.
      // WriteStripLeak2: gate on *clean*, not rawBuf (rawBuf always still contains the tool).
      const clean = stripToolCallText(rawBuf);
      if (
        isFormingFileWritePayload(clean)
        || /^\s*<!doctype html/i.test(clean)
        || /^\s*<html[\s>]/i.test(clean)
      ) {
        return;
      }
      lastClean = clean;
      const display = onStreamEvent
        ? stripContentLanguageFencesForDisplay(clean)
        : clean;
      if (display.length > lastForwardedDisplay.length) {
        const added = forwardChunk(display.slice(lastForwardedDisplay.length), onToken);
        visibleChars += added;
        lastForwardedDisplay = display;
      }
      return;
    }
    if (forceFlush && holdToolPayloads && looksLikeToolAttempt(rawBuf)) {
      emitFormingTool();
      const clean = stripToolCallText(rawBuf);
      if (
        isFormingFileWritePayload(clean)
        || /^\s*<!doctype html/i.test(clean)
        || /^\s*<html[\s>]/i.test(clean)
      ) {
        return;
      }
      lastClean = clean.length >= lastClean.length ? clean : lastClean;
      const display = onStreamEvent
        ? stripContentLanguageFencesForDisplay(clean)
        : clean;
      if (display.length > lastForwardedDisplay.length) {
        const added = forwardChunk(display.slice(lastForwardedDisplay.length), onToken);
        visibleChars += added;
        lastForwardedDisplay = display;
      } else if (clean.length === 0) {
        lastClean = '';
        lastForwardedDisplay = '';
      }
      return;
    }
    forwardCleanDelta();
  };

  return {
    processChunk(chunk) {
      if (!chunk) return;
      rawBuf += chunk;
      if (!holdToolPayloads) {
        if (onToken) onToken(chunk);
        visibleChars += chunk.length;
        lastClean = rawBuf;
        lastForwardedDisplay = rawBuf;
        return;
      }
      // ThinkStreamLive1: Thought channel streams live. Hold only real tool JSON —
      // never freeze on markdown fences / outlines in reasoning_content.
      if (channel === 'thinking') {
        const toolJson = /"tool"\s*:\s*"/.test(rawBuf) || /<tool_call\b/i.test(rawBuf);
        if (toolJson && shouldHoldToolBuffer(rawBuf)) {
          // StreamLiveFix1: never silent-void the UI. emitFormingTool needs onStreamEvent;
          // createCloudStreamFilters also mirrors held bytes into the prose absorb path.
          emitFormingTool();
          return;
        }
        if (onToken) onToken(chunk);
        visibleChars += chunk.length;
        lastClean = rawBuf;
        lastForwardedDisplay = rawBuf;
        return;
      }
      emitPartialFile();
      sync();
    },
    /**
     * ThinkFenceSilent2: keep bytes for tool/file parse + file-content cards,
     * never forward to chat prose (no CodeBlock twin of write_file).
     */
    absorbSilentChunk(chunk) {
      if (!chunk) return;
      rawBuf += chunk;
      if (!holdToolPayloads) return;
      emitPartialFile();
      emitFormingTool();
      const clean = stripToolCallText(rawBuf);
      if (clean.length > lastClean.length) lastClean = clean;
    },
    flush() {
      emitPartialFile();
      endPartialFile();
      sync({ forceFlush: true });
      formingToolName = '';
      formingToolCallId = '';
      holdNoticeSent = false;
      holdStartedAt = 0;
      lastHoldProgressAt = 0;
    },
    resetRound() {
      endPartialFile();
      rawBuf = '';
      lastClean = '';
      lastForwardedDisplay = '';
      visibleChars = 0;
      formingToolName = '';
      formingToolCallId = '';
      holdNoticeSent = false;
      holdStartedAt = 0;
      lastHoldProgressAt = 0;
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
    // Must hold tool/file JSON here too — otherwise write_file leaks into Thought UI
    // (and sticky continueInThinking can route tool bytes into thinking).
    holdToolPayloads: true,
    // Cards come from prose absorb mirror only — one formingToolName clock, no double emit.
  });

  return {
    proseFilter,
    thinkingFilter,
    processContentChunk(chunk) {
      proseFilter.processChunk(chunk);
    },
    /** Diverted thinking fences/file drafts — parse + file card, no chat CodeBlock. */
    processSilentContentChunk(chunk) {
      if (typeof proseFilter.absorbSilentChunk === 'function') {
        proseFilter.absorbSilentChunk(chunk);
      } else {
        proseFilter.processChunk(chunk);
      }
    },
    processThinkingChunk(chunk) {
      thinkingFilter.processChunk(chunk);
      // StreamLiveFix1: tool JSON in reasoning_content used to vanish (no card, no parse).
      // Mirror held bytes into prose silent absorb so tools execute + UI paints.
      const buf = thinkingFilter.getRawBuffer();
      if (
        buf
        && (/"tool"\s*:\s*"/.test(buf) || /<tool_call\b/i.test(buf))
        && shouldHoldToolBuffer(buf)
      ) {
        if (typeof proseFilter.absorbSilentChunk === 'function') {
          proseFilter.absorbSilentChunk(chunk);
        }
      }
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
    // ThinkBleed1: tool JSON lives in the content/prose channel. Never parse tools from
    // prose+thinking concat — Method 1.1 used to swallow reasoning into write_file content.
    getProseRawBuffer() {
      return proseFilter.getRawBuffer();
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
  extractFormingToolName,
  extractFormingToolParams,
  sliceCurrentToolBuf,
  isFormingFileWritePayload,
};

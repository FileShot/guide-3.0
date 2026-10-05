'use strict';

/** Max consecutive no-tool continues before stop — only when the todo ledger is empty.
 *  OpenTodoNoAbort1: with open todos the host fits context and continues (never aborts mid-task).
 */
const INCOMPLETE_ROUND_CAP = 4;

/**
 * Hard cap: never continuePartial a buffer this large.
 * Live 2026-09-30 pelican: continue#3 chars=62649 → Stream timeout 900s first-byte on graysoft.dev.
 */
const CONTINUE_PARTIAL_MAX_CHARS = 12000;

/**
 * Structural tool failure (RULES §11 — no English classifiers).
 */
function toolResultFailed(toolResult) {
  if (toolResult == null) return true;
  if (typeof toolResult === 'string') {
    const s = toolResult.trim();
    if (!s) return true;
    if (/^error\b/i.test(s)) return true;
    return false;
  }
  if (typeof toolResult !== 'object') return false;
  if (toolResult.success === false) return true;
  if (toolResult.ok === false) return true;
  if (typeof toolResult.error === 'string' && toolResult.error.trim()) return true;
  const statusCode = Number(toolResult.statusCode || toolResult.status || 0);
  if (statusCode >= 400) return true;
  return false;
}

/**
 * ThinkDumpBail: reasoning channel filled with a file dump / SVG scratchpad instead of
 * a short plan. Live 2026-09-30 pelican: textLen=0 thinkingChars=22204 → bail forced
 * continue into content (Thought broke at "foot (3" / chat "74,336)") → continue#3 62k
 * hung first-byte 900s.
 *
 * Caller must NOT continuePartial these dumps (neither thinking nor content channel).
 */
function looksLikeReasoningFileDump(buf, thinkingChars = 0) {
  const s = String(buf || '');
  if (thinkingChars >= 6000) return true;
  if (s.length >= 16000) return true;
  if (s.length < 200) return false;
  if (/```(?:html|css|javascript|js|tsx?|jsx|json|svg)\b/i.test(s) && s.length >= 400) return true;
  if ((/<!DOCTYPE\s+html/i.test(s) || /<html[\s>]/i.test(s) || /<svg[\s>]/i.test(s)) && s.length >= 200) {
    return true;
  }
  const letMe = (s.match(/\bLet me write\b/gi) || []).length;
  const illWrite = (s.match(/\bI(?:'ll| will) (?:write|compose|finalize)\b/gi) || []).length;
  if (letMe + illWrite >= 3 && s.length >= 400) return true;
  const footHits = (s.match(/\bfoot\s*\(/gi) || []).length;
  const kneeHits = (s.match(/\bknee\s*\(/gi) || []).length;
  if (footHits + kneeHits >= 6 && s.length >= 800) return true;
  if (/animateTransform|circumference|px\/s/i.test(s) && s.length >= 2000) return true;
  return false;
}

/**
 * FenceAllSilent1: first markdown fence in reasoning (any lang, e.g. ```index).
 * Live 2026-10-01: ```index painted CodeBlock "index (79 lines)" beside write_file
 * because Silent2 only stripped html|svg|css|js|json.
 */
const REASONING_CONTENT_FENCE_RE = /```[A-Za-z0-9_.+-]*/;

function findReasoningContentFenceIndex(buf) {
  const str = String(buf || '');
  const m = str.match(REASONING_CONTENT_FENCE_RE);
  return m ? m.index : -1;
}

/**
 * Hold only an incomplete fence opener. Never hold ordinary prose.
 */
function trailingIncompleteFenceOpenHold(buf) {
  const str = String(buf || '');
  if (!str) return 0;
  if (/```[A-Za-z0-9_.+-]*[ \t]*\r?\n/.test(str)) return 0;
  const m = str.match(/(`{1,3}|`{3}[A-Za-z0-9_.+-]*)$/);
  if (!m) return 0;
  return m[1].length;
}

/**
 * Display path: drop ALL markdown fences when file cards own file bytes.
 */
function stripContentLanguageFencesForDisplay(text) {
  let out = String(text || '');
  if (!out) return out;
  out = out.replace(/```[A-Za-z0-9_.+-]*[^\n]*\r?\n[\s\S]*?(?:```|$)/g, '');
  const open = out.search(/```/);
  if (open >= 0) out = out.slice(0, open);
  return out;
}

/**
 * Strip first-person narration lines that leaked into a recovered fence body.
 */
function scrubNarrationLinesFromFileBody(content) {
  if (!content || typeof content !== 'string') return '';
  return content
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (/^Let me (write|carefully|finalize|compose|fill|now)\b/i.test(t)) return false;
      if (/^I(?:'ll| will) (?:write|also|now|make|finalize|produce|comm)/i.test(t)) return false;
      if (/^Alright, writing\b/i.test(t)) return false;
      if (/^One more:/i.test(t)) return false;
      if (/^For the ['"]/i.test(t) && t.length < 120 && !/[{};<>]/.test(t)) return false;
      if (/^Now the footer\b/i.test(t)) return false;
      if (/^Hamburger:\s*$/i.test(t) || /^Play \(logo\):\s*$/i.test(t)) return false;
      return true;
    })
    .join('\n');
}

/**
 * Host end rule (RULES §11 — no English / length floors):
 *
 * - Parsed tool call → not incomplete.
 * - Open todos + no tool → incomplete (Cipher always emits prose; ledger is the gate).
 *   OpenTodoNoAbort1: host MUST NOT abort the turn on INCOMPLETE_ROUND_CAP while
 *   openTodoCount > 0. Cap only stops empty-ledger incomplete loops. With open todos,
 *   caller applies context fit / silent-continue instead of break.
 * - Failed last tool batch + no next tool → incomplete (one-shot flag cleared by caller).
 * - Length stop / thinking-only / trailing thinking → incomplete.
 * - Chat prose + stop + empty ledger + no failed-batch flag → complete.
 */
function roundIsIncomplete({
  toolCount,
  proseChars = 0,
  thinkingChars = 0,
  trailingChannel = '',
  stopReason = '',
  openTodoCount = 0,
  lastToolBatchFailed = false,
}) {
  if (toolCount > 0) return false;
  if ((openTodoCount || 0) > 0) return true;
  if (lastToolBatchFailed) return true;
  if (String(stopReason || '') === 'length') return true;
  if (String(trailingChannel || '') === 'thinking') return true;
  if (!(proseChars > 0) && (thinkingChars > 0)) return true;
  return false;
}

module.exports = {
  INCOMPLETE_ROUND_CAP,
  CONTINUE_PARTIAL_MAX_CHARS,
  roundIsIncomplete,
  toolResultFailed,
  looksLikeReasoningFileDump,
  findReasoningContentFenceIndex,
  trailingIncompleteFenceOpenHold,
  stripContentLanguageFencesForDisplay,
  REASONING_CONTENT_FENCE_RE,
  scrubNarrationLinesFromFileBody,
};

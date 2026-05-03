'use strict';

/** Hard cap so “full log” mode cannot write multi‑GB lines to guide-main.log */
const ABS_MAX = 512000;

function parseBodyLimit(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return ABS_MAX;
  return Math.min(n, ABS_MAX);
}

/** User + assistant message previews in guide-main.log */
function chatLogBodyLimit() {
  return parseBodyLimit(process.env.GUIDE_CHAT_LOG_MAX_CHARS, 32000);
}

/** Tool result previews (often JSON blobs) */
function chatLogToolLimit() {
  const body = chatLogBodyLimit();
  const raw = process.env.GUIDE_CHAT_LOG_TOOL_CHARS;
  if (raw === undefined || raw === '') return Math.min(32000, body);
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return Math.min(32000, body);
  return Math.min(n, ABS_MAX);
}

module.exports = {
  chatLogBodyLimit,
  chatLogToolLimit,
  CHAT_LOG_ABS_MAX: ABS_MAX,
};

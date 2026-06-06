'use strict';

function extractRefNumber(ref) {
  if (!ref || typeof ref !== 'string') return null;
  const trimmed = ref.trim();
  let m = trimmed.match(/^\[ref\s*=\s*(\d+)\]$/);
  if (m) return parseInt(m[1], 10);
  m = trimmed.match(/^\[ref\s*=\s*["'](\d+)["']\]$/);
  if (m) return parseInt(m[1], 10);
  m = trimmed.match(/^\[(\d+)\]$/);
  if (m) return parseInt(m[1], 10);
  m = trimmed.match(/^ref=(\d+)$/);
  if (m) return parseInt(m[1], 10);
  m = trimmed.match(/^element\[(\d+)\]$/i);
  if (m) return parseInt(m[1], 10);
  m = trimmed.match(/^#ref-(\d+)$/i);
  if (m) return parseInt(m[1], 10);
  m = trimmed.match(/^#(\d+)$/);
  if (m) return parseInt(m[1], 10);
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  return null;
}

function resolveRef(ref) {
  if (!ref || typeof ref !== 'string' || !ref.trim()) return null;
  const trimmed = ref.trim();

  let m = trimmed.match(/^\[ref\s*=\s*(\d+)\]$/);
  if (m) return `[data-ref="${m[1]}"]`;
  m = trimmed.match(/^\[ref\s*=\s*["'](\d+)["']\]$/);
  if (m) return `[data-ref="${m[1]}"]`;
  m = trimmed.match(/^\[(\d+)\]$/);
  if (m) return `[data-ref="${m[1]}"]`;
  m = trimmed.match(/^ref=(\d+)$/);
  if (m) return `[data-ref="${m[1]}"]`;
  m = trimmed.match(/^element\[(\d+)\]$/i);
  if (m) return `[data-ref="${m[1]}"]`;
  m = trimmed.match(/^#ref-(\d+)$/i);
  if (m) return `[data-ref="${m[1]}"]`;
  m = trimmed.match(/^#(\d+)$/);
  if (m) return `[data-ref="${m[1]}"]`;
  if (/^\d+$/.test(trimmed)) return `[data-ref="${trimmed}"]`;
  if (/^[a-zA-Z_][a-zA-Z0-9_\-]*$/.test(trimmed)) {
    return `[name="${trimmed}"], [id="${trimmed}"], [data-ref="${trimmed}"], [placeholder="${trimmed}"]`;
  }
  if (trimmed.startsWith('//') || trimmed.startsWith('xpath=')) {
    return { type: 'xpath', selector: trimmed.startsWith('xpath=') ? trimmed.slice(6) : trimmed };
  }
  if (trimmed.startsWith('..') || trimmed.includes('>>>')) return null;
  const opens = (trimmed.match(/\[/g) || []).length;
  const closes = (trimmed.match(/\]/g) || []).length;
  if (opens !== closes) return null;
  const singleQuotes = (trimmed.match(/'/g) || []).length;
  const doubleQuotes = (trimmed.match(/"/g) || []).length;
  if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0) return null;
  return { type: 'css', selector: ref };
}

function isStaleRef(ref, refGenMap, snapshotGen) {
  const numRef = extractRefNumber(ref);
  if (numRef === null) return null;
  if (!refGenMap.has(numRef)) return null;
  if (refGenMap.get(numRef) !== snapshotGen) {
    return `Stale ref [ref=${numRef}] — this element was from a previous page. The page has changed since then. Call browser_snapshot to get fresh element refs before clicking.`;
  }
  return null;
}

function isOnionUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.endsWith('.onion');
  } catch {
    return false;
  }
}

function redactPathForLog(filePath) {
  if (!filePath || typeof filePath !== 'string') return '(empty)';
  const base = require('path').basename(filePath);
  const parent = require('path').basename(require('path').dirname(filePath));
  return `${parent}/${base}`;
}

module.exports = {
  extractRefNumber,
  resolveRef,
  isStaleRef,
  isOnionUrl,
  redactPathForLog,
};

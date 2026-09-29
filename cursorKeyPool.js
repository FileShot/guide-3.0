/**
 * Sticky Cursor API-key rotation for guIDE.
 * Stay on the active key until usage/rate limit, then advance and remember.
 * Keys live encrypted in api-keys.enc as cursor_pool (JSON array) + cursor (active).
 * Sticky index + exhaustion live in settings.json (no secrets).
 */
'use strict';

const USAGE_LIMIT_RE =
  /usage limit|spend limit|usage_limit|usage-based pricing required|rate limit|too many requests|\b429\b/i;

const RESET_DATE_RE =
  /monthly cycle ends on\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i;

function isCursorLimitError(err) {
  const msg = String(err && err.message ? err.message : err || '');
  return USAGE_LIMIT_RE.test(msg);
}

function cooldownMsFromError(err) {
  const msg = String(err && err.message ? err.message : err || '');
  const m = msg.match(RESET_DATE_RE);
  if (m) {
    const month = parseInt(m[1], 10);
    const day = parseInt(m[2], 10);
    const year = parseInt(m[3], 10);
    const resetAt = Date.UTC(year, month - 1, day, 12, 0, 0);
    const ms = resetAt - Date.now();
    if (ms > 60_000) return ms;
  }
  // Rate-limit without monthly date → short cooldown
  if (/\b429\b|rate limit|too many requests/i.test(msg) && !/usage limit|spend limit/i.test(msg)) {
    return 60_000;
  }
  // Default: 7 days (usage exhaustion without parseable reset)
  return 7 * 24 * 60 * 60 * 1000;
}

function maskKey(key) {
  const k = String(key || '');
  if (k.length < 12) return '***';
  return `${k.slice(0, 8)}…${k.slice(-4)}`;
}

class CursorKeyPool {
  /**
   * @param {object} opts
   * @param {import('./settingsManager')} opts.settingsManager
   * @param {import('./cloudLLMService')} opts.cloudLLM
   */
  constructor({ settingsManager, cloudLLM }) {
    this.sm = settingsManager;
    this.cloudLLM = cloudLLM;
  }

  /** Load pool from encrypted store into CloudLLM sticky pool. */
  hydrate() {
    const keys = this.getKeys();
    if (!keys.length) {
      const single = this.sm.getApiKey('cursor');
      if (single && single.startsWith('crsr_')) keys.push(single);
    }
    if (!keys.length) return { count: 0, activeIndex: 0 };

    // Rebuild cloudLLM pool for cursor
    this.cloudLLM._keyPools.cursor = [];
    for (const k of keys) {
      this.cloudLLM.addKeyToPool('cursor', k);
    }

    const exhausted = this.sm.get('cursorPoolExhausted') || {};
    const now = Date.now();
    const pool = this.cloudLLM._keyPools.cursor;
    for (let i = 0; i < pool.length; i++) {
      const until = Number(exhausted[String(i)] || 0);
      if (until > now) {
        pool[i].cooldownUntil = until;
      }
    }

    let idx = Number(this.sm.get('cursorPoolActiveIndex') || 0);
    if (!Number.isFinite(idx) || idx < 0 || idx >= pool.length) idx = 0;
    // Snap to first non-cooling key starting at saved idx
    idx = this._firstAvailableIndex(idx);
    this.cloudLLM._keyPoolIndex.cursor = idx;
    this.cloudLLM.apiKeys.cursor = pool[idx]?.key || keys[0];
    this.sm.set('cursorPoolActiveIndex', idx);
    console.log(
      `[CursorPool] hydrated n=${pool.length} activeIndex=${idx} key=${maskKey(pool[idx]?.key)}`
    );
    return { count: pool.length, activeIndex: idx };
  }

  getKeys() {
    const raw = this.sm.getApiKey('cursor_pool');
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((k) => String(k || '').trim())
        .filter((k) => k.startsWith('crsr_'));
    } catch (_) {
      return [];
    }
  }

  /**
   * Replace pool with these keys. Dedupes. Sets sticky index to 0.
   * Does not log raw keys.
   */
  setKeys(keys) {
    const list = [];
    const seen = new Set();
    for (const k of keys || []) {
      const t = String(k || '').trim();
      if (!t.startsWith('crsr_')) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      list.push(t);
    }
    if (!list.length) throw new Error('cursor pool: no valid crsr_ keys');

    this.sm.setApiKey('cursor_pool', JSON.stringify(list));
    this.sm.setApiKey('cursor', list[0]);
    this.sm.set('cursorPoolActiveIndex', 0);
    this.sm.set('cursorPoolExhausted', {});
    if (this.sm._keysSaveTimer) {
      clearTimeout(this.sm._keysSaveTimer);
      this.sm._keysSaveTimer = null;
    }
    this.sm._saveKeys();
    this.sm.flush();
    return this.hydrate();
  }

  _firstAvailableIndex(startIdx) {
    const pool = this.cloudLLM._keyPools.cursor || [];
    if (!pool.length) return 0;
    const now = Date.now();
    const start = ((startIdx % pool.length) + pool.length) % pool.length;
    for (let i = 0; i < pool.length; i++) {
      const idx = (start + i) % pool.length;
      if (pool[idx].disabled) continue;
      if (pool[idx].cooldownUntil > now) continue;
      return idx;
    }
    return start;
  }

  /** Sticky: return current active key without rotating. */
  getActiveKey() {
    const pool = this.cloudLLM._keyPools.cursor || [];
    if (!pool.length) {
      return this.cloudLLM.apiKeys.cursor || this.sm.getApiKey('cursor') || '';
    }
    const idx = this._firstAvailableIndex(this.cloudLLM._keyPoolIndex.cursor || 0);
    this.cloudLLM._keyPoolIndex.cursor = idx;
    this.sm.set('cursorPoolActiveIndex', idx);
    const key = pool[idx].key;
    this.cloudLLM.apiKeys.cursor = key;
    return key;
  }

  status() {
    const pool = this.cloudLLM._keyPools.cursor || [];
    const now = Date.now();
    const activeIndex = this.cloudLLM._keyPoolIndex.cursor || 0;
    return {
      total: pool.length,
      activeIndex,
      keys: pool.map((e, i) => ({
        index: i,
        mask: maskKey(e.key),
        active: i === activeIndex,
        cooling: e.cooldownUntil > now,
        cooldownUntil: e.cooldownUntil || 0,
        disabled: !!e.disabled,
      })),
    };
  }

  /**
   * Mark current key exhausted from err, advance sticky index, return next key or null.
   */
  rotateOnLimit(err, failedKey) {
    const pool = this.cloudLLM._keyPools.cursor || [];
    if (!pool.length) return null;

    const failed = String(failedKey || '').trim();
    let failIdx = pool.findIndex((e) => e.key === failed);
    if (failIdx < 0) failIdx = this.cloudLLM._keyPoolIndex.cursor || 0;

    const ms = cooldownMsFromError(err);
    pool[failIdx].cooldownUntil = Date.now() + ms;
    this.cloudLLM._cooldownPoolKey('cursor', pool[failIdx].key, ms);

    const exhausted = { ...(this.sm.get('cursorPoolExhausted') || {}) };
    exhausted[String(failIdx)] = pool[failIdx].cooldownUntil;
    this.sm.set('cursorPoolExhausted', exhausted);

    const nextIdx = this._firstAvailableIndex(failIdx + 1);
    // If next is still the same exhausted key, all keys cooling
    if (pool[nextIdx].cooldownUntil > Date.now() && nextIdx === failIdx) {
      console.warn(
        `[CursorPool] all keys cooling after ${maskKey(pool[failIdx].key)} (cooldownMs=${ms})`
      );
      this.sm.set('cursorPoolActiveIndex', failIdx);
      return null;
    }
    // If every key is cooling, still null
    const now = Date.now();
    const anyReady = pool.some((e) => !e.disabled && e.cooldownUntil <= now);
    if (!anyReady) {
      console.warn('[CursorPool] all keys exhausted/cooling');
      return null;
    }

    this.cloudLLM._keyPoolIndex.cursor = nextIdx;
    this.sm.set('cursorPoolActiveIndex', nextIdx);
    this.cloudLLM.apiKeys.cursor = pool[nextIdx].key;
    this.sm.setApiKey('cursor', pool[nextIdx].key);
    if (this.sm._keysSaveTimer) {
      clearTimeout(this.sm._keysSaveTimer);
      this.sm._keysSaveTimer = null;
    }
    this.sm._saveKeys();

    console.log(
      `[CursorPool] rotated ${maskKey(pool[failIdx].key)} → ${maskKey(pool[nextIdx].key)} ` +
        `(idx ${failIdx}→${nextIdx}, cooldownMs=${ms})`
    );
    return pool[nextIdx].key;
  }
}

module.exports = {
  CursorKeyPool,
  isCursorLimitError,
  cooldownMsFromError,
  maskKey,
};

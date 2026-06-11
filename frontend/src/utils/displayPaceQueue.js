'use strict';

/**
 * Drip queued stream items to the UI at a fixed rate (display-only pacing).
 * Preserves arrival order across text, thinking, and tool UI events.
 * @param {{
 *   tokensPerSec?: number,
 *   onFlush?: (channel: 'text'|'thinking', chunk: string) => void,
 *   onFlushEvent?: (event: string, data: unknown) => void,
 *   onTrace?: (evt: string, fields: Record<string, unknown>) => void,
 * }} opts
 */
export function createDisplayPaceQueue({ tokensPerSec = 50, onFlush, onFlushEvent, onTrace } = {}) {
  const trace = (evt, fields = {}) => { try { onTrace?.(evt, fields); } catch (_) {} };
  const charsPerSec = tokensPerSec * 4;
  /** @type {Array<{ kind: 'token', channel: 'text'|'thinking', chunk: string } | { kind: 'event', event: string, data: unknown }>} */
  let queue = [];
  let timer = null;
  let lastTick = 0;

  const flushToken = (channel, chunk) => {
    if (chunk) trace('pace-flush', { channel, chunk });
    if (chunk && onFlush) onFlush(channel, chunk);
  };

  const flushEvent = (event, data) => {
    trace('pace-flush-event', { event, data });
    if (onFlushEvent) onFlushEvent(event, data);
  };

  const tick = () => {
    if (!queue.length) {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      return;
    }
    const now = performance.now();
    const elapsed = lastTick ? (now - lastTick) / 1000 : 0;
    lastTick = now;
    let budget = Math.max(1, Math.floor(charsPerSec * Math.max(elapsed, 1 / 60)));

    while (queue.length) {
      const head = queue[0];
      if (head.kind === 'event') {
        flushEvent(head.event, head.data);
        queue.shift();
        continue;
      }
      if (head.chunk.length <= budget) {
        budget -= head.chunk.length;
        flushToken(head.channel, head.chunk);
        queue.shift();
      } else {
        const part = head.chunk.slice(0, budget);
        head.chunk = head.chunk.slice(budget);
        budget = 0;
        flushToken(head.channel, part);
      }
      if (budget <= 0) break;
    }

    if (!queue.length && timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const schedule = () => {
    if (timer) return;
    lastTick = performance.now();
    timer = setInterval(tick, 16);
  };

  return {
    enqueue(channel, text) {
      if (!text) return;
      const ch = channel === 'thinking' ? 'thinking' : 'text';
      trace('pace-enqueue', { channel: ch, chunk: text });
      queue.push({ kind: 'token', channel: ch, chunk: text });
      schedule();
    },
    enqueueEvent(event, data) {
      if (!event) return;
      trace('pace-enqueue-event', { event, data });
      queue.push({ kind: 'event', event, data });
      schedule();
    },
    flushNow() {
      trace('pace-flush-now', { pending: queue.length });
      while (queue.length) {
        const item = queue.shift();
        if (item.kind === 'event') flushEvent(item.event, item.data);
        else flushToken(item.channel, item.chunk);
      }
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    reset() {
      if (queue.length) trace('pace-drop', { reason: 'reset', items: queue });
      queue = [];
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      lastTick = 0;
    },
    pendingLength: () => queue.reduce((n, item) => {
      if (item.kind === 'event') return n + 1;
      return n + item.chunk.length;
    }, 0),
  };
}

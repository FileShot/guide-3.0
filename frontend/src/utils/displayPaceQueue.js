'use strict';

/**
 * Drip queued text to the UI at a fixed rate (display-only pacing).
 * @param {{ tokensPerSec?: number, onFlush: (chunk: string) => void }} opts
 */
export function createDisplayPaceQueue({ tokensPerSec = 50, onFlush } = {}) {
  const charsPerSec = tokensPerSec * 4;
  let queue = '';
  let timer = null;
  let lastTick = 0;

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
    const budget = Math.max(1, Math.floor(charsPerSec * Math.max(elapsed, 1 / 60)));
    const chunk = queue.slice(0, budget);
    queue = queue.slice(budget);
    if (chunk) onFlush(chunk);
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
    enqueue(text) {
      if (!text) return;
      queue += text;
      schedule();
    },
    flushNow() {
      if (queue.length) {
        const all = queue;
        queue = '';
        onFlush(all);
      }
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    reset() {
      queue = '';
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      lastTick = 0;
    },
    pendingLength: () => queue.length,
  };
}

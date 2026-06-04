'use strict';

/**
 * Drip queued stream items to the UI at a fixed rate (display-only pacing).
 * Preserves arrival order across text and thinking channels.
 * @param {{ tokensPerSec?: number, onFlush: (channel: 'text'|'thinking', chunk: string) => void }} opts
 */
export function createDisplayPaceQueue({ tokensPerSec = 50, onFlush } = {}) {
  const charsPerSec = tokensPerSec * 4;
  /** @type {{ channel: 'text'|'thinking', chunk: string }[]} */
  let queue = [];
  let timer = null;
  let lastTick = 0;

  const flushItem = (channel, chunk) => {
    if (chunk) onFlush(channel, chunk);
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

    while (budget > 0 && queue.length) {
      const head = queue[0];
      if (head.chunk.length <= budget) {
        budget -= head.chunk.length;
        flushItem(head.channel, head.chunk);
        queue.shift();
      } else {
        const part = head.chunk.slice(0, budget);
        head.chunk = head.chunk.slice(budget);
        budget = 0;
        flushItem(head.channel, part);
      }
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
      queue.push({ channel: ch, chunk: text });
      schedule();
    },
    flushNow() {
      while (queue.length) {
        const item = queue.shift();
        flushItem(item.channel, item.chunk);
      }
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    reset() {
      queue = [];
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      lastTick = 0;
    },
    pendingLength: () => queue.reduce((n, item) => n + item.chunk.length, 0),
  };
}

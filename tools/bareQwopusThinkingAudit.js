'use strict';

/**
 * Optional baseline: Qwopus 4B + node-llama-cpp only (no guIDE tool prompt / injection).
 * Compare thinking output to guIDE log (2026-06-13 21:06): ~3290 thought chars, 1–100 list spiral.
 *
 * Run: node tools/bareQwopusThinkingAudit.js
 * Skip: GUIDE_SKIP_BARE_QWOPUS=1
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const MODEL_PATH = process.env.GUIDE_QWOPUS_MODEL
  || 'D:\\models\\Jackrong\\Qwopus3.5-4B-v3-GGUF\\Qwen3.5-4B.Q4_K_S.gguf';

const USER_PROMPT = `Create a COMPLETE, FULLY PLAYABLE standalone 3D skateboarding game in HTML, CSS, and JavaScript using Three.js and a modern physics engine (Rapier preferred).

DELIVERABLES
- index.html
- style.css
- script.js
- Any additional JS modules required.

The final result should feel like a complete indie skateboarding game rather than a demo.`;

function countNumberedListLines(text) {
  return (text.match(/^\s*\d+\./gm) || []).length;
}

function detectListDegeneration(text) {
  const lines = text.split('\n').filter((l) => /^\s*\d+\./.test(l));
  if (lines.length < 30) return { degenerate: false, lines: lines.length };
  const tail = lines.slice(-20).map((l) => l.replace(/^\s*\d+\.\s*/, '').trim());
  const shortNouns = tail.filter((w) => w.length > 0 && w.length < 40 && !/[\\/]/.test(w));
  return {
    degenerate: shortNouns.length >= 15,
    lines: lines.length,
    tailSample: tail.slice(-5),
  };
}

async function main() {
  if (process.env.GUIDE_SKIP_BARE_QWOPUS === '1') {
    console.log('SKIP bareQwopusThinkingAudit (GUIDE_SKIP_BARE_QWOPUS=1)');
    return;
  }
  if (!fs.existsSync(MODEL_PATH)) {
    console.log(`SKIP bareQwopusThinkingAudit (model not found: ${MODEL_PATH})`);
    return;
  }

  const llamaCppPath = require.resolve('node-llama-cpp');
  const {
    getLlama,
    LlamaChat,
    readGgufFileInfo,
  } = await import(pathToFileURL(llamaCppPath).href);

  console.log('[bareQwopus] loading model…');
  const llama = await getLlama({ gpu: 'auto' });
  const ggufInfo = await readGgufFileInfo(MODEL_PATH);
  const model = await llama.loadModel({
    modelPath: MODEL_PATH,
    gpuLayers: Number(process.env.GUIDE_BARE_QWOPUS_GPU_LAYERS) || 29,
  });
  const context = await model.createContext({
    contextSize: { min: 2048, max: Number(process.env.GUIDE_BARE_QWOPUS_CTX) || 4096 },
    failedCreationRemedy: { retries: 3, autoContextSizeShrink: 0.5 },
  });
  const sequence = context.getSequence();
  const chat = new LlamaChat({ contextSequence: sequence, chatWrapper: 'auto' });

  let thoughtText = '';
  let proseText = '';

  const genOptions = {
    budgets: { thoughtTokens: 2048 },
    temperature: 0.6,
    topP: 0.95,
    topK: 20,
    repeatPenalty: {
      penalty: 1.12,
      presencePenalty: 1.0,
      lastTokens: 512,
    },
    onResponseChunk: (chunk) => {
      const text = chunk.text || '';
      if (chunk.type === 'segment' && chunk.segmentType === 'thought') {
        thoughtText += text;
      } else if (text) {
        proseText += text;
      }
    },
  };

  const history = [
    { type: 'system', text: 'You are a helpful coding assistant.' },
    { type: 'user', text: USER_PROMPT },
  ];

  console.log('[bareQwopus] generating (2048 think budget, agent-like sampling)…');
  const start = Date.now();
  const genTimeoutMs = Number(process.env.GUIDE_BARE_QWOPUS_TIMEOUT_MS) || 120000;
  const result = await Promise.race([
    chat.generateResponse(history, genOptions),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`generation timeout after ${genTimeoutMs}ms`)), genTimeoutMs);
    }),
  ]);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  const fullThought = thoughtText || '';
  const numbered = countNumberedListLines(fullThought);
  const deg = detectListDegeneration(fullThought);

  console.log('[bareQwopus] ─── summary ───');
  console.log(`  stopReason: ${result.metadata?.stopReason}`);
  console.log(`  elapsed: ${elapsed}s`);
  console.log(`  thoughtChars: ${fullThought.length} (guIDE log: 3290)`);
  console.log(`  proseChars: ${(proseText || result.response || '').length}`);
  console.log(`  numberedListLines: ${numbered} (guIDE log: ~100)`);
  console.log(`  listDegeneration: ${deg.degenerate} (lines=${deg.lines})`);
  if (deg.tailSample) console.log(`  tailSample: ${JSON.stringify(deg.tailSample)}`);
  console.log(`  prosePreview: ${(proseText || result.response || '').slice(0, 200)}`);

  await model.dispose?.();
}

main().catch((err) => {
  console.error('[bareQwopus] failed:', err);
  process.exit(1);
});

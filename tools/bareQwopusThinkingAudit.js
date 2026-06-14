'use strict';

/**
 * Parity baseline: Qwopus 4B + node-llama-cpp (no guIDE injection paths except optional tool catalog).
 * Compare thinking output to guIDE log (2026-06-13 21:06): ~3290 thought chars, 1–100 list spiral.
 *
 * Run: node tools/bareQwopusThinkingAudit.js
 * Matrix: GUIDE_AUDIT_MATRIX=1
 * Full skatepark prompt: GUIDE_AUDIT_USER_PROMPT=full or GUIDE_AUDIT_USER_PROMPT_FILE=path
 * Tool catalog: GUIDE_AUDIT_TOOL_PROMPT=1 (full) or GUIDE_AUDIT_COMPACT_TOOLS=1 (small-tier compact)
 * Skip: GUIDE_SKIP_BARE_QWOPUS=1
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const MODEL_PATH = process.env.GUIDE_QWOPUS_MODEL
  || 'D:\\models\\Jackrong\\Qwopus3.5-4B-v3-GGUF\\Qwen3.5-4B.Q4_K_S.gguf';

const SHORT_USER_PROMPT = `Create a COMPLETE, FULLY PLAYABLE standalone 3D skateboarding game in HTML, CSS, and JavaScript using Three.js and a modern physics engine (Rapier preferred).

DELIVERABLES
- index.html
- style.css
- script.js
- Any additional JS modules required.

The final result should feel like a complete indie skateboarding game rather than a demo.`;

const SKATEPARK_FIXTURE = path.join(__dirname, 'fixtures', 'skatepark-user-prompt.txt');

function loadUserPrompt() {
  if (process.env.GUIDE_AUDIT_USER_PROMPT_FILE) {
    return fs.readFileSync(process.env.GUIDE_AUDIT_USER_PROMPT_FILE, 'utf8').trim();
  }
  if (process.env.GUIDE_AUDIT_USER_PROMPT === 'full' || process.env.GUIDE_AUDIT_MATRIX === '1') {
    if (fs.existsSync(SKATEPARK_FIXTURE)) {
      return fs.readFileSync(SKATEPARK_FIXTURE, 'utf8').trim();
    }
  }
  return SHORT_USER_PROMPT;
}

function buildGuideToolPrompt() {
  const { MCPToolServer } = require('../mcpToolServer');
  const { resolveAgentMode, filterToolDefinitions } = require('../agentModeResolver');
  const server = new MCPToolServer({ projectPath: process.cwd() });
  const mode = resolveAgentMode({ toolsEnabled: true, agentPhase: 'building' });
  const defs = filterToolDefinitions(server.getToolDefinitions(), mode.allowedTools);
  if (process.env.GUIDE_AUDIT_COMPACT_TOOLS === '1') {
    const parts = server.getCompactToolHint('default', {
      toolDefs: defs,
      planning: false,
      compactDescriptions: true,
    });
    return { prompt: parts.join(''), mode: 'compact', chars: parts.join('').length };
  }
  const prompt = server.getToolPromptForTools(defs, { planning: false });
  return { prompt, mode: 'full', chars: prompt.length };
}

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

function buildMatrixScenarios() {
  if (process.env.GUIDE_AUDIT_MATRIX !== '1') {
    const userPrompt = loadUserPrompt();
    const withTools = process.env.GUIDE_AUDIT_TOOL_PROMPT === '1'
      || process.env.GUIDE_AUDIT_COMPACT_TOOLS === '1';
    return [{
      name: withTools ? 'custom+tools' : 'custom',
      userPrompt,
      includeTools: withTools,
      compactTools: process.env.GUIDE_AUDIT_COMPACT_TOOLS === '1',
    }];
  }
  return [
    { name: 'short-prompt', userPrompt: SHORT_USER_PROMPT, includeTools: false },
    { name: 'full-skatepark', userPrompt: fs.readFileSync(SKATEPARK_FIXTURE, 'utf8').trim(), includeTools: false },
    { name: 'full+full-tools', userPrompt: fs.readFileSync(SKATEPARK_FIXTURE, 'utf8').trim(), includeTools: true, compactTools: false },
    { name: 'full+compact-tools', userPrompt: fs.readFileSync(SKATEPARK_FIXTURE, 'utf8').trim(), includeTools: true, compactTools: true },
  ];
}

async function runScenario(chat, scenario, genOptionsBase) {
  let thoughtText = '';
  let proseText = '';
  let lastProgressLog = 0;

  const genOptions = {
    ...genOptionsBase,
    onResponseChunk: (chunk) => {
      const text = chunk.text || '';
      if (chunk.type === 'segment' && chunk.segmentType === 'thought') {
        thoughtText += text;
        if (thoughtText.length - lastProgressLog >= 500) {
          lastProgressLog = thoughtText.length;
          console.log(`[bareQwopus:${scenario.name}] thinking… ${thoughtText.length} chars`);
        }
      } else if (text) {
        proseText += text;
      }
    },
  };

  let systemText = 'You are a helpful coding assistant.';
  let toolMeta = null;
  if (scenario.includeTools) {
    process.env.GUIDE_AUDIT_COMPACT_TOOLS = scenario.compactTools ? '1' : '0';
    toolMeta = buildGuideToolPrompt();
    systemText += '\n\n' + toolMeta.prompt;
  }

  const history = [
    { type: 'system', text: systemText },
    { type: 'user', text: scenario.userPrompt },
  ];

  console.log(`[bareQwopus:${scenario.name}] userChars=${scenario.userPrompt.length}, toolChars=${toolMeta?.chars ?? 0}, toolMode=${toolMeta?.mode ?? 'none'}`);
  const start = Date.now();
  const genTimeoutMs = Number(process.env.GUIDE_BARE_QWOPUS_TIMEOUT_MS) || 600000;
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

  const summary = {
    scenario: scenario.name,
    stopReason: result.metadata?.stopReason,
    elapsedSec: Number(elapsed),
    userChars: scenario.userPrompt.length,
    toolChars: toolMeta?.chars ?? 0,
    toolMode: toolMeta?.mode ?? 'none',
    thoughtChars: fullThought.length,
    proseChars: (proseText || result.response || '').length,
    numberedListLines: numbered,
    listDegeneration: deg.degenerate,
    listLines: deg.lines,
    tailSample: deg.tailSample,
  };

  console.log(`[bareQwopus:${scenario.name}] ─── summary ───`);
  console.log(`  stopReason: ${summary.stopReason}`);
  console.log(`  elapsed: ${summary.elapsedSec}s`);
  console.log(`  thoughtChars: ${summary.thoughtChars} (guIDE log: 3290)`);
  console.log(`  proseChars: ${summary.proseChars}`);
  console.log(`  numberedListLines: ${summary.numberedListLines} (guIDE log: ~100)`);
  console.log(`  listDegeneration: ${summary.listDegeneration} (lines=${summary.listLines})`);
  if (deg.tailSample) console.log(`  tailSample: ${JSON.stringify(deg.tailSample)}`);

  return summary;
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

  const scenarios = buildMatrixScenarios();
  for (const s of scenarios) {
    if (!s.userPrompt) {
      console.log(`SKIP scenario ${s.name} — missing user prompt`);
      continue;
    }
  }

  const llamaCppPath = require.resolve('node-llama-cpp');
  const {
    getLlama,
    LlamaChat,
    readGgufFileInfo,
  } = await import(pathToFileURL(llamaCppPath).href);

  console.log('[bareQwopus] loading model…');
  const llama = await getLlama({ gpu: 'auto' });
  await readGgufFileInfo(MODEL_PATH);
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

  const genOptionsBase = {
    budgets: { thoughtTokens: 2048 },
    temperature: 0.6,
    topP: 0.95,
    topK: 20,
    repeatPenalty: {
      penalty: 1.12,
      presencePenalty: 1.0,
      lastTokens: 512,
    },
    dryRepeatPenalty: { strength: 0.8, allowedLength: 2, lastTokens: 512 },
  };

  const results = [];
  for (const scenario of scenarios) {
    if (!scenario.userPrompt) continue;
    console.log(`\n[bareQwopus] ═══ scenario: ${scenario.name} ═══`);
    try {
      results.push(await runScenario(chat, scenario, genOptionsBase));
    } catch (err) {
      console.error(`[bareQwopus:${scenario.name}] failed:`, err.message);
      results.push({ scenario: scenario.name, error: err.message });
    }
  }

  if (results.length > 1) {
    console.log('\n[bareQwopus] ═══ degeneration matrix ═══');
    console.log('scenario\tuserChars\ttoolChars\tthoughtChars\tnumberedLines\tdegenerate');
    for (const r of results) {
      if (r.error) {
        console.log(`${r.scenario}\tERROR\t${r.error}`);
      } else {
        console.log(`${r.scenario}\t${r.userChars}\t${r.toolChars}\t${r.thoughtChars}\t${r.numberedListLines}\t${r.listDegeneration}`);
      }
    }
  }

  await model.dispose?.();
}

main().catch((err) => {
  console.error('[bareQwopus] failed:', err);
  process.exit(1);
});

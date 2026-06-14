'use strict';

/**
 * Gate: compiled b9253 must load MTP + standard Qwen GGUFs (not grep-source verify).
 *
 * Run after:
 *   LLAMA_CPP_RELEASE=b9253 node scripts/rebuild-llama-runtime.mjs --profile cuda --legacy
 *   node scripts/install-compiled-llama.mjs
 *
 * Env:
 *   MTP_MODEL_4B, MTP_MODEL_9B, MTP_REGRESSION_MODEL
 *   MTP_SMOKE_GPU=cuda|auto|false
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const MTP_4B = process.env.MTP_MODEL_4B || 'D:\\Qwopus3.5-4B-Coder-MTP-Q4_K_M.gguf';
const MTP_9B = process.env.MTP_MODEL_9B || 'D:\\Qwopus3.5-9B-Coder-MTP-Q4_K_M.gguf';
const REGRESSION =
  process.env.MTP_REGRESSION_MODEL
  || 'D:\\models\\Jackrong\\Qwopus3.5-4B-v3-GGUF\\Qwen3.5-4B.Q4_K_S.gguf';

const LOG_PATH = path.join(ROOT, 'notes', 'mtp-build-log.md');

function appendLog(lines) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, `${lines.join('\n')}\n\n`, 'utf8');
}

function prebuiltsPresent() {
  const backends = path.join(ROOT, 'node_modules', '@node-llama-cpp');
  if (!fs.existsSync(backends)) return false;
  return fs.readdirSync(backends).some((n) => !n.startsWith('.'));
}

function readLlamaTag() {
  const infoPath = path.join(ROOT, 'node_modules', 'node-llama-cpp', 'llama', 'llama.cpp.info.json');
  if (!fs.existsSync(infoPath)) return '(missing info json)';
  try {
    return JSON.parse(fs.readFileSync(infoPath, 'utf8')).tag || '(no tag)';
  } catch {
    return '(parse error)';
  }
}

async function tryLoad(getLlama, label, modelPath, gpu) {
  if (!fs.existsSync(modelPath)) {
    return { label, modelPath, ok: false, skipped: true, error: 'file not found' };
  }
  const t0 = Date.now();
  try {
    const lastBuild = path.join(ROOT, 'node_modules', 'node-llama-cpp', 'llama', 'lastBuild.json');
    const llama = fs.existsSync(lastBuild)
      ? await getLlama('lastBuild', { gpu })
      : await getLlama({ gpu });
    const model = await llama.loadModel({
      modelPath,
      gpuLayers: Number(process.env.MTP_SMOKE_GPU_LAYERS) || 999,
    });
    await model.dispose();
    return { label, modelPath, ok: true, ms: Date.now() - t0 };
  } catch (err) {
    return { label, modelPath, ok: false, ms: Date.now() - t0, error: err.message };
  }
}

async function main() {
  const llamaCppPath = require.resolve('node-llama-cpp');
  const { getLlama } = await import(pathToFileURL(llamaCppPath).href);
  const gpu = process.env.MTP_SMOKE_GPU || 'cuda';

  const meta = {
    time: new Date().toISOString(),
    tag: readLlamaTag(),
    prebuiltsPresent: prebuiltsPresent(),
    lastBuild: fs.existsSync(path.join(ROOT, 'node_modules', 'node-llama-cpp', 'llama', 'lastBuild.json')),
    gpu,
  };

  console.log('[mtpLoadSmoke] meta', meta);

  const cases = [
    { label: 'MTP_4B', path: MTP_4B },
    { label: 'MTP_9B', path: MTP_9B },
    { label: 'Qwen_regression', path: REGRESSION },
  ];

  const results = [];
  for (const c of cases) {
    console.log(`[mtpLoadSmoke] loading ${c.label} …`);
    const r = await tryLoad(getLlama, c.label, c.path, gpu);
    results.push(r);
    if (r.skipped) {
      console.warn(`[mtpLoadSmoke] SKIP ${c.label}: ${r.error}`);
    } else if (r.ok) {
      console.log(`[mtpLoadSmoke] OK ${c.label} (${r.ms}ms)`);
    } else {
      console.error(`[mtpLoadSmoke] FAIL ${c.label}: ${r.error}`);
    }
  }

  const required = results.filter((r) => !r.skipped);
  const failed = required.filter((r) => !r.ok);

  appendLog([
    `## ${meta.time}`,
    `- llama tag: ${meta.tag}`,
    `- lastBuild.json: ${meta.lastBuild}`,
    `- prebuilts present: ${meta.prebuiltsPresent}`,
    `- gpu: ${meta.gpu}`,
    ...results.map((r) => `- ${r.label}: ${r.skipped ? 'SKIP' : r.ok ? `OK ${r.ms}ms` : `FAIL ${r.error}`}`),
  ]);

  if (failed.length) {
    console.error('[mtpLoadSmoke] FAILED', failed.map((f) => f.label).join(', '));
    process.exit(1);
  }
  if (required.length === 0) {
    console.error('[mtpLoadSmoke] no model files found to test');
    process.exit(1);
  }
  console.log('[mtpLoadSmoke] all required loads passed');
}

main().catch((err) => {
  console.error('[mtpLoadSmoke] fatal:', err);
  process.exit(1);
});

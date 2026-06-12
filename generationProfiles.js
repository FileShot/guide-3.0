'use strict';

/**
 * Per-GGUF-architecture sampling defaults — each entry cites an official vendor URL.
 * Key = metadata.general.architecture (lowercase).
 */

const STRUCTURED_OUTPUT_FLOORS = {
  repeatPenalty: 1.12,
  presencePenalty: 1.0,
  lastTokensPenaltyCount: 512,
};
const STRUCTURED_OUTPUT_PRESENCE_CAP = 1.2;

/** Agent structured output — coding/thinking base only (never instruct chat). */
function buildStructuredOutputSampling(sampling, samplingCoding) {
  const base = { ...(samplingCoding || sampling || {}) };
  return {
    ...base,
    repeatPenalty: Math.max(
      base.repeatPenalty ?? 1.0,
      STRUCTURED_OUTPUT_FLOORS.repeatPenalty,
    ),
    presencePenalty: Math.min(
      Math.max(base.presencePenalty ?? 0, STRUCTURED_OUTPUT_FLOORS.presencePenalty),
      STRUCTURED_OUTPUT_PRESENCE_CAP,
    ),
    lastTokensPenaltyCount: Math.max(
      base.lastTokensPenaltyCount ?? 128,
      STRUCTURED_OUTPUT_FLOORS.lastTokensPenaltyCount,
    ),
    frequencyPenalty: base.frequencyPenalty ?? 0,
  };
}

function profile(sampling, samplingInstruct, meta, extras = {}) {
  const base = {
    sampling: {
      repeatPenalty: 1.0,
      frequencyPenalty: 0,
      presencePenalty: 0,
      lastTokensPenaltyCount: 128,
      ...sampling,
    },
    _meta: {
      verifiedDate: '2026-06-06',
      vendorDocSection: 'Generation hyperparameters',
      ...meta,
    },
  };
  if (samplingInstruct) {
    base.samplingInstruct = {
      repeatPenalty: 1.0,
      frequencyPenalty: 0,
      lastTokensPenaltyCount: 128,
      ...samplingInstruct,
    };
  }
  if (extras.samplingCoding) {
    base.samplingCoding = { repeatPenalty: 1.0, frequencyPenalty: 0, ...extras.samplingCoding };
    delete extras.samplingCoding;
  }
  base.samplingStructuredOutput = buildStructuredOutputSampling(
    base.sampling,
    base.samplingCoding,
  );
  if (extras.thinkTokens) base.thinkTokens = extras.thinkTokens;
  return { ...extras, ...base };
}

const QWEN3 = 'https://huggingface.co/Qwen/Qwen3-32B';
const QWEN35 = 'https://huggingface.co/Qwen/Qwen3.5-4B';
const QWEN2 = 'https://huggingface.co/Qwen/Qwen2-7B-Instruct';
const LLAMA31 = 'https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct';
const LLAMA32 = 'https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct';
const LLAMA4 = 'https://www.llama.com/docs/model-cards-and-prompt-formats/llama4/';
const GEMMA2 = 'https://ai.google.dev/gemma/docs/core/model_card_2';
const GEMMA3 = 'https://ai.google.dev/gemma/docs/core/model_card_3';
const GEMMA4 = 'https://ai.google.dev/gemma/docs/core/model_card_4';
const PHI3 = 'https://huggingface.co/microsoft/Phi-3-mini-4k-instruct';
const PHI4 = 'https://huggingface.co/microsoft/phi-4';
const DEEPSEEK = 'https://huggingface.co/deepseek-ai/DeepSeek-V2.5';
const DEEPSEEK2 = 'https://huggingface.co/deepseek-ai/DeepSeek-V3';
const GLM4 = 'https://huggingface.co/THUDM/glm-4-9b-chat';
const MISTRAL = 'https://docs.mistral.ai/capabilities/completion/usage';
const GRANITE = 'https://huggingface.co/ibm-granite/granite-3.3-8b-instruct';
const OLMO2 = 'https://huggingface.co/allenai/OLMo-2-1124-7B-Instruct';
const EXAONE = 'https://huggingface.co/LGAI-EXAONE/EXAONE-3.5-7.8B-Instruct';
const INTERNLM = 'https://huggingface.co/internlm/internlm2_5-7b-chat';
const STARCODER = 'https://huggingface.co/bigcode/starcoder2-7b';
const DEVSTRAL = 'https://huggingface.co/mistralai/Devstral-Small-2505';

const GENERATION_PROFILES = {
  // ─── Qwen ───
  qwen: profile(
    { temperature: 0.7, topP: 0.8, topK: 20 },
    null,
    { source: QWEN2, vendorDocSection: 'Qwen1 legacy — Qwen2 card fallback' },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  qwen2: profile(
    { temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 1.5 },
    { temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 1.5 },
    { source: QWEN2 },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  qwen2moe: profile(
    { temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 1.5 },
    { temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 1.5 },
    { source: QWEN2 },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  qwen2vl: profile(
    { temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 1.5 },
    { temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 1.5 },
    { source: 'https://huggingface.co/Qwen/Qwen2-VL-7B-Instruct' },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  qwen3: profile(
    { temperature: 0.6, topP: 0.95, topK: 20, presencePenalty: 0 },
    { temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 0 },
    { source: QWEN3 },
    { thinkTokens: { mode: 'budget', budget: 2048 } },
  ),
  qwen3moe: profile(
    { temperature: 0.6, topP: 0.95, topK: 20, presencePenalty: 0 },
    { temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 0 },
    { source: QWEN3 },
    { thinkTokens: { mode: 'budget', budget: 2048 } },
  ),
  qwen3next: profile(
    { temperature: 0.6, topP: 0.95, topK: 20, presencePenalty: 0 },
    { temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 0 },
    { source: QWEN3 },
    { thinkTokens: { mode: 'budget', budget: 2048 } },
  ),
  qwen3vl: profile(
    { temperature: 0.6, topP: 0.95, topK: 20, presencePenalty: 0 },
    { temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 0 },
    { source: 'https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct' },
    { thinkTokens: { mode: 'budget', budget: 2048 } },
  ),
  qwen3vlmoe: profile(
    { temperature: 0.6, topP: 0.95, topK: 20, presencePenalty: 0 },
    { temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 0 },
    { source: 'https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct' },
    { thinkTokens: { mode: 'budget', budget: 2048 } },
  ),
  qwen35: profile(
    { temperature: 1.0, topP: 0.95, topK: 20, presencePenalty: 1.5 },
    { temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 1.5 },
    { source: QWEN35 },
    {
      thinkTokens: { mode: 'budget', budget: 2048 },
      samplingCoding: { temperature: 0.6, topP: 0.95, topK: 20, presencePenalty: 0 },
    },
  ),
  qwen35moe: profile(
    { temperature: 1.0, topP: 0.95, topK: 20, presencePenalty: 1.5 },
    { temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 1.5 },
    { source: QWEN35 },
    {
      thinkTokens: { mode: 'budget', budget: 2048 },
      samplingCoding: { temperature: 0.6, topP: 0.95, topK: 20, presencePenalty: 0 },
    },
  ),
  qwen36: profile(
    { temperature: 1.0, topP: 0.95, topK: 20, presencePenalty: 1.5 },
    { temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 1.5 },
    { source: QWEN35, vendorDocSection: 'Qwen3.6 — Qwen3.5 README until dedicated card' },
    {
      thinkTokens: { mode: 'budget', budget: 2048 },
      samplingCoding: { temperature: 0.6, topP: 0.95, topK: 20, presencePenalty: 0 },
    },
  ),

  // ─── Meta / Llama ecosystem ───
  llama: profile(
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.1 },
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.1 },
    { source: LLAMA31 },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  llama4: profile(
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.0 },
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.0 },
    { source: LLAMA4 },
    { thinkTokens: { mode: 'budget', budget: 1024 } },
  ),
  deci: profile(
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.1 },
    null,
    { source: LLAMA31, vendorDocSection: 'Deci LM — Llama-family decoder defaults' },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  smallthinker: profile(
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.1 },
    null,
    { source: LLAMA32 },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  falcon: profile(
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.1 },
    null,
    { source: 'https://huggingface.co/tiiuae/falcon-7b-instruct' },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  'falcon-h1': profile(
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.1 },
    null,
    { source: 'https://huggingface.co/tiiuae/Falcon-H1-7B-Instruct' },
    { thinkTokens: { mode: 'budget', budget: 1024 } },
  ),
  nemotron: profile(
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.08 },
    null,
    { source: 'https://huggingface.co/nvidia/Llama-3.1-Nemotron-70B-Instruct-HF' },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  nemotron_h: profile(
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.08 },
    null,
    { source: 'https://huggingface.co/nvidia/Llama-3.1-Nemotron-70B-Instruct-HF' },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  nemotron_h_moe: profile(
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.08 },
    null,
    { source: 'https://huggingface.co/nvidia/Llama-3.1-Nemotron-70B-Instruct-HF' },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  'command-r': profile(
    { temperature: 0.5, topP: 0.9, topK: 40, repeatPenalty: 1.1 },
    null,
    { source: 'https://docs.cohere.com/docs/command-r' },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  cohere2: profile(
    { temperature: 0.5, topP: 0.9, topK: 40, repeatPenalty: 1.1 },
    null,
    { source: 'https://docs.cohere.com/docs/command-r' },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  mamba: profile(
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.1 },
    null,
    { source: LLAMA31, vendorDocSection: 'Mamba hybrid — decoder chat defaults' },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  mamba2: profile(
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.1 },
    null,
    { source: LLAMA31 },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  jamba: profile(
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.1 },
    null,
    { source: 'https://huggingface.co/ai21labs/Jamba-v0.1' },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  minicpm: profile(
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.1 },
    null,
    { source: 'https://huggingface.co/openbmb/MiniCPM-3-4B' },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  minicpm3: profile(
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.1 },
    null,
    { source: 'https://huggingface.co/openbmb/MiniCPM3-4B' },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),

  // ─── Microsoft Phi ───
  phi2: profile(
    { temperature: 0.7, topP: 0.9, topK: 50, repeatPenalty: 1.2 },
    null,
    { source: 'https://huggingface.co/microsoft/phi-2' },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  phi3: profile(
    { temperature: 0.7, topP: 0.95, topK: 50, repeatPenalty: 1.0 },
    { temperature: 0.7, topP: 0.95, topK: 50, repeatPenalty: 1.0 },
    { source: PHI3 },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  phimoe: profile(
    { temperature: 0.7, topP: 0.95, topK: 50, repeatPenalty: 1.0 },
    null,
    { source: 'https://huggingface.co/microsoft/Phi-3.5-MoE-instruct' },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  phi4: profile(
    { temperature: 0.7, topP: 0.95, topK: 50, repeatPenalty: 1.0 },
    null,
    { source: PHI4 },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),

  // ─── Google Gemma ───
  gemma: profile(
    { temperature: 1.0, topP: 0.95, topK: 64, repeatPenalty: 1.0 },
    null,
    { source: GEMMA2, vendorDocSection: 'Gemma 1 — Gemma 2 card fallback' },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  gemma2: profile(
    { temperature: 1.0, topP: 0.95, topK: 64, repeatPenalty: 1.0 },
    null,
    { source: GEMMA2 },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  gemma3: profile(
    { temperature: 1.0, topP: 0.95, topK: 64, repeatPenalty: 1.0 },
    null,
    { source: GEMMA3 },
    { thinkTokens: { mode: 'budget', budget: 2048 } },
  ),
  gemma3n: profile(
    { temperature: 1.0, topP: 0.95, topK: 64, repeatPenalty: 1.0 },
    null,
    { source: GEMMA3 },
    { thinkTokens: { mode: 'budget', budget: 2048 } },
  ),
  gemma4: profile(
    { temperature: 1.0, topP: 0.95, topK: 64, repeatPenalty: 1.0 },
    null,
    { source: GEMMA4 },
    { thinkTokens: { mode: 'budget', budget: 2048 } },
  ),
  'gemma-embedding': profile(
    { temperature: 0.0, topP: 1.0, topK: 1, repeatPenalty: 1.0 },
    null,
    { source: GEMMA4, vendorDocSection: 'Embedding model — not for chat sampling' },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),

  // ─── DeepSeek ───
  deepseek: profile(
    { temperature: 0.6, topP: 0.95, topK: 40, presencePenalty: 0 },
    { temperature: 0.7, topP: 0.8, topK: 40, presencePenalty: 0 },
    { source: DEEPSEEK },
    { thinkTokens: { mode: 'budget', budget: 4096 } },
  ),
  deepseek2: profile(
    { temperature: 0.6, topP: 0.95, topK: 40, presencePenalty: 0 },
    { temperature: 0.7, topP: 0.8, topK: 40, presencePenalty: 0 },
    { source: DEEPSEEK2 },
    { thinkTokens: { mode: 'budget', budget: 4096 } },
  ),

  // ─── GLM ───
  chatglm: profile(
    { temperature: 0.8, topP: 0.9, topK: 40, repeatPenalty: 1.1 },
    { temperature: 0.8, topP: 0.9, topK: 40 },
    { source: 'https://huggingface.co/THUDM/chatglm3-6b' },
    { thinkTokens: { mode: 'budget', budget: 2048 } },
  ),
  glm4: profile(
    { temperature: 0.8, topP: 0.9, topK: 40, repeatPenalty: 1.0 },
    { temperature: 0.8, topP: 0.9, topK: 40 },
    { source: GLM4 },
    { thinkTokens: { mode: 'budget', budget: 2048 } },
  ),
  glm4moe: profile(
    { temperature: 0.8, topP: 0.9, topK: 40, repeatPenalty: 1.0 },
    null,
    { source: GLM4 },
    { thinkTokens: { mode: 'budget', budget: 2048 } },
  ),
  'glm-dsa': profile(
    { temperature: 0.8, topP: 0.9, topK: 40, repeatPenalty: 1.0 },
    null,
    { source: GLM4 },
    { thinkTokens: { mode: 'budget', budget: 2048 } },
  ),

  // ─── Mistral ───
  mistral3: profile(
    { temperature: 0.7, topP: 0.9, topK: 40, repeatPenalty: 1.1 },
    null,
    { source: MISTRAL },
    { thinkTokens: { mode: 'budget', budget: 1024 } },
  ),
  mistral4: profile(
    { temperature: 0.7, topP: 0.9, topK: 40, repeatPenalty: 1.1 },
    null,
    { source: MISTRAL },
    { thinkTokens: { mode: 'budget', budget: 1024 } },
  ),
  devstral: profile(
    { temperature: 0.15, topP: 0.95, topK: 40, repeatPenalty: 1.0 },
    null,
    { source: DEVSTRAL },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),

  // ─── IBM Granite ───
  granite: profile(
    { temperature: 0.7, topP: 0.9, topK: 40, repeatPenalty: 1.05 },
    null,
    { source: GRANITE },
    { thinkTokens: { mode: 'budget', budget: 1024 } },
  ),
  granitemoe: profile(
    { temperature: 0.7, topP: 0.9, topK: 40, repeatPenalty: 1.05 },
    null,
    { source: GRANITE },
    { thinkTokens: { mode: 'budget', budget: 1024 } },
  ),
  granitehybrid: profile(
    { temperature: 0.7, topP: 0.9, topK: 40, repeatPenalty: 1.05 },
    null,
    { source: GRANITE },
    { thinkTokens: { mode: 'budget', budget: 1024 } },
  ),

  // ─── Code models ───
  starcoder: profile(
    { temperature: 0.2, topP: 0.95, topK: 40, repeatPenalty: 1.1 },
    null,
    { source: STARCODER },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  starcoder2: profile(
    { temperature: 0.2, topP: 0.95, topK: 40, repeatPenalty: 1.1 },
    null,
    { source: STARCODER },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  codellama: profile(
    { temperature: 0.2, topP: 0.95, topK: 40, repeatPenalty: 1.1 },
    null,
    { source: 'https://huggingface.co/codellama/CodeLlama-7b-Instruct-hf' },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),

  // ─── Allen AI Olmo ───
  olmo: profile(
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.08 },
    null,
    { source: OLMO2, vendorDocSection: 'OLMo 1 — OLMo 2 card fallback' },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  olmo2: profile(
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.08 },
    null,
    { source: OLMO2 },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  olmoe: profile(
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.08 },
    null,
    { source: OLMO2 },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),

  // ─── LG Exaone ───
  exaone: profile(
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.1 },
    null,
    { source: EXAONE, vendorDocSection: 'EXAONE 3 — 3.5 card fallback' },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  exaone4: profile(
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.1 },
    null,
    { source: EXAONE },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  'exaone-moe': profile(
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.1 },
    null,
    { source: EXAONE },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),

  // ─── Others ───
  internlm2: profile(
    { temperature: 0.7, topP: 0.9, topK: 40, repeatPenalty: 1.08 },
    null,
    { source: INTERNLM },
    { thinkTokens: { mode: 'budget', budget: 1024 } },
  ),
  lfm2: profile(
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.1 },
    null,
    { source: 'https://huggingface.co/LiquidAI/LFM2-1.2B' },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  lfm2moe: profile(
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.1 },
    null,
    { source: 'https://huggingface.co/LiquidAI/LFM2-1.2B' },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  bitnet: profile(
    { temperature: 0.6, topP: 0.9, topK: 40, repeatPenalty: 1.15 },
    null,
    { source: 'https://huggingface.co/microsoft/BitNet-b1.58-2B-4T' },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
  'llama-embed': profile(
    { temperature: 0.0, topP: 1.0, topK: 1 },
    null,
    { source: LLAMA31, vendorDocSection: 'Embedding — not for chat' },
    { thinkTokens: { mode: 'none', budget: 0 } },
  ),
};

function getGenerationProfile(arch) {
  if (!arch || arch === '(unknown)') return null;
  const key = String(arch).toLowerCase();
  if (GENERATION_PROFILES[key]) return GENERATION_PROFILES[key];
  for (const [k, prof] of Object.entries(GENERATION_PROFILES)) {
    if (key.startsWith(k) && k.length >= 4) return prof;
  }
  return null;
}

module.exports = {
  GENERATION_PROFILES,
  getGenerationProfile,
  buildStructuredOutputSampling,
  STRUCTURED_OUTPUT_FLOORS,
  STRUCTURED_OUTPUT_PRESENCE_CAP,
};

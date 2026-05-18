'use strict';

const path = require('path');

/**
 * Map from GGUF metadata.general.architecture strings to guIDE model profile family keys.
 * This is the authoritative detection method — GGUF architecture is always correct.
 * Any architecture not in this map falls through to filename detection.
 */
const GGUF_ARCH_TO_FAMILY = {
  // Llama family
  llama: 'llama', llama4: 'llama', deci: 'llama', 'llama-embed': 'llama', smallthinker: 'llama',
  // Qwen family
  qwen: 'qwen', qwen2: 'qwen', qwen2moe: 'qwen', qwen2vl: 'qwen',
  qwen3: 'qwen', qwen3moe: 'qwen', qwen3next: 'qwen', qwen3vl: 'qwen', qwen3vlmoe: 'qwen',
  qwen35: 'qwen', qwen35moe: 'qwen',
  // Phi family
  phi2: 'phi', phi3: 'phi', phimoe: 'phi',
  // Gemma family
  gemma: 'gemma', gemma2: 'gemma', gemma3: 'gemma', gemma3n: 'gemma', 'gemma-embedding': 'gemma',
  gemma4: 'gemma',
  // DeepSeek family
  deepseek: 'deepseek', deepseek2: 'deepseek',
  // GLM family
  chatglm: 'glm', glm4: 'glm', glm4moe: 'glm', 'glm-dsa': 'glm',
  // Mistral family
  mistral3: 'mistral', mistral4: 'mistral',
  // Starcoder family
  starcoder: 'starcoder', starcoder2: 'starcoder',
  // Granite family
  granite: 'granite', granitemoe: 'granite', granitehybrid: 'granite',
  // InternLM family
  internlm2: 'internlm',
  // Olmo family
  olmo: 'olmo', olmo2: 'olmo', olmoe: 'olmo',
  // Exaone family
  exaone: 'exaone', exaone4: 'exaone', 'exaone-moe': 'exaone',
  // Bitnet family
  bitnet: 'bitnet',
  // LFM family
  lfm2: 'lfm', lfm2moe: 'lfm',
  // Falcon — uses llama profile (similar decoder-only arch)
  falcon: 'llama', 'falcon-h1': 'llama',
  // Nemotron — uses llama profile
  nemotron: 'llama', nemotron_h: 'llama', nemotron_h_moe: 'llama',
  // Command-R / Cohere — uses llama profile
  'command-r': 'llama', cohere2: 'llama',
  // Jamba / Mamba — uses llama profile
  mamba: 'llama', mamba2: 'llama', jamba: 'llama',
  // MiniCPM — uses llama profile
  minicpm: 'llama', minicpm3: 'llama',
  // Devstral
  devstral: 'devstral',
};

/**
 * Detect model family from GGUF metadata.general.architecture string.
 * Returns a lowercase family string or null if architecture is unknown/unmapped.
 */
function detectFamilyFromArch(archString) {
  if (!archString || archString === '(unknown)') return null;
  const mapped = GGUF_ARCH_TO_FAMILY[archString];
  if (mapped) return mapped;
  // Fuzzy prefix fallback: e.g. unknown future "qwen4" → "qwen"
  for (const [arch, family] of Object.entries(GGUF_ARCH_TO_FAMILY)) {
    if (archString.startsWith(arch)) return family;
  }
  return null;
}

/**
 * Detect the model family from a GGUF filename.
 * Returns a lowercase family string or 'unknown'.
 * Used as fallback when GGUF architecture metadata is unavailable.
 */
function detectFamily(modelPath) {
  if (!modelPath) return 'unknown';
  const base = path.basename(modelPath).toLowerCase();

  const families = [
    ['devstral', 'devstral'],
    ['deepseek', 'deepseek'],
    ['qwen', 'qwen'],
    ['codellama', 'codellama'],
    ['llama', 'llama'],
    ['phi', 'phi'],
    ['gemma', 'gemma'],
    ['glm', 'glm'],
    ['mistral', 'mistral'],
    ['mixtral', 'mistral'],
    ['granite', 'granite'],
    ['internlm', 'internlm'],
    ['yi-', 'yi'],
    ['starcoder', 'starcoder'],
    ['lfm', 'lfm'],
    ['nanbeige', 'nanbeige'],
    ['bitnet', 'bitnet'],
    ['exaone', 'exaone'],
    ['olmo', 'olmo'],
    ['gpt', 'gpt'],
  ];

  for (const [pattern, family] of families) {
    if (base.includes(pattern)) return family;
  }
  return 'unknown';
}

/**
 * Detect the parameter count (in billions) from a GGUF filename.
 * Returns a number (e.g. 0.6, 4, 70) or 0 if unknown.
 */
function detectParamSize(modelPath) {
  if (!modelPath) return 0;
  const base = path.basename(modelPath).toLowerCase();

  // Primary: parse parameter count from filename using regex
  // Handles patterns like: 7b, 0.6B, 14B, 1.5B, 70b, 2.7b, 0.5b, 405b, etc.
  const match = base.match(/(\d+\.?\d*)\s*[bm]/i);
  if (match) {
    const val = parseFloat(match[1]);
    // 'm' suffix means millions → convert to billions
    if (match[0].toLowerCase().endsWith('m')) return val / 1000;
    return val;
  }

  // Fallback: version-based size inference for models whose filenames
  // don't include the parameter count (e.g. phi-4-mini without "3.8b")
  const versionFallbacks = [
    { pattern: 'phi-4-mini', size: 3.8 },
    { pattern: 'phi-4', size: 14 },
    { pattern: 'phi-3-mini', size: 3.8 },
    { pattern: 'phi-3-medium', size: 14 },
    { pattern: 'phi-3-small', size: 7 },
    { pattern: 'phi-2', size: 2.7 },
  ];
  for (const { pattern, size } of versionFallbacks) {
    if (base.includes(pattern)) return size;
  }

  return 0;
}

/**
 * Detect whether a model is an LLM or a diffusion model (SD/FLUX/etc.).
 * Returns 'diffusion' or 'llm'.
 */
function detectModelType(modelPath) {
  if (!modelPath) return 'llm';
  const base = path.basename(modelPath).toLowerCase();
  const diffusionPatterns = ['stable-diffusion', 'sd_', 'sd-', 'sdxl', 'flux', 'controlnet', 'vae'];
  for (const p of diffusionPatterns) {
    if (base.includes(p)) return 'diffusion';
  }
  return 'llm';
}

module.exports = { detectFamily, detectFamilyFromArch, detectParamSize, detectModelType };

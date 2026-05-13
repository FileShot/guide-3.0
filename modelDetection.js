'use strict';

const path = require('path');

/**
 * Detect the model family from a GGUF filename.
 * Returns a lowercase family string or 'unknown'.
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

module.exports = { detectFamily, detectParamSize, detectModelType };

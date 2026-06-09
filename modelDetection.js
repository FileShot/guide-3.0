'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

/**
 * Map from GGUF metadata.general.architecture strings to guIDE model profile family keys.
 * Profile sampling uses GENERATION_PROFILES keyed on raw arch; this map is for display/legacy tier overrides.
 */
const GGUF_ARCH_TO_FAMILY = {
  llama: 'llama', llama4: 'llama', deci: 'llama', 'llama-embed': 'llama', smallthinker: 'llama',
  qwen: 'qwen', qwen2: 'qwen', qwen2moe: 'qwen', qwen2vl: 'qwen',
  qwen3: 'qwen', qwen3moe: 'qwen', qwen3next: 'qwen', qwen3vl: 'qwen', qwen3vlmoe: 'qwen',
  qwen35: 'qwen', qwen35moe: 'qwen', qwen36: 'qwen',
  phi2: 'phi', phi3: 'phi', phi4: 'phi', phimoe: 'phi',
  gemma: 'gemma', gemma2: 'gemma', gemma3: 'gemma', gemma3n: 'gemma', 'gemma-embedding': 'gemma',
  gemma4: 'gemma',
  deepseek: 'deepseek', deepseek2: 'deepseek',
  chatglm: 'glm', glm4: 'glm', glm4moe: 'glm', 'glm-dsa': 'glm',
  mistral3: 'mistral', mistral4: 'mistral',
  starcoder: 'starcoder', starcoder2: 'starcoder', codellama: 'codellama',
  granite: 'granite', granitemoe: 'granite', granitehybrid: 'granite',
  internlm2: 'internlm',
  olmo: 'olmo', olmo2: 'olmo', olmoe: 'olmo',
  exaone: 'exaone', exaone4: 'exaone', 'exaone-moe': 'exaone',
  bitnet: 'bitnet',
  lfm2: 'lfm', lfm2moe: 'lfm',
  falcon: 'llama', 'falcon-h1': 'llama',
  nemotron: 'llama', nemotron_h: 'llama', nemotron_h_moe: 'llama',
  'command-r': 'llama', cohere2: 'llama',
  mamba: 'llama', mamba2: 'llama', jamba: 'llama',
  minicpm: 'llama', minicpm3: 'llama',
  devstral: 'devstral',
};

/** GGUF general.architecture values for diffusion/image models */
const DIFFUSION_ARCHITECTURES = new Set([
  'flux', 'flux2', 'sd', 'sd2', 'sd2.5', 'sd3', 'stable-diffusion', 'stable_diffusion',
  'sdxl', 'vae', 'controlnet', 'unet',
  // Lumina / Z-Image and related image diffusion arches
  'lumina', 'lumina2', 'lumina-mgpt', 'z-image', 'zimage',
  'pixart', 'pixart-alpha', 'pixart-sigma', 'aura', 'kolors', 'sana', 'chroma', 'chroma-radiance',
  'dit', 'hidream', 'omnigen', 'qwen-image',
]);

/** Video generation architectures (extend when confirmed from real GGUF files) */
const VIDEO_ARCHITECTURES = new Set([
  'wan', 'wan2', 'cogvideox', 'cogvideo', 'ltx', 'hunyuan-video', 'mochi',
]);

const _ggufMetaCache = new Map();

function detectFamilyFromArch(archString) {
  if (!archString || archString === '(unknown)') return null;
  const key = String(archString).toLowerCase();
  const mapped = GGUF_ARCH_TO_FAMILY[key];
  if (mapped) return mapped;
  for (const [arch, family] of Object.entries(GGUF_ARCH_TO_FAMILY)) {
    if (key.startsWith(arch)) return family;
  }
  return null;
}

function detectFamily(modelPath) {
  if (!modelPath) return 'unknown';
  const base = path.basename(modelPath).toLowerCase();
  const families = [
    ['devstral', 'devstral'], ['deepseek', 'deepseek'], ['qwen', 'qwen'],
    ['codellama', 'codellama'], ['llama', 'llama'], ['phi', 'phi'],
    ['gemma', 'gemma'], ['glm', 'glm'], ['mistral', 'mistral'],
    ['mixtral', 'mistral'], ['granite', 'granite'], ['internlm', 'internlm'],
    ['yi-', 'yi'], ['starcoder', 'starcoder'], ['lfm', 'lfm'],
    ['nanbeige', 'nanbeige'], ['bitnet', 'bitnet'], ['exaone', 'exaone'],
    ['olmo', 'olmo'], ['gpt', 'gpt'],
  ];
  for (const [pattern, family] of families) {
    if (base.includes(pattern)) return family;
  }
  return 'unknown';
}

function detectParamSize(modelPath) {
  if (!modelPath) return 0;
  const base = path.basename(modelPath).toLowerCase();
  const match = base.match(/(\d+\.?\d*)\s*[bm]/i);
  if (match) {
    const val = parseFloat(match[1]);
    if (match[0].toLowerCase().endsWith('m')) return val / 1000;
    return val;
  }
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
 * Classify model type from GGUF metadata (authoritative).
 * @returns {'llm'|'diffusion'|'video'|'unknown'}
 */
function detectModelTypeFromGguf(metadata) {
  const arch = (metadata?.general?.architecture || '').toLowerCase();
  if (!arch) return 'unknown';
  if (DIFFUSION_ARCHITECTURES.has(arch)) return 'diffusion';
  for (const d of DIFFUSION_ARCHITECTURES) {
    if (arch.startsWith(d)) return 'diffusion';
  }
  if (VIDEO_ARCHITECTURES.has(arch)) return 'video';
  for (const v of VIDEO_ARCHITECTURES) {
    if (arch.startsWith(v)) return 'video';
  }
  if (detectFamilyFromArch(arch)) return 'llm';
  if (metadata?.[arch]?.block_count != null || metadata?.[`${arch}.block_count`] != null) {
    return 'llm';
  }
  return 'unknown';
}

async function readGgufMetadata(modelPath) {
  if (!modelPath) return null;
  if (_ggufMetaCache.has(modelPath)) return _ggufMetaCache.get(modelPath);
  try {
    const llamaCppPath = require.resolve('node-llama-cpp');
    const { readGgufFileInfo } = await import(pathToFileURL(llamaCppPath).href);
    const gguf = await readGgufFileInfo(modelPath, { readTensorInfo: false, logWarnings: false });
    const meta = gguf.metadata || {};
    _ggufMetaCache.set(modelPath, meta);
    return meta;
  } catch (e) {
    _ggufMetaCache.set(modelPath, null);
    return null;
  }
}

async function detectModelType(modelPath) {
  const meta = await readGgufMetadata(modelPath);
  if (!meta) return 'unknown';
  return detectModelTypeFromGguf(meta);
}

function clearGgufMetadataCache() {
  _ggufMetaCache.clear();
}

module.exports = {
  GGUF_ARCH_TO_FAMILY,
  DIFFUSION_ARCHITECTURES,
  VIDEO_ARCHITECTURES,
  detectFamily,
  detectFamilyFromArch,
  detectParamSize,
  detectModelType,
  detectModelTypeFromGguf,
  readGgufMetadata,
  clearGgufMetadataCache,
};

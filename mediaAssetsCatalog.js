'use strict';

/**
 * Bundled / cached auxiliary files for stable-diffusion.cpp.
 * Diffusion/video GGUFs are weights only — VAE and text encoders ship separately.
 */

const LUMINA_ARCHS = new Set(['lumina', 'lumina2', 'lumina-mgpt', 'z-image', 'zimage']);
const FLUX_ARCHS = new Set(['flux', 'flux2', 'chroma', 'chroma-radiance']);
const WAN_ARCHS = new Set(['wan', 'wan2']);

/** @type {Record<string, { id: string, relPath: string, url: string, bytes: number }[]>} */
const MEDIA_ASSET_PROFILES = {
  'lumina-image': {
    label: 'Z-Image / Lumina image',
    assets: [
      {
        id: 'flux-ae-vae',
        relPath: 'image/ae.safetensors',
        url: 'https://huggingface.co/black-forest-labs/FLUX.1-schnell/resolve/main/ae.safetensors',
        bytes: 335_644_682,
      },
      {
        id: 'qwen3-4b-llm',
        relPath: 'image/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
        url: 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
        bytes: 2_492_781_248,
      },
    ],
    auxKeys: { vae: 'flux-ae-vae', llm: 'qwen3-4b-llm' },
  },
  'wan-video': {
    label: 'Wan video',
    assets: [
      {
        id: 'wan-tae',
        relPath: 'wan/taew2_2.safetensors',
        url: 'https://github.com/madebyollin/taehv/raw/refs/heads/main/safetensors/taew2_2.safetensors',
        bytes: 0,
      },
      {
        id: 'umt5-xxl',
        relPath: 'wan/umt5-xxl-encoder-Q3_K_S.gguf',
        url: 'https://huggingface.co/city96/umt5-xxl-encoder-gguf/resolve/main/umt5-xxl-encoder-Q3_K_S.gguf',
        bytes: 2_858_489_696,
      },
    ],
    auxKeys: { tae: 'wan-tae', t5: 'umt5-xxl' },
  },
  'flux-image': {
    label: 'Flux image',
    assets: [
      {
        id: 'flux-ae-vae',
        relPath: 'image/ae.safetensors',
        url: 'https://huggingface.co/black-forest-labs/FLUX.1-schnell/resolve/main/ae.safetensors',
        bytes: 335_644_682,
      },
    ],
    auxKeys: { vae: 'flux-ae-vae' },
  },
};

function archToMediaProfile(arch, modelType) {
  const a = (arch || '').toLowerCase();
  if (modelType === 'video' || WAN_ARCHS.has(a) || a.startsWith('wan')) return 'wan-video';
  if (LUMINA_ARCHS.has(a) || a.startsWith('lumina') || a.includes('z-image') || a.includes('zimage')) {
    return 'lumina-image';
  }
  if (FLUX_ARCHS.has(a) || a.includes('flux')) return 'flux-image';
  return null;
}

function listAssetsForProfile(profileId) {
  return MEDIA_ASSET_PROFILES[profileId]?.assets || [];
}

module.exports = {
  MEDIA_ASSET_PROFILES,
  LUMINA_ARCHS,
  FLUX_ARCHS,
  WAN_ARCHS,
  archToMediaProfile,
  listAssetsForProfile,
};

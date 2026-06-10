'use strict';

/**
 * Auxiliary file URLs for stable-diffusion.cpp (AppData cache on first generate — not in installer).
 * @see https://github.com/leejet/stable-diffusion.cpp docs/z_image.md, docs/wan.md
 */

const LUMINA_ARCHS = new Set(['lumina', 'lumina2', 'lumina-mgpt', 'z-image', 'zimage']);
const FLUX_ARCHS = new Set(['flux', 'flux2', 'chroma', 'chroma-radiance']);
const WAN_ARCHS = new Set(['wan', 'wan2']);

const OPEN_AE_VAE_URL =
  'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors';

const WAN21_VAE_URL =
  'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors';

const WAN22_VAE_URL =
  'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors';

/** @type {Record<string, { label: string, assets: object[], auxKeys: object, lowVramAuxKeys?: object }>} */
const MEDIA_ASSET_PROFILES = {
  'lumina-image': {
    label: 'image generation',
    assets: [
      {
        id: 'flux-ae-vae',
        relPath: 'image/ae.safetensors',
        url: OPEN_AE_VAE_URL,
        bytes: 335_304_388,
        userLabel: 'VAE',
      },
      {
        id: 'qwen3-4b-llm',
        relPath: 'image/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
        url: 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
        bytes: 2_492_781_248,
        userLabel: 'image text encoder',
      },
    ],
    auxKeys: { vae: 'flux-ae-vae', llm: 'qwen3-4b-llm' },
  },
  'flux-image': {
    label: 'image generation',
    assets: [
      {
        id: 'flux-ae-vae',
        relPath: 'image/ae.safetensors',
        url: OPEN_AE_VAE_URL,
        bytes: 335_304_388,
        userLabel: 'VAE',
      },
    ],
    auxKeys: { vae: 'flux-ae-vae' },
  },
  'wan22-ti2v': {
    label: 'video generation',
    assets: [
      {
        id: 'wan22-vae',
        relPath: 'wan/wan2.2_vae.safetensors',
        url: WAN22_VAE_URL,
        bytes: 0,
        userLabel: 'video VAE',
      },
      {
        id: 'wan-tae',
        relPath: 'wan/taew2_2.safetensors',
        url: 'https://github.com/madebyollin/taehv/raw/refs/heads/main/safetensors/taew2_2.safetensors',
        bytes: 0,
        userLabel: 'lightweight video decoder',
      },
      {
        id: 'umt5-xxl',
        relPath: 'wan/umt5-xxl-encoder-Q3_K_S.gguf',
        url: 'https://huggingface.co/city96/umt5-xxl-encoder-gguf/resolve/main/umt5-xxl-encoder-Q3_K_S.gguf',
        bytes: 2_858_489_696,
        userLabel: 'video text encoder',
      },
    ],
    auxKeys: { vae: 'wan22-vae', t5: 'umt5-xxl' },
    lowVramAuxKeys: { tae: 'wan-tae', t5: 'umt5-xxl' },
  },
  'wan-video': {
    label: 'video generation',
    assets: [
      {
        id: 'wan21-vae',
        relPath: 'wan/wan_2.1_vae.safetensors',
        url: WAN21_VAE_URL,
        bytes: 0,
        userLabel: 'video VAE',
      },
      {
        id: 'wan-tae',
        relPath: 'wan/taew2_2.safetensors',
        url: 'https://github.com/madebyollin/taehv/raw/refs/heads/main/safetensors/taew2_2.safetensors',
        bytes: 0,
        userLabel: 'lightweight video decoder',
      },
      {
        id: 'umt5-xxl',
        relPath: 'wan/umt5-xxl-encoder-Q3_K_S.gguf',
        url: 'https://huggingface.co/city96/umt5-xxl-encoder-gguf/resolve/main/umt5-xxl-encoder-Q3_K_S.gguf',
        bytes: 2_858_489_696,
        userLabel: 'video text encoder',
      },
    ],
    auxKeys: { vae: 'wan21-vae', t5: 'umt5-xxl' },
    lowVramAuxKeys: { tae: 'wan-tae', t5: 'umt5-xxl' },
  },
};

function isWan22Ti2v(arch, modelPath) {
  const a = (arch || '').toLowerCase();
  const base = (modelPath || '').toLowerCase();
  if (!WAN_ARCHS.has(a) && !a.startsWith('wan')) return false;
  return /ti2v|wan2\.2|wan2_2|wan22/.test(base) || /5b/.test(base);
}

function archToMediaProfile(arch, modelType, modelPath) {
  const a = (arch || '').toLowerCase();
  if (modelType === 'video' || WAN_ARCHS.has(a) || a.startsWith('wan')) {
    return isWan22Ti2v(a, modelPath) ? 'wan22-ti2v' : 'wan-video';
  }
  if (LUMINA_ARCHS.has(a) || a.startsWith('lumina') || a.includes('z-image') || a.includes('zimage')) {
    return 'lumina-image';
  }
  if (FLUX_ARCHS.has(a) || a.includes('flux')) return 'flux-image';
  return null;
}

function listAssetsForProfile(profileId) {
  return MEDIA_ASSET_PROFILES[profileId]?.assets || [];
}

function getAuxKeyMap(profileId, lowVram) {
  const profile = MEDIA_ASSET_PROFILES[profileId];
  if (!profile) return {};
  if (lowVram && profile.lowVramAuxKeys) return profile.lowVramAuxKeys;
  return profile.auxKeys || {};
}

module.exports = {
  MEDIA_ASSET_PROFILES,
  LUMINA_ARCHS,
  FLUX_ARCHS,
  WAN_ARCHS,
  archToMediaProfile,
  listAssetsForProfile,
  getAuxKeyMap,
  isWan22Ti2v,
};

'use strict';

/**
 * Arch → profile → aux companions for stable-diffusion.cpp.
 * Profiles are family-level (not per-quantizer). Unknown diffusion/video arches
 * fall back to generic profiles (same-folder scan + settings overrides only).
 */

const LUMINA_ARCHS = new Set(['lumina', 'lumina2', 'lumina-mgpt', 'z-image', 'zimage']);
const FLUX_ARCHS = new Set(['flux', 'flux2', 'chroma', 'chroma-radiance']);
const WAN_ARCHS = new Set(['wan', 'wan2']);
const SD3_ARCHS = new Set(['sd3', 'mmdit']);
const PIXART_ARCHS = new Set(['pixart', 'pixart-alpha', 'pixart-sigma']);
const SDXL_ARCHS = new Set(['sdxl']);
const SD_ARCHS = new Set(['sd', 'sd2', 'sd2.5', 'stable-diffusion', 'stable_diffusion']);

const OPEN_AE_VAE_URL =
  'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors';

const QWEN3_ENCODER_ST_URL =
  'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors';

const WAN21_VAE_URL =
  'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors';

const WAN22_VAE_URL =
  'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors';

const UMT5_ENCODER_URL =
  'https://huggingface.co/city96/umt5-xxl-encoder-gguf/resolve/main/umt5-xxl-encoder-Q8_0.gguf';

const SD35_SPLIT = 'https://huggingface.co/Comfy-Org/stable-diffusion-3.5-medium_repackaged/resolve/main/split_files';
const SDXL_SPLIT = 'https://huggingface.co/Comfy-Org/stable-diffusion-xl-base-1.0_repackaged/resolve/main/split_files';
const SD15_SPLIT = 'https://huggingface.co/Comfy-Org/stable-diffusion-v1-5_repackaged/resolve/main/split_files';
const PIXART_SPLIT = 'https://huggingface.co/Comfy-Org/PixArt-alpha_repackaged/resolve/main/split_files';

const LABEL_ENCODER = 'text encoder (diffusion weights, not chat)';
const LABEL_CLIP_L = 'CLIP-L text encoder';
const LABEL_CLIP_G = 'CLIP-G text encoder';
const LABEL_T5 = 'T5 encoder (diffusion weights)';

const WAN_NEGATIVE =
  '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，'
  + 'JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，'
  + '形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走';

const WAN_GEN = { video: true, cfgScale: 6.0, negativePrompt: WAN_NEGATIVE, flowShift: 3.0 };

/** @type {Record<string, object>} */
const MEDIA_ASSET_PROFILES = {
  'lumina-image': {
    label: 'image generation',
    gen: { cfgScale: 1.0 },
    assets: [
      {
        id: 'flux-ae-vae',
        relPath: 'image/ae.safetensors',
        url: OPEN_AE_VAE_URL,
        bytes: 335_304_388,
        userLabel: 'VAE',
      },
      {
        id: 'qwen3-4b-safetensors',
        relPath: 'image/qwen_3_4b.safetensors',
        url: QWEN3_ENCODER_ST_URL,
        bytes: 0,
        userLabel: LABEL_ENCODER,
      },
      {
        id: 'qwen3-4b-llm',
        relPath: 'image/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
        url: 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
        bytes: 2_492_781_248,
        userLabel: LABEL_ENCODER,
      },
    ],
    auxKeys: { vae: 'flux-ae-vae', llm: 'qwen3-4b-llm' },
    auxKeyFallbacks: { llm: 'qwen3-4b-safetensors' },
  },
  'flux-image': {
    label: 'image generation',
    gen: {},
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
  'sdxl-image': {
    label: 'image generation',
    gen: {},
    assets: [
      {
        id: 'sdxl-vae',
        relPath: 'image/sdxl_vae.safetensors',
        url: `${SDXL_SPLIT}/vae/diffusion_pytorch_model.safetensors`,
        bytes: 0,
        userLabel: 'VAE',
      },
      {
        id: 'sdxl-clip-l',
        relPath: 'image/sdxl_clip_l.safetensors',
        url: `${SDXL_SPLIT}/text_encoders/clip_l.safetensors`,
        bytes: 0,
        userLabel: LABEL_CLIP_L,
      },
      {
        id: 'sdxl-clip-g',
        relPath: 'image/sdxl_clip_g.safetensors',
        url: `${SDXL_SPLIT}/text_encoders/clip_g.safetensors`,
        bytes: 0,
        userLabel: LABEL_CLIP_G,
      },
    ],
    auxKeys: { vae: 'sdxl-vae', clip_l: 'sdxl-clip-l', clip_g: 'sdxl-clip-g' },
  },
  'sd-image': {
    label: 'image generation',
    gen: {},
    assets: [
      {
        id: 'sd15-vae',
        relPath: 'image/sd15_vae.safetensors',
        url: `${SD15_SPLIT}/vae/diffusion_pytorch_model.safetensors`,
        bytes: 0,
        userLabel: 'VAE',
      },
      {
        id: 'sd15-clip-l',
        relPath: 'image/sd15_clip_l.safetensors',
        url: `${SD15_SPLIT}/text_encoders/clip_l.safetensors`,
        bytes: 0,
        userLabel: LABEL_CLIP_L,
      },
    ],
    auxKeys: { vae: 'sd15-vae', clip_l: 'sd15-clip-l' },
  },
  'sd3-image': {
    label: 'image generation',
    gen: { cfgScale: 4.5 },
    assets: [
      {
        id: 'sd3-vae',
        relPath: 'image/sd3_vae.safetensors',
        url: `${SD35_SPLIT}/vae/diffusion_pytorch_model.safetensors`,
        bytes: 0,
        userLabel: 'VAE',
      },
      {
        id: 'sd3-clip-l',
        relPath: 'image/sd3_clip_l.safetensors',
        url: `${SD35_SPLIT}/text_encoders/clip_l.safetensors`,
        bytes: 0,
        userLabel: LABEL_CLIP_L,
      },
      {
        id: 'sd3-clip-g',
        relPath: 'image/sd3_clip_g.safetensors',
        url: `${SD35_SPLIT}/text_encoders/clip_g.safetensors`,
        bytes: 0,
        userLabel: LABEL_CLIP_G,
      },
      {
        id: 'sd3-t5',
        relPath: 'image/sd3_t5xxl_fp16.safetensors',
        url: `${SD35_SPLIT}/text_encoders/t5xxl_fp16.safetensors`,
        bytes: 0,
        userLabel: LABEL_T5,
      },
    ],
    auxKeys: { vae: 'sd3-vae', clip_l: 'sd3-clip-l', clip_g: 'sd3-clip-g', t5: 'sd3-t5' },
  },
  'pixart-image': {
    label: 'image generation',
    gen: {},
    assets: [
      {
        id: 'pixart-vae',
        relPath: 'image/pixart_vae.safetensors',
        url: `${PIXART_SPLIT}/vae/diffusion_pytorch_model.safetensors`,
        bytes: 0,
        userLabel: 'VAE',
      },
      {
        id: 'pixart-t5',
        relPath: 'image/pixart_t5xxl.safetensors',
        url: `${PIXART_SPLIT}/text_encoders/t5xxl_fp16.safetensors`,
        bytes: 0,
        userLabel: LABEL_T5,
      },
    ],
    auxKeys: { vae: 'pixart-vae', t5: 'pixart-t5' },
  },
  'image-generic': {
    label: 'image generation',
    gen: {},
    assets: [],
    auxKeys: {},
  },
  'wan22-ti2v': {
    label: 'video generation',
    gen: WAN_GEN,
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
        userLabel: 'lightweight video decoder (optional override)',
      },
      {
        id: 'umt5-xxl',
        relPath: 'wan/umt5-xxl-encoder-Q8_0.gguf',
        url: UMT5_ENCODER_URL,
        bytes: 0,
        userLabel: LABEL_T5,
      },
    ],
    auxKeys: { vae: 'wan22-vae', t5: 'umt5-xxl' },
  },
  'wan-video': {
    label: 'video generation',
    gen: WAN_GEN,
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
        relPath: 'wan/umt5-xxl-encoder-Q8_0.gguf',
        url: UMT5_ENCODER_URL,
        bytes: 0,
        userLabel: LABEL_T5,
      },
    ],
    auxKeys: { vae: 'wan21-vae', t5: 'umt5-xxl' },
    lowVramAuxKeys: { tae: 'wan-tae', t5: 'umt5-xxl' },
  },
  'cogvideo-video': {
    label: 'video generation',
    gen: { video: true, flowShift: 3.0 },
    assets: [],
    auxKeys: {},
  },
  'ltx-video': {
    label: 'video generation',
    gen: { video: true, flowShift: 3.0 },
    assets: [],
    auxKeys: {},
  },
  'hunyuan-video': {
    label: 'video generation',
    gen: { video: true, flowShift: 3.0 },
    assets: [],
    auxKeys: {},
  },
  'mochi-video': {
    label: 'video generation',
    gen: { video: true, flowShift: 3.0 },
    assets: [],
    auxKeys: {},
  },
  'video-generic': {
    label: 'video generation',
    gen: { video: true, flowShift: 3.0 },
    assets: [],
    auxKeys: {},
  },
};

const TENSOR_5D_MSG =
  'sd.cpp could not load this GGUF. guIDE attempted an automatic 5D tensor patch but generation still failed. '
  + 'Place fix_5d_tensors_<arch>.safetensors beside the model, or use a GGUF converted via ComfyUI-GGUF fix_5d_tensors.';

function isWan22Ti2v(arch, modelPath) {
  const a = (arch || '').toLowerCase();
  const base = (modelPath || '').toLowerCase();
  if (!WAN_ARCHS.has(a) && !a.startsWith('wan')) return false;
  return /ti2v|wan2[._-]2|wan22/i.test(base);
}

function archToMediaProfile(arch, modelType, modelPath) {
  const a = (arch || '').toLowerCase();

  if (WAN_ARCHS.has(a) || a.startsWith('wan')) {
    return isWan22Ti2v(a, modelPath) ? 'wan22-ti2v' : 'wan-video';
  }
  if (LUMINA_ARCHS.has(a) || a.startsWith('lumina') || a.includes('z-image') || a.includes('zimage')) {
    return 'lumina-image';
  }
  if (FLUX_ARCHS.has(a) || a.includes('flux')) return 'flux-image';
  if (SD3_ARCHS.has(a) || a.startsWith('sd3') || a === 'mmdit') return 'sd3-image';
  if (SDXL_ARCHS.has(a) || a.startsWith('sdxl')) return 'sdxl-image';
  if (SD_ARCHS.has(a) || (a.startsWith('sd') && !a.startsWith('sd3'))) return 'sd-image';
  if (PIXART_ARCHS.has(a) || a.startsWith('pixart')) return 'pixart-image';

  if (a.startsWith('cogvideo')) return 'cogvideo-video';
  if (a.startsWith('ltx')) return 'ltx-video';
  if (a.includes('hunyuan')) return 'hunyuan-video';
  if (a.startsWith('mochi')) return 'mochi-video';

  if (modelType === 'video') return 'video-generic';
  if (modelType === 'diffusion') return 'image-generic';
  return null;
}

function getProfileGen(profileId) {
  return MEDIA_ASSET_PROFILES[profileId]?.gen || {};
}

function withMirrorUrls(asset) {
  if (!asset?.url || asset.mirrorUrls?.length) return asset;
  if (!/huggingface\.co/i.test(asset.url)) return asset;
  return {
    ...asset,
    mirrorUrls: [asset.url.replace('https://huggingface.co/', 'https://hf-mirror.com/')],
  };
}

function listAssetsForProfile(profileId) {
  return (MEDIA_ASSET_PROFILES[profileId]?.assets || []).map(withMirrorUrls);
}

function listProfileIds() {
  return Object.keys(MEDIA_ASSET_PROFILES);
}

function getAuxKeyMap(profileId, lowVram, settings = {}) {
  const profile = MEDIA_ASSET_PROFILES[profileId];
  if (!profile) return {};

  if (profileId === 'wan22-ti2v') {
    const keys = { ...profile.auxKeys };
    if (settings.mediaTaePath) keys.tae = 'wan-tae';
    return keys;
  }

  if (lowVram && profile.lowVramAuxKeys && !settings.mediaVaePath) {
    return { ...profile.lowVramAuxKeys };
  }

  const keys = { ...profile.auxKeys };
  if (settings.mediaTaePath && profile.assets.some((a) => a.id === 'wan-tae')) {
    delete keys.vae;
    keys.tae = 'wan-tae';
  }
  return keys;
}

function getAuxKeyFallbacks(profileId) {
  return MEDIA_ASSET_PROFILES[profileId]?.auxKeyFallbacks || {};
}

function getRequiredAuxKeys(profileId, lowVram, settings = {}) {
  return Object.keys(getAuxKeyMap(profileId, lowVram, settings));
}

function is5dTensorStderr(stderr) {
  return /patch_embedding|invalid number of dimensions:\s*5\s*>\s*4|5D tensors incompatible/i.test(stderr || '');
}

/** @deprecated use is5dTensorStderr */
const isWanIncompatibleStderr = is5dTensorStderr;

module.exports = {
  MEDIA_ASSET_PROFILES,
  LUMINA_ARCHS,
  FLUX_ARCHS,
  WAN_ARCHS,
  SD3_ARCHS,
  PIXART_ARCHS,
  TENSOR_5D_MSG,
  WAN_5D_INCOMPAT_MSG: TENSOR_5D_MSG,
  archToMediaProfile,
  getProfileGen,
  listAssetsForProfile,
  listProfileIds,
  getAuxKeyMap,
  getAuxKeyFallbacks,
  getRequiredAuxKeys,
  isWan22Ti2v,
  is5dTensorStderr,
  isWanIncompatibleStderr,
};

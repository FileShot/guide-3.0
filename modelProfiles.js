'use strict';

const { getGenerationProfile } = require('./generationProfiles');
const { detectFamilyFromArch } = require('./modelDetection');

// ─── Tier Boundaries ───
const TIER_BOUNDARIES = {
  tiny:   { min: 0,  max: 1 },
  small:  { min: 1,  max: 4 },
  medium: { min: 4,  max: 8 },
  large:  { min: 8,  max: 14 },
  xlarge: { min: 14, max: Infinity },
};

function getSizeTier(paramSize) {
  // Unknown/undetected models should get generous context (large tier) rather than restrictive
  // The hardware context computation will still limit based on actual RAM availability
  if (!paramSize || paramSize <= 0) return 'large';
  for (const [tier, { min, max }] of Object.entries(TIER_BOUNDARIES)) {
    if (paramSize >= min && paramSize < max) return tier;
  }
  return 'xlarge';
}

// ─── Base Defaults (applied to ALL models before family overrides) ───
const BASE_DEFAULTS = {
  sampling: {
    temperature: 0.6,
    topP: 0.90,
    topK: 40,
    repeatPenalty: 1.10,
    frequencyPenalty: 0,
    presencePenalty: 0,
    lastTokensPenaltyCount: 128,
  },
  context: {
    // Default to generous context — hardware limits (_computeMaxContext) will cap based on actual RAM
    effectiveContextSize: 65536,
    sysPromptBudgetPct: 0.15,
    responseReservePct: 0.25,
    maxResponseTokens: 4096,
  },
  prompt: {
    style: 'full',
    toolPromptStyle: 'full',
    fewShotExamples: 0,
    preferJsonCodeFence: true,
  },
  thinkTokens: {
    mode: 'strip',
    budget: 0,
  },
  retry: {
    maxRetries: 3,
    onLoop: 'increase-penalty',
    onTruncation: 'reduce-response',
    onRefusal: 'rephrase-prompt',
  },
  generation: {
    grammarConstrained: false,
    stopStrings: [],
    maxToolsPerTurn: 14,
  },
};

// ─── Family Profiles (context/prompt/generation tiers only — sampling in generationProfiles.js) ───
const FAMILY_PROFILES = {
  qwen: {
    base: {
      thinkTokens: { mode: 'budget', budget: 2048 },
    },
    tiny: {
      sampling: { temperature: 0.6, topP: 0.95, topK: 20, repeatPenalty: 1.0, presencePenalty: 0, lastTokensPenaltyCount: 512 },
      samplingInstruct: { temperature: 0.7, topP: 0.8, topK: 20, repeatPenalty: 1.0, presencePenalty: 1.5, lastTokensPenaltyCount: 512 },
      prompt: { style: 'compact', fewShotExamples: 1 },
      thinkTokens: { mode: 'budget', budget: 1024 },
      generation: { maxToolsPerTurn: 10 },
    },
    small: {
      sampling: { temperature: 0.6, topP: 0.95, topK: 20, repeatPenalty: 1.0, presencePenalty: 0, lastTokensPenaltyCount: 512 },
      samplingInstruct: { temperature: 0.7, topP: 0.8, topK: 20, repeatPenalty: 1.0, presencePenalty: 1.5, lastTokensPenaltyCount: 512 },
      prompt: { style: 'compact', fewShotExamples: 1 },
      thinkTokens: { mode: 'budget', budget: 2048 },
      generation: { maxToolsPerTurn: 14 },
    },
    medium: {
      sampling: { temperature: 0.6, topP: 0.95, topK: 20, repeatPenalty: 1.0, presencePenalty: 0 },
      samplingInstruct: { temperature: 0.7, topP: 0.8, topK: 20, repeatPenalty: 1.0, presencePenalty: 1.5 },
      context: { effectiveContextSize: 16384 },
      prompt: { style: 'full' },
      generation: { maxToolsPerTurn: 15 },
      thinkTokens: { mode: 'budget', budget: 2048 },
    },
    large: {
      sampling: { temperature: 0.6, topP: 0.95, topK: 20, repeatPenalty: 1.0, presencePenalty: 0 },
      samplingInstruct: { temperature: 0.7, topP: 0.8, topK: 20, repeatPenalty: 1.0, presencePenalty: 1.5 },
      context: { effectiveContextSize: 32768, maxResponseTokens: 8192 },
      prompt: { style: 'full' },
      generation: { maxToolsPerTurn: 25 },
      thinkTokens: { mode: 'budget', budget: 2048 },
    },
    xlarge: {
      sampling: { temperature: 0.6, topP: 0.95, topK: 20, repeatPenalty: 1.0, presencePenalty: 0 },
      samplingInstruct: { temperature: 0.7, topP: 0.8, topK: 20, repeatPenalty: 1.0, presencePenalty: 1.5 },
      context: { effectiveContextSize: 65536, maxResponseTokens: 16384 },
      prompt: { style: 'full' },
      generation: { maxToolsPerTurn: 50 },
      thinkTokens: { mode: 'budget', budget: 4096 },
    },
  },

  llama: {
    base: {
      sampling: { temperature: 0.5, topP: 0.90, topK: 40, repeatPenalty: 1.10 },
      thinkTokens: { mode: 'budget', budget: 1024 },
    },
    tiny: {
      sampling: { temperature: 0.35, topP: 0.80, topK: 15, repeatPenalty: 1.15, lastTokensPenaltyCount: 512 },
      prompt: { style: 'compact', fewShotExamples: 2 },
      thinkTokens: { mode: 'none', budget: 0 },
      generation: { maxToolsPerTurn: 10 },
    },
    small: {
      sampling: { temperature: 0.4, topP: 0.85, topK: 20, repeatPenalty: 1.12 },
      prompt: { style: 'compact', fewShotExamples: 1 },
      thinkTokens: { mode: 'none', budget: 0 },
      generation: { maxToolsPerTurn: 14 },
    },
    medium: {
      sampling: { temperature: 0.5, topP: 0.90, topK: 30, repeatPenalty: 1.08 },
      context: { effectiveContextSize: 16384 },
      prompt: { style: 'full' },
      generation: { maxToolsPerTurn: 15 },
    },
    large: {
      context: { effectiveContextSize: 32768, maxResponseTokens: 8192 },
      generation: { maxToolsPerTurn: 25 },
    },
    xlarge: {
      context: { effectiveContextSize: 65536, maxResponseTokens: 16384 },
      generation: { maxToolsPerTurn: 50 },
    },
  },

  phi: {
    base: {
      sampling: { temperature: 0.35, topP: 0.80, topK: 20, repeatPenalty: 1.20, frequencyPenalty: 0.05, lastTokensPenaltyCount: 256 },
      thinkTokens: { mode: 'none', budget: 0 },
    },
    tiny: {
      sampling: { temperature: 0.30, topP: 0.75, topK: 15, repeatPenalty: 1.25, lastTokensPenaltyCount: 512 },
      prompt: { style: 'compact' },
      thinkTokens: { mode: 'none', budget: 0 },
      generation: { maxToolsPerTurn: 10 },
    },
    small: {
      sampling: { temperature: 0.35, topP: 0.80, topK: 20, repeatPenalty: 1.20 },
      prompt: { style: 'compact' },
      thinkTokens: { mode: 'none', budget: 0 },
      generation: { maxToolsPerTurn: 14 },
    },
    medium: {
      sampling: { temperature: 0.40, topP: 0.85, topK: 25, repeatPenalty: 1.15 },
      context: { effectiveContextSize: 16384 },
      prompt: { style: 'full' },
      generation: { maxToolsPerTurn: 14 },
    },
    large: {
      sampling: { temperature: 0.45, topP: 0.88, topK: 30, repeatPenalty: 1.12 },
      context: { effectiveContextSize: 32768, maxResponseTokens: 8192 },
      prompt: { style: 'full' },
      generation: { maxToolsPerTurn: 20 },
    },
    xlarge: {
      context: { effectiveContextSize: 65536, maxResponseTokens: 16384 },
    },
  },

  gemma: {
    // Official Google Gemma 4 recommended settings from https://ai.google.dev/gemma/docs/core/model_card_4
    // temperature=1.0, topP=0.95, topK=64 across all use cases
    // Thinking: controlled via <|think|> token in chat template (handled by llama.cpp)
    // Non-thinking (E2B/E4B): empty thought block emitted automatically
    base: {
      sampling: { temperature: 1.0, topP: 0.95, topK: 64, repeatPenalty: 1.0 },
      thinkTokens: { mode: 'budget', budget: 2048 },
    },
    tiny: {
      sampling: { temperature: 1.0, topP: 0.95, topK: 64, repeatPenalty: 1.05, lastTokensPenaltyCount: 256 },
      prompt: { style: 'compact', fewShotExamples: 1 },
      thinkTokens: { mode: 'budget', budget: 256 },
      generation: { maxToolsPerTurn: 10 },
    },
    small: {
      sampling: { temperature: 1.0, topP: 0.95, topK: 64, repeatPenalty: 1.0 },
      prompt: { style: 'compact', fewShotExamples: 1 },
      thinkTokens: { mode: 'budget', budget: 512 },
      generation: { maxToolsPerTurn: 14 },
    },
    medium: {
      sampling: { temperature: 1.0, topP: 0.95, topK: 64, repeatPenalty: 1.0 },
      context: { effectiveContextSize: 16384 },
      prompt: { style: 'full' },
      thinkTokens: { mode: 'budget', budget: 2048 },
    },
    large: {
      sampling: { temperature: 1.0, topP: 0.95, topK: 64, repeatPenalty: 1.0 },
      context: { effectiveContextSize: 32768, maxResponseTokens: 8192 },
      thinkTokens: { mode: 'budget', budget: 4096 },
    },
    xlarge: {
      sampling: { temperature: 1.0, topP: 0.95, topK: 64, repeatPenalty: 1.0 },
      context: { effectiveContextSize: 65536, maxResponseTokens: 16384 },
      thinkTokens: { mode: 'budget', budget: 8192 },
    },
  },

  deepseek: {
    base: {
      sampling: { temperature: 0.5, topP: 0.90, topK: 30, repeatPenalty: 1.08 },
      thinkTokens: { mode: 'budget', budget: 4096 },
    },
    tiny: {
      sampling: { temperature: 0.45, topP: 0.85, topK: 20, repeatPenalty: 1.12, lastTokensPenaltyCount: 512 },
      prompt: { style: 'compact' },
      thinkTokens: { mode: 'budget', budget: 128 },
      generation: { maxToolsPerTurn: 10 },
    },
    small: {
      sampling: { temperature: 0.5, topP: 0.88, topK: 25, repeatPenalty: 1.08 },
      prompt: { style: 'compact' },
      thinkTokens: { mode: 'budget', budget: 256 },
      generation: { maxToolsPerTurn: 14 },
    },
    medium: {
      context: { effectiveContextSize: 16384 },
      thinkTokens: { mode: 'budget', budget: 2048 },
    },
    large: {
      context: { effectiveContextSize: 32768, maxResponseTokens: 8192 },
    },
    xlarge: {
      context: { effectiveContextSize: 65536, maxResponseTokens: 16384 },
    },
  },

  glm: {
    base: {
      sampling: { temperature: 0.45, topP: 0.88, topK: 30, repeatPenalty: 1.08 },
      thinkTokens: { mode: 'budget', budget: 2048 },
    },
    tiny: {
      sampling: { temperature: 0.40, topP: 0.85, topK: 20, repeatPenalty: 1.12, lastTokensPenaltyCount: 512 },
      prompt: { style: 'compact', fewShotExamples: 1 },
      thinkTokens: { mode: 'budget', budget: 512 },
      generation: { maxToolsPerTurn: 10 },
    },
    small: {
      sampling: { temperature: 0.42, topP: 0.87, topK: 25, repeatPenalty: 1.10 },
      prompt: { style: 'compact', fewShotExamples: 1 },
      thinkTokens: { mode: 'budget', budget: 1024 },
      generation: { maxToolsPerTurn: 14 },
    },
    medium: {
      sampling: { temperature: 0.48, topP: 0.90, topK: 30, repeatPenalty: 1.06 },
      context: { effectiveContextSize: 16384 },
      prompt: { style: 'full' },
      generation: { maxToolsPerTurn: 15 },
      thinkTokens: { mode: 'budget', budget: 2048 },
    },
    large: {
      context: { effectiveContextSize: 32768, maxResponseTokens: 8192 },
      prompt: { style: 'full' },
      generation: { maxToolsPerTurn: 25 },
      thinkTokens: { mode: 'budget', budget: 4096 },
    },
    xlarge: {
      context: { effectiveContextSize: 65536, maxResponseTokens: 16384 },
      generation: { maxToolsPerTurn: 50 },
    },
  },

  mistral: {
    base: {
      sampling: { temperature: 0.5, topP: 0.90, topK: 40, repeatPenalty: 1.10 },
      thinkTokens: { mode: 'budget', budget: 1024 },
    },
    small: {
      context: { effectiveContextSize: 32768, maxResponseTokens: 4096 },
      prompt: { style: 'compact' },
    },
    medium: {
      context: { effectiveContextSize: 16384, maxResponseTokens: 4096 },
    },
    large: {
      context: { effectiveContextSize: 32768, maxResponseTokens: 8192 },
    },
    xlarge: {
      context: { effectiveContextSize: 65536, maxResponseTokens: 16384 },
    },
  },

  granite: {
    base: {
      sampling: { temperature: 0.5, topP: 0.88, topK: 30, repeatPenalty: 1.10 },
      thinkTokens: { mode: 'budget', budget: 1024 },
      retry: { onRefusal: 'add-permission' },
    },
    small: {
      context: { effectiveContextSize: 32768 },
      prompt: { style: 'compact' },
    },
    medium: {
      context: { effectiveContextSize: 16384 },
    },
  },

  codellama: {
    base: {
      sampling: { temperature: 0.35, topP: 0.85, topK: 25, repeatPenalty: 1.12 },
      thinkTokens: { mode: 'budget', budget: 1024 },
    },
    small: {
      context: { effectiveContextSize: 32768 },
      prompt: { style: 'compact' },
    },
    medium: {
      context: { effectiveContextSize: 16384 },
    },
  },

  starcoder: {
    base: {
      sampling: { temperature: 0.35, topP: 0.85, topK: 25, repeatPenalty: 1.12 },
      thinkTokens: { mode: 'budget', budget: 1024 },
    },
    small: {
      context: { effectiveContextSize: 32768 },
      prompt: { style: 'compact' },
    },
  },

  yi: {
    base: {
      sampling: { temperature: 0.45, topP: 0.88, topK: 30, repeatPenalty: 1.10 },
      thinkTokens: { mode: 'budget', budget: 1024 },
    },
    small: {
      context: { effectiveContextSize: 32768 },
      prompt: { style: 'compact' },
    },
    medium: {
      context: { effectiveContextSize: 16384 },
    },
  },

  internlm: {
    base: {
      sampling: { temperature: 0.5, topP: 0.90, topK: 30, repeatPenalty: 1.08 },
      thinkTokens: { mode: 'budget', budget: 1024 },
    },
    small: {
      context: { effectiveContextSize: 32768 },
      prompt: { style: 'compact' },
    },
  },

  lfm: {
    base: {
      sampling: { temperature: 0.45, topP: 0.88, topK: 25, repeatPenalty: 1.10 },
      thinkTokens: { mode: 'budget', budget: 1024 },
    },
    tiny: {
      sampling: { temperature: 0.40, topP: 0.85, topK: 20, repeatPenalty: 1.12, lastTokensPenaltyCount: 512 },
      prompt: { style: 'compact', fewShotExamples: 1 },
      generation: { maxToolsPerTurn: 10 },
    },
    small: {
      sampling: { temperature: 0.45, topP: 0.88, topK: 25, repeatPenalty: 1.10 },
      prompt: { style: 'compact', fewShotExamples: 1 },
      generation: { maxToolsPerTurn: 14 },
    },
  },

  nanbeige: {
    base: {
      sampling: { temperature: 0.50, topP: 0.90, topK: 30, repeatPenalty: 1.08 },
      thinkTokens: { mode: 'budget', budget: 1024 },
    },
    small: {
      sampling: { temperature: 0.48, topP: 0.88, topK: 25, repeatPenalty: 1.10 },
      prompt: { style: 'compact', fewShotExamples: 1 },
      generation: { maxToolsPerTurn: 14 },
    },
  },

  bitnet: {
    base: {
      sampling: { temperature: 0.40, topP: 0.85, topK: 20, repeatPenalty: 1.15 },
      thinkTokens: { mode: 'budget', budget: 1024 },
    },
    small: {
      sampling: { temperature: 0.38, topP: 0.82, topK: 18, repeatPenalty: 1.15 },
      prompt: { style: 'compact', fewShotExamples: 1 },
      generation: { maxToolsPerTurn: 14 },
    },
  },

  exaone: {
    base: {
      sampling: { temperature: 0.45, topP: 0.88, topK: 25, repeatPenalty: 1.10 },
      thinkTokens: { mode: 'budget', budget: 1024 },
    },
    tiny: {
      sampling: { temperature: 0.40, topP: 0.85, topK: 20, repeatPenalty: 1.12, lastTokensPenaltyCount: 512 },
      prompt: { style: 'compact', fewShotExamples: 1 },
      generation: { maxToolsPerTurn: 10 },
    },
  },

  devstral: {
    base: {
      sampling: { temperature: 0.45, topP: 0.88, topK: 30, repeatPenalty: 1.10 },
      thinkTokens: { mode: 'budget', budget: 1024 },
    },
    small: {
      context: { effectiveContextSize: 32768 },
      prompt: { style: 'compact' },
      generation: { maxToolsPerTurn: 10 },
    },
    large: {
      context: { effectiveContextSize: 65536, maxResponseTokens: 8192 },
      prompt: { style: 'full' },
      generation: { maxToolsPerTurn: 25 },
    },
    xlarge: {
      context: { effectiveContextSize: 131072, maxResponseTokens: 16384 },
      generation: { maxToolsPerTurn: 50 },
    },
  },

  olmo: {
    base: {
      sampling: { temperature: 0.50, topP: 0.90, topK: 30, repeatPenalty: 1.08 },
      thinkTokens: { mode: 'budget', budget: 1024 },
    },
    small: {
      context: { effectiveContextSize: 32768 },
      prompt: { style: 'compact' },
    },
    large: {
      context: { effectiveContextSize: 32768, maxResponseTokens: 8192 },
    },
    xlarge: {
      context: { effectiveContextSize: 65536, maxResponseTokens: 16384 },
    },
  },

  gpt: {
    base: {
      sampling: { temperature: 0.50, topP: 0.90, topK: 40, repeatPenalty: 1.08 },
      thinkTokens: { mode: 'none', budget: 0 },
    },
    small: {
      sampling: { temperature: 0.40, topP: 0.85, topK: 25, repeatPenalty: 1.12 },
      prompt: { style: 'compact', fewShotExamples: 1 },
      generation: { maxToolsPerTurn: 14 },
    },
    medium: {
      sampling: { temperature: 0.50, topP: 0.90, topK: 30, repeatPenalty: 1.08 },
      context: { effectiveContextSize: 16384 },
      prompt: { style: 'full' },
      generation: { maxToolsPerTurn: 15 },
    },
    large: {
      context: { effectiveContextSize: 32768, maxResponseTokens: 8192 },
      prompt: { style: 'full' },
      generation: { maxToolsPerTurn: 25 },
    },
    xlarge: {
      context: { effectiveContextSize: 65536, maxResponseTokens: 16384 },
      generation: { maxToolsPerTurn: 50 },
    },
  },
};

// ─── Deep Merge (non-mutating, arrays replaced not concatenated) ───
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
      target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// ─── Profile Resolution ───
/**
 * Resolve model profile by GGUF architecture string (preferred) or legacy family name.
 * @param {string} ggufArchOrFamily - metadata.general.architecture (e.g. qwen35) or family fallback
 * @param {number} paramSize - parameter count in billions
 * @param {{ agentMode?: boolean }} [options]
 */
function getModelProfile(ggufArchOrFamily, paramSize, options = {}) {
  const tier = getSizeTier(paramSize);
  const arch = (ggufArchOrFamily || '').toLowerCase();
  const family = detectFamilyFromArch(arch) || (FAMILY_PROFILES[arch] ? arch : null);
  const familyDef = family ? FAMILY_PROFILES[family] : null;

  const genProfile = getGenerationProfile(arch);
  let profile = { ...BASE_DEFAULTS };

  if (genProfile) {
    profile = deepMerge(profile, genProfile);
    if (options.agentMode && genProfile.samplingCoding) {
      profile.sampling = deepMerge(profile.sampling || {}, genProfile.samplingCoding);
    }
  } else if (familyDef) {
    profile = deepMerge(profile, familyDef.base || {});
    console.warn(`[modelProfiles] No GENERATION_PROFILES entry for arch="${arch}" — using legacy family bucket "${family}"`);
  }

  // Size-tier overrides: context, prompt, generation limits only (not sampling)
  if (familyDef?.[tier]) {
    const tierPatch = { ...familyDef[tier] };
    delete tierPatch.sampling;
    delete tierPatch.samplingInstruct;
    delete tierPatch.samplingCoding;
    profile = deepMerge(profile, tierPatch);
  } else if (familyDef?.base) {
    const basePatch = { ...familyDef.base };
    delete basePatch.sampling;
    delete basePatch.samplingInstruct;
    delete basePatch.samplingCoding;
    if (!genProfile) profile = deepMerge(profile, basePatch);
  }

  profile._meta = {
    arch: arch || 'unknown',
    family: family || 'unknown',
    paramSize: paramSize || 0,
    tier,
    profileSource: genProfile?._meta?.source || (familyDef ? `legacy:${family}` : 'base-defaults'),
    source: genProfile?._meta?.source || null,
    vendorDocSection: genProfile?._meta?.vendorDocSection || null,
  };

  return profile;
}

function getModelSamplingParams(family, paramSize) {
  return getModelProfile(family, paramSize).sampling;
}

function getEffectiveContextSize(family, paramSize) {
  return getModelProfile(family, paramSize).context.effectiveContextSize;
}

function getAvailableFamilies() {
  return Object.keys(FAMILY_PROFILES);
}

function isFamilyKnown(family) {
  return family in FAMILY_PROFILES;
}

module.exports = {
  getModelProfile,
  getModelSamplingParams,
  getEffectiveContextSize,
  getSizeTier,
  getAvailableFamilies,
  isFamilyKnown,
  deepMerge,
  BASE_DEFAULTS,
  FAMILY_PROFILES,
  TIER_BOUNDARIES,
};

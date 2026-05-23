'use strict';

const path = require('path');

/**
 * Per-model runtime defaults applied on every model load.
 * Does not overwrite unrelated user settings (gpuLayers, context, etc.) — only keys listed here.
 */

/** GGUF filenames known to need thinkingMode=off (GLM 4.6V thought-segment trap; GLM 4.7+ not included). */
const GLM_46_THINKING_OFF_PATTERN = /glm-4\.6|glm4\.6|4\.6v-flash|glm-4\.6v/i;

/**
 * @param {string} modelPath
 * @returns {{ thinkingMode: 'auto'|'off'|'B'|'C', reason: string }}
 */
function resolveRuntimeDefaultsForModel(modelPath) {
  const base = path.basename(modelPath || '').toLowerCase();

  if (GLM_46_THINKING_OFF_PATTERN.test(base)) {
    return { thinkingMode: 'off', reason: 'glm-4.6v-known-trap' };
  }

  return { thinkingMode: 'auto', reason: 'default-auto' };
}

module.exports = { resolveRuntimeDefaultsForModel, GLM_46_THINKING_OFF_PATTERN };

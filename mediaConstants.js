'use strict';

/** VRAM tiers (MB) for automatic media memory policy. */
const VRAM_TIGHT_MB = 8192;
const VRAM_LOW_MB = 6144;

/** Windows STATUS_DLL_NOT_FOUND when sd.exe cannot load bundled CUDA DLLs. */
const WIN_DLL_NOT_FOUND = 3221225781;
/** Windows STATUS_STACK_BUFFER_OVERRUN — sd runtime crash (not a launch/DLL issue). */
const WIN_STACK_OVERRUN = 3221226505;

module.exports = {
  VRAM_TIGHT_MB,
  VRAM_LOW_MB,
  WIN_DLL_NOT_FOUND,
  WIN_STACK_OVERRUN,
};

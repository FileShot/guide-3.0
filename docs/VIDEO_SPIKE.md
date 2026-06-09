# Wan Video Generation Spike (sd.cpp `vid_gen`)

## Goal

Verify bundled `stable-diffusion.cpp` (`sd.exe`) can produce Wan 2.x text-to-video output before shipping `/video` in guIDE.

## Prerequisites

1. Run `node scripts/fetch-sd-cpp.js` (bundles `sd.exe` into `resources/sd-cpp/` and `bin/`).
2. Download test assets (small footprint preferred):
   - Wan2.1 T2V diffusion GGUF (e.g. 1.3B variant)
   - `wan_2.1_vae.safetensors`
   - `umt5-xxl-encoder` (or compatible T5) GGUF
3. Configure paths in **Settings → Media Generation** (VAE + T5).

## Manual command (Windows)

From the directory containing `sd.exe` and its DLLs:

```powershell
.\sd.exe -M vid_gen `
  --diffusion-model "C:\path\to\wan.gguf" `
  --vae "C:\path\to\wan_2.1_vae.safetensors" `
  --t5xxl "C:\path\to\umt5-xxl.gguf" `
  -p "a cat walking on grass" `
  -o out.mp4 `
  -W 512 -H 512 `
  --steps 20 -s 42 `
  --video-frames 33
```

guIDE auto-applies sd.cpp low-VRAM flags on ≤8GB GPUs (`--offload-to-cpu`, `--vae-on-cpu`, `--clip-on-cpu`, `--diffusion-fa`). On ≤6GB, use **TAE** (`taew2_2.safetensors` via Settings → Media) instead of the full Wan VAE.

## Pass criteria

- [ ] Process exits 0
- [ ] Output file exists (`out.mp4` or frame sequence convertible to MP4)
- [ ] File plays in a standard video player
- [ ] guIDE `/video a cat walking` shows inline video with Save/Retry

## Fail criteria (ship clear errors, do not claim video support)

- OOM / CUDA errors on target GPU even with `--offload-to-cpu`
- Missing aux files (VAE/T5) — Settings must list required files
- `sd.exe` not found in packaged app (`resources/sd-cpp/sd.exe`)

## Notes

- Wan 14B may fail on 8GB VRAM; guIDE surfaces actionable errors via Settings and `/video`.
- Linux/mac sd binaries are follow-up when those installers ship.

# Media generation release gate (v0.4.42+)

## Product requirement

For **any user**, **any supported hardware**, **any path** to a **compatible** image/video GGUF:

1. Load model from the model picker
2. Send a prompt in chat
3. First generate may fetch arch-required diffusion companions (with progress)
4. **PNG or MP4 appears in chat**

## Supported architectures

Behavior is driven by GGUF `general.architecture` → profile in `mediaAssetsCatalog.js` → stable-diffusion.cpp flags. Not by filename or install path.

| Profile | Architectures | Output |
|---------|---------------|--------|
| `lumina-image` | lumina, lumina2, z-image, … | PNG |
| `flux-image` | flux, flux2, chroma, … | PNG |
| `wan-video` | wan (2.1 family) | MP4 |
| `wan22-ti2v` | wan2 TI2V 5B | MP4 |

Unknown or unsupported arch → error at **load**, not after multi-GB downloads.

## Release blocked until

- `npm test` passes (unit tests)
- `node tools/mediaE2E.test.js` passes on Windows with bundled `sd.exe` (real PNG/MP4 per profile)
- No regression to load-only smoke tests without output assertion

Set `GUIDE_SKIP_MEDIA_E2E=1` to skip E2E locally when `sd.exe` is not bundled.

## Companion files

Split GGUF exports require diffusion pipeline weights (VAE, text encoders). These are **not** chat LLMs. guIDE resolves them automatically: Settings → same folder as GGUF → AppData cache → download on first generate.

/**
 * guIDE Cloud AI → Secrypt Cipher Quality (P40 27B).
 * Plain `cipher` is FAST 2B on the P40 queue; bundled Cloud must send cipher-quality.
 */

export const GUIDE_CLOUD_PROVIDERS = new Set(['secrypt', 'cipher', 'graysoft']);
export const GUIDE_CLOUD_QUALITY_MODEL = 'cipher-quality';

const LEGACY_TO_QUALITY = new Set([
  '',
  'cipher',
  'gpt-oss-120b',
  'openai/gpt-oss-120b',
  'graysoft-cloud',
  'secrypt-cloud',
]);

export function resolveGuideCloudModel(provider, model) {
  if (!GUIDE_CLOUD_PROVIDERS.has(provider) && provider !== 'cerebras') {
    return model || null;
  }
  const id = String(model || '').trim();
  if (!id || LEGACY_TO_QUALITY.has(id)) return GUIDE_CLOUD_QUALITY_MODEL;
  return id;
}

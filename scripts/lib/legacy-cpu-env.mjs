/** Shared compile flags for legacy (Haswell-class) native builds. */
export const LEGACY_MARCH = 'x86-64-v2';

export function legacyCompileEnv(extra = {}) {
  const flags = `-march=${LEGACY_MARCH} -mtune=generic`;
  return {
    ...process.env,
    ...extra,
    CXXFLAGS: [flags, process.env.CXXFLAGS].filter(Boolean).join(' '),
    CFLAGS: [flags, process.env.CFLAGS].filter(Boolean).join(' '),
    LDFLAGS: [flags, process.env.LDFLAGS].filter(Boolean).join(' '),
  };
}

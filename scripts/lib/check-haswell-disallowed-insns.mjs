/**
 * Return paths of binaries whose disassembly contains instructions absent on Intel Haswell.
 * QEMU Haswell smoke tests miss some illegal opcodes that real i7-4xxx hardware traps.
 *
 * Haswell (i7-4xxx) supports: SSE4.2, AVX, AVX2, FMA3, F16C, POPCNT, BMI1/2, RDRAND.
 * Haswell does NOT support: AVX-512 (ZMM registers), RDSEED, ADX (ADCX/ADOX), CLFLUSHOPT,
 *   CLW, PCOMMIT, PREFETCHWT1, SERIALIZE, XSAVEC, XSAVES.
 *
 * CRITICAL: AVX-512 instructions do NOT have "avx512" in their mnemonic text.
 * They use 512-bit ZMM registers (%zmm0–%zmm31) and mask registers (%k0–%k7).
 * Detect them by the register name in objdump output, not by mnemonic keyword.
 */
import { spawnSync } from 'child_process';

/**
 * Matches post-Haswell CPU instructions in objdump disassembly output lines.
 * - %zmm[0-9]  : AVX-512 ZMM registers (512-bit) — exclusive to AVX-512
 * - \{%k[0-7]\}: AVX-512 opmask register syntax
 * - rdseed     : RDSEED instruction (Broadwell+, NOT Haswell)
 * - adcx/adox  : ADX extension (Broadwell+)
 * - clflushopt : Cache-line flush optimized (Skylake+)
 * - clwb       : Cache-line write-back (Skylake+)
 * - pcommit    : Persistent memory commit (Skylake+)
 * - prefetchwt1: Prefetch with intent to write (KNL+)
 * - serialize  : SERIALIZE instruction (Tiger Lake+)
 * - xsavec/xsaves: Extended save instructions (Broadwell+)
 *
 * NOTE: rdrand is intentionally excluded — Haswell DOES support RDRAND (since Ivy Bridge).
 * NOTE: "avx512" as a string never appears in real disassembly mnemonics; %zmm is the signal.
 */
const DISALLOWED_PATTERN =
  /%zmm[0-9]|\{%k[0-7]\}|\b(rdseed|adcx|adox|clflushopt|clwb|pcommit|prefetchwt1|serialize|xsavec|xsaves)\b/i;

export function disasmHasDisallowedInsn(filePath) {
  const r = spawnSync('objdump', ['-d', filePath], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const hits = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.includes('\t')) continue;
    const insn = line.split('\t').pop().trim();
    if (DISALLOWED_PATTERN.test(insn)) hits.push(insn);
  }
  return hits.length ? [...new Set(hits)].slice(0, 8) : null;
}

export function assertHaswellSafeBinaries(filePaths, label = 'binary') {
  const offenders = [];
  for (const f of filePaths) {
    const insns = disasmHasDisallowedInsn(f);
    if (insns) offenders.push({ file: f, insns });
  }
  if (offenders.length) {
    const msg = offenders
      .map((o) => `${o.file}: ${o.insns.join(', ')}`)
      .join('\n');
    throw new Error(`Haswell-unsafe ${label} (post-Haswell instructions):\n${msg}`);
  }
}

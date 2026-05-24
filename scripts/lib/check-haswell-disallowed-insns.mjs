/**
 * Return paths of binaries whose disassembly contains instructions absent on Intel Haswell.
 * QEMU Haswell smoke tests miss some illegal opcodes that real i7-4xxx hardware traps.
 */
import { spawnSync } from 'child_process';

/** Mnemonics for ISA extensions after Haswell (not on i7-4790). */
const DISALLOWED_MNEMONIC =
  /\b(clflushopt|clwb|rdseed|adx|avx512|pcommit|prefetchwt1|serialize|xsavec|xsaves|rdrand)\b/i;

export function disasmHasDisallowedInsn(filePath) {
  const r = spawnSync('objdump', ['-d', filePath], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const hits = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.includes('\t')) continue;
    const insn = line.split('\t').pop().trim();
    if (DISALLOWED_MNEMONIC.test(insn)) hits.push(insn);
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

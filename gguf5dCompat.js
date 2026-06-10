'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const { is5dTensorStderr } = require('./mediaAssetsCatalog');

/** Architectures that may need ComfyUI-GGUF 5D tensor injection for sd.cpp. */
const ARCHS_5D = new Set(['wan', 'wan2', 'hyvid', 'hunyuan-video', 'hunyuan_video', 'mochi']);

/**
 * Official diffusion weight sources keyed by normalized model stem patterns.
 * Any quantizer's GGUF for the same base checkpoint shares one fix tensor set.
 */
const SOURCE_REPO_HINTS = [
  { pattern: /wan2[._-]?2.*ti2v.*5b/i, repo: 'Wan-AI/Wan2.2-TI2V-5B' },
  { pattern: /wan2[._-]?2.*t2v.*14b/i, repo: 'Wan-AI/Wan2.2-T2V-A14B' },
  { pattern: /wan2[._-]?2.*i2v.*14b/i, repo: 'Wan-AI/Wan2.2-I2V-A14B' },
  { pattern: /wan2[._-]?1.*t2v.*14b/i, repo: 'Wan-AI/Wan2.1-T2V-14B' },
  { pattern: /wan2[._-]?1.*i2v.*14b/i, repo: 'Wan-AI/Wan2.1-I2V-14B' },
  { pattern: /wan2[._-]?1.*t2v.*1[._-]?3b/i, repo: 'Wan-AI/Wan2.1-T2V-1.3B' },
  { pattern: /wan2[._-]?1.*i2v.*14b.*480p/i, repo: 'Wan-AI/Wan2.1-I2V-14B-480P' },
  { pattern: /hunyuan.*video/i, repo: 'hunyuanvideo-community/HunyuanVideo' },
];

const QUANT_SUFFIX_RE = /[-_.](q\d[_\w]*|f16|bf16|fp16|iq\d[_\w]*)$/i;
const INDEX_CANDIDATES = [
  'diffusion_pytorch_model.safetensors.index.json',
  'diffusion_model.safetensors.index.json',
  'model.safetensors.index.json',
];

function is5dCompatArch(arch) {
  const a = (arch || '').toLowerCase();
  return ARCHS_5D.has(a) || a.startsWith('wan') || a.includes('hunyuan');
}

function needs5dFix(stderr) {
  return is5dTensorStderr(stderr);
}

function normalizeModelStem(modelPath) {
  const base = path.basename(modelPath, path.extname(modelPath));
  return base.replace(QUANT_SUFFIX_RE, '');
}

function inferSourceRepo(modelPath) {
  const stem = normalizeModelStem(modelPath);
  for (const hint of SOURCE_REPO_HINTS) {
    if (hint.pattern.test(stem) || hint.pattern.test(path.basename(modelPath))) {
      return hint.repo;
    }
  }
  return null;
}

function _cacheKey(modelPath) {
  try {
    const st = fs.statSync(modelPath);
    return crypto.createHash('sha256')
      .update(`${path.resolve(modelPath)}|${st.size}|${st.mtimeMs}`)
      .digest('hex')
      .slice(0, 24);
  } catch {
    return crypto.createHash('sha256').update(path.resolve(modelPath)).digest('hex').slice(0, 24);
  }
}

function _findPython() {
  const { execSync } = require('child_process');
  for (const cmd of process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']) {
    try {
      execSync(`${cmd} --version`, { stdio: 'ignore', timeout: 5000 });
      return cmd;
    } catch { /* try next */ }
  }
  return null;
}

function _runPython(scriptPath, args, timeoutMs = 30 * 60 * 1000) {
  const python = _findPython();
  if (!python) {
    return Promise.reject(new Error('Python not found (needed once to patch 5D GGUF tensors for sd.cpp)'));
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(python, [scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      reject(new Error('5D GGUF patch timed out'));
    }, timeoutMs);
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || stdout.trim() || `fix_5d_tensors exited ${code}`));
    });
  });
}

async function _readBytes(source, start, length) {
  if (source.kind === 'file') {
    const fh = await fsp.open(source.path, 'r');
    try {
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, start);
      return buf;
    } finally {
      await fh.close();
    }
  }
  const headers = { 'User-Agent': 'guIDE-gguf-5d-compat' };
  if (process.env.HF_TOKEN) headers.Authorization = `Bearer ${process.env.HF_TOKEN}`;
  headers.Range = `bytes=${start}-${start + length - 1}`;
  const res = await fetch(source.url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} reading ${source.url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function _readSafetensorsHeader(source) {
  const lenBuf = await _readBytes(source, 0, 8);
  const headerLen = Number(lenBuf.readBigUInt64LE(0));
  if (headerLen <= 0 || headerLen > 64 * 1024 * 1024) {
    throw new Error(`Invalid safetensors header length: ${headerLen}`);
  }
  const headerBuf = await _readBytes(source, 8, headerLen);
  return JSON.parse(headerBuf.toString('utf8'));
}

function _buildFixSafetensors(tensorMap) {
  const entries = {};
  let offset = 0;
  const dataBuffers = [];
  for (const [name, { shape, data }] of Object.entries(tensorMap)) {
    entries[name] = { dtype: 'F32', shape, data_offsets: [offset, offset + data.byteLength] };
    offset += data.byteLength;
    dataBuffers.push(data);
  }
  const header = JSON.stringify(entries);
  const headerBytes = Buffer.from(header, 'utf8');
  const headerLen = Buffer.alloc(8);
  headerLen.writeBigUInt64LE(BigInt(headerBytes.length), 0);
  return Buffer.concat([headerLen, headerBytes, ...dataBuffers]);
}

async function _extract5dFromSafetensorsSource(source, onProgress) {
  const header = await _readSafetensorsHeader(source);
  const tensors = {};
  for (const [name, meta] of Object.entries(header)) {
    if (!meta || !meta.data_offsets) continue;
    const dims = meta.shape?.length || 0;
    if (dims <= 4) continue;
    const [start, end] = meta.data_offsets;
    const dataStart = 8 + Number((await _readBytes(source, 0, 8)).readBigUInt64LE(0)) + start;
    const data = await _readBytes(source, dataStart, end - start);
    tensors[name] = { shape: meta.shape, data };
    if (onProgress) onProgress(`Found 5D tensor ${name} (${meta.shape.join('×')})`);
  }
  return tensors;
}

async function _scanLocalSafetensors(modelDir, onProgress) {
  let files = [];
  try {
    files = (await fsp.readdir(modelDir)).filter((f) => /\.safetensors$/i.test(f));
  } catch {
    return null;
  }
  const collected = {};
  for (const file of files) {
    const full = path.join(modelDir, file);
    try {
      const found = await _extract5dFromSafetensorsSource({ kind: 'file', path: full }, onProgress);
      Object.assign(collected, found);
    } catch { /* skip unreadable */ }
  }
  return Object.keys(collected).length ? collected : null;
}

async function _hfResolveIndex(repo) {
  for (const indexName of INDEX_CANDIDATES) {
    const url = `https://huggingface.co/${repo}/resolve/main/${indexName}`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'guIDE-gguf-5d-compat' },
        redirect: 'follow',
      });
      if (!res.ok) continue;
      const index = await res.json();
      if (index?.weight_map) return { index, indexName };
    } catch { /* try next */ }
  }
  return null;
}

async function _extract5dFromHfRepo(repo, onProgress) {
  const resolved = await _hfResolveIndex(repo);
  if (!resolved) return null;
  const { index } = resolved;
  const shards = [...new Set(Object.values(index.weight_map))];

  const collected = {};
  for (const shard of shards) {
    const url = `https://huggingface.co/${repo}/resolve/main/${shard}`;
    if (onProgress) onProgress(`Reading ${shard} from ${repo}…`);
    const header = await _readSafetensorsHeader({ kind: 'url', url });
    const headerLen = Number((await _readBytes({ kind: 'url', url }, 0, 8)).readBigUInt64LE(0));
    for (const [key, meta] of Object.entries(header)) {
      if (!meta?.data_offsets || (meta.shape?.length || 0) <= 4) continue;
      const [start, end] = meta.data_offsets;
      const dataStart = 8 + headerLen + start;
      const data = await _readBytes({ kind: 'url', url }, dataStart, end - start);
      collected[key] = { shape: meta.shape, data };
      if (onProgress) onProgress(`Fetched 5D tensor ${key} (${meta.shape.join('×')})`);
    }
    if (Object.keys(collected).length) break;
  }
  return Object.keys(collected).length ? collected : null;
}

async function _writeFixSafetensors(fixPath, tensorMap) {
  const buf = _buildFixSafetensors(tensorMap);
  await fsp.mkdir(path.dirname(fixPath), { recursive: true });
  await fsp.writeFile(fixPath, buf);
  return fixPath;
}

async function resolveFixSafetensors({ arch, modelPath, cacheDir, onProgress }) {
  const a = (arch || '').toLowerCase();
  const modelDir = path.dirname(modelPath);
  const fixName = `fix_5d_tensors_${a}.safetensors`;
  const localCandidates = [
    path.join(modelDir, fixName),
    path.join(cacheDir, '5d-fix', fixName),
    path.join(cacheDir, '5d-fix', `${_cacheKey(modelPath)}-${fixName}`),
  ];
  for (const p of localCandidates) {
    if (fs.existsSync(p)) return p;
  }

  const fixOut = path.join(cacheDir, '5d-fix', `${_cacheKey(modelPath)}-${fixName}`);
  if (fs.existsSync(fixOut)) return fixOut;

  if (onProgress) onProgress('Scanning local safetensors for 5D patch tensors…');
  let tensors = await _scanLocalSafetensors(modelDir, onProgress);
  if (!tensors) {
    const repo = inferSourceRepo(modelPath);
    if (repo) {
      if (onProgress) onProgress(`Resolving 5D tensors from ${repo}…`);
      tensors = await _extract5dFromHfRepo(repo, onProgress);
    }
  }
  if (!tensors || !Object.keys(tensors).length) {
    throw new Error(
      'Could not resolve 5D patch tensors for this GGUF. '
      + `Place ${fixName} beside your model, or use a GGUF converted with ComfyUI-GGUF fix_5d_tensors.`,
    );
  }
  await _writeFixSafetensors(fixOut, tensors);
  return fixOut;
}

async function apply5dFix({ srcGguf, arch, modelPath, cacheDir, onProgress }) {
  if (!is5dCompatArch(arch)) {
    throw new Error(`Architecture "${arch}" does not use sd.cpp 5D tensor patching`);
  }
  const key = _cacheKey(srcGguf);
  const fixedDir = path.join(cacheDir, 'gguf-5d-fixed');
  const fixedPath = path.join(fixedDir, `${key}.gguf`);
  if (fs.existsSync(fixedPath)) {
    const srcStat = fs.statSync(srcGguf);
    const fixedStat = fs.statSync(fixedPath);
    if (fixedStat.mtimeMs >= srcStat.mtimeMs && fixedStat.size > srcStat.size * 0.9) {
      return fixedPath;
    }
  }

  const fixPath = await resolveFixSafetensors({ arch, modelPath: srcGguf, cacheDir, onProgress });
  const scriptPath = path.join(__dirname, 'scripts', 'fix_5d_tensors.py');
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Missing bundled patch script: ${scriptPath}`);
  }

  if (onProgress) onProgress('Patching GGUF for sd.cpp 5D compatibility (one-time)…');
  await fsp.mkdir(fixedDir, { recursive: true });
  const tmpOut = `${fixedPath}.part`;
  if (fs.existsSync(tmpOut)) {
    try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  }
  await _runPython(scriptPath, [
    '--src', path.resolve(srcGguf),
    '--dst', path.resolve(tmpOut),
    '--fix', path.resolve(fixPath),
    '--overwrite',
  ]);
  if (fs.existsSync(fixedPath)) fs.unlinkSync(fixedPath);
  fs.renameSync(tmpOut, fixedPath);
  if (onProgress) onProgress('GGUF 5D patch complete');
  return fixedPath;
}

module.exports = {
  ARCHS_5D,
  is5dCompatArch,
  needs5dFix,
  normalizeModelStem,
  inferSourceRepo,
  resolveFixSafetensors,
  apply5dFix,
};

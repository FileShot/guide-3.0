'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), '.config'),
  'guide-ide',
  'logs',
);

const CHANNELS = {
  stream: { file: 'stream-trace.log', maxBytes: 200 * 1024 * 1024, backups: 5 },
  ipc: { file: 'ipc-trace.log', maxBytes: 200 * 1024 * 1024, backups: 5 },
  ui: { file: 'ui-trace.log', maxBytes: 200 * 1024 * 1024, backups: 5 },
  api: { file: 'api-trace.log', maxBytes: 100 * 1024 * 1024, backups: 3 },
};

const BLOB_THRESHOLD = 64 * 1024; // sidecar for payloads > 64KB in JSON line

let _seq = 0;
let _turnId = null;
let _enabled = true;
let _deferRotate = false;
const _streams = new Map();
const _bytesWritten = new Map();
const _pending = new Map();
let _flushTimer = null;

function ensureDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const blobDir = path.join(LOG_DIR, 'trace-blobs');
    if (!fs.existsSync(blobDir)) fs.mkdirSync(blobDir, { recursive: true });
  } catch (err) {
    process.stderr.write(`[streamTrace] ensureDir: ${err.message}\n`);
  }
}

function getStream(channel) {
  const cfg = CHANNELS[channel];
  if (!cfg) return null;
  if (_streams.has(channel)) return _streams.get(channel);
  ensureDir();
  const filePath = path.join(LOG_DIR, cfg.file);
  try {
    let size = 0;
    try { size = fs.statSync(filePath).size; } catch (_) {}
    const s = fs.createWriteStream(filePath, { flags: 'a' });
    s.on('error', (e) => {
      process.stderr.write(`[streamTrace] stream error ${channel}: ${e.message}\n`);
      _streams.delete(channel);
    });
    _streams.set(channel, s);
    _bytesWritten.set(channel, size);
    return s;
  } catch (err) {
    process.stderr.write(`[streamTrace] getStream ${channel}: ${err.message}\n`);
    return null;
  }
}

function rotate(channel) {
  if (_deferRotate) return;
  const cfg = CHANNELS[channel];
  if (!cfg) return;
  const written = _bytesWritten.get(channel) || 0;
  if (written < cfg.maxBytes) return;
  try {
    const s = _streams.get(channel);
    if (s) { s.end(); _streams.delete(channel); }
    const filePath = path.join(LOG_DIR, cfg.file);
    for (let i = cfg.backups - 1; i >= 1; i--) {
      const src = i === 1 ? filePath : `${filePath}.${i - 1}`;
      const dst = `${filePath}.${i}`;
      try { if (fs.existsSync(src)) fs.renameSync(src, dst); } catch (_) {}
    }
    _bytesWritten.set(channel, 0);
  } catch (err) {
    process.stderr.write(`[streamTrace] rotate ${channel}: ${err.message}\n`);
  }
}

function writeBlob(seq, text) {
  ensureDir();
  const blobPath = path.join(LOG_DIR, 'trace-blobs', `${seq}.txt`);
  fs.writeFileSync(blobPath, String(text ?? ''), 'utf8');
  return `trace-blobs/${seq}.txt`;
}

function serializeValue(val, seq) {
  if (val == null) return val;
  if (typeof val === 'string') {
    if (val.length > BLOB_THRESHOLD) {
      const blob = writeBlob(seq, val);
      return { __blob: blob, len: val.length, text: val };
    }
    return val;
  }
  if (typeof val === 'object') {
    try {
      const json = JSON.stringify(val);
      if (json.length > BLOB_THRESHOLD) {
        const blob = writeBlob(seq, json);
        return { __blob: blob, len: json.length, json: val };
      }
      return val;
    } catch (_) {
      return String(val);
    }
  }
  return val;
}

function flushChannel(channel) {
  const batch = _pending.get(channel);
  if (!batch || batch.length === 0) return;
  _pending.set(channel, []);
  const s = getStream(channel);
  if (!s) return;
  const combined = batch.join('');
  try {
    s.write(combined);
    const prev = _bytesWritten.get(channel) || 0;
    _bytesWritten.set(channel, prev + Buffer.byteLength(combined, 'utf8'));
    rotate(channel);
  } catch (err) {
    process.stderr.write(`[streamTrace] flush ${channel}: ${err.message}\n`);
  }
}

function scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    for (const ch of _pending.keys()) flushChannel(ch);
  }, 10);
}

function trace(channel, evt, fields = {}) {
  if (!_enabled) return _seq;
  const seq = ++_seq;
  const record = {
    ts: new Date().toISOString(),
    seq,
    turnId: _turnId,
    channel,
    evt,
  };
  for (const [k, v] of Object.entries(fields)) {
    record[k] = serializeValue(v, seq);
  }
  let line;
  try {
    line = JSON.stringify(record) + '\n';
  } catch (err) {
    line = JSON.stringify({
      ts: record.ts, seq, turnId: _turnId, channel, evt,
      __serializeError: err.message,
    }) + '\n';
  }
  if (!_pending.has(channel)) _pending.set(channel, []);
  _pending.get(channel).push(line);
  scheduleFlush();
  return seq;
}

function traceFull(channel, evt, text, meta = {}) {
  return trace(channel, evt, { ...meta, text: text == null ? '' : String(text) });
}

function setEnabled(on) {
  _enabled = !!on;
}

function isEnabled() {
  return _enabled;
}

function setTurnId(id) {
  _turnId = id == null ? null : String(id);
}

function setDeferRotate(defer) {
  _deferRotate = !!defer;
}

function flushAll() {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  for (const ch of Object.keys(CHANNELS)) flushChannel(ch);
}

function close() {
  flushAll();
  for (const s of _streams.values()) {
    try { s.end(); } catch (_) {}
  }
  _streams.clear();
}

function syncFromSettings(settings) {
  _enabled = settings?.streamTraceEnabled !== false;
}

function clearAll() {
  flushAll();
  close();
  _pending.clear();
  _bytesWritten.clear();
  _seq = 0;
  _turnId = null;
  ensureDir();
  for (const cfg of Object.values(CHANNELS)) {
    const filePath = path.join(LOG_DIR, cfg.file);
    try { fs.unlinkSync(filePath); } catch (_) {}
    for (let i = 1; i <= cfg.backups; i++) {
      try { fs.unlinkSync(`${filePath}.${i}`); } catch (_) {}
    }
  }
  const blobDir = path.join(LOG_DIR, 'trace-blobs');
  try {
    if (fs.existsSync(blobDir)) {
      for (const name of fs.readdirSync(blobDir)) {
        try { fs.unlinkSync(path.join(blobDir, name)); } catch (_) {}
      }
    }
  } catch (_) {}
}

module.exports = {
  trace,
  traceFull,
  setEnabled,
  isEnabled,
  setTurnId,
  setDeferRotate,
  flushAll,
  close,
  clearAll,
  syncFromSettings,
  LOG_DIR,
  CHANNELS,
};

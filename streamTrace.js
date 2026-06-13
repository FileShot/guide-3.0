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
  stream: { file: 'stream-trace.log', maxBytes: 50 * 1024 * 1024, backups: 3 },
  ipc: { file: 'ipc-trace.log', maxBytes: 50 * 1024 * 1024, backups: 3 },
  ui: { file: 'ui-trace.log', maxBytes: 50 * 1024 * 1024, backups: 3 },
  api: { file: 'api-trace.log', maxBytes: 25 * 1024 * 1024, backups: 2 },
};

const BLOB_THRESHOLD = 64 * 1024;

/** @type {'off'|'tokens'|'full'} */
let _level = 'tokens';
let _seq = 0;
let _turnId = null;
let _enabled = false;
let _deferRotate = false;
const _streams = new Map();
const _bytesWritten = new Map();
const _pending = new Map();
let _flushTimer = null;

const TOKEN_STREAM_EVTS = new Set([
  'token-prose',
  'token-response-chunk',
  'sf-content-token-emit',
  'llm-token',
]);

const SF_CONTENT_BATCH_MIN_CHARS = 50;
const SF_CONTENT_BATCH_HEARTBEAT_MS = 2000;
const _sfContentBatch = { pending: '', totalLen: 0, lastFlushAt: 0, meta: {} };
let _sfContentBatchTimer = null;

const _ipcFileContentBatch = { pending: '', totalLen: 0, lastFlushAt: 0 };
let _ipcFileContentBatchTimer = null;

function flushIpcFileContentBatch(force = false) {
  if (!_ipcFileContentBatch.pending && !force) return;
  const text = _ipcFileContentBatch.pending;
  if (!text) return;
  const preview = text.length > 120 ? `${text.slice(0, 80)}…` : text;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    seq: _seq,
    turnId: _turnId,
    channel: 'ipc',
    evt: 'ipc-send',
    batched: true,
    channelName: 'file-content-token',
    len: text.length,
    totalLen: _ipcFileContentBatch.totalLen,
    data: preview,
  }) + '\n';
  if (!_pending.has('ipc')) _pending.set('ipc', []);
  _pending.get('ipc').push(line);
  _ipcFileContentBatch.pending = '';
  _ipcFileContentBatch.lastFlushAt = Date.now();
  scheduleFlush();
}

function scheduleIpcFileContentBatchFlush() {
  if (_ipcFileContentBatchTimer) return;
  _ipcFileContentBatchTimer = setTimeout(() => {
    _ipcFileContentBatchTimer = null;
    flushIpcFileContentBatch();
  }, SF_CONTENT_BATCH_HEARTBEAT_MS);
}

function resetIpcFileContentBatch() {
  _ipcFileContentBatch.pending = '';
  _ipcFileContentBatch.totalLen = 0;
  _ipcFileContentBatch.lastFlushAt = 0;
  if (_ipcFileContentBatchTimer) {
    clearTimeout(_ipcFileContentBatchTimer);
    _ipcFileContentBatchTimer = null;
  }
}

function resetSfContentBatch() {
  resetIpcFileContentBatch();
  _sfContentBatch.pending = '';
  _sfContentBatch.totalLen = 0;
  _sfContentBatch.lastFlushAt = 0;
  _sfContentBatch.meta = {};
  if (_sfContentBatchTimer) {
    clearTimeout(_sfContentBatchTimer);
    _sfContentBatchTimer = null;
  }
}

function flushSfContentBatch(channel, force = false) {
  if (!_sfContentBatch.pending && !force) return;
  const text = _sfContentBatch.pending;
  if (!text) return;
  const preview = text.length > 120 ? `${text.slice(0, 80)}…` : text;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    seq: _seq,
    turnId: _turnId,
    channel,
    evt: 'sf-content-token-emit',
    len: text.length,
    totalLen: _sfContentBatch.totalLen,
    batched: true,
    text: preview,
    ..._sfContentBatch.meta,
  }) + '\n';
  if (!_pending.has(channel)) _pending.set(channel, []);
  _pending.get(channel).push(line);
  _sfContentBatch.pending = '';
  _sfContentBatch.lastFlushAt = Date.now();
  scheduleFlush();
}

function scheduleSfContentBatchFlush(channel) {
  if (_sfContentBatchTimer) return;
  _sfContentBatchTimer = setTimeout(() => {
    _sfContentBatchTimer = null;
    flushSfContentBatch(channel);
  }, SF_CONTENT_BATCH_HEARTBEAT_MS);
}

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
      return { __blob: blob, len: val.length };
    }
    return val;
  }
  if (typeof val === 'object') {
    try {
      const json = JSON.stringify(val);
      if (json.length > BLOB_THRESHOLD) {
        const blob = writeBlob(seq, json);
        return { __blob: blob, len: json.length };
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

function shouldTraceEvt(channel, evt) {
  if (!_enabled || _level === 'off') return false;
  if (_level === 'full') return true;
  if (channel === 'stream' && TOKEN_STREAM_EVTS.has(evt)) return true;
  if (channel === 'ipc' && evt === 'ipc-send') return true;
  if (evt === 'ai-chat-start' || evt.startsWith('lifecycle-') || evt.startsWith('generateResponse-')) return true;
  return false;
}

function trace(channel, evt, fields = {}) {
  if (!shouldTraceEvt(channel, evt)) return _seq;
  const seq = ++_seq;
  if (_level === 'tokens' && channel === 'ipc' && evt === 'ipc-send' && fields.channel === 'file-content-token' && typeof fields.data === 'string') {
    _ipcFileContentBatch.pending += fields.data;
    _ipcFileContentBatch.totalLen += fields.data.length;
    const now = Date.now();
    const due = _ipcFileContentBatch.pending.length >= SF_CONTENT_BATCH_MIN_CHARS
      || (now - (_ipcFileContentBatch.lastFlushAt || 0) >= SF_CONTENT_BATCH_HEARTBEAT_MS && _ipcFileContentBatch.pending.length > 0);
    if (due) {
      flushIpcFileContentBatch();
    } else {
      scheduleIpcFileContentBatchFlush();
    }
    return seq;
  }
  if (_level === 'tokens' && evt === 'sf-content-token-emit' && typeof fields.text === 'string') {
    _sfContentBatch.pending += fields.text;
    _sfContentBatch.totalLen += fields.text.length;
    _sfContentBatch.meta = {
      filePath: fields.filePath,
      phase: fields.phase,
    };
    const now = Date.now();
    const due = _sfContentBatch.pending.length >= SF_CONTENT_BATCH_MIN_CHARS
      || (now - _sfContentBatch.lastFlushAt >= SF_CONTENT_BATCH_HEARTBEAT_MS && _sfContentBatch.pending.length > 0);
    if (due) {
      flushSfContentBatch(channel);
    } else {
      scheduleSfContentBatchFlush(channel);
    }
    return seq;
  }
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
    if (_level === 'tokens' && TOKEN_STREAM_EVTS.has(evt) && typeof fields.text === 'string') {
      const preview = fields.text.length > 120 ? `${fields.text.slice(0, 80)}…` : fields.text;
      line = JSON.stringify({
        ts: record.ts, seq, turnId: _turnId, channel, evt,
        len: fields.text.length,
        text: preview,
      }) + '\n';
    } else {
      line = JSON.stringify(record) + '\n';
    }
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

function getLevel() {
  return _level;
}

function setTurnId(id) {
  flushSfContentBatch('stream', true);
  resetSfContentBatch();
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
  _enabled = settings?.streamTraceEnabled === true;
  const lvl = settings?.streamTraceLevel;
  _level = (lvl === 'off' || lvl === 'tokens' || lvl === 'full') ? lvl : 'tokens';
  if (!_enabled) _level = 'off';
}

function clearAll() {
  flushSfContentBatch('stream', true);
  flushIpcFileContentBatch(true);
  resetSfContentBatch();
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
  getLevel,
  setTurnId,
  setDeferRotate,
  flushAll,
  close,
  clearAll,
  syncFromSettings,
  LOG_DIR,
  CHANNELS,
};

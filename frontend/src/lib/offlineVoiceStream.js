/**
 * Offline chunked Whisper streaming for guIDE voice input.
 * Captures mic PCM at 16 kHz, flushes ~1.6s chunks (plus silence-based flush),
 * and transcribes each chunk via local whisper-cli — no Web Speech / cloud.
 */

const TARGET_RATE = 16000;
const CHUNK_MS = 4500;
const MIN_CHUNK_MS = 500;
const SILENCE_MS = 700;
const SILENCE_RMS = 0.012;
const OVERLAP_MS = 0;

function isBlankTranscript(text) {
  const norm = String(text || '')
    .toLowerCase()
    .replace(/[\[\]()*_]/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!norm) return true;
  const words = norm.split(' ');
  return words.every((w) => w === 'blank' || w === 'audio' || w === 'silence');
}

function encodeWavPcm16(samples, sampleRate = TARGET_RATE) {
  const dataLen = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buffer);
  const writeStr = (o, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataLen, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * @param {{
 *   onPartialText?: (text: string) => void,
 *   onFinalText: (text: string) => void,
 *   onStatus?: (msg: string) => void,
 *   onError?: (msg: string) => void,
 *   transcribe: (wavBuffer: ArrayBuffer) => Promise<{ success?: boolean, text?: string, error?: string }>,
 * }} handlers
 */
export function createOfflineVoiceStream(handlers) {
  let audioCtx = null;
  let stream = null;
  let processor = null;
  let mute = null;
  let source = null;
  let running = false;
  let generation = 0;
  let samples = [];
  let silenceSamples = 0;
  let busy = false;
  const queue = [];
  let overlap = new Float32Array(0);

  const chunkSamples = Math.floor((TARGET_RATE * CHUNK_MS) / 1000);
  const minChunkSamples = Math.floor((TARGET_RATE * MIN_CHUNK_MS) / 1000);
  const silenceLimit = Math.floor((TARGET_RATE * SILENCE_MS) / 1000);
  const overlapSamples = Math.floor((TARGET_RATE * OVERLAP_MS) / 1000);

  async function drainQueue(gen) {
    if (busy) return;
    busy = true;
    while (queue.length && gen === generation) {
      const wav = queue.shift();
      try {
        handlers.onStatus?.('Transcribing…');
        const r = await handlers.transcribe(wav);
        if (gen !== generation) break;
        const text = (r?.text || '').trim();
        if (r?.success && text && !isBlankTranscript(text)) {
          handlers.onFinalText(text);
        } else if (r?.error && gen === generation) {
          handlers.onError?.(r.error);
        }
      } catch (e) {
        if (gen === generation) handlers.onError?.(e.message || 'Transcription failed');
      }
    }
    if (gen !== generation) queue.length = 0;
    busy = false;
    if (running && gen === generation) handlers.onStatus?.('Listening…');
  }

  function enqueueChunk(floatSamples) {
    if (!floatSamples?.length || floatSamples.length < minChunkSamples) return;
    if (rms(floatSamples) < SILENCE_RMS) return;
    const withOverlap = new Float32Array(overlap.length + floatSamples.length);
    withOverlap.set(overlap, 0);
    withOverlap.set(floatSamples, overlap.length);
    const keep = Math.min(overlapSamples, floatSamples.length);
    overlap = floatSamples.slice(floatSamples.length - keep);
    queue.push(encodeWavPcm16(withOverlap, TARGET_RATE));
    drainQueue(generation);
  }

  function flush(force = false) {
    if (!samples.length) return;
    if (!force && samples.length < minChunkSamples) return;
    const chunk = new Float32Array(samples);
    samples = [];
    silenceSamples = 0;
    enqueueChunk(chunk);
  }

  function onAudio(e) {
    if (!running) return;
    const input = e.inputBuffer.getChannelData(0);
    const rate = audioCtx.sampleRate;
    // Downsample to 16 kHz if needed
    if (rate === TARGET_RATE) {
      for (let i = 0; i < input.length; i++) samples.push(input[i]);
    } else {
      const ratio = rate / TARGET_RATE;
      const outLen = Math.floor(input.length / ratio);
      for (let i = 0; i < outLen; i++) {
        const pos = i * ratio;
        const idx = Math.floor(pos);
        const frac = pos - idx;
        const a = input[idx] || 0;
        const b = input[idx + 1] || a;
        samples.push(a + (b - a) * frac);
      }
    }

    const recent = samples.slice(-Math.min(samples.length, 2048));
    const level = rms(recent);
    if (level < SILENCE_RMS) {
      silenceSamples += recent.length > 512 ? 512 : recent.length;
    } else {
      silenceSamples = 0;
    }

    if (samples.length >= chunkSamples) {
      flush(true);
    } else if (silenceSamples >= silenceLimit && samples.length >= minChunkSamples) {
      flush(true);
    }
  }

  async function start() {
    if (running) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone API unavailable');
    }
    if (!window.electronAPI?.voiceTranscribe) {
      throw new Error('Local Whisper bridge unavailable — use the desktop app');
    }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true,
      },
    });
    audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    source = audioCtx.createMediaStreamSource(stream);
    // ScriptProcessor is deprecated but widely available in Electron without worklet bundling.
    const bufferSize = 4096;
    processor = audioCtx.createScriptProcessor(bufferSize, 1, 1);
    processor.onaudioprocess = onAudio;
    source.connect(processor);
    // Keep the processor in the graph without playing the mic through speakers
    // (feedback + AEC fighting is why quiet speech was dropped).
    const muteNode = audioCtx.createGain();
    muteNode.gain.value = 0;
    mute = muteNode;
    processor.connect(mute);
    mute.connect(audioCtx.destination);
    generation += 1;
    running = true;
    samples = [];
    silenceSamples = 0;
    overlap = new Float32Array(0);
    handlers.onStatus?.('Listening…');
  }

  async function stop() {
    running = false;
    generation += 1;
    samples = [];
    queue.length = 0;
    try { window.electronAPI?.voiceAbort?.(); } catch (_) {}
    try { processor?.disconnect(); } catch (_) {}
    try { mute?.disconnect(); } catch (_) {}
    try { source?.disconnect(); } catch (_) {}
    processor = null;
    mute = null;
    source = null;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (audioCtx) {
      await audioCtx.close().catch(() => {});
      audioCtx = null;
    }
    const deadline = Date.now() + 1500;
    while (busy && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    handlers.onStatus?.(null);
  }

  return {
    start,
    stop,
    isRunning: () => running,
  };
}

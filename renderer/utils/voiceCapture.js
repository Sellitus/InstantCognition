// voiceCapture.js — renderer-side audio recording for voice input.
//
// Uses the Web Audio API to capture mono PCM at the target sample rate
// (default 16 kHz, what Moonshine expects). Returns a Recorder object with:
//   .stop()           — Promise<ArrayBuffer> (PCM16 little-endian)
//   .cancel()         — discard, release tracks
//   .getMeterLevel()  — 0..1 instantaneous RMS for the UI dot
//
// Auto-stops after `autoStopOnSilenceMs` of below-threshold audio so the user
// doesn't have to manually release the hotkey on a quick utterance.

const SILENCE_RMS = 0.012;          // tuned for typical headset / built-in mic
const ACTIVE_GRACE_MS = 800;        // require this much speech before silence-stop arms

function downsampleAndPCM16(input, fromHz, toHz) {
  if (toHz === fromHz) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }
  const ratio = fromHz / toHz;
  const newLength = Math.round(input.length / ratio);
  const out = new Int16Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < newLength) {
    const nextOffset = Math.round((offsetResult + 1) * ratio);
    let acc = 0; let count = 0;
    for (let i = offsetBuffer; i < nextOffset && i < input.length; i++) { acc += input[i]; count++; }
    const sample = count > 0 ? acc / count : 0;
    const s = Math.max(-1, Math.min(1, sample));
    out[offsetResult] = s < 0 ? s * 0x8000 : s * 0x7fff;
    offsetResult++; offsetBuffer = nextOffset;
  }
  return out;
}

function pcm16ToArrayBuffer(int16) {
  return int16.buffer.slice(int16.byteOffset, int16.byteOffset + int16.byteLength);
}

/**
 * @param {{ sampleRate?: number, autoStopOnSilenceMs?: number, maxRecordingMs?: number,
 *   onAutoStop?: () => void }} [opts]
 */
async function startCapture({ sampleRate = 16000, autoStopOnSilenceMs = 700, maxRecordingMs = 30000, onAutoStop } = {}) {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('getUserMedia unavailable');
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  // Some Chromium builds lock to 44.1k or 48k regardless of sampleRate hint;
  // we resample at stop time. AudioContext sampleRate is the source rate.
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const source = ac.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but works everywhere — AudioWorklet would
  // require a separate worklet module file, more moving parts. Buffer size
  // 4096 = ~85ms at 48kHz — fine for our latency budget.
  const proc = ac.createScriptProcessor(4096, 1, 1);
  source.connect(proc);
  proc.connect(ac.destination);

  const chunks = [];
  let lastLevel = 0;
  let everSpoke = false;
  let armedSilenceAt = null;
  let stopped = false;
  const startedAt = Date.now();

  proc.onaudioprocess = (ev) => {
    if (stopped) return;
    const buf = ev.inputBuffer.getChannelData(0);
    const copy = new Float32Array(buf.length);
    copy.set(buf);
    chunks.push(copy);

    let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    lastLevel = rms;
    if (rms > SILENCE_RMS) {
      everSpoke = true;
      armedSilenceAt = null;
    } else if (everSpoke && Date.now() - startedAt > ACTIVE_GRACE_MS) {
      if (!armedSilenceAt) armedSilenceAt = Date.now();
      else if (Date.now() - armedSilenceAt > autoStopOnSilenceMs) {
        if (typeof onAutoStop === 'function') try { onAutoStop(); } catch (err) { console.error('[voice] onAutoStop threw:', (err instanceof Error && err.message) || err); }
      }
    }
    if (Date.now() - startedAt > maxRecordingMs && typeof onAutoStop === 'function') {
      try { onAutoStop(); } catch (err) { console.error('[voice] onAutoStop threw:', (err instanceof Error && err.message) || err); }
    }
  };

  function teardown() {
    stopped = true;
    // Teardown is best-effort: each step is independent, so a failure in one
    // must not skip the rest — but it is logged, never swallowed.
    try { proc.disconnect(); } catch (err) { console.warn('[voice] processor disconnect failed:', (err instanceof Error && err.message) || err); }
    try { source.disconnect(); } catch (err) { console.warn('[voice] source disconnect failed:', (err instanceof Error && err.message) || err); }
    try { stream.getTracks().forEach((t) => t.stop()); } catch (err) { console.warn('[voice] track stop failed:', (err instanceof Error && err.message) || err); }
    try { ac.close(); } catch (err) { console.warn('[voice] AudioContext close failed:', (err instanceof Error && err.message) || err); }
  }

  return {
    getMeterLevel: () => Math.min(1, lastLevel * 8),
    cancel: () => { teardown(); chunks.length = 0; },
    stop: () => {
      teardown();
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const merged = new Float32Array(total);
      let offset = 0;
      for (const c of chunks) { merged.set(c, offset); offset += c.length; }
      const pcm16 = downsampleAndPCM16(merged, ac.sampleRate, sampleRate);
      return pcm16ToArrayBuffer(pcm16);
    },
  };
}

module.exports = { startCapture, downsampleAndPCM16, SILENCE_RMS };

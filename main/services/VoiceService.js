// VoiceService — local speech-to-text via Moonshine Tiny (May 2026 SOTA for
// edge devices: 26 MB, ~50ms latency for short utterances on CPU, no
// zero-padding penalty unlike Whisper). Mirrors the singleton-with-bindConfig
// shape of the other services.
//
// Runtime strategy:
//   1. Lazy-load the ONNX runtime + Moonshine model on first transcribe call
//      (saves cold-start memory + load time when the user never uses voice).
//   2. If loading fails (missing dep, model file, native init), set
//      `_unavailable = true`. `isAvailable()` returns false; the renderer
//      hides the mic button + hotkey gracefully.
//   3. Falls back to whisper.cpp CLI if the user has it on PATH and they
//      configure provider='whisper-tiny' (deferred — Phase 4.2.1).

const fs = require('fs');
const path = require('path');

// Legacy package name for the same native runtime. Held in a variable so the
// optional dependency is not resolved at build time.
const SHERPA_FALLBACK_MODULE = 'sherpa-onnx';

const PROVIDERS = {
  'moonshine-tiny': { dir: 'tiny-en', label: 'Moonshine Tiny (26 MB, English, fastest)' },
  'moonshine-base': { dir: 'base-en', label: 'Moonshine Base (58 MB, English, more accurate)' },
};

function defaultModelRoot() {
  // app.getPath('userData')/../Resources/vendor/moonshine in built apps,
  // and ROOT/vendor/moonshine in dev. Probe both.
  try {
    const { app } = require('electron');
    if (app && typeof app.getAppPath === 'function') {
      const candidates = [
        path.join(process.resourcesPath || '', 'moonshine'),         // packaged: extraResources to="moonshine"
        path.join(process.resourcesPath || '', 'vendor', 'moonshine'),
        path.join(app.getAppPath(), 'vendor', 'moonshine'),
        path.join(__dirname, '..', '..', 'vendor', 'moonshine'),
      ];
      for (const c of candidates) { if (c && fs.existsSync(c)) return c; }
    }
  } catch (_) { /* not in electron */ }
  return path.join(__dirname, '..', '..', 'vendor', 'moonshine');
}

class VoiceService {
  constructor() {
    this._cs = null;
    this._provider = 'moonshine-tiny';
    this._model = null;
    this._loading = null;
    this._unavailable = false;
    this._unavailableReason = null;
  }

  bindConfig(configService) {
    this._cs = configService;
    const cfg = configService.get('settings.voice', {}) || {};
    if (cfg.provider && PROVIDERS[cfg.provider]) this._provider = cfg.provider;
  }

  isEnabled() {
    if (!this._cs) return true;
    const cfg = this._cs.get('settings.voice', {}) || {};
    return cfg.enabled !== false;
  }

  isAvailable() {
    if (this._unavailable) return false;
    if (!this.isEnabled()) return false;
    // Probe model files are present (don't actually load yet).
    return this._modelFilesExist();
  }

  unavailableReason() { return this._unavailableReason; }

  listProviders() {
    return Object.keys(PROVIDERS).map((name) => ({
      name, label: PROVIDERS[name].label, available: this._modelFilesExist(name),
    }));
  }

  _providerDir(name) { return path.join(defaultModelRoot(), PROVIDERS[name || this._provider].dir); }

  _modelFilesExist(name) {
    const dir = this._providerDir(name);
    if (!fs.existsSync(dir)) return false;
    // Verify each ONNX file actually exists (the fetch script writes a
    // manifest after a successful extract, but checking the ONNX files
    // directly is cheap and catches partial / interrupted downloads).
    const required = ['preprocess.onnx', 'encode.int8.onnx', 'uncached_decode.int8.onnx', 'cached_decode.int8.onnx', 'tokens.txt'];
    for (const f of required) {
      const p = path.join(dir, f);
      if (!fs.existsSync(p) || fs.statSync(p).size === 0) return false;
    }
    return true;
  }

  // Lazy load the native ASR runtime. Runs once per session; subsequent
  // transcribes reuse the cached model. Returns null + sets _unavailable on
  // failure. Designed to NEVER throw — the caller checks `isAvailable()`.
  async _loadModel() {
    if (this._model) return this._model;
    if (this._loading) return this._loading;
    if (this._unavailable) return null;
    this._loading = (async () => {
      try {
        if (!this._modelFilesExist()) { this._unavailable = true; this._unavailableReason = 'model_not_bundled'; return null; }
        // The native runtime (sherpa-onnx or onnxruntime-node) is loaded
        // dynamically so the build doesn't hard-fail when the dep isn't
        // installed. In production builds, sherpa-onnx is in dependencies.
        let sherpa;
        try { sherpa = require('sherpa-onnx-node'); }
        catch (_e1) {
          try { sherpa = require(SHERPA_FALLBACK_MODULE); }
          catch (_e2) { this._unavailable = true; this._unavailableReason = 'native_runtime_missing'; return null; }
        }
        if (!sherpa || typeof sherpa.OfflineRecognizer !== 'function') {
          this._unavailable = true; this._unavailableReason = 'native_runtime_incompatible'; return null;
        }
        const dir = this._providerDir();
        // sherpa-onnx Node API for Moonshine, per the official non-streaming
        // Moonshine example. featConfig + modelConfig.moonshine + tokens are
        // all required at the top level of modelConfig.
        const recognizer = new sherpa.OfflineRecognizer({
          featConfig: { sampleRate: 16000, featureDim: 80 },
          modelConfig: {
            moonshine: {
              preprocessor: path.join(dir, 'preprocess.onnx'),
              encoder: path.join(dir, 'encode.int8.onnx'),
              uncachedDecoder: path.join(dir, 'uncached_decode.int8.onnx'),
              cachedDecoder: path.join(dir, 'cached_decode.int8.onnx'),
            },
            tokens: path.join(dir, 'tokens.txt'),
            numThreads: 2,
            provider: 'cpu',
            debug: 0,
          },
        });
        this._model = recognizer;
        return recognizer;
      } catch (err) {
        this._unavailable = true;
        this._unavailableReason = (err instanceof Error && err.message) || 'init_failed';
        return null;
      } finally { this._loading = null; }
    })();
    return this._loading;
  }

  // transcribe(audioBuffer, opts) — audioBuffer is a Node Buffer of PCM16
  // (mono, sampleRate Hz). Returns { ok, text, ms } or { ok:false, error }.
  /**
   * @param {Buffer} audioBuffer
   * @param {{ sampleRate?: number, signal?: AbortSignal }} [opts]
   */
  async transcribe(audioBuffer, { sampleRate = 16000, signal } = {}) {
    if (!this.isEnabled()) return { ok: false, error: 'voice_disabled' };
    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length < 1024) return { ok: false, error: 'audio_too_short' };
    const t0 = Date.now();
    const model = await this._loadModel();
    if (!model) return { ok: false, error: this._unavailableReason || 'unavailable' };
    // The decode below is a synchronous native call; the abortable window is the
    // (cold) model load above. Skip the decode entirely if cancelled meanwhile.
    if (signal && signal.aborted) return { ok: false, error: 'cancelled', ms: Date.now() - t0 };
    try {
      // PCM16 -> Float32 in-place (sherpa expects Float32 -1..1).
      const pcm16 = new Int16Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.length / 2);
      const floats = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) floats[i] = pcm16[i] / 32768;
      const stream = model.createStream();
      stream.acceptWaveform({ samples: floats, sampleRate });
      model.decode(stream);
      const result = model.getResult(stream);
      stream.free && stream.free();
      const text = (result && (result.text || result.transcript)) || '';
      return { ok: true, text: text.trim(), ms: Date.now() - t0 };
    } catch (err) {
      return { ok: false, error: (err instanceof Error && err.message) || 'transcribe_failed', ms: Date.now() - t0 };
    }
  }

  // For the "Test microphone" button in settings — runs a no-op probe to make
  // sure the runtime loads. Doesn't actually transcribe anything.
  async warmUp() { await this._loadModel(); return { ok: !!this._model, reason: this._unavailableReason }; }
}

const instance = new VoiceService();
module.exports = instance;
module.exports.VoiceService = VoiceService;
module.exports.PROVIDERS = PROVIDERS;

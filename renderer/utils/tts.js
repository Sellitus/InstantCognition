// tts.js — local text-to-speech via the renderer's Web Speech API
// (window.speechSynthesis). Zero dependency, OS voices, offline,
// cross-platform. The renderer has nodeIntegration + no CSP, so
// speechSynthesis is directly available (same context that already uses
// Web Audio for voice input).
//
// Long text is split into sentence-sized utterances and queued: Chromium
// silently truncates very long single utterances and stalls on multi-minute
// ones, so chunking is required for "listen to this whole article/report".
//
// markdownToSpeech() strips markdown + [N] citation noise so reports and
// reader content are spoken cleanly. Pure helpers are exported for tests.

const SENTENCE_MAX = 220;

function markdownToSpeech(md) {
  let t = String(md == null ? '' : md);
  t = t.replace(/```[\s\S]*?```/g, ' . ');        // fenced code blocks
  t = t.replace(/`([^`]+)`/g, '$1');              // inline code
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');    // images
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');  // links -> link text
  t = t.replace(/\[\d+\]/g, '');                  // [N] citation markers
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');       // ATX headings
  t = t.replace(/^\s{0,3}>\s?/gm, '');            // blockquote markers
  t = t.replace(/^\s*[-*+]\s+/gm, '');            // list bullets
  t = t.replace(/^\s*[-*_]{3,}\s*$/gm, ' ');      // horizontal rules
  t = t.replace(/(\*\*|__|\*|_|~~)/g, '');        // emphasis markers
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  return t;
}

// Split into speakable chunks at sentence boundaries; hard-wrap any single
// over-long sentence so no utterance is large enough to stall the engine.
function chunkText(text) {
  const out = [];
  const paras = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  for (const para of paras) {
    const sentences = para.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [para];
    let buf = '';
    for (const raw of sentences) {
      const piece = raw.trim();
      if (!piece) continue;
      if ((`${buf} ${piece}`).trim().length > SENTENCE_MAX) {
        if (buf) { out.push(buf.trim()); buf = ''; }
        if (piece.length > SENTENCE_MAX) {
          for (let i = 0; i < piece.length; i += SENTENCE_MAX) out.push(piece.slice(i, i + SENTENCE_MAX));
        } else {
          buf = piece;
        }
      } else {
        buf = buf ? `${buf} ${piece}` : piece;
      }
    }
    if (buf) out.push(buf.trim());
  }
  return out;
}

class TtsEngine {
  constructor() {
    this._synth = (typeof window !== 'undefined' && window.speechSynthesis) || null;
    this._queue = [];
    this._idx = 0;
    this._state = 'idle'; // 'idle' | 'speaking' | 'paused'
    this._onState = null;
    this._token = 0;
  }

  isSupported() { return !!this._synth; }
  isSpeaking() { return this._state === 'speaking'; }
  isPaused() { return this._state === 'paused'; }

  // OS voices. May be empty until the async voiceschanged event fires.
  listVoices() {
    if (!this._synth) return [];
    try { return this._synth.getVoices() || []; } catch (_) { return []; }
  }

  onVoicesChanged(cb) {
    if (!this._synth || typeof cb !== 'function') return;
    try { this._synth.addEventListener('voiceschanged', cb); } catch (_) {}
  }

  offVoicesChanged(cb) {
    if (!this._synth || typeof cb !== 'function') return;
    try { this._synth.removeEventListener('voiceschanged', cb); } catch (_) {}
  }

  // Pick a sensible voice when the user hasn't chosen one. The engine's own
  // fallback is arbitrary and frequently a low-quality / oddly-pitched voice,
  // so prefer an on-device (localService) voice in the UI language, then a
  // language match, then the engine's default-flagged voice, then any local
  // voice. Returns null only when no voices exist at all.
  _pickDefaultVoice() {
    const voices = this.listVoices();
    if (!voices.length) return null;
    const uiLang = String(
      (typeof navigator !== 'undefined' && navigator.language) || 'en-US',
    ).toLowerCase();
    const base = uiLang.split('-')[0];
    const local = voices.filter((v) => v.localService);
    const pool = local.length ? local : voices;
    const lc = (v) => String(v.lang || '').toLowerCase();
    return pool.find((v) => lc(v) === uiLang)
      || pool.find((v) => lc(v).split('-')[0] === base)
      || pool.find((v) => v.default)
      || pool[0];
  }

  _emit(state) {
    this._state = state;
    if (typeof this._onState === 'function') { try { this._onState(state); } catch (_) {} }
  }

  speak(text, opts = {}) {
    if (!this._synth) return false;
    const speakable = (opts.markdown ? markdownToSpeech(text) : String(text || '')).trim();
    if (!speakable) return false;
    this.cancel();
    const token = ++this._token;
    this._queue = chunkText(speakable);
    this._idx = 0;
    this._onState = typeof opts.onState === 'function' ? opts.onState : null;
    const rate = Math.max(0.5, Math.min(2, Number(opts.rate) || 1));
    const saved = opts.voiceURI
      ? this.listVoices().find((v) => v.voiceURI === opts.voiceURI) || null
      : null;
    // Fall back to a deliberately chosen default (not the engine's arbitrary
    // one) when nothing is configured or a saved voice is no longer installed.
    const voice = saved || this._pickDefaultVoice();
    const next = () => {
      if (token !== this._token) return; // superseded by a newer speak/cancel
      if (this._idx >= this._queue.length) { this._emit('idle'); return; }
      const u = new SpeechSynthesisUtterance(this._queue[this._idx]);
      this._idx += 1;
      u.rate = rate;
      u.pitch = 1; // pin to normal — never inherit an odd engine default
      if (voice) {
        u.voice = voice;
        if (voice.lang) u.lang = voice.lang;
      }
      u.onend = () => next();
      u.onerror = () => next();
      this._synth.speak(u);
    };
    this._emit('speaking');
    next();
    return true;
  }

  pause() {
    if (this._synth && this._state === 'speaking') {
      try { this._synth.pause(); } catch (_) {}
      this._emit('paused');
    }
  }

  resume() {
    if (this._synth && this._state === 'paused') {
      try { this._synth.resume(); } catch (_) {}
      this._emit('speaking');
    }
  }

  // Start speaking, or stop if already speaking. Returns true if it started.
  toggle(text, opts) {
    if (this._state === 'speaking' || this._state === 'paused') { this.cancel(); return false; }
    return this.speak(text, opts);
  }

  cancel() {
    this._token += 1;
    this._queue = [];
    this._idx = 0;
    if (this._synth) { try { this._synth.cancel(); } catch (_) {} }
    if (this._state !== 'idle') this._emit('idle');
  }
}

const instance = new TtsEngine();
module.exports = instance;
module.exports.TtsEngine = TtsEngine;
module.exports.markdownToSpeech = markdownToSpeech;
module.exports.chunkText = chunkText;

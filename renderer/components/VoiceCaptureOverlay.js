// VoiceCaptureOverlay.js — small, non-intrusive listening indicator. Lives
// at the bottom-center of the viewport as a pill chip, NEVER as a full-screen
// modal — the user can keep typing/clicking elsewhere while it records.
// Click the chip or press Esc to stop. Errors flow through Toast.
//
// Focus preservation: we capture the explicit target, when supplied, or
// document.activeElement BEFORE we start recording so that after transcription
// we can drop the text exactly where the user was last focused. The chip
// itself does not steal focus.

const { ipcRenderer } = require('electron');
const { startCapture } = require('../utils/voiceCapture');
const { insertTranscript, insertIntoElement, isEditableElement } = require('../utils/focusInsertion');
const { errMsg } = require('../../shared/errMsg');
const fx = require('../fx');

let toast = null;
try { toast = require('./Toast'); } catch (_) { toast = { error: () => {}, info: () => {}, warn: () => {} }; }
// User-facing failure copy, hoisted so the transcribe path (_friendlyError)
// and the Cmd+Shift+V path (voiceUnavailableMessage) speak the same family.
// Recovery paths must be actions a shipped user can actually take: no shell
// commands, no settings pages that don't exist.
const FRIENDLY_VOICE_ERRORS = {
  model_not_bundled: 'Voice model is not installed. Reinstall the app to restore voice input.',
  native_runtime_missing: 'Voice runtime is not installed. Reinstall the app to repair it, then restart.',
  native_runtime_incompatible: 'Voice runtime version is incompatible with this build. Reinstalling the app may fix it.',
  audio_too_short: 'Recording was too short. Try again and speak for at least half a second.',
  voice_disabled: 'Voice input is turned off. Use "Open config file" under Settings → Diagnostics & reset, set settings.voice.enabled back to true, and restart the app.',
  transcribe_failed: 'Transcription failed. The audio may have been too noisy or the model may need a restart.',
};

// Maps a voice:available reply to the same copy family. `reason` comes from
// VoiceService.unavailableReason(); enabled:false is the settings toggle; a
// null reason with voice enabled means the model-file probe failed, so the
// model copy applies (VoiceService.isAvailable probes without loading).
function voiceUnavailableMessage(r) {
  if (!r) return 'Voice input could not start. Restart the app and try again.';
  const code = r.reason || (r.enabled === false ? 'voice_disabled' : 'model_not_bundled');
  const known = FRIENDLY_VOICE_ERRORS[code];
  // typeof guard: prototype-named codes ('constructor', '__proto__', …) must
  // hit the fallback, not leak Object.prototype members into the copy.
  return typeof known === 'string' ? known : `Voice input could not start: ${code}. Restart the app and try again.`;
}

class VoiceCaptureOverlay {
  constructor() {
    this._chip = null;
    this._meterEl = null;
    this._orbEl = null;
    this._labelEl = null;
    this._recorder = null;
    this._meterRaf = null;
    this._mode = 'idle'; // 'idle' | 'recording' | 'transcribing'
    this._cfg = null;
    this._targetEl = null;
    this._sessionId = 0;          // bumped on every start; results from older sessions are discarded
    this._activeSession = 0;
    this._transcribeTimer = null; // hard timeout on the transcribe phase
    this._stateListeners = new Set();
    this._onKeydown = (e) => { if (e.key === 'Escape' && this._mode !== 'idle') { e.preventDefault(); this.cancel(); } };
  }

  bindConfig(cfg) { this._cfg = cfg; }

  onStateChange(fn) {
    if (typeof fn !== 'function') return () => {};
    this._stateListeners.add(fn);
    try { fn(this.getState()); } catch (_) { /* ignore listener errors */ }
    return () => this._stateListeners.delete(fn);
  }

  getState() {
    return {
      mode: this._mode,
      isActive: this._mode !== 'idle',
      targetEl: this._targetEl,
    };
  }

  _emitState() {
    const state = this.getState();
    for (const fn of this._stateListeners) {
      try { fn(state); } catch (_) { /* ignore listener errors */ }
    }
  }

  _build() {
    if (this._chip) return;
    const chip = document.createElement('div');
    chip.className = 'voice-chip';
    chip.setAttribute('role', 'status');
    chip.setAttribute('aria-live', 'polite');
    chip.setAttribute('aria-label', 'Voice input');
    // tabindex=-1 so click-to-stop works without grabbing focus from the
    // user's text input. We never call .focus() on it.
    chip.setAttribute('tabindex', '-1');
    chip.innerHTML = ''
      + '<span class="voice-chip-dot" aria-hidden="true"></span>'
      + '<canvas class="voice-chip-orb" aria-hidden="true"></canvas>'
      + '<span class="voice-chip-label">Listening…</span>'
      + '<span class="voice-chip-meter"><span class="voice-chip-meter-bar"></span></span>'
      + '<span class="voice-chip-hint">click or Esc to stop</span>';
    chip.addEventListener('mousedown', (e) => {
      // mousedown rather than click so we don't briefly steal focus.
      e.preventDefault();
      if (this._mode === 'recording') this.stop();
      else if (this._mode === 'transcribing') this.cancel();
    });
    document.body.appendChild(chip);
    this._chip = chip;
    this._meterEl = /** @type {HTMLElement} */ (chip.querySelector('.voice-chip-meter-bar'));
    this._orbEl = /** @type {HTMLCanvasElement} */ (chip.querySelector('.voice-chip-orb'));
    this._labelEl = chip.querySelector('.voice-chip-label');
  }

  async start({ pressToTalk = false, targetEl = null } = {}) {
    if (this._mode !== 'idle') return;
    this._sessionId += 1;
    const sid = this._sessionId;
    const candidate = isEditableElement(targetEl) ? targetEl : document.activeElement;
    this._targetEl = isEditableElement(candidate) ? candidate : null;

    this._build();
    this._chip.classList.add('is-visible');
    this._mode = 'recording';
    this._activeSession = sid;
    if (this._labelEl) this._labelEl.textContent = pressToTalk ? 'Listening… (hold)' : 'Listening…';
    document.addEventListener('keydown', this._onKeydown, true);
    this._emitState();
    try {
      const cfg = this._cfg || {};
      this._recorder = await startCapture({
        sampleRate: cfg.sampleRate || 16000,
        autoStopOnSilenceMs: cfg.autoStopOnSilenceMs || 700,
        maxRecordingMs: cfg.maxRecordingMs || 30000,
        onAutoStop: () => this.stop(),
      });
      this._tickMeter();
    } catch (err) {
      this._teardown();
      const msg = (err instanceof Error && err.name === 'NotAllowedError')
        ? 'Microphone permission denied. Allow it in System Settings → Privacy & Security → Microphone, then try again.'
        : `Mic unavailable: ${errMsg(err)}`;
      if (toast && toast.error) toast.error(msg, { title: 'Voice input' });
    }
  }

  _tickMeter() {
    const tick = () => {
      if (this._mode !== 'recording' || !this._recorder || !this._meterEl) return;
      const lvl = Math.max(0, Math.min(1, this._recorder.getMeterLevel ? this._recorder.getMeterLevel() : 0));
      this._meterEl.style.transform = `scaleX(${lvl.toFixed(3)})`;
      fx.voiceOrb(this._orbEl, lvl);
      this._meterRaf = requestAnimationFrame(tick);
    };
    this._meterRaf = requestAnimationFrame(tick);
  }

  async stop() {
    if (this._mode !== 'recording' || !this._recorder) return;
    const sid = this._activeSession;
    if (this._labelEl) this._labelEl.textContent = 'Transcribing…';
    if (this._chip) this._chip.classList.add('is-transcribing');
    this._mode = 'transcribing';
    this._emitState();
    if (this._meterRaf) { cancelAnimationFrame(this._meterRaf); this._meterRaf = null; }
    let audio;
    try { audio = this._recorder.stop(); }
    catch (_err) { this._teardown(); return; }
    this._recorder = null;
    const target = this._targetEl;

    // Hard 30s timeout on the transcribe phase. If the native runtime hangs,
    // we tear down anyway so the chip never gets stuck on screen.
    if (this._transcribeTimer) clearTimeout(this._transcribeTimer);
    this._transcribeTimer = setTimeout(() => {
      if (this._sessionId !== sid) return;
      this._teardown();
      if (toast && toast.error) toast.error('Transcription timed out (30s). Try again with a shorter clip.', { title: 'Voice input' });
    }, 30000);

    let r;
    try { r = await ipcRenderer.invoke('voice:transcribe', { audio, sampleRate: (this._cfg && this._cfg.sampleRate) || 16000 }); }
    catch (err) {
      if (this._sessionId !== sid) return;     // user cancelled while we were waiting
      this._teardown();
      if (toast && toast.error) toast.error(`Transcribe failed: ${errMsg(err)}`, { title: 'Voice input' });
      return;
    }
    if (this._sessionId !== sid) return;         // cancelled mid-flight; ignore the late result
    this._teardown();

    if (r && r.ok && r.text) {
      const mode = (this._cfg && this._cfg.insertMode) || 'append-with-space';
      let placed = false;
      if (target && document.body.contains(target)) {
        placed = insertIntoElement(target, r.text, { mode });
        if (placed) try { target.focus(); } catch (err) { console.warn('[voice] could not refocus target after insert:', errMsg(err)); }
      }
      if (!placed) {
        const ins = insertTranscript(r.text, { mode });
        placed = ins && ins.ok;
        if (!placed && toast && toast.info) toast.info(`Heard: "${r.text}" — but no input was focused.`, { title: 'Voice input' });
      }
    } else if (r && r.ok && !r.text) {
      if (toast && toast.info) toast.info('No speech detected. Try again.', { title: 'Voice input' });
    } else if (r && r.error) {
      if (toast && toast.error) toast.error(this._friendlyError(r.error), { title: 'Voice input' });
    }
  }

  cancel() {
    // Bumping sessionId discards any in-flight transcribe result so a late
    // resolution doesn't trip teardown again or insert stale text.
    this._sessionId += 1;
    if (this._recorder) { try { this._recorder.cancel(); } catch (err) { console.warn('[voice] recorder cancel failed:', errMsg(err)); } }
    if (this._transcribeTimer) { clearTimeout(this._transcribeTimer); this._transcribeTimer = null; }
    try { ipcRenderer.send('voice:cancel'); } catch (err) { console.warn('[voice] voice:cancel send failed:', errMsg(err)); }
    this._teardown();
    if (toast && toast.info) toast.info('Voice input cancelled.', { title: 'Voice input', timeout: 1500 });
  }

  _teardown() {
    this._mode = 'idle';
    this._recorder = null;
    this._targetEl = null;
    if (this._meterRaf) { cancelAnimationFrame(this._meterRaf); this._meterRaf = null; }
    if (this._transcribeTimer) { clearTimeout(this._transcribeTimer); this._transcribeTimer = null; }
    document.removeEventListener('keydown', this._onKeydown, true);
    if (this._chip) {
      this._chip.classList.remove('is-visible');
      this._chip.classList.remove('is-transcribing');
    }
    this._emitState();
  }

  isActive() { return this._mode !== 'idle'; }

  _friendlyError(code) { const known = FRIENDLY_VOICE_ERRORS[code]; return typeof known === 'string' ? known : `Transcription failed: ${code}`; }
}

module.exports = new VoiceCaptureOverlay();
module.exports.voiceUnavailableMessage = voiceUnavailableMessage;

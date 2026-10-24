// @ts-nocheck
const { icon } = require('./Icon');
const overlay = require('./VoiceCaptureOverlay');
const configBridge = require('../core/configBridge');

function fallbackConfig() {
  return configBridge.get('settings.voice', {}) || {};
}

function readConfig(getConfig) {
  if (typeof getConfig === 'function') {
    const cfg = getConfig();
    return cfg && typeof cfg === 'object' ? cfg : {};
  }
  return fallbackConfig();
}

function overlayState() {
  if (overlay && typeof overlay.getState === 'function') return overlay.getState();
  const active = !!(overlay && typeof overlay.isActive === 'function' && overlay.isActive());
  return { mode: active ? 'recording' : 'idle', isActive: active, targetEl: null };
}

function createVoiceInputButton(options = {}) {
  const target = options.target || null;
  const label = options.label || 'Dictate text';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = ['voice-input-button', options.className].filter(Boolean).join(' ');
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-pressed', 'false');
  button.title = label;
  button.appendChild(icon('mic'));

  const sync = (state = overlayState()) => {
    const ownSession = !!target && state.targetEl === target && state.isActive;
    button.classList.toggle('is-listening', ownSession && state.mode === 'recording');
    button.classList.toggle('is-transcribing', ownSession && state.mode === 'transcribing');
    button.disabled = !!(state.isActive && !ownSession);
    button.setAttribute('aria-pressed', ownSession ? 'true' : 'false');
    if (ownSession && state.mode === 'transcribing') button.title = 'Cancel transcription';
    else if (ownSession) button.title = 'Stop dictation';
    else button.title = label;
  };

  if (overlay && typeof overlay.onStateChange === 'function') {
    button.destroyVoiceButton = overlay.onStateChange(sync);
  } else {
    sync();
  }

  button.addEventListener('mousedown', (event) => {
    event.preventDefault();
  });

  button.addEventListener('click', () => {
    if (!target) return;
    const state = overlayState();
    const ownSession = state.targetEl === target && state.isActive;

    if (ownSession && state.mode === 'transcribing') {
      if (overlay && typeof overlay.cancel === 'function') overlay.cancel();
      return;
    }
    if (ownSession && state.mode === 'recording') {
      if (overlay && typeof overlay.stop === 'function') overlay.stop();
      return;
    }
    if (state.isActive) return;

    if (overlay && typeof overlay.bindConfig === 'function') {
      overlay.bindConfig(readConfig(options.getConfig));
    }
    if (typeof target.focus === 'function') {
      try { target.focus({ preventScroll: true }); } catch (_) { target.focus(); }
    }
    if (overlay && typeof overlay.start === 'function') {
      overlay.start({ pressToTalk: false, targetEl: target });
    }
  });

  sync();
  return button;
}

module.exports = { createVoiceInputButton };

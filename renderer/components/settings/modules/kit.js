// kit — small DOM helpers shared by the custom settings modules.

const { el } = require('../controls');
const { icon: makeIcon } = require('../../Icon');
const { createVoiceInputButton } = require('../../VoiceInputButton');

function actionButton(label, className = 'sv-button', iconName = null) {
  const children = [];
  if (iconName) children.push(makeIcon(iconName, { className: 'sv-button-icon' }));
  children.push(el('span', {}, [label]));
  return el('button', { type: 'button', class: className, 'aria-label': label }, children);
}

function isValidUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch (_) {
    return false; // URL() throwing is the "not a URL" answer.
  }
  return u.protocol === 'http:' || u.protocol === 'https:';
}

function voiceField(target, label, configBridge) {
  const options = { target, label };
  if (configBridge && typeof configBridge.snapshot === 'function') {
    options.getConfig = () => {
      const snap = configBridge.snapshot() || {};
      return (snap.settings && snap.settings.voice) || {};
    };
  }
  return el('div', { class: 'sv-voice-field' }, [target, createVoiceInputButton(options)]);
}

/** A visible, announced error line for a list or panel that failed to load. */
function errorRow(message) {
  return el('div', { class: 'sv-empty-row sv-empty-row--error', role: 'alert' }, [message]);
}

/** Set an `.sv-validation-status` line; kind is ok | error | pending | null. */
function setStatus(statusEl, kind, message) {
  statusEl.className = kind ? `sv-validation-status is-${kind}` : 'sv-validation-status';
  statusEl.textContent = message || '';
  if (kind === 'error') statusEl.setAttribute('role', 'alert');
  else statusEl.removeAttribute('role');
}

module.exports = { actionButton, isValidUrl, voiceField, errorRow, setStatus };

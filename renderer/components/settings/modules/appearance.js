// Accent color picker with live preview.

const { el } = require('../controls');
const { actionButton, setStatus } = require('./kit');

// -- Accent color ----------------------------------------------------------

const DEFAULT_ACCENT = '#0089AB';
// <input type=color> only accepts #rrggbb; anything else would be shown as black.
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

function accentColor({ host, configBridge }) {
  const current = configBridge.get('settings.accentColor', null);
  const savedIsValid = typeof current === 'string' && HEX_COLOR_RE.test(current);
  const input = el('input', {
    type: 'color', class: 'sv-color',
    value: savedIsValid ? current : DEFAULT_ACCENT,
    'aria-label': 'Accent color',
  });
  const status = el('span', { class: 'sv-validation-status' });
  if (current != null && !savedIsValid) {
    setStatus(status, 'error', `Saved accent "${String(current)}" is not a #rrggbb color; showing the default.`);
  }
  const resetBtn = actionButton('Reset to default', 'sv-button', 'refresh');

  // Live visual preview straight to the DOM (no IPC per drag frame); the value
  // is persisted once on 'change'. Re-derives the whole appearance so a partial
  // override never leaves the theme half-applied.
  const preview = (overrideColor) => {
    const w = /** @type {any} */ (window);
    if (typeof w.applyAppearanceSettings !== 'function') return;
    const snap = configBridge.snapshot() || {};
    const settings = { ...(snap.settings || {}) };
    if (overrideColor !== undefined) settings.accentColor = overrideColor;
    w.applyAppearanceSettings(settings);
  };

  input.addEventListener('input', () => preview(input.value));
  input.addEventListener('change', () => {
    configBridge.set('settings.accentColor', input.value);
    setStatus(status, null, '');
  });
  resetBtn.addEventListener('click', () => {
    configBridge.set('settings.accentColor', null);
    setStatus(status, null, '');
    input.value = DEFAULT_ACCENT;
    preview();
  });

  host.appendChild(el('div', { class: 'sv-actions-row sv-accent-row' }, [input, resetBtn, status]));
}

module.exports = { accentColor };

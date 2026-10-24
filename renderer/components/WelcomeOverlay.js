// WelcomeOverlay.js — one-time first-run panel. Names the shortcuts that are
// otherwise undiscoverable (nothing on screen hints at Cmd+K or Cmd+Shift+A)
// and points at Settings → LLM, without which the chat and agent surfaces have
// no model to talk to. Dismissal writes state.hasSeenWelcome, so it shows once.

const { iconHTML } = require('./Icon');
const { trap } = require('../utils/focusTrap');
const modalStack = require('../utils/modalStack');
const { escapeHtml } = require('../utils/html');
const shortcutManager = require('../utils/shortcuts');
const configBridge = require('../core/configBridge');
const fx = require('../fx');

// action → what the shortcut gets you. Keys come from the live registry so a
// remapped shortcut shows the user's own binding.
const HIGHLIGHTS = [
  { action: 'window.toggle', icon: 'power', label: 'Show or hide InstantCognition from anywhere' },
  { action: 'palette.toggle', icon: 'search', label: 'Command palette — every action, one search box' },
  { action: 'tab.new', icon: 'plus', label: 'New tab — pick an AI space or open any URL' },
  { action: 'panel.chat', icon: 'sparkles', label: 'Chat and agent panel for the current page' },
  { action: 'view.flip', icon: 'panelLeft', label: 'Flip between the assistant and browser views' },
];

function displayKey(key) {
  if (!key) return '';
  const isMac = process.platform === 'darwin';
  return key.replace(/CmdOrCtrl/g, isMac ? 'Cmd' : 'Ctrl');
}

class WelcomeOverlay {
  constructor() {
    this._overlay = null;
    this._releaseTrap = null;
    this._layer = null;
    this._stars = null;
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onOpenLlmSettings = null;
  }

  /** @param {{ onOpenLlmSettings?: () => void }} [opts] */
  initialize(opts = {}) {
    const onOpenLlmSettings = opts.onOpenLlmSettings;
    this._onOpenLlmSettings = typeof onOpenLlmSettings === 'function' ? onOpenLlmSettings : null;
  }

  // Shows only on a genuine first run. Config migration marks every upgraded
  // install as already-seen, so this fires for new users alone.
  /** @param {{ state?: { hasSeenWelcome?: boolean } }} config */
  maybeShow(config) {
    const state = (config && config.state) || {};
    if (state.hasSeenWelcome) return false;
    this.show();
    return true;
  }

  isOpen() { return !!this._overlay; }

  show() {
    if (this._overlay) return;
    if (typeof document === 'undefined' || !document.body) return;

    const rows = HIGHLIGHTS.map((h) => {
      const shortcut = shortcutManager.getShortcut(h.action);
      const key = displayKey(shortcut && shortcut.key);
      return ''
        + '<li class="welcome-row">'
        + '  <span class="welcome-row-icon">' + iconHTML(h.icon) + '</span>'
        + '  <span class="welcome-row-label">' + escapeHtml(h.label) + '</span>'
        + '  <kbd class="welcome-row-key">' + escapeHtml(key) + '</kbd>'
        + '</li>';
    }).join('');

    const overlay = document.createElement('div');
    overlay.className = 'welcome-overlay';
    overlay.innerHTML = ''
      + '<canvas class="fx-starfield" aria-hidden="true"></canvas>'
      + '<div class="welcome-panel" role="dialog" aria-modal="true" aria-labelledby="welcome-title">'
      + '  <h1 class="welcome-title" id="welcome-title">Welcome to InstantCognition</h1>'
      + '  <p class="welcome-subtitle">A browser for AI spaces, with a local model and an agent built in.</p>'
      + '  <ul class="welcome-rows">' + rows + '</ul>'
      + '  <p class="welcome-llm-note">Chat and the agent need a model. Point them at a local engine or a remote API in Settings → LLM.</p>'
      + '  <div class="welcome-actions">'
      + '    <button type="button" class="welcome-llm">Set up a model</button>'
      + '    <button type="button" class="welcome-dismiss">Start browsing</button>'
      + '  </div>'
      + '</div>';
    document.body.appendChild(overlay);
    this._overlay = overlay;
    this._stars = fx.starfield(overlay.querySelector('.fx-starfield'), { warp: true });
    this._stars.start();

    const dismissBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('.welcome-dismiss'));
    const llmBtn = overlay.querySelector('.welcome-llm');
    dismissBtn.addEventListener('click', () => this.dismiss());
    llmBtn.addEventListener('click', () => {
      this.dismiss();
      if (this._onOpenLlmSettings) this._onOpenLlmSettings();
    });

    document.addEventListener('keydown', this._onKeyDown, true);
    this._layer = modalStack.push();
    this._releaseTrap = trap(overlay.querySelector('.welcome-panel'), { initialFocus: dismissBtn });
  }

  dismiss() {
    if (!this._overlay) return;
    this._persistSeen();
    if (this._stars) { this._stars.stop(); this._stars = null; }
    if (this._layer) { modalStack.pop(this._layer); this._layer = null; }
    if (this._releaseTrap) {
      const release = this._releaseTrap;
      this._releaseTrap = null;
      try { release(); }
      catch (err) { console.error('[WelcomeOverlay] focus trap release failed:', (err instanceof Error && err.message) || err); }
    }
    document.removeEventListener('keydown', this._onKeyDown, true);
    if (this._overlay.parentNode) this._overlay.parentNode.removeChild(this._overlay);
    this._overlay = null;
  }

  _persistSeen() {
    try { configBridge.set('state.hasSeenWelcome', true); }
    catch (err) { console.error('[WelcomeOverlay] could not persist hasSeenWelcome:', (err instanceof Error && err.message) || err); }
  }

  _onKeyDown(e) {
    if (!this._overlay) return;
    if (this._layer && !modalStack.isTop(this._layer)) return;
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      this.dismiss();
    }
  }
}

module.exports = new WelcomeOverlay();

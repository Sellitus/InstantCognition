// PermissionPrompt.js — Singleton prompt queue that renders a modal dialog
// each time PermissionPromptService requests a decision. Handles one prompt
// at a time; additional prompts queue behind the current one.
//
// Responds via ipcRenderer.send('notifications:permission:resolve',
// { id, decision: 'allow'|'deny', remember: boolean }).

const { ipcRenderer } = require('electron');
const { iconHTML } = require('./Icon');
const { trap } = require('../utils/focusTrap');
const modalStack = require('../utils/modalStack');
const { escapeHtml } = require('../utils/html');

const PERMISSION_COPY = {
  'clipboard-read': {
    title: 'Read your clipboard?',
    detail: 'This site wants to read what you last copied, which can include passwords or private text.',
    icon: 'copy',
  },
  notifications: {
    title: 'Allow notifications?',
    detail: 'This site wants to send you notifications. They will appear in your in-app inbox.',
    icon: 'bell',
  },
  geolocation: {
    title: 'Share your location?',
    detail: 'This site wants to access your approximate location.',
    icon: 'location',
  },
  media: {
    title: 'Use your camera and microphone?',
    detail: 'This site wants to access your camera and/or microphone.',
    icon: 'camera',
  },
  midi: {
    title: 'Connect MIDI devices?',
    detail: 'This site wants to communicate with MIDI devices attached to your computer.',
    icon: 'settings',
  },
  midiSysex: {
    title: 'Send MIDI system messages?',
    detail: 'This site wants to send low-level MIDI SysEx messages to your devices.',
    icon: 'settings',
  },
  'display-capture': {
    title: 'Share your screen?',
    detail: 'This site wants to capture the contents of a window or display.',
    icon: 'screen',
  },
};

function copyFor(permission) {
  if (permission.startsWith('openExternal:')) {
    return {
      title: 'Open another app?',
      detail: 'This site wants to open a "' + permission.slice('openExternal:'.length) + ':" link in an app outside InstantCognition.',
      icon: 'external',
    };
  }
  return PERMISSION_COPY[permission] || {
    title: 'Allow ' + permission + '?',
    detail: 'This site is requesting the ' + permission + ' permission.',
    icon: 'settings',
  };
}

class PermissionPrompt {
  constructor() {
    this._queue = [];
    this._active = null;
    this._overlay = null;
    this._onKeyDown = this._onKeyDown.bind(this);
    this._layer = null;
    this._wired = false;
  }

  initialize() {
    if (this._wired) return;
    this._wired = true;
    ipcRenderer.on('notifications:permission-prompt', (_e, request) => {
      if (!request || !request.id) return;
      this._queue.push(request);
      this._pump();
    });
    // Main settled the prompt without this UI (timeout, or a page that went away).
    ipcRenderer.on('notifications:permission-resolved', (_e, settled) => {
      if (!settled || !settled.id) return;
      this._queue = this._queue.filter((r) => r.id !== settled.id);
      if (this._active && this._active.id === settled.id) {
        this._teardown();
        this._active = null;
        this._pump();
      }
    });
  }

  _pump() {
    if (this._active) return;
    const next = this._queue.shift();
    if (!next) return;
    this._active = next;
    this._render(next);
  }

  _resolve(decision, remember) {
    if (!this._active) return;
    const { id } = this._active;
    ipcRenderer.send('notifications:permission:resolve', { id, decision, remember });
    this._teardown();
    this._active = null;
    this._pump();
  }

  _render(request) {
    if (typeof document === 'undefined' || !document.body) {
      // No DOM — auto-deny so pending promises resolve.
      this._resolve('deny', false);
      return;
    }
    const copy = copyFor(request.permission);
    const overlay = document.createElement('div');
    overlay.className = 'permission-prompt-overlay';
    overlay.innerHTML = ''
      + '<div class="permission-prompt" role="alertdialog" aria-modal="true" aria-labelledby="permission-prompt-title">'
      + '  <div class="permission-prompt-header">'
      + '    <span class="permission-prompt-icon">' + iconHTML(copy.icon) + '</span>'
      + '    <span class="permission-prompt-title" id="permission-prompt-title">' + escapeHtml(copy.title) + '</span>'
      + '    <button type="button" class="permission-prompt-close" aria-label="Dismiss and block" title="Dismiss and block">' + iconHTML('close') + '</button>'
      + '  </div>'
      + '  <div class="permission-prompt-origin">' + escapeHtml(request.origin || 'Unknown site') + '</div>'
      + '  <div class="permission-prompt-detail">' + escapeHtml(copy.detail) + '</div>'
      + (request.detail ? '  <div class="permission-prompt-detail permission-prompt-target">' + escapeHtml(request.detail) + '</div>' : '')
      + '  <label class="permission-prompt-remember">'
      + '    <input type="checkbox" class="permission-prompt-remember-cb" checked />'
      + '    <span>' + (request.ephemeral ? 'Remember for this site for this private session' : 'Remember this decision for this site') + '</span>'
      + '  </label>'
      + '  <div class="permission-prompt-actions">'
      + '    <button type="button" class="permission-prompt-deny">Block</button>'
      + '    <button type="button" class="permission-prompt-allow">Allow</button>'
      + '  </div>'
      + '</div>';
    document.body.appendChild(overlay);
    this._overlay = overlay;

    const rememberEl = /** @type {HTMLInputElement} */ (overlay.querySelector('.permission-prompt-remember-cb'));
    const allowBtn = overlay.querySelector('.permission-prompt-allow');
    const denyBtn = overlay.querySelector('.permission-prompt-deny');
    allowBtn.addEventListener('click', () => this._resolve('allow', !!rememberEl.checked));
    denyBtn.addEventListener('click', () => this._resolve('deny', !!rememberEl.checked));
    overlay.querySelector('.permission-prompt-close').addEventListener('click', () => this._resolve('deny', false));
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) this._resolve('deny', false);
    });
    document.addEventListener('keydown', this._onKeyDown, true);
    this._layer = modalStack.push();
    // The teardown check is load-bearing: a prompt dismissed before this tick
    // would otherwise install a trap nobody can release, leaving every body
    // child inert and the window unclickable.
    setTimeout(() => {
      if (this._overlay !== overlay) return;
      this._releaseTrap = trap(overlay.querySelector('.permission-prompt'), { initialFocus: allowBtn });
    }, 0);
  }

  _teardown() {
    if (this._layer) { modalStack.pop(this._layer); this._layer = null; }
    if (this._releaseTrap) {
      // Clear the handle first: a throwing release must not leave a trap that
      // teardown will try to release again on the next prompt.
      const release = this._releaseTrap;
      this._releaseTrap = null;
      try { release(); }
      catch (err) { console.error('[PermissionPrompt] focus trap release failed:', (err instanceof Error && err.message) || err); }
    }
    document.removeEventListener('keydown', this._onKeyDown, true);
    if (this._overlay && this._overlay.parentNode) {
      this._overlay.parentNode.removeChild(this._overlay);
    }
    this._overlay = null;
  }

  _onKeyDown(e) {
    if (!this._active) return;
    if (this._layer && !modalStack.isTop(this._layer)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this._resolve('deny', false);
    } else if (e.key === 'Enter') {
      // Enter on Block or the close icon must not grant: leave it to that
      // button's own click.
      const focused = document.activeElement;
      if (focused && focused.tagName === 'BUTTON' && !focused.classList.contains('permission-prompt-allow')
        && this._overlay && this._overlay.contains(focused)) return;
      e.preventDefault();
      const allow = this._overlay && /** @type {HTMLButtonElement} */ (this._overlay.querySelector('.permission-prompt-allow'));
      if (allow) allow.click();
    }
  }
}

module.exports = new PermissionPrompt();

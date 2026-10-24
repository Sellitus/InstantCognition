// HistoryRail — collapses the Assistant's history column to a narrow rail
// (icon + run count) and expands it on demand. The choice persists per machine
// in localStorage; storage that is unavailable or throws falls back to the
// collapsed default so the panel always renders.

const { iconHTML } = require('../Icon');

const STORAGE_KEY = 'agent.history.open';

function errText(err) {
  return (err && err.message) || String(err);
}

function readStoredOpen(getStorage) {
  try {
    const storage = getStorage();
    return !!storage && storage.getItem(STORAGE_KEY) === '1';
  } catch (err) {
    console.warn('[HistoryRail] history state unreadable; starting collapsed:', errText(err));
    return false;
  }
}

function writeStoredOpen(getStorage, open) {
  try {
    const storage = getStorage();
    if (storage) storage.setItem(STORAGE_KEY, open ? '1' : '0');
  } catch (err) {
    console.warn('[HistoryRail] history state not saved:', errText(err));
  }
}

class HistoryRail {
  /**
   * @param {{
   *   panelEl: HTMLElement,
   *   sidebarEl: HTMLElement,
   *   historyEl: HTMLElement,
   *   toggleBtn: HTMLButtonElement,
   *   getStorage?: () => (Storage|null),
   * }} opts
   */
  constructor({ panelEl, sidebarEl, historyEl, toggleBtn, getStorage }) {
    this._panelEl = panelEl;
    this._sidebarEl = sidebarEl;
    this._historyEl = historyEl;
    this._toggleBtn = toggleBtn;
    this._getStorage = typeof getStorage === 'function' ? getStorage : () => window.localStorage;
    this._open = false;

    if (!historyEl.id) historyEl.id = 'agent-panel-history';
    toggleBtn.setAttribute('aria-controls', historyEl.id);

    this._railBtn = document.createElement('button');
    this._railBtn.type = 'button';
    this._railBtn.className = 'agent-panel-history-rail';
    this._railBtn.setAttribute('aria-controls', historyEl.id);
    this._railBtn.setAttribute('aria-expanded', 'false');
    this._railBtn.innerHTML = `${iconHTML('history')}<span class="agent-panel-history-count" aria-hidden="true">0</span>`;
    sidebarEl.insertBefore(this._railBtn, sidebarEl.firstChild);
    this.setCount(0);

    this._railBtn.addEventListener('click', () => this.setOpen(true));
    toggleBtn.addEventListener('click', () => this.toggle());

    this._apply(readStoredOpen(this._getStorage));
  }

  isOpen() { return this._open; }

  /** @param {boolean} open @param {{persist?: boolean}} [opts] */
  setOpen(open, opts = {}) {
    const next = !!open;
    this._apply(next);
    if (opts.persist !== false) writeStoredOpen(this._getStorage, next);
  }

  toggle() { this.setOpen(!this._open); }

  setCount(n) {
    const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    const countEl = /** @type {HTMLElement} */ (this._railBtn.querySelector('.agent-panel-history-count'));
    countEl.textContent = count > 99 ? '99+' : String(count);
    countEl.hidden = count === 0;
    const label = count === 1 ? 'Show history (1 run)' : `Show history (${count} runs)`;
    this._railBtn.setAttribute('aria-label', label);
    this._railBtn.title = label;
  }

  _apply(open) {
    this._open = open;
    this._panelEl.classList.toggle('is-history-open', open);
    this._historyEl.hidden = !open;
    this._railBtn.hidden = open;
    this._railBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    this._toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    this._toggleBtn.classList.toggle('is-on', open);
    const label = open ? 'Hide history' : 'Show history';
    this._toggleBtn.setAttribute('aria-label', label);
    this._toggleBtn.title = `${label} (Ctrl/Cmd+Shift+H)`;
  }
}

module.exports = HistoryRail;
module.exports.STORAGE_KEY = STORAGE_KEY;

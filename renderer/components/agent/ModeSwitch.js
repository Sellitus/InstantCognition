// ModeSwitch — Auto / Chat / Agent segmented control in the composer. A
// radiogroup with roving tabindex; the owner persists the choice
// (settings.chat.mode) and pushes it back in through set().

const MODES = [
  { id: 'auto', label: 'Auto', title: 'Auto: questions get a fast answer; multi-step requests run as agent tasks' },
  { id: 'chat', label: 'Chat', title: 'Chat: every message gets a fast single answer' },
  { id: 'agent', label: 'Agent', title: 'Agent: every message runs as a browser task' },
];

class ModeSwitch {
  /** @param {{ onSelect: (mode: string) => void }} opts */
  constructor({ onSelect }) {
    this._onSelect = onSelect;
    this._mode = 'auto';
    this.el = document.createElement('div');
    this.el.className = 'agent-panel-modeswitch';
    this.el.setAttribute('role', 'radiogroup');
    this.el.setAttribute('aria-label', 'Answer mode');
    for (const m of MODES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'agent-panel-modeswitch-btn';
      btn.dataset.mode = m.id;
      btn.setAttribute('role', 'radio');
      btn.title = m.title;
      btn.textContent = m.label;
      this.el.appendChild(btn);
    }
    this.el.addEventListener('click', (e) => {
      const btn = /** @type {HTMLElement} */ (e.target).closest('.agent-panel-modeswitch-btn');
      if (btn) this._choose(/** @type {HTMLElement} */ (btn).dataset.mode);
    });
    this.el.addEventListener('keydown', (e) => this._onKey(e));
    this.set('auto');
  }

  get mode() { return this._mode; }

  /** Reflect a mode without notifying the owner. Unknown values show Auto. */
  set(mode) {
    this._mode = MODES.some((m) => m.id === mode) ? mode : 'auto';
    this.el.querySelectorAll('.agent-panel-modeswitch-btn').forEach((raw) => {
      const b = /** @type {HTMLElement} */ (raw);
      const on = b.dataset.mode === this._mode;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle('is-active', on);
    });
  }

  _choose(mode) {
    if (mode === this._mode) return;
    this.set(mode);
    this._onSelect(this._mode);
  }

  _onKey(e) {
    const delta = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1
      : ((e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0);
    if (!delta) return;
    e.preventDefault();
    const idx = MODES.findIndex((m) => m.id === this._mode);
    const next = MODES[(idx + delta + MODES.length) % MODES.length].id;
    this._choose(next);
    const btn = /** @type {HTMLElement|null} */ (this.el.querySelector(`[data-mode="${next}"]`));
    if (btn) btn.focus();
  }
}

module.exports = ModeSwitch;

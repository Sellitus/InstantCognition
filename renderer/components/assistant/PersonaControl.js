// PersonaControl — the Assistant menu's persona picker: lists enabled personas,
// locks/unlocks one for the session, reflects the router's pick in the label,
// and handles the Cmd+Shift+P / Cmd+0..9 quick-lock keys. Talks persona:*.
// State lives on the panel (host) so its long-standing field names stay valid.

const { ipcRenderer } = require('electron');
const { errMsg } = require('../../../shared/errMsg');

class PersonaControl {
  /** @param {import('../AgentPanel')} host */
  constructor(host) {
    this.host = host;
  }

  /** @param {HTMLElement} content */
  mount(content) {
    const h = this.host;
    h._personaSelect = /** @type {HTMLSelectElement} */ (content.querySelector('.agent-panel-persona'));
    h._personaList = [];
    h._personaLock = null;
    if (h._personaSelect) {
      h._personaSelect.addEventListener('change', () => this.onChange(h._personaSelect.value));
      this.load();
    }
  }

  async load() {
    const h = this.host;
    if (!h._personaSelect) return;
    try {
      const r = await ipcRenderer.invoke('persona:list');
      const enabled = (r && Array.isArray(r.enabled)) ? r.enabled : [];
      h._personaList = enabled;
      h._personaLock = (r && typeof r.lock === 'string') ? r.lock : null;
      // Labels come from imported persona files: text nodes only, never markup.
      const opts = [{ name: '', label: 'Auto' }].concat(enabled).map((p) => {
        const opt = document.createElement('option');
        opt.value = String(p.name);
        opt.textContent = String(p.label || p.name);
        return opt;
      });
      h._personaSelect.replaceChildren(...opts);
      h._personaSelect.value = h._personaLock || '';
      this.renderPill();
    } catch (err) {
      // Engine boot race: agent:task-started refreshes the list on the next run.
      console.warn('[AgentPanel] persona:list failed; persona picker shows Auto only:', errMsg(err));
    }
  }

  onChange(value) {
    const h = this.host;
    const name = value || null;
    h._personaLock = name;
    if (name) ipcRenderer.send('persona:lock', name);
    else ipcRenderer.send('persona:reset-lock');
    this.renderPill();
  }

  renderPill(resolvedPayload) {
    const h = this.host;
    if (!h._personaSelect) return;
    // Persona wrap is adopted into the portalled menu (document.body),
    // not nested in the panel overlay.
    const wrap = /** @type {HTMLElement | null} */ (document.querySelector('.agent-panel-persona-wrap'));
    const labelEl = wrap && /** @type {HTMLElement} */ (wrap.querySelector('.agent-panel-persona-label'));
    if (!labelEl) return;
    if (h._personaLock) { labelEl.textContent = 'Persona (locked)'; wrap.dataset.personaState = 'locked'; return; }
    if (resolvedPayload && resolvedPayload.persona) {
      labelEl.textContent = `Persona (${resolvedPayload.routerSource || 'auto'})`;
      wrap.dataset.personaState = resolvedPayload.routerSource || 'auto';
      // Reflect resolved persona in the select so the user sees what was picked,
      // without flipping it into a lock — clearing it back to Auto on the next change.
      const opt = Array.from(h._personaSelect.options).find((o) => o.value === resolvedPayload.persona);
      if (opt) h._personaSelect.value = ''; // keep showing "Auto" since not locked
      return;
    }
    labelEl.textContent = 'Persona';
    wrap.dataset.personaState = 'auto';
  }

  // Panel-level persona keys; runs for every keydown while the panel is open.
  /** @param {KeyboardEvent} e */
  onPanelKey(e) {
    const h = this.host;
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      if (h._personaSelect) { h._personaSelect.focus(); try { h._personaSelect.click(); } catch (err) { console.error('personaSelect click failed', (err instanceof Error && err.message) || err); } }
    }
    // Persona quick-lock: Cmd/Ctrl+1..9 picks the Nth enabled persona; Cmd+0
    // resets to auto. VSCode-style; only fires when no shift/alt are held to
    // avoid colliding with browser shortcuts.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && /^[0-9]$/.test(e.key)) {
      const n = parseInt(e.key, 10);
      if (n === 0) {
        e.preventDefault();
        if (h._personaSelect) h._personaSelect.value = '';
        this.onChange('');
      } else if (Array.isArray(h._personaList) && h._personaList[n - 1]) {
        e.preventDefault();
        const target = h._personaList[n - 1].name;
        if (h._personaSelect) h._personaSelect.value = target;
        this.onChange(target);
      }
    }
  }
}

module.exports = PersonaControl;

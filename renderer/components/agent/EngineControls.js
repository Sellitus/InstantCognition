// EngineControls — the Assistant panel's inference-engine surface: the composer
// model chip, the empty-state hero line, and the menu's Start/Stop button with
// its Backend/Model selects. Talks to main over the llm:* channels.
// State lives on the panel (host) so its long-standing field names stay valid.

const { ipcRenderer } = require('electron');
const { engineChipState } = require('./statusChips');
const { escapeHtml } = require('./format');
const { iconHTML } = require('../Icon');
const { errMsg } = require('../../../shared/errMsg');

class EngineControls {
  /** @param {import('../AgentPanel')} host */
  constructor(host) {
    this.host = host;
  }

  /** @param {HTMLElement} content */
  mount(content) {
    const h = this.host;
    h._heroEngineEl = /** @type {HTMLElement} */ (content.querySelector('.agent-panel-hero-engine'));
    h.engineChip = /** @type {HTMLButtonElement} */ (content.querySelector('.agent-panel-engine-chip'));
    h.engineChip.addEventListener('click', () => h._openSettingsTab('llm'));
    h._heroEngineEl.addEventListener('click', (e) => {
      if (/** @type {HTMLElement} */ (e.target).closest('.agent-panel-hero-setup')) h._openSettingsTab('llm');
    });
    h.engineBtn = /** @type {HTMLButtonElement} */ (content.querySelector('.agent-panel-engine'));
    h.enginePopover = /** @type {HTMLElement} */ (content.querySelector('.agent-engine-popover'));
    h.engineBackendSelect = /** @type {HTMLSelectElement} */ (content.querySelector('.agent-engine-backend'));
    h.engineModelSelect = /** @type {HTMLSelectElement} */ (content.querySelector('.agent-engine-model'));
    h.engineStartStopBtn = /** @type {HTMLButtonElement} */ (content.querySelector('.agent-engine-startstop'));
    h._engineStatus = { status: 'unknown', backend: null, isRemote: false };
    h._engineBackends = null;
    this.renderButton();
    this.renderChip();
    h.engineBtn.addEventListener('click', () => this.toggle());
    h.engineStartStopBtn.addEventListener('click', () => this.toggle());
    h.engineBackendSelect.addEventListener('change', () => this.selectBackend());
  }

  // Initial fetch is best-effort; if main isn't ready yet the status-changed
  // event will fill it in.
  wireIpc() {
    const h = this.host;
    ipcRenderer.invoke('llm:get-status')
      .then((s) => { if (s) { h._engineStatus = s; this.renderButton(); this.renderChip(); } })
      .catch((err) => {
        h._engineStatus = { status: 'error', backend: null, isRemote: false, lastError: `status unavailable (${errMsg(err)})` };
        this.renderButton();
        this.renderChip();
      });
    ipcRenderer.on('llm:status-changed', (_e, payload) => {
      // LLMService emits { previous, current, info: <full status snapshot> }.
      // The info object mirrors getStatus() and is the source of truth.
      if (payload && payload.info && typeof payload.info === 'object') {
        h._engineStatus = payload.info;
      } else if (payload && payload.current) {
        h._engineStatus = { ...h._engineStatus, status: payload.current };
      }
      this.renderButton();
      this.renderChip();
    });
  }

  renderButton() {
    const h = this.host;
    if (!h.engineBtn) return;
    const s = h._engineStatus || { status: 'unknown' };
    const status = s.status || 'unknown';
    h.engineBtn.dataset.engineState = status;

    if (s.isRemote) {
      h.engineBtn.textContent = 'Remote engine';
      h.engineBtn.disabled = true;
      h.engineBtn.title = `Using remote endpoint — manage in Settings → LLM`;
      h.engineBtn.setAttribute('aria-label', 'Remote engine. Using remote endpoint — manage in Settings → LLM');
      this.renderPopoverStartStop();
      return;
    }
    h.engineBtn.disabled = (status === 'starting' || status === 'stopping');
    h.engineBtn.removeAttribute('aria-label');

    const labelByStatus = {
      running: 'Stop engine',
      starting: 'Starting…',
      stopping: 'Stopping…',
      stopped: 'Start engine',
      error: 'Start engine',
      unknown: 'Engine…',
    };
    h.engineBtn.textContent = labelByStatus[status] || 'Engine…';

    const backendLabel = s.backend && s.backend !== 'remote' ? ` · ${s.backend}` : '';
    const tipByStatus = {
      running: `Inference engine running${backendLabel}. Click to stop.`,
      starting: 'Engine starting…',
      stopping: 'Engine stopping…',
      stopped: 'Click to start the selected backend/model.',
      error: s.lastError ? `Engine error: ${s.lastError}. Click to retry start.` : 'Engine error. Click to retry start.',
      unknown: 'Inference engine controls',
    };
    h.engineBtn.title = tipByStatus[status] || 'Inference engine controls';
    this.renderPopoverStartStop();
  }

  // Composer chip + empty-state hero line: what model will answer, or a CTA
  // into Settings → LLM when nothing can.
  renderChip() {
    const h = this.host;
    const st = engineChipState(h._engineStatus);
    if (h.engineChip) {
      h.engineChip.dataset.tone = st.tone;
      h.engineChip.title = st.title;
      h.engineChip.setAttribute('aria-label', `Model: ${st.label}. Open model settings`);
      /** @type {HTMLElement} */ (h.engineChip.querySelector('.agent-panel-engine-chip-label')).textContent = st.label;
    }
    if (h._heroEngineEl) {
      h._heroEngineEl.dataset.tone = st.tone;
      h._heroEngineEl.innerHTML = st.ready || st.tone === 'busy'
        ? `<span class="agent-panel-engine-chip-dot" aria-hidden="true"></span><span>${escapeHtml(st.ready ? `${st.label} is ready` : st.label)}</span>`
        : `<span class="agent-panel-hero-engine-text">${escapeHtml(st.tone === 'error' ? st.title : 'No model is running yet.')}</span>`
          + `<button type="button" class="agent-panel-hero-setup">${iconHTML('cpu')}<span>${st.tone === 'error' ? 'Open model settings' : 'Set up a model'}</span></button>`;
    }
  }

  renderPopoverStartStop() {
    const h = this.host;
    if (!h.engineStartStopBtn) return;
    const s = h._engineStatus || { status: 'unknown' };
    const status = s.status || 'unknown';
    const labelByStatus = { running: 'Stop engine', starting: 'Starting…', stopping: 'Stopping…', stopped: 'Start engine', error: 'Start engine', unknown: 'Start engine' };
    h.engineStartStopBtn.textContent = labelByStatus[status] || 'Start engine';
    h.engineStartStopBtn.disabled = (status === 'starting' || status === 'stopping' || s.isRemote);
    if (s.isRemote) {
      h.engineStartStopBtn.title = 'Using remote endpoint — manage in Settings → LLM';
      h.engineStartStopBtn.setAttribute('aria-label', 'Using remote endpoint — manage in Settings → LLM');
    } else {
      h.engineStartStopBtn.removeAttribute('title');
      h.engineStartStopBtn.removeAttribute('aria-label');
    }
  }

  async toggle() {
    const h = this.host;
    if (h._engineActionPending) return;
    const status = (h._engineStatus && h._engineStatus.status) || 'unknown';
    if (status === 'starting' || status === 'stopping') return;
    h._engineActionPending = true;
    if (h.engineBtn) h.engineBtn.disabled = true;
    try {
      if (status === 'running') {
        await ipcRenderer.invoke('llm:stop');
      } else {
        await ipcRenderer.invoke('llm:start', {});
      }
    } catch (err) {
      const msg = errMsg(err);
      h._answerView.present(`Engine action failed: ${msg}`);
    } finally {
      h._engineActionPending = false;
      this.renderButton();
    }
  }

  // Fetch the backend catalog + model list and populate the inline selects.
  // Called when the panel first opens so the menu's Backend/Model rows are
  // ready by the time the user expands it.
  async refreshPopover() {
    const h = this.host;
    try {
      const [backendRes, modelRes] = await Promise.all([
        ipcRenderer.invoke('llm:backends'),
        ipcRenderer.invoke('llm:list-models-popover').catch(() => null),
      ]);
      h._engineBackends = backendRes;
      this.populateBackendSelect(backendRes);
      this.populateModelSelect(modelRes);
    } catch (err) {
      if (h._answerView) h._answerView.present(`Engine info failed: ${errMsg(err)}`);
    }
  }

  populateBackendSelect(backendRes) {
    const h = this.host;
    if (!h.engineBackendSelect || !backendRes) return;
    const backends = backendRes.backends || [];
    const active = backendRes.active;
    h.engineBackendSelect.innerHTML = '';
    for (const b of backends) {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = b.installed ? b.label : `${b.label} (not detected)`;
      opt.selected = (active === b.id) || (!active && b.id === 'llamaCpp');
      h.engineBackendSelect.appendChild(opt);
    }
  }

  populateModelSelect(modelRes) {
    const h = this.host;
    if (!h.engineModelSelect) return;
    const models = (modelRes && modelRes.ok && Array.isArray(modelRes.models)) ? modelRes.models : [];
    h.engineModelSelect.innerHTML = '<option value="">(default)</option>';
    for (const m of models) {
      const opt = document.createElement('option');
      const name = typeof m === 'string' ? m : (m && (m.name || m.path || m.id)) || '';
      if (!name) continue;
      opt.value = name;
      opt.textContent = name.split('/').pop();
      h.engineModelSelect.appendChild(opt);
    }
  }

  async selectBackend() {
    const h = this.host;
    const id = h.engineBackendSelect && h.engineBackendSelect.value;
    if (!id) return;
    try { await ipcRenderer.invoke('llm:select-backend', id); }
    catch (err) { if (h._answerView) h._answerView.present(`Backend switch failed: ${errMsg(err)}`); }
  }
}

module.exports = EngineControls;

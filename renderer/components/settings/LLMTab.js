// LLMTab — the Models page: local engines and remote OpenAI-compatible APIs.
//
// Mounted by customModules.llmTab into the bare "models" card, so the cards
// built here flow straight into the page grid:
//   Source · Engine · Model · Server · Performance   (local)
//   Source · Remote API                              (remote)
//   Agent vision · Server logs                       (collapsible, both modes)
// Card DOM lives in ./llm/*; this class owns state, IPC and visibility.
// Every persisted change goes through _setLLM(key, value), which mirrors the
// value into this.config and hands the granular path to the save callback.

const { ipcRenderer } = require('electron');
const { isMlxBackend } = require('../../../shared/llmDefaults');
const { errMsg } = require('../../../shared/errMsg');
const toast = require('../Toast');
const { confirm } = require('../ConfirmDialog');
const { setLine } = require('./llm/cardKit');
const { buildSourceCard } = require('./llm/sourceCard');
const { buildEngineCard, renderEngines, renderEnginesError, ENGINE_OPTIONS } = require('./llm/engineCard');
const { buildModelCard, renderModelOptions } = require('./llm/modelCard');
const { buildServerCard } = require('./llm/serverCard');
const { buildPerformanceCard } = require('./llm/performanceCard');
const { buildRemoteCard, renderActivateCopy, checkEndpoint, populateRemoteModels } = require('./llm/remoteCard');
const { buildVisionCard } = require('./llm/visionCard');
const { buildLogsCard } = require('./llm/logsCard');

const VALID_BACKENDS = ENGINE_OPTIONS.map((o) => o.value);
const SCAN_DIR_TITLES = { combined: 'Choose combined MLX + GGUF folder', mlx: 'Choose MLX folder', gguf: 'Choose GGUF folder' };

class LLMTab {
  constructor(config, saveCallback) {
    this.config = config;
    this.save = saveCallback;
    this.container = null;
    this.engines = null;
    this.models = [];
    this.status = null;
    this._mode = 'local';
    this._selectedBackend = 'llamaCpp';
    this._engineActionPending = false;
    this._refs = {};
    this._realtime = null;
  }

  render(container) {
    this.container = container;
    this._readState();
    this._build();
    this._applyVisibility();
    this._wireRealtime();
    this.refresh();
  }

  // -- State -------------------------------------------------------------

  _readState() {
    const llm = this._llm();
    this._mode = llm.mode || (llm.activeBackend === 'remote' ? 'remote' : 'local');
    // Pre-v9 configs persisted 'mlx' as the backend; it maps to mlxOpenAi.
    const persisted = llm.activeBackend === 'mlx' ? 'mlxOpenAi' : llm.activeBackend;
    this._selectedBackend = VALID_BACKENDS.includes(persisted) ? persisted : 'llamaCpp';
  }

  _llm() {
    return (this.config.settings && this.config.settings.llm) || {};
  }

  _setLLM(key, value) {
    if (!this.config.settings) this.config.settings = {};
    if (!this.config.settings.llm) this.config.settings.llm = {};
    const parts = key.split('.');
    let cur = this.config.settings.llm;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]]) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
    this.save(key, value);
  }

  // -- Build + visibility ------------------------------------------------

  _build() {
    this.container.textContent = '';
    this.container.classList.add('sv-llm-tab');
    const cards = {
      source: buildSourceCard(this),
      engine: buildEngineCard(this),
      model: buildModelCard(this),
      server: buildServerCard(this),
      performance: buildPerformanceCard(this),
      remote: buildRemoteCard(this),
      vision: buildVisionCard(this),
      logs: buildLogsCard(this),
    };
    this._refs.cards = cards;
    this.container.append(...Object.values(cards));
  }

  _applyVisibility() {
    const isLocal = this._mode === 'local';
    const { cards, perfPanels, mlxShared } = this._refs;
    for (const key of ['engine', 'model', 'server', 'performance']) cards[key].hidden = !isLocal;
    cards.remote.hidden = isLocal;
    for (const [backend, { main, adv }] of Object.entries(perfPanels)) {
      main.hidden = backend !== this._selectedBackend;
      adv.hidden = backend !== this._selectedBackend;
    }
    mlxShared.hidden = !isMlxBackend(this._selectedBackend);
    this._refs.hfRepoRow.hidden = this._selectedBackend !== 'vllm';
    this._updateImportButtonLabel();
  }

  _updateImportButtonLabel() {
    const btn = this._refs.importBtn;
    const b = this._selectedBackend;
    const label = isMlxBackend(b) ? 'Import MLX model folder' : b === 'vllm' ? 'Import model folder' : 'Import .gguf';
    btn.querySelector('span').textContent = label;
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  _onModeChange(value) {
    this._mode = value === 'remote' ? 'remote' : 'local';
    this._setLLM('mode', this._mode);
    this._applyVisibility();
  }

  _onBackendChange(value) {
    this._selectedBackend = VALID_BACKENDS.includes(value) ? value : 'llamaCpp';
    this._setLLM('activeBackend', this._selectedBackend);
    this._applyVisibility();
    this._renderModels();
  }

  // -- Data fetch + render -----------------------------------------------

  refresh() {
    this._fetchEngines();
    this._fetchModels();
    this._fetchStatus();
    this._fetchLogs();
  }

  async _fetchEngines(force = false) {
    try {
      this.engines = force
        ? await ipcRenderer.invoke('llm:detect-engines', { force: true })
        : await ipcRenderer.invoke('llm:detect-engines');
      this._renderEngines();
    } catch (err) {
      renderEnginesError(this._refs, `Couldn't detect engines: ${errMsg(err)}`);
    }
  }

  _renderEngines() {
    if (this.engines) renderEngines(this._refs, this.engines);
  }

  async _onRedetect() {
    const btn = this._refs.redetectBtn;
    btn.disabled = true;
    try {
      await this._fetchEngines(true);
    } finally {
      btn.disabled = false;
    }
  }

  async _fetchModels() {
    try {
      this.models = await ipcRenderer.invoke('llm:list-models') || [];
      this._renderModels();
    } catch (err) {
      setLine(this._refs.scanResultEl, 'error', `Couldn't load the model library: ${errMsg(err)}`);
    }
  }

  _renderModels() {
    const { autoSelected } = renderModelOptions(this._refs.modelSelect, this.models, {
      backend: this._selectedBackend,
      lastModel: this._llm().lastModel,
    });
    if (autoSelected) this._setLLM('lastModel', autoSelected);
  }

  async _fetchStatus() {
    try {
      this.status = await ipcRenderer.invoke('llm:get-status');
      this._renderStatus();
    } catch (err) {
      const { statusPill, endpointEl } = this._refs;
      statusPill.textContent = 'unknown';
      statusPill.className = 'sv-llm-status-pill error';
      endpointEl.textContent = `Couldn't read server status: ${errMsg(err)}`;
    }
  }

  _renderStatus() {
    if (!this.status) return;
    const { statusPill, endpointEl, startBtn, stopBtn } = this._refs;
    statusPill.textContent = this.status.status;
    statusPill.className = 'sv-llm-status-pill ' + this.status.status;
    endpointEl.textContent = this.status.endpoint || '';
    if (!this._engineActionPending) {
      const transitional = this.status.status === 'starting' || this.status.status === 'stopping';
      startBtn.disabled = transitional || this.status.status === 'running';
      stopBtn.disabled = transitional || this.status.status === 'stopped';
    }
    renderActivateCopy(this);
  }

  _localServing() {
    const s = this.status || {};
    return !s.isRemote && (s.status === 'running' || s.status === 'starting');
  }

  async _fetchLogs() {
    const { logsEl, logsStatus } = this._refs;
    try {
      const logs = await ipcRenderer.invoke('llm:get-logs') || [];
      logsEl.textContent = logs.map((l) => `[${l.level}] ${l.message}`).join('\n');
      logsEl.scrollTop = logsEl.scrollHeight;
      logsStatus.hidden = true;
    } catch (err) {
      logsStatus.hidden = false;
      setLine(logsStatus, 'error', `Couldn't read server logs: ${errMsg(err)}`);
    }
  }

  // -- Server start / stop -----------------------------------------------

  async _runServerAction(fn, failTitle) {
    if (this._engineActionPending) return;
    this._engineActionPending = true;
    this._refs.startBtn.disabled = true;
    this._refs.stopBtn.disabled = true;
    try {
      await fn();
    } catch (err) {
      toast.error(`${failTitle}: ${errMsg(err)}`, { title: 'Local model' });
    } finally {
      this._engineActionPending = false;
      this._renderStatus();
    }
  }

  _onStartServer() {
    return this._runServerAction(async () => {
      // In remote mode "Start" means activating the remote endpoint.
      if (this._mode === 'remote') return this._activateRemote();
      const modelPath = this._refs.modelSelect.value || null;
      return ipcRenderer.invoke('llm:start', { backend: this._selectedBackend, modelPath });
    }, 'Failed to start');
  }

  _onStopServer() {
    return this._runServerAction(
      () => ipcRenderer.invoke(this._mode === 'remote' ? 'llm:clear-remote' : 'llm:stop'),
      'Failed to stop',
    );
  }

  // -- Model library -----------------------------------------------------

  async _onImportModel() {
    try {
      const result = await ipcRenderer.invoke('llm:import-model', { backend: this._selectedBackend });
      if (result && result.path) this._setLLM('lastModel', result.path);
      if (result) await this._fetchModels();
    } catch (err) {
      toast.error('Import failed: ' + errMsg(err), { title: 'Model import failed' });
    }
  }

  async _onOpenModelsDir() {
    try {
      await ipcRenderer.invoke('llm:open-models-dir');
    } catch (err) {
      setLine(this._refs.scanResultEl, 'error', `Couldn't open the models folder: ${errMsg(err)}`);
    }
  }

  // Only models under the managed models directory are removed from disk;
  // anything else is just unregistered, which is why the copy is about the library.
  async _onDeleteModel() {
    const modelPath = this._refs.modelSelect.value;
    if (!modelPath) {
      toast.warn('Pick a model to delete first.');
      return;
    }
    const ok = await confirm({
      title: 'Delete this model?',
      message: 'Removes ' + modelPath + ' from your library, and deletes its files if they live in the managed models folder. This cannot be undone.',
      confirmLabel: 'Delete',
      confirmKind: 'danger',
    });
    if (!ok) return;
    const btn = this._refs.deleteBtn;
    btn.disabled = true;
    try {
      await ipcRenderer.invoke('llm:delete-model', modelPath);
      if (this._llm().lastModel === modelPath) this._setLLM('lastModel', null);
      await this._fetchModels();
      toast.success('Model deleted');
    } catch (err) {
      toast.error('Delete failed: ' + errMsg(err), { title: 'Model delete failed' });
    } finally {
      btn.disabled = false;
    }
  }

  async _onRescan() {
    const btn = this._refs.rescanBtn;
    btn.disabled = true;
    try {
      await this._runScan();
    } finally {
      btn.disabled = false;
    }
  }

  async _runScan() {
    const out = this._refs.scanResultEl;
    setLine(out, 'busy', 'Scanning…');
    try {
      const r = await ipcRenderer.invoke('llm:scan-models');
      setLine(out, 'ok', `Found ${r.mlx} MLX + ${r.gguf} GGUF (${r.added} new, ${r.skipped} already registered)`);
      await this._fetchModels();
      return r;
    } catch (err) {
      setLine(out, 'error', `Scan failed: ${errMsg(err)}`);
      return null;
    }
  }

  async _onBrowseScanDir(slot, pathEl) {
    try {
      const chosen = await ipcRenderer.invoke('llm:browse-scan-dir', { title: SCAN_DIR_TITLES[slot] });
      if (!chosen) return;
      await ipcRenderer.invoke('llm:set-scan-dirs', { [slot]: chosen });
      pathEl.textContent = chosen;
      this._refs[`scan_${slot}_clear`].disabled = false;
      await this._runScan();
    } catch (err) {
      toast.error('Folder update failed: ' + errMsg(err));
    }
  }

  async _onClearScanDir(slot, pathEl) {
    try {
      await ipcRenderer.invoke('llm:set-scan-dirs', { [slot]: null });
      pathEl.textContent = 'Not set';
      this._refs[`scan_${slot}_clear`].disabled = true;
    } catch (err) {
      toast.error('Folder update failed: ' + errMsg(err));
    }
  }

  // -- Remote ------------------------------------------------------------

  _onRemoteEndpointChange(raw) {
    const endpoint = checkEndpoint(this._refs, raw);
    if (endpoint == null) return;
    this._setLLM('remote.endpoint', endpoint);
    this._refs.remoteRefreshBtn.disabled = !endpoint;
  }

  _onRemoteKeyChange(raw) {
    const apiKey = String(raw || '').trim();
    this._refs.remoteKeyInput.value = apiKey;
    this._setLLM('remote.apiKey', apiKey);
  }

  async _verifyRemote(isRefresh) {
    const { remoteUrlInput, remoteKeyInput, verifyStatusEl, remoteModelSelect, verifyBtn, remoteRefreshBtn } = this._refs;
    const endpoint = checkEndpoint(this._refs, remoteUrlInput.value);
    if (endpoint == null) return;
    if (!endpoint) {
      setLine(verifyStatusEl, 'error', 'Endpoint URL is required.');
      return;
    }
    setLine(verifyStatusEl, 'busy', isRefresh ? 'Refreshing…' : 'Verifying…');
    verifyBtn.disabled = true;
    remoteRefreshBtn.disabled = true;
    try {
      const r = await ipcRenderer.invoke('llm:verify-remote', { endpoint, apiKey: remoteKeyInput.value.trim() });
      if (!r || !r.ok) {
        setLine(verifyStatusEl, 'error', (r && r.error) || 'Verify failed.');
        return;
      }
      const models = Array.isArray(r.models) ? r.models : [];
      this._populateRemoteModelDropdown(remoteModelSelect, models);
      remoteModelSelect.disabled = models.length === 0;
      setLine(verifyStatusEl, 'ok', models.length
        ? `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available.`
        : 'Connected, but the endpoint returned 0 models.');
    } catch (err) {
      setLine(verifyStatusEl, 'error', 'Verify failed: ' + errMsg(err));
    } finally {
      verifyBtn.disabled = false;
      remoteRefreshBtn.disabled = !endpoint;
    }
  }

  _populateRemoteModelDropdown(sel, models) {
    const saved = (this._llm().remote && this._llm().remote.model) || '';
    populateRemoteModels(sel, models, sel.value || saved);
  }

  async _activateRemote() {
    const { remoteUrlInput, remoteKeyInput, remoteModelSelect } = this._refs;
    const endpoint = checkEndpoint(this._refs, remoteUrlInput.value);
    if (endpoint == null) return;
    if (!endpoint) {
      toast.warn('Endpoint URL is required.', { title: 'Remote API' });
      return;
    }
    const apiKey = remoteKeyInput.value.trim();
    const model = remoteModelSelect.value;
    const remote = this._llm().remote || {};
    const toolMode = remote.toolMode || 'native';
    const localServing = this._localServing();
    try {
      await ipcRenderer.invoke('llm:set-remote', { endpoint, apiKey, model, visionCapable: !!remote.visionCapable });
      const detail = model ? `: ${model} (${toolMode === 'native' ? 'native tools' : 'JSON tools'})` : '';
      toast.success(localServing
        ? `Remote API set${detail}. The app switches to the remote endpoint's model, which is not locally hosted; the loaded local model keeps serving until you stop it.`
        : `Remote API active${detail || '.'}`, { title: 'Remote API' });
    } catch (err) {
      toast.error('Activate failed: ' + errMsg(err), { title: 'Remote API' });
    }
  }

  async _clearRemote() {
    try {
      await ipcRenderer.invoke('llm:clear-remote');
      toast.info('Remote API cleared.', { title: 'Remote API' });
    } catch (err) {
      toast.error('Clear failed: ' + errMsg(err), { title: 'Remote API' });
    }
  }

  // -- Real-time IPC listeners -------------------------------------------

  _wireRealtime() {
    /** @type {Array<[string, (...args: any[]) => void]>} */
    const listeners = [
      ['llm:status-changed', (_e, payload) => { if (payload && payload.info) { this.status = payload.info; this._renderStatus(); } }],
      ['llm:log', () => this._fetchLogs()],
      ['llm:models-changed', () => this._fetchModels()],
      ['llm:fallback', (_e, p) => { if (p) toast.warn(`MLX fallback: ${p.from} → ${p.to} (${p.reason || 'load failed'})`); }],
    ];
    this._realtime = listeners;
    for (const [channel, fn] of this._realtime) ipcRenderer.on(channel, fn);
  }

  // Settings re-mounts this tab on every open; remove the global ipcRenderer
  // listeners so stale instances don't accumulate and update detached DOM.
  destroy() {
    if (this._realtime) {
      for (const [channel, fn] of this._realtime) ipcRenderer.removeListener(channel, fn);
    }
    this._realtime = null;
  }
}

module.exports = LLMTab;

// Persona library editor and curated persona packs.

const { ipcRenderer } = require('electron');
const { el } = require('../controls');
const { errMsg } = require('../../../../shared/errMsg');
const { prompt } = require('../../PromptDialog');
const { actionButton, voiceField, errorRow } = require('./kit');

// -- Personas editor -------------------------------------------------------
//
// Surfaces the agent's persona library: router toggles, per-built-in
// notes/enabled overrides, custom personas, and a "test routing" box that
// previews which persona the router would pick for typed text.

function personas({ host, configBridge }) {
  const cfg = (configBridge.snapshot() || {});
  const stored = (cfg.settings && cfg.settings.agentPersonas) || {};

  const intro = el('p', { class: 'sv-section-intro' }, [
    'Personas tailor the agent for shopping, research, code, news, etc. The router auto-picks one per task; lock a choice from the agent panel header (Cmd+Shift+P).',
  ]);
  host.appendChild(intro);

  // Router on/off + LLM fallback toggles
  const routerRow = el('div', { class: 'sv-row sv-row--toggles' });
  const routerEnabled = !!(stored.routerEnabled !== false);
  const routerCb = el('input', { type: 'checkbox' });
  routerCb.checked = routerEnabled;
  routerCb.addEventListener('change', () => configBridge.set('settings.agentPersonas.routerEnabled', !!routerCb.checked));
  const routerLabel = el('label', { class: 'sv-toggle-label' });
  routerLabel.append(routerCb, document.createTextNode(' Auto-route to a persona per task'));

  const llmFb = !!(stored.routerLLMFallback !== false);
  const llmCb = el('input', { type: 'checkbox' });
  llmCb.checked = llmFb;
  llmCb.addEventListener('change', () => configBridge.set('settings.agentPersonas.routerLLMFallback', !!llmCb.checked));
  const llmLabel = el('label', { class: 'sv-toggle-label' });
  llmLabel.append(llmCb, document.createTextNode(' Use LLM as fallback when keyword router is ambiguous'));

  routerRow.append(routerLabel, llmLabel);
  host.appendChild(routerRow);

  // Built-in personas list (fetched from main, not config)
  const listEl = el('div', { class: 'sv-personas-list' });
  host.appendChild(el('h4', { class: 'sv-subhead' }, ['Built-in personas']));
  host.appendChild(listEl);

  function rowFor(p, isBuiltin) {
    const row = el('div', { class: 'sv-persona-row' });
    const head = el('div', { class: 'sv-persona-row-head' });
    const enabledCb = el('input', { type: 'checkbox', 'aria-label': `Enable persona ${p.label || p.name}` });
    enabledCb.checked = p.enabled !== false;
    enabledCb.addEventListener('change', () => {
      const fresh = (configBridge.snapshot() || {}).settings || {};
      const list = (fresh.agentPersonas && Array.isArray(fresh.agentPersonas.enabledPersonas)) ? fresh.agentPersonas.enabledPersonas.slice() : [];
      const idx = list.indexOf(p.name);
      if (enabledCb.checked && idx < 0) list.push(p.name);
      if (!enabledCb.checked && idx >= 0) list.splice(idx, 1);
      configBridge.set('settings.agentPersonas.enabledPersonas', list);
    });
    const title = el('span', { class: 'sv-persona-title' }, [p.label || p.name]);
    const sub = el('span', { class: 'sv-persona-sub' }, [p.description || '']);
    head.append(enabledCb, title, sub);
    row.appendChild(head);

    // Notes textarea (overrides for built-ins, full edit for custom)
    const notesArea = el('textarea', { class: 'sv-text sv-persona-notes', rows: '3', placeholder: 'Notes the agent should know in this persona (e.g. "Prefer Amazon and B&H").', 'aria-label': `Notes for persona ${p.label || p.name}` });
    notesArea.value = p.notes || '';
    // Starter-tabs textarea — one URL per line. Auto-opens in the agent
    // workspace when this persona is picked for a fresh conversation.
    const starterArea = el('textarea', { class: 'sv-text sv-persona-starters', rows: '2', placeholder: 'Optional starter URLs, one per line (e.g. https://www.reddit.com/r/LocalLLaMA/).', 'aria-label': `Starter URLs for persona ${p.label || p.name}` });
    starterArea.value = (Array.isArray(p.starterTabs) ? p.starterTabs : []).map((t) => typeof t === 'string' ? t : (t && t.url) || '').filter(Boolean).join('\n');
    function persistField(field, value) {
      if (isBuiltin) {
        const fresh = (configBridge.snapshot() || {}).settings || {};
        const overrides = (fresh.agentPersonas && fresh.agentPersonas.builtinOverrides) || {};
        const next = { ...overrides, [p.name]: { ...(overrides[p.name] || {}), [field]: value } };
        configBridge.set('settings.agentPersonas.builtinOverrides', next);
      } else {
        const fresh = (configBridge.snapshot() || {}).settings || {};
        const customs = (fresh.agentPersonas && Array.isArray(fresh.agentPersonas.customPersonas)) ? fresh.agentPersonas.customPersonas.slice() : [];
        const idx = customs.findIndex((c) => c && c.name === p.name);
        if (idx >= 0) { customs[idx] = { ...customs[idx], [field]: value }; configBridge.set('settings.agentPersonas.customPersonas', customs); }
      }
    }
    notesArea.addEventListener('change', () => persistField('notes', notesArea.value));
    starterArea.addEventListener('change', () => {
      const urls = starterArea.value.split('\n').map((s) => s.trim()).filter(Boolean).map((u) => ({ url: u }));
      persistField('starterTabs', urls);
    });
    row.append(voiceField(notesArea, `Dictate notes for ${p.label || p.name}`, configBridge), starterArea);
    return row;
  }

  async function refreshList() {
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    try {
      const r = await ipcRenderer.invoke('persona:list');
      const all = (r && Array.isArray(r.all)) ? r.all : [];
      for (const p of all) listEl.appendChild(rowFor(p, !!p.builtin));
    } catch (err) {
      listEl.appendChild(errorRow(`Could not load personas: ${errMsg(err)}`));
    }
  }
  refreshList();

  // Custom personas — add/remove + import/export
  host.appendChild(el('h4', { class: 'sv-subhead' }, ['Custom personas']));
  const addRow = el('div', { class: 'sv-actions-row' });
  const addBtn = actionButton('Add custom persona', 'sv-button sv-button--primary', 'plus');
  const exportBtn = actionButton('Export…', 'sv-button', 'download');
  const importBtn = actionButton('Import…', 'sv-button', 'external');
  const ioStatus = el('span', { class: 'sv-persona-io-status' });
  exportBtn.addEventListener('click', async () => {
    ioStatus.textContent = 'Exporting…';
    try {
      const r = await ipcRenderer.invoke('persona:export');
      if (r && r.ok) ioStatus.textContent = `Exported ${r.count} custom persona${r.count === 1 ? '' : 's'}.`;
      else if (r && r.canceled) ioStatus.textContent = '';
      else ioStatus.textContent = `Export failed: ${(r && r.error) || 'unknown'}`;
    } catch (err) { ioStatus.textContent = `Export failed: ${errMsg(err)}`; }
  });
  importBtn.addEventListener('click', async () => {
    ioStatus.textContent = 'Importing…';
    try {
      const r = await ipcRenderer.invoke('persona:import');
      if (r && r.ok) {
        ioStatus.textContent = `Imported ${r.added} persona${r.added === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} skipped — already present or invalid)` : ''}.`;
        configBridge.refresh();
        refreshList();
      } else if (r && r.canceled) ioStatus.textContent = '';
      else ioStatus.textContent = `Import failed: ${(r && r.error) || 'unknown'}`;
    } catch (err) { ioStatus.textContent = `Import failed: ${errMsg(err)}`; }
  });
  addBtn.addEventListener('click', async () => {
    const name = await prompt({
      title: 'New persona',
      message: 'Internal name (lowercase letters, digits, _ or -). Used for routing keywords.',
      placeholder: 'my-persona',
      validate: (v) => {
        const cleaned = String(v).toLowerCase().replace(/[^a-z0-9_-]/g, '');
        return cleaned ? null : 'Use lowercase letters, digits, _ or - only.';
      },
    });
    if (!name) return;
    const cleaned = name.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const label = await prompt({
      title: 'Display label',
      defaultValue: cleaned,
      confirmLabel: 'Next',
      validate: (v) => (v.trim() ? null : 'Label cannot be empty'),
    });
    if (!label) return;
    const overlay = await prompt({
      title: 'System-prompt overlay',
      message: 'One or two sentences shaping the persona.',
      defaultValue: 'Be helpful.',
      confirmLabel: 'Create persona',
      validate: (v) => (v.trim() ? null : 'Overlay cannot be empty'),
    });
    if (overlay == null) return;
    const fresh = (configBridge.snapshot() || {}).settings || {};
    const customs = (fresh.agentPersonas && Array.isArray(fresh.agentPersonas.customPersonas)) ? fresh.agentPersonas.customPersonas.slice() : [];
    const enabled = (fresh.agentPersonas && Array.isArray(fresh.agentPersonas.enabledPersonas)) ? fresh.agentPersonas.enabledPersonas.slice() : [];
    customs.push({ name: cleaned, label, description: '', systemOverlay: overlay, qualityOverride: null, starterTabs: [], notes: '', followUps: [], builtin: false, enabled: true });
    if (!enabled.includes(cleaned)) enabled.push(cleaned);
    configBridge.set('settings.agentPersonas.customPersonas', customs);
    configBridge.set('settings.agentPersonas.enabledPersonas', enabled);
    refreshList();
  });
  addRow.append(addBtn, exportBtn, importBtn, ioStatus);
  host.appendChild(addRow);

  // Test box
  host.appendChild(el('h4', { class: 'sv-subhead' }, ['Test routing']));
  const testRow = el('div', { class: 'sv-row' });
  const testInput = el('input', { type: 'text', class: 'sv-text', placeholder: 'Type a sample task to see which persona the router picks…', 'aria-label': 'Sample task for persona routing test' });
  const testBtn = actionButton('Test', 'sv-button', 'check');
  const testOut = el('span', { class: 'sv-persona-test-out' });
  testBtn.addEventListener('click', async () => {
    testOut.textContent = '…';
    try {
      const r = await ipcRenderer.invoke('persona:test-route', { description: testInput.value, sync: true });
      testOut.textContent = r && r.ok ? `→ ${r.name} (${r.source})` : 'Test failed.';
    } catch (err) { testOut.textContent = `Test failed: ${errMsg(err)}`; }
  });
  testRow.append(testInput, testBtn, testOut);
  host.appendChild(testRow);

  const cacheRow = el('div', { class: 'sv-row' });
  const cacheBtn = actionButton('Reset routing cache', 'sv-button', 'refresh');
  const cacheOut = el('span', { class: 'sv-persona-test-out' });
  cacheBtn.addEventListener('click', async () => {
    cacheOut.textContent = '…';
    try { const r = await ipcRenderer.invoke('persona:clear-cache'); cacheOut.textContent = r && r.ok ? 'Cache cleared.' : `Failed: ${(r && r.error) || 'unknown'}`; }
    catch (err) { cacheOut.textContent = `Failed: ${errMsg(err)}`; }
  });
  cacheRow.append(cacheBtn, cacheOut);
  host.appendChild(cacheRow);
}

// Curated vertical packs (T3.9). Apply installs the pack persona via the
// existing persona import path (so it shows up + is editable under Personas)
// and opens the pack's starter sites as panes; Run task launches the pack's
// reusable agent task. Skills are intentionally delivered as the persona +
// task — there is no skills UI to surface a .skill.json. Reuses existing sv-*
// classes only (no new CSS).
function packs({ host, configBridge }) {
  const { PACKS } = require('../../../../shared/personaPacks');
  host.appendChild(el('p', { class: 'sv-section-intro' }, [
    'One-click vertical workspaces. Apply installs a tuned agent persona (editable under Personas) and opens the pack’s starter sites as panes. Run task launches the pack’s reusable agent task.',
  ]));

  const status = el('span', { class: 'sv-persona-io-status' });
  const list = el('div', { class: 'sv-personas-list' });
  let installed = new Set();

  function rowFor(pack) {
    const isIn = installed.has(pack.persona && pack.persona.name);
    const headInfo = el('div', {}, [
      el('div', { class: 'sv-persona-row-head' }, [
        el('span', { class: 'sv-persona-title' }, [pack.label]),
        isIn && el('span', { class: 'sv-status-badge' }, ['Installed']),
      ]),
      el('div', { class: 'sv-persona-sub' }, [pack.description]),
      el('div', { class: 'sv-hint' }, [`${pack.panes.length} starter pane${pack.panes.length === 1 ? '' : 's'} · persona: ${pack.persona.label}`]),
    ]);
    const applyBtn = actionButton(isIn ? 'Re-apply' : 'Apply', 'sv-button sv-button--primary', 'plus');
    const runBtn = actionButton('Run task', 'sv-button', 'agent');
    applyBtn.addEventListener('click', async () => {
      status.textContent = `Applying ${pack.label}…`;
      try {
        const r = await ipcRenderer.invoke('pack:apply', { id: pack.id });
        if (r && r.ok) {
          status.textContent = `${pack.label}: persona installed${r.skipped ? ' (already present)' : ''}, panes opening.`;
          configBridge.refresh();
          await refresh();
        } else status.textContent = `Apply failed: ${(r && r.error) || 'unknown'}`;
      } catch (err) { status.textContent = `Apply failed: ${err instanceof Error ? err.message : String(err)}`; }
    });
    runBtn.addEventListener('click', async () => {
      status.textContent = `Starting ${pack.label} task…`;
      try {
        const r = await ipcRenderer.invoke('pack:run-task', { id: pack.id });
        status.textContent = (r && r.ok) ? `${pack.label} task started.` : `Could not start: ${(r && r.error) || 'unknown'}`;
      } catch (err) { status.textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`; }
    });
    return el('div', { class: 'sv-persona-row' }, [headInfo, el('div', { class: 'sv-actions-row' }, [applyBtn, runBtn])]);
  }

  async function refresh() {
    try {
      const r = await ipcRenderer.invoke('persona:list');
      const all = (r && Array.isArray(r.all)) ? r.all : [];
      installed = new Set(all.map((p) => p && p.name).filter(Boolean));
    } catch (err) {
      installed = new Set();
      status.textContent = `Couldn't check which packs are installed: ${errMsg(err)}`;
    }
    list.textContent = '';
    PACKS.forEach((pack) => list.appendChild(rowFor(pack)));
  }

  host.appendChild(list);
  host.appendChild(el('div', { class: 'sv-actions-row' }, [status]));
  refresh();
}

module.exports = { personas, packs };

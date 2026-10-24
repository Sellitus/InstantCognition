// User memory editor: persistent facts injected into agent prompts.

const { ipcRenderer } = require('electron');
const { el } = require('../controls');
const { errMsg } = require('../../../../shared/errMsg');
const { confirm } = require('../../ConfirmDialog');
const { actionButton, voiceField, errorRow } = require('./kit');

// -- User Memory editor ----------------------------------------------------
//
// Persistent facts about the user. Every fact is injected into every agent
// system prompt automatically. ENABLED BY DEFAULT — the master toggle at top
// is the kill switch. The list supports add/edit/delete/archive/pin and
// import/export (JSON, format `instantcognition.usermemory.v1`).

function userMemory({ host }) {
  const intro = el('p', { class: 'sv-section-intro' }, [
    'Persistent facts the agent knows about you. Injected into every agent system prompt — toggle the switch off below to disable entirely. Stored locally in config.json; never sent anywhere except as part of the prompt.',
  ]);
  host.appendChild(intro);

  const enableRow = el('div', { class: 'sv-row sv-row--toggles' });
  const enableCb = el('input', { type: 'checkbox' });
  const enableLabel = el('label', { class: 'sv-toggle-label' });
  enableLabel.append(enableCb, document.createTextNode(' Enable user memory'));
  enableRow.append(enableLabel);
  host.appendChild(enableRow);

  const listEl = el('div', { class: 'sv-usermem-list' });
  host.appendChild(listEl);

  function rowFor(f) {
    const row = el('div', { class: 'sv-usermem-row' + (f.pinned ? ' is-pinned' : '') + (f.archived ? ' is-archived' : '') });
    const pinBtn = el('button', { type: 'button', class: 'sv-usermem-pin', title: f.pinned ? 'Unpin' : 'Pin', 'aria-label': f.pinned ? 'Unpin memory fact' : 'Pin memory fact' }, [f.pinned ? '★' : '☆']);
    pinBtn.addEventListener('click', async () => { await ipcRenderer.invoke('usermemory:pin', { id: f.id, on: !f.pinned }); refreshList(); });
    const textArea = el('textarea', { class: 'sv-text sv-usermem-text', rows: '2', 'aria-label': 'Memory fact text' });
    textArea.value = f.text;
    textArea.addEventListener('change', async () => {
      const nextText = textArea.value.trim();
      if (!nextText) return;
      await ipcRenderer.invoke('usermemory:edit', { id: f.id, patch: { text: nextText } });
    });
    const archiveBtn = el('button', { type: 'button', class: 'sv-usermem-archive', title: f.archived ? 'Unarchive' : 'Archive', 'aria-label': f.archived ? 'Unarchive memory fact' : 'Archive memory fact' }, [f.archived ? '↑' : '↓']);
    archiveBtn.addEventListener('click', async () => { await ipcRenderer.invoke('usermemory:archive', { id: f.id, on: !f.archived }); refreshList(); });
    const delBtn = el('button', { type: 'button', class: 'sv-usermem-delete', title: 'Delete', 'aria-label': 'Delete memory fact' }, ['✕']);
    delBtn.addEventListener('click', async () => {
      const ok = await confirm({
        title: 'Delete this fact?',
        message: 'This can\'t be undone — use Archive if you want to keep it.',
        confirmLabel: 'Delete',
        confirmKind: 'danger',
      });
      if (!ok) return;
      await ipcRenderer.invoke('usermemory:delete', f.id); refreshList();
    });
    row.append(pinBtn, voiceField(textArea, 'Dictate memory fact'), archiveBtn, delBtn);
    return row;
  }

  let allFacts = [];
  let showArchived = false;
  async function refreshList() {
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    try {
      const r = await ipcRenderer.invoke('usermemory:list', { includeArchived: true });
      enableCb.checked = !!(r && r.enabled);
      allFacts = (r && Array.isArray(r.facts)) ? r.facts : [];
    } catch (err) {
      allFacts = [];
      listEl.appendChild(errorRow(`Couldn't load memory facts: ${errMsg(err)}`));
      return;
    }
    const live = allFacts.filter((f) => !f.archived);
    const archived = allFacts.filter((f) => f.archived);
    if (live.length === 0) {
      listEl.appendChild(el('div', { class: 'sv-empty-row' }, ['No facts yet — add one below.']));
    } else {
      // Pinned first, then most-recent.
      live.sort((a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || (b.editedAt || b.createdAt || 0) - (a.editedAt || a.createdAt || 0));
      for (const f of live) listEl.appendChild(rowFor(f));
    }
    if (archived.length) {
      const disclosure = el('details', { class: 'sv-usermem-archived' });
      const summary = el('summary', {}, [`Archived (${archived.length})`]);
      disclosure.appendChild(summary);
      const archList = el('div', { class: 'sv-usermem-archive-list' });
      for (const f of archived) archList.appendChild(rowFor(f));
      disclosure.appendChild(archList);
      if (showArchived) disclosure.open = true;
      disclosure.addEventListener('toggle', () => { showArchived = disclosure.open; });
      listEl.appendChild(disclosure);
    }
  }

  enableCb.addEventListener('change', () => { ipcRenderer.send('usermemory:enable', !!enableCb.checked); });

  // Add row
  const addRow = el('div', { class: 'sv-row sv-usermem-add-row' });
  const addInput = el('input', { type: 'text', class: 'sv-text', placeholder: 'New fact (e.g. "I\'m a Go developer learning React")', 'aria-label': 'New memory fact' });
  const addBtn = actionButton('Add fact', 'sv-button sv-button--primary', 'plus');
  async function submitAdd() {
    const text = addInput.value.trim();
    if (!text) return;
    await ipcRenderer.invoke('usermemory:add', { text });
    addInput.value = '';
    refreshList();
  }
  addBtn.addEventListener('click', submitAdd);
  addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitAdd(); } });
  addRow.append(addInput, addBtn);
  host.appendChild(addRow);

  // Footer — export / import / clear all
  const footer = el('div', { class: 'sv-actions-row' });
  const exportBtn = actionButton('Export…', 'sv-button', 'download');
  const importBtn = actionButton('Import…', 'sv-button', 'external');
  const clearBtn = actionButton('Clear all…', 'sv-button sv-button--danger', 'trash');
  const status = el('span', { class: 'sv-persona-io-status' });
  exportBtn.addEventListener('click', async () => {
    status.textContent = 'Exporting…';
    const r = await ipcRenderer.invoke('usermemory:export');
    status.textContent = r && r.ok ? `Exported ${r.count} fact${r.count === 1 ? '' : 's'}.` : (r && r.canceled ? '' : `Export failed: ${(r && r.error) || 'unknown'}`);
  });
  importBtn.addEventListener('click', async () => {
    status.textContent = 'Importing…';
    const r = await ipcRenderer.invoke('usermemory:import', { mode: 'merge' });
    if (r && r.ok) { status.textContent = `Imported ${r.added}${r.skipped ? ` (${r.skipped} skipped — duplicate or invalid)` : ''}.`; refreshList(); }
    else if (r && r.canceled) status.textContent = '';
    else status.textContent = `Import failed: ${(r && r.error) || 'unknown'}`;
  });
  clearBtn.addEventListener('click', async () => {
    const ok = await confirm({
      title: 'Clear ALL user memory?',
      message: 'This deletes every fact (including archived) and cannot be undone.',
      confirmLabel: 'Clear everything',
      confirmKind: 'danger',
    });
    if (!ok) return;
    await ipcRenderer.invoke('usermemory:clear-all');
    refreshList();
  });
  footer.append(exportBtn, importBtn, clearBtn, status);
  host.appendChild(footer);

  refreshList();
}

module.exports = { userMemory };

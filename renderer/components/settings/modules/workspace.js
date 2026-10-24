// Custom settings modules for spaces, keyboard shortcuts, the download
// folder, and the About panel.

const { ipcRenderer } = require('electron');
const { el } = require('../controls');
const { errMsg } = require('../../../../shared/errMsg');
const shortcutManager = require('../../../utils/shortcuts');
const { confirm } = require('../../ConfirmDialog');
const { prompt } = require('../../PromptDialog');
const { actionButton } = require('./kit');

// -- Spaces editor ---------------------------------------------------------

function spaces({ host, configBridge }) {
  const cfg = configBridge.snapshot() || {};
  const spaces = cfg.spaces || {};

  const list = el('div', { class: 'sv-spaces-list' });
  host.appendChild(list);

  function rerender() {
    while (list.firstChild) list.removeChild(list.firstChild);
    const fresh = configBridge.snapshot() || {};
    const entries = Object.entries(fresh.spaces || {});
    for (const [id, sp] of entries) {
      list.appendChild(buildSpaceRow(id, sp));
    }
    if (!entries.length) {
      list.appendChild(el('div', { class: 'sv-empty-row' }, ['No spaces yet. Click "Add space" to create one.']));
    }
  }

  function buildSpaceRow(id, sp) {
    const row = el('div', { class: 'sv-space-row' });
    const handle = el('span', { class: 'sv-space-handle', 'aria-hidden': 'true' }, ['⋮⋮']);
    const nameInput = el('input', {
      type: 'text', class: 'sv-text sv-space-name', value: sp.name || id,
      placeholder: 'Space name', 'aria-label': `Name for space ${id}`,
    });
    const urlInput = el('input', {
      type: 'text', class: 'sv-text sv-space-url', value: sp.url || '',
      placeholder: 'https://example.com', 'aria-label': `URL for space ${id}`,
    });
    const removeBtn = actionButton('Remove', 'sv-button sv-button--danger sv-space-remove', 'trash');
    removeBtn.setAttribute('aria-label', `Remove space ${id}`);

    nameInput.addEventListener('change', () => {
      configBridge.set(`spaces.${id}.name`, nameInput.value);
    });
    urlInput.addEventListener('change', () => {
      configBridge.set(`spaces.${id}.url`, urlInput.value);
    });
    removeBtn.addEventListener('click', async () => {
      const ok = await confirm({
        title: `Remove space "${sp.name || id}"?`,
        message: 'This cannot be undone.',
        confirmLabel: 'Remove',
        confirmKind: 'danger',
      });
      if (!ok) return;
      ipcRenderer.send('spaces:remove', id);
      // Optimistically update local cache so the row vanishes immediately.
      const snap = configBridge.snapshot() || {};
      if (snap.spaces && snap.spaces[id]) { delete snap.spaces[id]; configBridge.replace(snap); }
      rerender();
    });

    row.append(handle, nameInput, urlInput, removeBtn);
    return row;
  }

  const actionsRow = el('div', { class: 'sv-actions-row' });
  const addBtn = actionButton('Add space', 'sv-button sv-button--primary', 'plus');
  const resetBtn = actionButton('Reset to defaults', 'sv-button', 'refresh');
  actionsRow.append(addBtn, resetBtn);
  host.appendChild(actionsRow);

  addBtn.addEventListener('click', async () => {
    const name = await prompt({
      title: 'New space',
      message: 'Give the space a name.',
      defaultValue: 'New space',
      confirmLabel: 'Next',
      validate: (v) => (v.trim() ? null : 'Name cannot be empty'),
    });
    if (!name) return;
    const url = await prompt({
      title: `URL for "${name}"`,
      placeholder: 'https://',
      defaultValue: 'https://',
      confirmLabel: 'Add space',
      validate: (v) => (/^https?:\/\//i.test(v.trim()) ? null : 'Enter a valid http(s) URL'),
    });
    if (!url) return;
    ipcRenderer.send('spaces:add', { name, url, type: 'web-page' });
    setTimeout(() => { configBridge.refresh(); rerender(); }, 100);
  });
  resetBtn.addEventListener('click', async () => {
    const ok = await confirm({
      title: 'Reset all spaces to defaults?',
      message: 'Custom spaces will be lost.',
      confirmLabel: 'Reset',
      confirmKind: 'danger',
    });
    if (!ok) return;
    ipcRenderer.send('spaces:reset');
    setTimeout(() => { configBridge.refresh(); rerender(); }, 100);
  });

  rerender();
  if (!spaces || !Object.keys(spaces).length) rerender();
}

// -- Shortcuts editor ------------------------------------------------------

function shortcuts({ host, configBridge }) {
  const cfg = configBridge.snapshot() || {};
  shortcutManager.loadShortcuts(cfg);

  const search = el('input', {
    type: 'search', class: 'sv-text', placeholder: 'Search shortcuts (try "tab", "zoom", "agent"…)',
    'aria-label': 'Search shortcuts',
  });
  const list = el('div', { class: 'sv-shortcuts-list' });
  const resetBtn = actionButton('Reset all to defaults', 'sv-button', 'refresh');
  const status = el('span', { class: 'sv-validation-status' }, ['']);

  const showStatus = (kind, msg) => {
    status.className = kind ? `sv-validation-status is-${kind}` : 'sv-validation-status';
    status.textContent = msg || '';
    if (msg) setTimeout(() => { if (status.textContent === msg) showStatus(null, ''); }, 4000);
  };

  host.append(
    el('div', { class: 'sv-actions-row' }, [search, resetBtn, status]),
    list,
  );

  function render(filter = '') {
    while (list.firstChild) list.removeChild(list.firstChild);
    const all = typeof shortcutManager.getAllShortcuts === 'function' ? shortcutManager.getAllShortcuts() : [];
    const f = filter.toLowerCase().trim();
    const matches = all.filter((s) => {
      if (!f) return true;
      const blob = `${s.action} ${s.label || ''} ${s.key || ''} ${s.category || ''}`.toLowerCase();
      return f.split(/\s+/).every((t) => blob.includes(t));
    });
    if (!matches.length) {
      list.appendChild(el('div', { class: 'sv-empty-row' }, [`No shortcuts match "${filter}".`]));
      return;
    }
    for (const s of matches) list.appendChild(buildShortcutRow(s));
  }

  function buildShortcutRow(s) {
    const row = el('div', { class: 'sv-shortcut-row' });
    const label = el('div', { class: 'sv-shortcut-label' }, [
      el('div', { class: 'sv-shortcut-title' }, [s.label || s.action]),
      el('div', { class: 'sv-shortcut-action' }, [s.action]),
    ]);
    const keyEl = el('kbd', { class: 'sv-shortcut-key' }, [s.key || '(none)']);
    const editBtn = actionButton('Edit', 'sv-button', 'edit');
    editBtn.addEventListener('click', () => beginRecord(s, keyEl, row));
    row.append(label, keyEl, editBtn);
    return row;
  }

  function beginRecord(shortcut, keyEl, row) {
    document.body.classList.add('recording-shortcut');
    row.classList.add('is-recording');
    keyEl.textContent = 'Press keys…';
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return finish(null);
      // Reuse shortcutManager.eventToShortcut so Space serializes as 'Space'
      // (not the literal space character) and modifier names match the rest
      // of the codebase (Cmd/Ctrl on darwin, CmdOrCtrl elsewhere). Returns
      // null on modifier-only events — keep listening in that case.
      const newKey = shortcutManager.eventToShortcut(e);
      if (newKey) finish(newKey);
    };
    function finish(newKey) {
      document.removeEventListener('keydown', onKey, true);
      document.body.classList.remove('recording-shortcut');
      row.classList.remove('is-recording');
      if (newKey != null) {
        try {
          shortcutManager.setShortcut(shortcut.action, newKey);
          // Action names contain dots (e.g. "window.toggle"); configBridge.set
          // splits its path on '.', which would write the nested-orphan form
          // `settings.shortcuts.window.toggle` instead of the flat dotted key.
          // Write the whole subtree to keep the path two segments deep.
          const cfg = configBridge.snapshot() || {};
          const current = (cfg.settings && cfg.settings.shortcuts) || {};
          const description = (current[shortcut.action] && current[shortcut.action].description)
            || shortcutManager.getDescription(shortcut.action);
          const next = { ...current, [shortcut.action]: { key: newKey, description } };
          configBridge.set('settings.shortcuts', next);
          keyEl.textContent = newKey;
          showStatus('ok', `Bound ${shortcut.action} to ${newKey}.`);
        } catch (err) {
          showStatus('error', `Could not bind: ${errMsg(err)}`);
          keyEl.textContent = shortcut.key || '(none)';
        }
      } else {
        keyEl.textContent = shortcut.key || '(none)';
      }
    }
    document.addEventListener('keydown', onKey, true);
  }

  search.addEventListener('input', () => render(search.value));
  resetBtn.addEventListener('click', async () => {
    const ok = await confirm({
      title: 'Reset every keyboard shortcut to its default?',
      message: 'Custom keybindings will be lost.',
      confirmLabel: 'Reset',
      confirmKind: 'danger',
    });
    if (!ok) return;
    try {
      shortcutManager.resetAllShortcuts();
      configBridge.set('settings.shortcuts', {});
      render(search.value);
      showStatus('ok', 'All shortcuts reset to defaults.');
    } catch (err) {
      showStatus('error', `Reset failed: ${errMsg(err)}`);
    }
  });

  render('');
}

// -- Download location -----------------------------------------------------

function downloadLocation({ host, configBridge }) {
  const wrap = el('div', { class: 'sv-row-stack' });
  const pathEl = el('code', { class: 'sv-path' }, [pathOrDefault()]);
  const browseBtn = actionButton('Choose folder…', 'sv-button', 'external');
  const clearBtn = actionButton('Use OS default', 'sv-button', 'refresh');

  function pathOrDefault() {
    const cur = configBridge.get('settings.downloadLocation', null);
    return cur || '(OS default Downloads folder)';
  }

  browseBtn.addEventListener('click', async () => {
    const result = await ipcRenderer.invoke('dialog:choose-directory', { title: 'Choose download folder' });
    if (result && typeof result === 'string') {
      configBridge.set('settings.downloadLocation', result);
      pathEl.textContent = result;
    }
  });
  clearBtn.addEventListener('click', () => {
    configBridge.set('settings.downloadLocation', null);
    pathEl.textContent = pathOrDefault();
  });

  wrap.append(pathEl, el('div', { class: 'sv-actions-row' }, [browseBtn, clearBtn]));
  host.appendChild(wrap);
}

function about({ host }) {
  const v = (typeof process !== 'undefined' && process && process.versions) ? process.versions : {};
  const app = (typeof process !== 'undefined' && process && process.env && process.env.npm_package_version) || '';

  const grid = el('div', { class: 'sv-about' });
  const items = [
    ['App version', app || '(unavailable)'],
    ['Electron', v.electron || '—'],
    ['Chromium', v.chrome || '—'],
    ['Node', v.node || '—'],
    ['V8', v.v8 || '—'],
    ['Platform', `${process.platform || ''} ${process.arch || ''}`.trim() || '—'],
  ];
  for (const [label, value] of items) {
    grid.append(
      el('div', { class: 'sv-about-label' }, [label]),
      el('div', { class: 'sv-about-value' }, [String(value)]),
    );
  }

  const links = el('div', { class: 'sv-actions-row' });
  const githubBtn = actionButton('GitHub', 'sv-button', 'external');
  const issuesBtn = actionButton('Report a bug', 'sv-button', 'warn');
  githubBtn.addEventListener('click', () => ipcRenderer.send('open-external-url', 'https://github.com/daemon-summoner/InstantCognition'));
  issuesBtn.addEventListener('click', () => ipcRenderer.send('open-external-url', 'https://github.com/daemon-summoner/InstantCognition/issues'));
  links.append(githubBtn, issuesBtn);

  host.append(grid, links);
}

module.exports = { spaces, shortcuts, downloadLocation, about };

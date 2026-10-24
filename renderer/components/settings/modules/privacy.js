// Custom settings modules for privacy: custom DoH URL, adblocker blocklists,
// the adblock site allowlist, and site permissions.

const { ipcRenderer } = require('electron');
const { el } = require('../controls');
const { errMsg } = require('../../../../shared/errMsg');
const toast = require('../../Toast');
const { actionButton, isValidUrl, errorRow } = require('./kit');

// -- Custom DoH URL --------------------------------------------------------

function dnsCustomUrl({ host, configBridge }) {
  const wrap = el('div', { class: 'sv-row-stack' });
  const initial = configBridge.get('settings.dns.customUrl', '') || '';
  const input = el('input', {
    type: 'text', class: 'sv-text',
    value: initial,
    placeholder: 'https://dns.example.com/dns-query',
    'aria-label': 'Custom DoH URL',
  });
  const status = el('span', { class: 'sv-validation-status' }, ['']);
  const validateBtn = actionButton('Validate', 'sv-button', 'check');
  const applyBtn = actionButton('Apply', 'sv-button sv-button--primary', 'check');

  let saveTimer = null;
  // Persist the URL to config immediately on every edit (debounced) so a
  // user who types a URL and walks away — without ever clicking Apply —
  // doesn't lose it on restart. This matches every other setting in the v2
  // menu, which saves on change. Apply remains the explicit "use this now"
  // trigger that fires dns:apply for the live host resolver.
  const persistDebounced = (url) => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { configBridge.set('settings.dns.customUrl', url); saveTimer = null; }, 300);
  };

  validateBtn.addEventListener('click', async () => {
    const url = input.value.trim();
    if (!url) {
      status.className = 'sv-validation-status is-error';
      status.textContent = 'Enter a URL first.';
      return;
    }
    status.className = 'sv-validation-status is-pending';
    status.textContent = 'Validating…';
    try {
      const result = await ipcRenderer.invoke('dns:validate', url);
      if (result && result.ok) {
        status.className = 'sv-validation-status is-ok';
        status.textContent = '✓ Valid DoH endpoint';
      } else {
        status.className = 'sv-validation-status is-error';
        status.textContent = '✗ ' + ((result && result.error) || 'Invalid');
      }
    } catch (err) {
      status.className = 'sv-validation-status is-error';
      status.textContent = '✗ ' + (errMsg(err) || 'Validation failed');
    }
  });

  applyBtn.addEventListener('click', () => {
    const url = input.value.trim();
    if (!url) {
      status.className = 'sv-validation-status is-error';
      status.textContent = 'Enter a URL first.';
      return;
    }
    // Force-flush any pending debounced save then trigger the runtime apply.
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    configBridge.set('settings.dns.customUrl', url);
    ipcRenderer.send('dns:apply');
    status.className = 'sv-validation-status is-ok';
    status.textContent = '✓ Applied';
  });

  input.addEventListener('input', () => {
    persistDebounced(input.value.trim());
    // Reset the validation pill on edit so a stale ✓ doesn't linger.
    status.textContent = '';
    status.className = 'sv-validation-status';
  });

  wrap.append(input, el('div', { class: 'sv-actions-row' }, [validateBtn, applyBtn, status]));
  host.appendChild(wrap);
}

// -- Adblocker blocklists --------------------------------------------------

function adblockerLists({ host, configBridge }) {
  const builtinSection = el('div', { class: 'sv-blocklist-section' });
  const customSection = el('div', { class: 'sv-blocklist-section' });
  const footer = el('div', { class: 'sv-stat-footer' }, ['Loading…']);

  host.append(builtinSection, customSection, footer);

  let catalog = [];
  let reloading = false;

  function getEnabledIds() {
    const arr = configBridge.get('settings.adblocker.builtinEnabled', []) || [];
    return Array.isArray(arr) ? arr.slice() : [];
  }

  function getCustomLists() {
    const arr = configBridge.get('settings.adblocker.customLists', []) || [];
    return Array.isArray(arr) ? arr.slice() : [];
  }

  async function refreshStats() {
    try {
      const stats = await ipcRenderer.invoke('adblocker:get-stats');
      if (!stats || !stats.enabled) {
        footer.textContent = 'Adblocker is off.';
        return;
      }
      const filterStr = stats.filterCount > 1000 ? (Math.round(stats.filterCount / 1000) + 'K') : String(stats.filterCount);
      const ago = stats.lastReloadAt ? Math.max(0, Math.round((Date.now() - stats.lastReloadAt) / 60000)) : null;
      footer.classList.remove('is-error');
      footer.textContent = `Active: ${stats.activeListCount} list(s) · ${filterStr} filters` + (ago != null ? ` · last reload ${ago}m ago` : '');
    } catch (err) {
      footer.classList.add('is-error');
      footer.textContent = `Couldn't read adblocker status: ${errMsg(err)}`;
    }
  }

  async function triggerReload() {
    if (reloading) return;
    reloading = true;
    footer.textContent = 'Reloading engine…';
    ipcRenderer.send('adblocker:reload');
    setTimeout(async () => { reloading = false; await refreshStats(); }, 1500);
  }

  function renderBuiltin() {
    while (builtinSection.firstChild) builtinSection.removeChild(builtinSection.firstChild);
    builtinSection.appendChild(el('div', { class: 'sv-blocklist-heading' }, ['Built-in lists']));
    const enabled = getEnabledIds();
    for (const entry of catalog) {
      const row = el('div', { class: 'sv-blocklist-row' });
      const cb = el('input', {
        type: 'checkbox',
        class: 'sv-blocklist-check',
        'aria-label': `Toggle ${entry.label}`,
      });
      cb.checked = enabled.includes(entry.id);
      cb.addEventListener('change', () => {
        const next = getEnabledIds();
        const idx = next.indexOf(entry.id);
        if (cb.checked && idx === -1) next.push(entry.id);
        else if (!cb.checked && idx !== -1) next.splice(idx, 1);
        configBridge.set('settings.adblocker.builtinEnabled', next);
        triggerReload();
      });
      const label = el('div', { class: 'sv-blocklist-label' }, [
        el('div', { class: 'sv-blocklist-title' }, [entry.label]),
        el('div', { class: 'sv-blocklist-url' }, [entry.url]),
      ]);
      row.append(cb, label);
      builtinSection.appendChild(row);
    }
  }

  function renderCustom() {
    while (customSection.firstChild) customSection.removeChild(customSection.firstChild);
    customSection.appendChild(el('div', { class: 'sv-blocklist-heading' }, ['Custom lists']));
    const list = getCustomLists();
    if (!list.length) {
      customSection.appendChild(el('div', { class: 'sv-empty-row' }, ['No custom blocklists yet.']));
    }
    for (const item of list) {
      const row = el('div', { class: 'sv-blocklist-row' });
      const label = el('div', { class: 'sv-blocklist-label' }, [
        el('div', { class: 'sv-blocklist-title' }, [item.name || item.url]),
        el('div', { class: 'sv-blocklist-url' }, [
          item.url,
          item.filterCount ? ` · ${item.filterCount.toLocaleString()} filters` : '',
        ]),
      ]);
      const removeBtn = actionButton('Remove', 'sv-button sv-button--danger', 'trash');
      removeBtn.addEventListener('click', () => {
        const next = getCustomLists().filter((x) => x.id !== item.id);
        configBridge.set('settings.adblocker.customLists', next);
        renderCustom();
        triggerReload();
      });
      row.append(label, removeBtn);
      customSection.appendChild(row);
    }
    // Add-list form
    const addRow = el('div', { class: 'sv-blocklist-add-row' });
    const urlInput = el('input', {
      type: 'text', class: 'sv-text',
      placeholder: 'https://example.com/filters.txt',
      'aria-label': 'New blocklist URL',
    });
    const addStatus = el('span', { class: 'sv-validation-status' }, ['']);
    const addBtn = actionButton('Add list', 'sv-button sv-button--primary', 'plus');
    addBtn.addEventListener('click', async () => {
      const url = urlInput.value.trim();
      if (!url) {
        addStatus.className = 'sv-validation-status is-error';
        addStatus.textContent = 'Enter a URL first.';
        return;
      }
      addStatus.className = 'sv-validation-status is-pending';
      addStatus.textContent = 'Validating…';
      addBtn.disabled = true;
      try {
        const result = await ipcRenderer.invoke('adblocker:validate', url);
        if (result && result.ok) {
          const next = getCustomLists();
          if (next.some((x) => x.url === url)) {
            addStatus.className = 'sv-validation-status is-error';
            addStatus.textContent = 'Already added.';
            return;
          }
          const host = isValidUrl(url) ? new URL(url).host : url;
          const entry = {
            id: 'custom-' + Date.now().toString(36),
            name: host,
            url,
            addedAt: Date.now(),
            lastValidated: Date.now(),
            filterCount: result.filterCount || 0,
          };
          next.push(entry);
          configBridge.set('settings.adblocker.customLists', next);
          urlInput.value = '';
          addStatus.className = 'sv-validation-status is-ok';
          addStatus.textContent = `✓ Added (${(result.filterCount || 0).toLocaleString()} filters)`;
          renderCustom();
          triggerReload();
        } else {
          addStatus.className = 'sv-validation-status is-error';
          addStatus.textContent = '✗ ' + ((result && result.error) || 'Invalid');
        }
      } catch (err) {
        addStatus.className = 'sv-validation-status is-error';
        addStatus.textContent = '✗ ' + (errMsg(err) || 'Validation failed');
      } finally {
        addBtn.disabled = false;
      }
    });
    addRow.append(urlInput, addBtn, addStatus);
    customSection.appendChild(addRow);
  }

  let catalogError = null;
  (async () => {
    try {
      catalog = await ipcRenderer.invoke('adblocker:get-catalog') || [];
    } catch (err) {
      catalog = [];
      catalogError = err;
    }
    renderBuiltin();
    if (catalogError) builtinSection.appendChild(errorRow(`Couldn't load the built-in lists: ${errMsg(catalogError)}`));
    renderCustom();
    refreshStats();
  })();
}

// -- Site allowlist --------------------------------------------------------
// Hosts here are exempted from the adblocker. Populated by the "site blocked"
// popup or manually here. The list is the source of truth — the engine's
// runtime exception filters are re-derived from it on every change.

function siteAllowlist({ host, configBridge }) {
  const wrap = el('div', { class: 'sv-row-stack' });
  host.appendChild(wrap);

  const list = el('div', { class: 'sv-list' });

  const inputRow = el('div', { class: 'sv-actions-row' });
  const input = el('input', {
    type: 'text', class: 'sv-text',
    placeholder: 'example.com',
    'aria-label': 'Hostname to allowlist',
  });
  const addBtn = actionButton('Add', 'sv-button sv-button--primary', 'plus');
  const status = el('span', { class: 'sv-validation-status' }, ['']);
  inputRow.append(input, addBtn, status);

  function rerender(entries) {
    while (list.firstChild) list.removeChild(list.firstChild);
    const hosts = Array.isArray(entries)
      ? entries.slice()
      : (configBridge.get('settings.siteAllowlist', []) || []).slice();
    hosts.sort();
    if (!hosts.length) {
      list.appendChild(el('div', { class: 'sv-empty-row' }, ['No hosts allowlisted. The "Site couldn\'t load" prompt will offer to add hosts here when a page is blocked.']));
      return;
    }
    for (const h of hosts) {
      const row = el('div', { class: 'sv-list-row' });
      const label = el('span', { class: 'sv-list-label' }, [h]);
      const removeBtn = actionButton('Remove', 'sv-button sv-button--danger', 'trash');
      removeBtn.addEventListener('click', async () => {
        try {
          const res = await ipcRenderer.invoke('site-allowlist:remove', h);
          if (res && res.ok) {
            configBridge.set('settings.siteAllowlist', res.list || []);
            rerender(res.list || []);
          } else {
            toast.error('Could not remove ' + h + (res && res.error ? ': ' + res.error : ''));
          }
        } catch (err) {
          console.error('[site-allowlist] remove failed', err);
          toast.error('Could not remove ' + h + ': ' + errMsg(err));
        }
      });
      row.append(label, removeBtn);
      list.appendChild(row);
    }
  }

  addBtn.addEventListener('click', async () => {
    const raw = input.value.trim();
    if (!raw) {
      status.className = 'sv-validation-status is-error';
      status.textContent = 'Enter a hostname.';
      return;
    }
    status.className = 'sv-validation-status is-pending';
    status.textContent = 'Adding…';
    try {
      const res = await ipcRenderer.invoke('site-allowlist:add', raw);
      if (res && res.ok) {
        status.className = 'sv-validation-status is-ok';
        status.textContent = '✓ Added ' + res.hostname;
        configBridge.set('settings.siteAllowlist', res.list || []);
        input.value = '';
        rerender(res.list || []);
      } else {
        status.className = 'sv-validation-status is-error';
        status.textContent = '✗ ' + ((res && res.error) || 'Could not add hostname.');
      }
    } catch (err) {
      status.className = 'sv-validation-status is-error';
      status.textContent = '✗ ' + (errMsg(err) || 'Add failed.');
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addBtn.click();
    }
  });

  wrap.append(inputRow, list);
  rerender();
}

// -- Permissions (mount existing module) -----------------------------------

function permissions({ host }) {
  const PermissionsTab = require('../PermissionsTab');
  const tab = typeof PermissionsTab === 'function' ? new PermissionsTab() : PermissionsTab;
  if (tab && typeof tab.render === 'function') tab.render(host);
  return () => { if (tab && typeof tab.destroy === 'function') tab.destroy(); };
}

module.exports = { dnsCustomUrl, adblockerLists, siteAllowlist, permissions };

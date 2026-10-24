// Custom search engines editor for the address bar.

const { el } = require('../controls');
const { confirm } = require('../../ConfirmDialog');
const { syncSelect } = require('../../menu/Select');
const { actionButton, isValidUrl, setStatus } = require('./kit');

// urlNavigate's and the registry's documented fallback engine.
const DEFAULT_ENGINE = 'google';

// -- Custom search engines -------------------------------------------------

// Derive a stable, unique id from the engine name so it can be referenced by
// settings.defaultSearchEngine. Falls back to a counter when the slug collides
// or the name is empty.
function _engineId(name, taken) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'engine';
  let id = base;
  let n = 2;
  while (taken.has(id)) { id = `${base}-${n}`; n += 1; }
  return id;
}

// Main fetches suggestions with credentials omitted and only over https; the
// endpoint must answer in the OpenSearch suggestions format.
function _isValidSuggestUrl(url) {
  return /^https:\/\//i.test(url) && url.includes('%s') && isValidUrl(url.replace(/%s/g, 'q'));
}

// The default-engine select is a sibling registry row whose options were
// resolved when Settings opened. Drop the removed engine from it so it can no
// longer be chosen, and show the default that is now in effect.
function _syncDefaultEngineSelect(host, removedId, defaultId) {
  const scope = host.closest('.settings-v2') || host.ownerDocument;
  const select = /** @type {HTMLSelectElement | null} */ (scope.querySelector('[data-setting-id="search.defaultEngine"] select'));
  if (!select) return;
  for (const opt of Array.from(select.options)) {
    if (opt.value === removedId) opt.remove();
  }
  select.value = defaultId;
  syncSelect(select);
}

function customSearchEngines({ host, configBridge }) {
  const read = () => {
    const list = configBridge.get('settings.customSearchEngines', []);
    return Array.isArray(list) ? list.filter((e) => e && typeof e === 'object') : [];
  };
  const write = (list) => configBridge.set('settings.customSearchEngines', list);

  const list = el('div', { class: 'sv-engine-list' });
  host.appendChild(list);

  function rerender() {
    while (list.firstChild) list.removeChild(list.firstChild);
    const engines = read();
    engines.forEach((e, idx) => list.appendChild(buildRow(e, idx)));
    if (!engines.length) {
      list.appendChild(el('div', { class: 'sv-empty-row' }, ['No custom engines yet. Click "Add engine" to create one.']));
    }
  }

  function buildRow(engine, idx) {
    const row = el('div', { class: 'sv-space-row' });
    const nameInput = el('input', {
      type: 'text', class: 'sv-text sv-space-name', value: engine.name || '',
      placeholder: 'Name', 'aria-label': 'Search engine name',
    });
    const urlInput = el('input', {
      type: 'text', class: 'sv-text sv-space-url', value: engine.url || '',
      placeholder: 'https://example.com/search?q=%s', 'aria-label': 'Search engine URL',
    });
    const suggestInput = el('input', {
      type: 'text', class: 'sv-text sv-space-url sv-engine-suggest', value: engine.suggest || '',
      placeholder: 'Suggestions URL (optional): https://example.com/suggest?q=%s', 'aria-label': 'Search suggestions URL',
    });
    const removeBtn = actionButton('Remove', 'sv-button sv-button--danger sv-space-remove', 'trash');
    removeBtn.setAttribute('aria-label', `Remove ${engine.name || 'engine'}`);
    const status = el('span', { class: 'sv-validation-status' });
    const suggestStatus = el('span', { class: 'sv-validation-status' });

    nameInput.addEventListener('change', () => {
      const engines = read();
      if (!engines[idx]) return;
      engines[idx] = { ...engines[idx], name: nameInput.value.trim() };
      write(engines);
    });
    // The address bar substitutes the query for %s; a template without it, or
    // a non-http(s) URL, would produce a broken search, so it is not saved.
    urlInput.addEventListener('change', () => {
      const engines = read();
      if (!engines[idx]) return;
      const url = urlInput.value.trim();
      if (!isValidUrl(url.replace('%s', 'q')) || !url.includes('%s')) {
        urlInput.setAttribute('aria-invalid', 'true');
        setStatus(status, 'error', 'Enter an http(s) URL containing %s where the search terms go.');
        return;
      }
      urlInput.removeAttribute('aria-invalid');
      setStatus(status, null, '');
      engines[idx] = { ...engines[idx], url };
      write(engines);
    });
    suggestInput.addEventListener('change', () => {
      const engines = read();
      if (!engines[idx]) return;
      const suggest = suggestInput.value.trim();
      if (suggest && !_isValidSuggestUrl(suggest)) {
        suggestInput.setAttribute('aria-invalid', 'true');
        setStatus(suggestStatus, 'error', 'Enter an https URL containing %s where the search terms go, or leave it empty for no suggestions.');
        return;
      }
      suggestInput.removeAttribute('aria-invalid');
      setStatus(suggestStatus, null, '');
      const next = { ...engines[idx], suggest };
      if (!suggest) delete next.suggest;
      engines[idx] = next;
      write(engines);
    });
    removeBtn.addEventListener('click', async () => {
      const engines = read();
      if (!engines[idx]) return;
      const ok = await confirm({
        title: `Remove search engine "${engines[idx].name || engines[idx].id}"?`,
        confirmLabel: 'Remove',
        confirmKind: 'danger',
      });
      if (!ok) return;
      const [removed] = engines.splice(idx, 1);
      // Written before the list so config never names an engine that is gone;
      // otherwise searches would quietly fall back and suggestions stop.
      if (removed.id && configBridge.get('settings.defaultSearchEngine', DEFAULT_ENGINE) === removed.id) {
        configBridge.set('settings.defaultSearchEngine', DEFAULT_ENGINE);
      }
      write(engines);
      _syncDefaultEngineSelect(host, removed.id, configBridge.get('settings.defaultSearchEngine', DEFAULT_ENGINE));
      rerender();
    });

    row.append(nameInput, urlInput, suggestInput, removeBtn, status, suggestStatus);
    return row;
  }

  const actionsRow = el('div', { class: 'sv-actions-row' });
  const addBtn = actionButton('Add engine', 'sv-button sv-button--primary', 'plus');
  actionsRow.appendChild(addBtn);
  host.appendChild(actionsRow);

  addBtn.addEventListener('click', () => {
    const engines = read();
    const taken = new Set(engines.map((e) => e.id).filter(Boolean));
    engines.push({ id: _engineId('engine', taken), name: '', url: '' });
    write(engines);
    rerender();
  });

  rerender();
}

module.exports = { customSearchEngines };

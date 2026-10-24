// OmniboxSuggest — the dropdown under a tab's address input: bookmark and
// history matches (settings.addressBarSearchHistory) plus the search engine's
// live suggestions (settings.searchSuggestionsEnabled, fetched by main through
// 'search:suggest'). Settings are read on every keystroke, so toggles apply
// immediately. The input becomes an ARIA combobox; the host routes keydown
// through handleKey() so a highlighted row wins over plain Enter-to-navigate.

const { ipcRenderer } = require('electron');
const { isLocalHost } = require('../../shared/privateIp');

const DEBOUNCE_MS = 150;
const MAX_PAGES = 5;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HOST_AND_REST = /^([a-z0-9.-]+|\[[0-9a-f:.]+\])(:\d+)?([/?#].*)?$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// A destination being typed, not a query worth sending to the search engine: a
// URL with a scheme, a host with a port/path/query (which can carry intranet
// paths or tokens), an IP address, or a local-network name. A bare public
// domain ("github.com") and a single word, even one ending in "?", still get
// suggestions.
function isAddress(query) {
  if (HAS_SCHEME.test(query)) return true;
  const match = HOST_AND_REST.exec(query);
  if (!match) return false;
  const [, host, port, rest] = match;
  if (!host.includes('.') && !host.startsWith('[')) return !!port || (!!rest && rest.length > 1);
  return !!(port || rest) || host.startsWith('[') || IPV4.test(host) || isLocalHost(host);
}

let instances = 0;

class OmniboxSuggest {
  /**
   * @param {HTMLInputElement} input
   * @param {{ getSettings: () => any, onPick: (row: { type: 'url'|'search', value: string }) => void,
   *   invoke?: (channel: string, arg: any) => Promise<any> }} opts
   */
  constructor(input, { getSettings, onPick, invoke }) {
    this._input = input;
    this._getSettings = getSettings;
    this._onPick = onPick;
    this._invoke = invoke || ((channel, arg) => ipcRenderer.invoke(channel, arg));
    this._listId = `omnibox-list-${++instances}`;
    this._list = null;
    this._rows = [];
    this._active = -1;
    this._activeRow = null;
    this._seq = 0;
    this._timer = null;
    this._result = null;

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', this._listId);
    this._onInput = () => this._schedule();
    this._onBlur = () => this.close();
    input.addEventListener('input', this._onInput);
    input.addEventListener('blur', this._onBlur);
  }

  attach(container) {
    const list = document.createElement('ul');
    list.className = 'omnibox-list';
    list.id = this._listId;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Address bar suggestions');
    list.hidden = true;
    container.appendChild(list);
    this._list = list;
  }

  isOpen() { return !!this._list && !this._list.hidden; }

  _schedule() {
    clearTimeout(this._timer);
    const query = this._input.value.trim();
    if (!query) { this.close(); return; }
    this._timer = setTimeout(() => this._query(query), DEBOUNCE_MS);
  }

  _query(query) {
    const seq = ++this._seq;
    const settings = this._getSettings() || {};
    const wantPages = settings.addressBarSearchHistory !== false;
    const wantSuggest = settings.searchSuggestionsEnabled !== false && !isAddress(query);
    this._result = {
      pages: [], pagesFailed: false, suggestions: [], suggestState: wantSuggest ? 'loading' : 'off',
    };
    this._active = -1;
    this._activeRow = null;
    this._render();
    const current = () => seq === this._seq;
    const jobs = [];
    if (wantPages) {
      jobs.push(this._loadPages(query).then((pages) => {
        if (!current()) return;
        this._result.pages = pages;
        this._render();
      }, (err) => {
        console.error('[omnibox] history/bookmark lookup failed:', err);
        if (!current()) return;
        this._result.pagesFailed = true;
        this._render();
      }));
    }
    if (wantSuggest) {
      jobs.push(this._invoke('search:suggest', { query }).then((res) => {
        if (!current()) return;
        if (res && res.ok) {
          this._result.suggestions = Array.isArray(res.suggestions) ? res.suggestions : [];
          this._result.suggestState = 'done';
        } else {
          this._result.suggestState = 'error';
        }
        this._render();
      }, (err) => {
        console.error('[omnibox] search:suggest failed:', err);
        if (!current()) return;
        this._result.suggestState = 'error';
        this._render();
      }));
    }
    return Promise.all(jobs);
  }

  // Bookmarks first, then history (newest first); one row per URL.
  async _loadPages(query) {
    const [bookmarks, history] = await Promise.all([
      this._invoke('bookmarks:search', { query }),
      this._invoke('history:search', { query, limit: 30 }),
    ]);
    const seen = new Set();
    const pages = [];
    for (const item of [...(bookmarks || []), ...(history || [])]) {
      if (!item || typeof item.url !== 'string' || seen.has(item.url)) continue;
      seen.add(item.url);
      pages.push({ url: item.url, title: item.title || item.name || '' });
      if (pages.length === MAX_PAGES) break;
    }
    return pages;
  }

  _render() {
    if (!this._list || !this._result) return;
    const { pages, pagesFailed, suggestions, suggestState } = this._result;
    this._rows = [
      ...pages.map((p) => ({ type: 'url', value: p.url, label: p.title || p.url, detail: p.title ? p.url : '' })),
      ...suggestions.map((s) => ({ type: 'search', value: s, label: s, detail: '' })),
    ];
    // Late answers reorder rows; keep the highlight on the same row, not the same index.
    this._active = this._activeRow ? this._rows.findIndex((r) => r.type === this._activeRow.type && r.value === this._activeRow.value) : -1;
    const notes = [];
    if (pagesFailed) notes.push('History search failed');
    if (suggestState === 'loading') notes.push('Loading suggestions…');
    if (suggestState === 'error') notes.push('Search suggestions are unavailable');
    if (!this._rows.length && !notes.length) { this._hide(); return; }

    this._list.textContent = '';
    this._rows.forEach((row, i) => {
      const li = document.createElement('li');
      li.className = `omnibox-row omnibox-row-${row.type}`;
      li.id = `${this._listId}-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === this._active));
      const label = document.createElement('span');
      label.className = 'omnibox-label';
      label.textContent = row.label;
      li.appendChild(label);
      if (row.detail) {
        const detail = document.createElement('span');
        detail.className = 'omnibox-detail';
        detail.textContent = row.detail;
        li.appendChild(detail);
      }
      // mousedown would blur the input (closing the list) before click lands.
      li.addEventListener('mousedown', (e) => e.preventDefault());
      li.addEventListener('click', () => this._pick(row));
      this._list.appendChild(li);
    });
    for (const text of notes) {
      const li = document.createElement('li');
      li.className = 'omnibox-note';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-disabled', 'true');
      li.textContent = text;
      this._list.appendChild(li);
    }
    this._list.style.left = `${this._input.offsetLeft}px`;
    this._list.style.width = `${this._input.offsetWidth}px`;
    this._list.hidden = false;
    this._input.setAttribute('aria-expanded', 'true');
    this._syncActive();
  }

  _syncActive() {
    this._activeRow = this._rows[this._active] || null;
    this._rows.forEach((_, i) => {
      const li = this._list.children[i];
      if (li) li.setAttribute('aria-selected', String(i === this._active));
    });
    if (this._active >= 0) this._input.setAttribute('aria-activedescendant', `${this._listId}-${this._active}`);
    else this._input.removeAttribute('aria-activedescendant');
  }

  /** @returns {boolean} true when the key was consumed by the dropdown */
  handleKey(e) {
    if (!this.isOpen()) {
      // The host navigates on this Enter; a lookup still debouncing would
      // reopen the list over the page being loaded.
      if (e.key === 'Enter') this.close();
      return false;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // A list showing only a note has nothing to highlight; the host's own
      // rows (the new-tab picker's) take the arrows.
      if (!this._rows.length) return false;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      // -1 is "no row": the typed text itself.
      const span = this._rows.length + 1;
      this._active = ((this._active + 1 + step + span) % span) - 1;
      this._syncActive();
      return true;
    }
    if (e.key === 'Enter') {
      const row = this._rows[this._active];
      if (!row) { this.close(); return false; }
      e.preventDefault();
      this._pick(row);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
      return true;
    }
    return false;
  }

  _pick(row) {
    this.close();
    this._onPick({ type: row.type, value: row.value });
  }

  _hide() {
    this._active = -1;
    this._activeRow = null;
    if (this._list) { this._list.hidden = true; this._list.textContent = ''; }
    this._input.setAttribute('aria-expanded', 'false');
    this._input.removeAttribute('aria-activedescendant');
  }

  close() {
    clearTimeout(this._timer);
    this._seq++; // answers still in flight are dropped
    this._result = null;
    this._rows = [];
    this._hide();
  }

  destroy() {
    this.close();
    this._input.removeEventListener('input', this._onInput);
    this._input.removeEventListener('blur', this._onBlur);
    if (this._list && this._list.parentNode) this._list.parentNode.removeChild(this._list);
    this._list = null;
  }
}

module.exports = OmniboxSuggest;

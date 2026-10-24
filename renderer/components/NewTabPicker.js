// NewTabPicker.js — Modal overlay for opening a new tab from the space library
// or by entering an arbitrary URL. Renders inside the unified .app-dropdown
// shell (size: lg). Supports fuzzy search, keyboard navigation, and detects
// when a space is already open. The input also carries the address-bar
// suggestion list (OmniboxSuggest): while that list is open it owns
// ArrowUp/ArrowDown/Enter/Escape, as in a tab's URL strip; once it closes the
// keys move through the picker's own rows (navigate, ask, spaces).

const { fuzzyScore } = require('../utils/commandRegistry');
const { resolveNavigationUrl, searchUrlFor } = require('../utils/urlNavigate');
const Dropdown = require('./dropdown/Dropdown');
const OmniboxSuggest = require('./OmniboxSuggest');
const { createVoiceInputButton } = require('./VoiceInputButton');
const fx = require('../fx');

const TYPE_GROUPS = [
  { key: 'ai-service', label: 'AI Services' },
  { key: 'web-page', label: 'Web Pages' },
  { key: 'local-llm', label: 'Local' },
];

class NewTabPicker {
  constructor() {
    this._state = null;
    this._spaceManager = null;
    this._content = null;
    this._input = null;
    this._urlOption = null;
    this._groupsContainer = null;
    this._dropdown = null;
    this._highlightIndex = -1;
    this._flatCards = [];
    this._resolvedUrl = null;
    this._starCanvas = null;
    this._stars = null;
    this._suggest = null;
    this._getSettings = null;
    this._getSearchEngine = null;
    this._getCustomEngines = null;
  }

  /**
   * The search accessors should read live config (renderer.js passes the
   * configBridge cache) so engine and suggestion toggles apply without a
   * restart; without them the picker reads `state`'s config.
   * @param {{ state: any, spaceManager: any, getSettings?: () => any,
   *   getSearchEngine?: () => string, getCustomEngines?: () => any[] }} deps
   */
  initialize({ state, spaceManager, getSettings, getSearchEngine, getCustomEngines }) {
    this._state = state;
    this._spaceManager = spaceManager;
    this._getSettings = typeof getSettings === 'function' ? getSettings : null;
    this._getSearchEngine = typeof getSearchEngine === 'function' ? getSearchEngine : null;
    this._getCustomEngines = typeof getCustomEngines === 'function' ? getCustomEngines : null;
    if (this._suggest) this._suggest.destroy();
    this._buildContent();
    this._dropdown = new Dropdown({
      id: 'new-tab-picker',
      size: 'lg',
      ariaLabel: 'New Tab Picker',
      // The first Esc closes an open suggestion list, the next one the picker.
      shouldCloseOnEsc: () => !(this._suggest && this._suggest.isOpen()),
      onClose: () => { if (this._suggest) this._suggest.close(); },
    });
    this._dropdown.mount(this._content);
    const surface = this._content.closest('.app-dropdown');
    if (surface) {
      this._starCanvas = document.createElement('canvas');
      this._starCanvas.className = 'fx-starfield';
      this._starCanvas.setAttribute('aria-hidden', 'true');
      surface.insertBefore(this._starCanvas, surface.firstChild);
    }
  }

  open() {
    if (!this._dropdown) return;
    if (this._suggest) this._suggest.close();
    if (this._input) this._input.value = '';
    this._resolvedUrl = null;
    this._renderSpaces();
    this._updateUrlOption('');
    this._highlightIndex = -1;
    this._applyHighlight();
    this._dropdown.open();
    // Next frame: the surface is laid out, so the canvas has a size. The
    // starfield stops itself once the dropdown is hidden again.
    if (this._starCanvas) {
      if (this._stars) this._stars.stop();
      this._stars = fx.starfield(this._starCanvas, { warp: true });
      requestAnimationFrame(() => { if (this._stars && this.isOpen()) this._stars.start(); });
    }
  }

  close() {
    if (this._suggest) this._suggest.close();
    if (this._dropdown) this._dropdown.close();
    if (this._stars) { this._stars.stop(); this._stars = null; }
  }

  toggle() {
    if (!this._dropdown) return;
    if (this._dropdown.isOpen()) this.close();
    else this.open();
  }

  isOpen() {
    return !!(this._dropdown && this._dropdown.isOpen());
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  _buildContent() {
    const root = document.createElement('div');
    root.className = 'new-tab-picker-content';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'new-tab-picker-search';
    input.placeholder = 'Search spaces or enter URL…';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('data-autofocus', 'true');
    input.setAttribute('aria-label', 'Search spaces or enter a URL');
    // OmniboxSuggest makes the input the one combobox and owns aria-expanded
    // for its popup list. aria-activedescendant follows whichever list holds
    // the arrows, so the always-visible results are listed in aria-controls too.
    this._suggest = new OmniboxSuggest(input, {
      getSettings: () => this._searchSettings(),
      onPick: (row) => this._openSuggestion(row),
    });

    const searchRow = document.createElement('div');
    searchRow.className = 'new-tab-picker-search-row';
    const voiceBtn = createVoiceInputButton({
      target: input,
      label: 'Dictate search or agent task',
      getConfig: () => {
        const cfg = this._state && typeof this._state.get === 'function' ? this._state.get('config') || {} : {};
        return (cfg.settings && cfg.settings.voice) || {};
      },
    });
    searchRow.append(input, voiceBtn);

    const urlOption = document.createElement('div');
    urlOption.className = 'new-tab-picker-url-option';

    const askOption = document.createElement('div');
    askOption.className = 'new-tab-picker-ask-option';
    askOption.style.display = 'none';
    askOption.title = 'Ask the agent (Cmd/Ctrl+Enter also works)';

    const groups = document.createElement('div');
    groups.className = 'new-tab-picker-groups';
    groups.id = 'new-tab-picker-results';

    root.appendChild(searchRow);
    this._suggest.attach(root);
    input.setAttribute('aria-controls', `${input.getAttribute('aria-controls')} ${groups.id}`);
    root.appendChild(urlOption);
    root.appendChild(askOption);
    root.appendChild(groups);

    input.addEventListener('input', () => this._onInput());
    input.addEventListener('keydown', (e) => this._onInputKey(e));
    // A press that blurs the input closes the in-flow suggestion list, the rows
    // below jump up before mouseup, and the click lands on a different row.
    for (const row of [urlOption, askOption, groups]) {
      row.addEventListener('mousedown', (e) => e.preventDefault());
    }
    urlOption.addEventListener('click', () => this._openUrl());
    askOption.addEventListener('click', () => this._openAskAgent());
    groups.addEventListener('click', (e) => {
      const tgt = /** @type {HTMLElement} */ (e.target);
      const card = tgt.closest('.new-tab-picker-card');
      if (!card) return;
      const id = card.getAttribute('data-space-id');
      if (id) this._openSpace(id);
    });

    this._content = root;
    this._input = input;
    this._urlOption = urlOption;
    this._askOption = askOption;
    this._groupsContainer = groups;
  }

  _updateAskOption(raw) {
    if (!this._askOption) return;
    const text = (raw || '').trim();
    // Show "ask the agent" when the user typed something that's clearly not a
    // URL and looks like a sentence/question (3+ chars). The URL option is
    // mutually exclusive — if the input parses as a URL, prefer that.
    const looksLikeUrl = !!this._resolvedUrl;
    if (!looksLikeUrl && text.length >= 3) {
      this._askText = text;
      this._askOption.textContent = 'Ask the agent: ' + text;
      this._askOption.style.display = '';
    } else {
      this._askText = null;
      this._askOption.style.display = 'none';
    }
  }

  // ── Space rendering ───────────────────────────────────────────────────────

  _renderSpaces(filter) {
    if (!this._groupsContainer || !this._state) return;
    const config = this._state.get('config') || {};
    const spaces = config.spaces || {};
    const openTabs = this._state.get('openTabs') || [];
    const query = (filter || '').trim();

    const matched = [];
    const ids = Object.keys(spaces);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const space = spaces[id];
      if (!space || !space.name) continue;
      if (query) {
        const nameScore = fuzzyScore(query, space.name);
        const urlScore = fuzzyScore(query, space.url || '');
        if (nameScore < 0 && urlScore < 0) continue;
      }
      matched.push({ id, space });
    }

    const grouped = {};
    for (let i = 0; i < matched.length; i++) {
      const { id, space } = matched[i];
      const type = space.type || 'web-page';
      if (!grouped[type]) grouped[type] = [];
      grouped[type].push({ id, space });
    }

    this._groupsContainer.innerHTML = '';
    this._flatCards = [];

    for (let g = 0; g < TYPE_GROUPS.length; g++) {
      const group = TYPE_GROUPS[g];
      const entries = grouped[group.key];
      if (!entries || !entries.length) continue;

      const section = document.createElement('div');
      section.className = 'new-tab-picker-group';

      const title = document.createElement('h3');
      title.className = 'new-tab-picker-group-title';
      title.textContent = group.label;
      section.appendChild(title);

      const grid = document.createElement('div');
      grid.className = 'new-tab-picker-grid';
      grid.setAttribute('role', 'listbox');
      grid.setAttribute('aria-label', group.label);

      for (let i = 0; i < entries.length; i++) {
        const { id, space } = entries[i];
        const isOpenTab = openTabs.includes(id);

        const card = document.createElement('div');
        card.className = 'new-tab-picker-card' + (isOpenTab ? ' is-open' : '');
        card.setAttribute('data-space-id', id);
        // The search input keeps DOM focus, so cards are options addressed by
        // aria-activedescendant rather than focusable elements of their own.
        card.id = 'new-tab-picker-card-' + id;
        card.setAttribute('role', 'option');
        card.setAttribute('aria-selected', 'false');
        card.setAttribute('aria-label', space.name + (isOpenTab ? ' (already open)' : ''));
        if (space.color) {
          card.style.borderLeftColor = space.color;
        }

        const icon = document.createElement('span');
        icon.className = 'new-tab-picker-card-icon';
        icon.textContent = (space.name || '?')[0].toUpperCase();

        const name = document.createElement('span');
        name.className = 'new-tab-picker-card-name';
        name.textContent = space.name;
        if (isOpenTab) name.title = space.name + ' — already open';
        else name.title = space.name;

        card.appendChild(icon);
        card.appendChild(name);

        grid.appendChild(card);
        this._flatCards.push({ el: card, id, isOpen: isOpenTab });
      }

      section.appendChild(grid);
      this._groupsContainer.appendChild(section);
    }

    if (!this._flatCards.length && query) {
      const empty = document.createElement('div');
      empty.className = 'new-tab-picker-empty';
      empty.textContent = 'No matching spaces';
      this._groupsContainer.appendChild(empty);
    }
  }

  // ── URL detection ─────────────────────────────────────────────────────────

  _searchSettings() {
    if (this._getSettings) return this._getSettings() || {};
    const cfg = (this._state && this._state.get('config')) || {};
    return cfg.settings || {};
  }

  _searchEngine() {
    if (this._getSearchEngine) return this._getSearchEngine() || 'google';
    return this._searchSettings().defaultSearchEngine || 'google';
  }

  _customEngines() {
    if (this._getCustomEngines) return this._getCustomEngines() || [];
    return this._searchSettings().customSearchEngines || [];
  }

  _updateUrlOption(raw) {
    if (!this._urlOption) return;
    const resolved = resolveNavigationUrl(raw, this._searchEngine(), this._customEngines());
    if (resolved && raw.trim() && (raw.includes('.') || raw.includes('://') || raw.includes('localhost'))) {
      this._resolvedUrl = resolved;
      this._urlOption.textContent = 'Navigate to ' + resolved;
      // The stylesheet hides this row by default and reveals it on `.visible`;
      // an inline display would be overridden and the row would never show.
      this._urlOption.classList.add('visible');
    } else {
      this._resolvedUrl = null;
      this._urlOption.classList.remove('visible');
    }
  }

  // ── Input handling ────────────────────────────────────────────────────────

  _onInput() {
    const value = this._input ? this._input.value : '';
    this._updateUrlOption(value);
    this._updateAskOption(value);
    this._renderSpaces(value);
    this._highlightIndex = -1;
    this._applyHighlight();
  }

  _onInputKey(e) {
    // Cmd/Ctrl+Enter asks the agent even over a highlighted suggestion.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && this._askText) {
      e.preventDefault();
      this._openAskAgent();
      return;
    }
    if (this._suggest && this._suggest.handleKey(e)) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this._moveHighlight(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this._moveHighlight(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this._executeHighlighted();
    }
    // Esc handled by Dropdown controller.
  }

  // ── Keyboard navigation ───────────────────────────────────────────────────

  _totalItems() {
    return (this._resolvedUrl ? 1 : 0) + (this._askText ? 1 : 0) + this._flatCards.length;
  }

  _moveHighlight(delta) {
    const total = this._totalItems();
    if (!total) return;
    this._highlightIndex = (this._highlightIndex + delta + total) % total;
    this._applyHighlight();
  }

  _applyHighlight() {
    const urlIdx = this._resolvedUrl ? 0 : -1;
    const askIdx = this._askText ? (this._resolvedUrl ? 1 : 0) : -1;
    if (this._urlOption) {
      if (urlIdx >= 0 && this._highlightIndex === urlIdx) this._urlOption.classList.add('highlighted');
      else this._urlOption.classList.remove('highlighted');
    }
    if (this._askOption) {
      if (askIdx >= 0 && this._highlightIndex === askIdx) this._askOption.classList.add('highlighted');
      else this._askOption.classList.remove('highlighted');
    }
    const cardOffset = (this._resolvedUrl ? 1 : 0) + (this._askText ? 1 : 0);
    for (let i = 0; i < this._flatCards.length; i++) {
      const el = this._flatCards[i].el;
      if (i + cardOffset === this._highlightIndex) {
        el.classList.add('highlighted');
        el.setAttribute('aria-selected', 'true');
        el.scrollIntoView({ block: 'nearest' });
        if (this._input) this._input.setAttribute('aria-activedescendant', el.id);
      } else {
        el.classList.remove('highlighted');
        el.setAttribute('aria-selected', 'false');
      }
    }
    if (this._input && this._highlightIndex < cardOffset) this._input.removeAttribute('aria-activedescendant');
  }

  _executeHighlighted() {
    const total = this._totalItems();
    if (!total) return;
    const urlIdx = this._resolvedUrl ? 0 : -1;
    const askIdx = this._askText ? (this._resolvedUrl ? 1 : 0) : -1;

    if (this._highlightIndex < 0) {
      // No explicit highlight: prefer URL over ask over first card. URL is the
      // most "exact" intent — they typed a URL — so it wins.
      if (this._resolvedUrl) { this._openUrl(); return; }
      if (this._askText) { this._openAskAgent(); return; }
      if (this._flatCards.length) { this._openSpace(this._flatCards[0].id); return; }
      return;
    }

    if (urlIdx >= 0 && this._highlightIndex === urlIdx) { this._openUrl(); return; }
    if (askIdx >= 0 && this._highlightIndex === askIdx) { this._openAskAgent(); return; }

    const cardOffset = (this._resolvedUrl ? 1 : 0) + (this._askText ? 1 : 0);
    const cardIdx = this._highlightIndex - cardOffset;
    if (cardIdx >= 0 && cardIdx < this._flatCards.length) {
      this._openSpace(this._flatCards[cardIdx].id);
    }
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  _openSpace(id) {
    if (!this._spaceManager) return;
    const openTabs = (this._state && this._state.get('openTabs')) || [];
    if (openTabs.includes(id)) {
      this._spaceManager.focusTab(id);
    } else {
      this._spaceManager.openTab(id);
    }
    this.close();
  }

  _openUrl() {
    if (!this._resolvedUrl || !this._spaceManager) return;
    this._spaceManager.openAdHocTab(this._resolvedUrl);
    this.close();
  }

  _openSuggestion(row) {
    if (!this._spaceManager) return;
    const url = row.type === 'url' ? row.value : searchUrlFor(row.value, this._searchEngine(), this._customEngines());
    this._spaceManager.openAdHocTab(url);
    this.close();
  }

  _openAskAgent() {
    const text = this._askText;
    if (!text) return;
    this.close();
    // Defer the require so NewTabPicker doesn't pull AgentPanel into its module
    // graph at load time (helps tests that don't mount the panel).
    try {
      const agentPanel = require('./AgentPanel');
      if (agentPanel && typeof agentPanel.openWithTask === 'function') agentPanel.openWithTask(text, { scope: 'global', userSend: true });
    } catch (_) { /* AgentPanel unavailable in this build */ }
  }
}

module.exports = new NewTabPicker();

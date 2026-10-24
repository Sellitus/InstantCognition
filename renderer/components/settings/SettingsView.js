// SettingsView — registry-driven settings UI.
//
// Public API (initialize/show/hide/toggle/showTab/setRestartNeeded) is what
// ChromeBar, TabBar, the command registry and AgentPanel call.
//
// Layout: one Dropdown(size:'xxl') with a sticky header (search, expand /
// collapse all, restart hint, close), a nav rail of pages grouped under
// headings, and a content pane showing ONE page at a time. Each page is a
// grid of cards; each card holds rows and an optional "Advanced" disclosure.
// All pages render eagerly (so search and deep links never wait on a build);
// non-active pages are `hidden`.
//
// Search spans every page: matching rows stay visible, pages without matches
// hide, and each visible row offers a "go to" button that clears the search
// and lands on the row in its page. Row visibility is always
// `visibleIf(config) && searchMatch`, so a search never reveals a row whose
// visibleIf is false. Custom modules may tag their own controls with
// `[data-search]`; those are filtered with `.is-search-miss` (never `hidden`,
// which modules own for their own state).

const { ipcRenderer } = require('electron');
const Dropdown = require('../dropdown/Dropdown');
const configBridge = require('../../core/configBridge');
const { REGISTRY, GROUPS, resolvePage } = require('./registry');
const { filter, highlight, tokenize, matches } = require('./searchIndex');
const { render: renderControl, el, createAdvancedSection, setCollapsedState } = require('./controls');
const { runSideEffect } = require('./sideEffects');
const { resolveDynamicOptions } = require('./dynamicOptions');
const customModules = require('./customModules');
const { icon: makeIcon } = require('../Icon');

const WIDE_TYPES = new Set(['slider', 'text', 'number', 'radioGroup', 'custom', 'button']);
const SEARCH_DEBOUNCE_MS = 80;

function errorText(err) {
  return (err instanceof Error && err.message) || String(err);
}

/** True when `node` or an ancestor below `stop` carries `hidden`. */
function hiddenWithin(node, stop) {
  for (let cur = node; cur && cur !== stop; cur = cur.parentElement) {
    if (cur.hidden) return true;
  }
  return false;
}

/** Open every <details> ancestor of `node` (inside `root`) so it is reachable. */
function openAncestors(node, root) {
  let d = node.parentElement ? node.parentElement.closest('details') : null;
  while (d && root.contains(d)) {
    /** @type {HTMLDetailsElement} */ (d).open = true;
    d = d.parentElement ? d.parentElement.closest('details') : null;
  }
}

class SettingsView {
  constructor() {
    this._dropdown = null;
    this._headerEl = null;
    this._searchInput = null;
    this._searchClearEl = null;
    this._matchCountEl = null;
    this._restartHintEl = null;
    this._navEl = null;
    this._contentEl = null;
    /** @type {Map<string, { pageEl: HTMLElement, navEl: HTMLElement, def: any }>} */
    this._pages = new Map();
    /** @type {Map<string, { el: HTMLElement, pageId: string }>} key `${pageId}/${cardId}` */
    this._cards = new Map();
    /** @type {Map<string, { setting: any, rowEl: HTMLElement, pageId: string, cardKey: string, visibleIfOk: boolean }>} */
    this._rows = new Map();
    /** @type {Map<string, HTMLElement>} */
    this._groupHeaders = new Map();
    this._moduleTeardowns = [];
    this._activePage = REGISTRY.length ? REGISTRY[0].id : null;
    this._searchQuery = '';
    this._searchDebounce = null;
    this._isVisible = false;
    this._initialized = false;
  }

  // -- Public API --------------------------------------------------------

  initialize(config) {
    if (this._initialized) return;
    this._initialized = true;
    // renderer.js seeds the bridge at startup; re-copying that startup config
    // here would drop writes made since (e.g. settings.assistant.lastMode).
    configBridge.initialize(configBridge.snapshot() ? null : config);
    this._build();
  }

  show() {
    if (!this._dropdown) return;
    this._isVisible = true;
    document.body.classList.add('settings-open');
    // Rebuild from the latest config so values changed elsewhere since the
    // last open (LLM auto-start persisting lastModel, etc.) are shown; custom
    // modules snapshot config at mount.
    this._refreshFromConfig();
    this._dropdown.open();
    // Focus after the dropdown's open transition has started.
    setTimeout(() => { if (this._searchInput) this._searchInput.focus(); }, 50);
  }

  hide() {
    if (!this._dropdown) return;
    this._dropdown.close();
  }

  toggle() {
    if (!this._dropdown) return;
    if (this._dropdown.isOpen()) this.hide();
    else this.show();
  }

  /**
   * Open settings on a page. Accepts a page id or a legacy section id (see
   * ALIASES in pages.js); aliases that name a card scroll it into view.
   */
  showTab(id) {
    this.show();
    if (!id) return;
    const target = resolvePage(id);
    if (!target) {
      console.warn(`[settings] showTab: unknown page "${id}"; staying on "${this._activePage}"`);
      return;
    }
    this._showPage(target.page);
    if (target.card) setTimeout(() => this._revealCard(target.page, target.card), 60);
  }

  setRestartNeeded(needed, reason) {
    if (!this._restartHintEl) return;
    this._restartHintEl.hidden = !needed;
    if (needed && reason) this._restartHintEl.querySelector('.settings-v2-restart-hint-text').textContent = reason;
  }

  // -- Build -------------------------------------------------------------

  _build() {
    this._dropdown = new Dropdown({
      id: 'settings-v2',
      size: 'xxl',
      ariaLabel: 'Settings',
      persistent: true,
      // While the search box holds a query, Esc clears the search instead of
      // closing Settings — abstain here so the event reaches _onSearchKey.
      shouldCloseOnEsc: (e) => !(e && e.target === this._searchInput && this._searchQuery),
      onClose: () => {
        this._isVisible = false;
        document.body.classList.remove('settings-open');
      },
    });
    this._dropdown.el.classList.add('settings-v2-shell');
    const root = el('div', { class: 'settings-v2' });
    this._headerEl = this._buildHeader();
    this._navEl = el('nav', { class: 'settings-v2-nav', 'aria-label': 'Settings pages' });
    this._navEl.addEventListener('keydown', (e) => this._onNavKey(e));
    this._contentEl = el('div', { class: 'settings-v2-content', tabindex: '0' });
    root.append(this._headerEl, this._navEl, this._contentEl);
    this._dropdown.mount(root);
    this._renderPages();
  }

  _refreshFromConfig() {
    if (!this._contentEl) return;
    configBridge.refresh();
    if (this._searchInput) this._searchInput.value = '';
    this._searchQuery = '';
    if (this._searchClearEl) this._searchClearEl.hidden = true;
    if (this._matchCountEl) this._matchCountEl.textContent = '';
    this._renderPages();
  }

  _buildHeader() {
    const header = el('div', { class: 'settings-v2-header' });
    const search = el('div', { class: 'settings-v2-search' });
    const searchIcon = el('span', { class: 'settings-v2-search-icon' }, [makeIcon('search')]);
    const input = /** @type {HTMLInputElement} */ (el('input', {
      type: 'search',
      placeholder: 'Search all settings — try "dark mode", "zoom", "api key"…',
      'data-autofocus': '',
      'aria-label': 'Search settings',
      autocomplete: 'off',
      spellcheck: 'false',
    }));
    const clear = el('button', { type: 'button', class: 'settings-v2-search-clear', 'aria-label': 'Clear search', hidden: true }, ['Clear']);
    const matchCount = el('span', { class: 'settings-v2-match-count', 'aria-live': 'polite' });
    search.append(searchIcon, input, clear, matchCount);

    input.addEventListener('input', () => this._onSearchInput(input.value));
    input.addEventListener('keydown', (e) => this._onSearchKey(e));
    clear.addEventListener('click', () => { this._clearSearch(); input.focus(); });

    const expandAll = el('button', {
      type: 'button',
      class: 'sv-button sv-button--ghost',
      'aria-label': 'Expand all advanced sections',
      onclick: () => this._setAllAdvanced(true),
    }, ['Expand all']);
    const collapseAll = el('button', {
      type: 'button',
      class: 'sv-button sv-button--ghost',
      'aria-label': 'Collapse all advanced sections',
      onclick: () => this._setAllAdvanced(false),
    }, ['Collapse all']);
    const toolbarActions = el('div', { class: 'settings-v2-toolbar-actions' }, [expandAll, collapseAll]);

    const restartHint = el('div', { class: 'settings-v2-restart-hint', hidden: true, role: 'status' });
    restartHint.append(
      el('span', { class: 'settings-v2-restart-hint-text' }, ['Restart required for some changes']),
      el('button', { type: 'button', class: 'sv-button sv-button--primary', onclick: () => ipcRenderer.send('restart-app') }, ['Restart now'])
    );

    const close = el('button', {
      type: 'button',
      class: 'app-dropdown-close',
      'aria-label': 'Close',
      onclick: () => this.hide(),
    }, [makeIcon('close')]);

    header.append(search, toolbarActions, restartHint, close);
    this._searchInput = input;
    this._matchCountEl = matchCount;
    this._restartHintEl = restartHint;
    this._searchClearEl = clear;
    return header;
  }

  // -- Pages / cards / rows ----------------------------------------------

  _renderPages() {
    // Custom modules register listeners on globals (ipcRenderer,
    // speechSynthesis) that removing their DOM does not detach.
    this._teardownModules();
    this._pages.clear();
    this._cards.clear();
    this._rows.clear();
    this._groupHeaders.clear();
    this._navEl.replaceChildren();
    this._contentEl.replaceChildren();

    const cfg = configBridge.snapshot() || {};
    let lastGroup = null;
    for (const page of REGISTRY) {
      const gid = page.group || 'general';
      if (gid !== lastGroup) {
        const group = GROUPS.find((g) => g.id === gid);
        if (group) {
          const header = el('div', { class: 'settings-v2-nav-group', 'data-group-id': gid, role: 'heading', 'aria-level': '3' }, [group.label]);
          this._navEl.appendChild(header);
          this._groupHeaders.set(gid, header);
        }
        lastGroup = gid;
      }
      const navEl = this._buildNavItem(page);
      navEl.dataset.groupId = gid;
      this._navEl.appendChild(navEl);

      const pageEl = el('section', {
        class: 'settings-v2-section settings-v2-page',
        id: `sv-section-${page.id}`,
        'data-section-id': page.id,
        'aria-labelledby': `sv-page-title-${page.id}`,
      });
      pageEl.addEventListener('animationend', () => pageEl.classList.remove('is-entering'));
      const openBtn = el('button', {
        type: 'button',
        class: 'sv-button sv-button--ghost settings-v2-page-open',
        hidden: true,
        onclick: () => { this._clearSearch(); this._showPage(page.id); },
      }, ['Open page']);
      const headerEl = el('header', { class: 'settings-v2-section-header' }, [
        el('div', { class: 'settings-v2-section-heading' }, [
          el('h2', { class: 'settings-v2-section-title', id: `sv-page-title-${page.id}` }, [page.title]),
          page.description ? el('p', { class: 'settings-v2-section-description' }, [page.description]) : null,
        ]),
        openBtn,
      ]);
      const grid = el('div', { class: 'settings-v2-cards' });
      for (const card of page.cards) grid.appendChild(this._buildCard(page, card, cfg));
      pageEl.append(headerEl, grid);
      this._contentEl.appendChild(pageEl);
      this._pages.set(page.id, { pageEl, navEl, def: page });
    }
    if (!this._pages.has(this._activePage) && REGISTRY.length) this._activePage = REGISTRY[0].id;
    this._applySearch();
  }

  _buildNavItem(page) {
    const navIcon = makeIcon(page.icon || 'settings');
    navIcon.classList.add('settings-v2-nav-item-icon');
    const item = el('button', { type: 'button', class: 'settings-v2-nav-item', 'data-section-id': page.id });
    const label = el('span', { class: 'settings-v2-nav-item-label' }, [page.title]);
    const badge = el('span', { class: 'settings-v2-nav-item-badge', hidden: true });
    item.append(navIcon, label, badge);
    item.addEventListener('click', () => {
      if (this._searchQuery) this._clearSearch();
      this._showPage(page.id);
    });
    return item;
  }

  _buildCard(page, card, cfg) {
    const key = `${page.id}/${card.id}`;
    const wideClass = card.wide ? ' is-wide' : '';
    let cardEl;
    let body;
    let advancedBody = null;
    if (card.bare) {
      cardEl = el('div', { class: 'settings-v2-card-group is-bare' + wideClass, 'data-card-id': card.id });
      body = cardEl;
    } else if (card.collapsible) {
      const section = createAdvancedSection({ id: `${page.id}.${card.id}`, title: card.title, defaultOpen: !!card.defaultOpen });
      cardEl = section.root;
      cardEl.classList.add('settings-v2-card', 'is-collapsible');
      if (card.wide) cardEl.classList.add('is-wide');
      cardEl.dataset.cardId = card.id;
      body = section.body;
      body.classList.add('settings-v2-card-body');
    } else {
      cardEl = el('article', { class: 'settings-v2-card' + wideClass, 'data-card-id': card.id, 'aria-label': card.title });
      cardEl.appendChild(el('header', { class: 'settings-v2-card-header' }, [
        el('h3', { class: 'settings-v2-card-title settings-v2-category' }, [card.title]),
        card.description ? el('p', { class: 'settings-v2-card-description' }, [card.description]) : null,
      ]));
      body = el('div', { class: 'settings-v2-card-body' });
      cardEl.appendChild(body);
      if (card.settings.some((s) => s.advanced)) {
        const adv = createAdvancedSection({ id: `${page.id}.${card.id}.advanced`, title: 'Advanced', defaultOpen: false });
        adv.body.classList.add('settings-v2-card-body');
        advancedBody = adv.body;
        cardEl.appendChild(adv.root);
      }
    }
    for (const setting of card.settings) {
      const host = setting.advanced && advancedBody ? advancedBody : body;
      host.appendChild(this._buildRow(page, setting, cfg, key, !!card.bare));
    }
    this._cards.set(key, { el: cardEl, pageId: page.id });
    return cardEl;
  }

  _buildRow(page, setting, cfg, cardKey, bare) {
    const classes = ['settings-v2-row'];
    if (bare) classes.push('is-bare');
    else if (WIDE_TYPES.has(setting.type)) classes.push('is-wide');
    if (setting.type === 'toggle') classes.push('is-toggle');
    const rowEl = el('div', { class: classes.join(' '), 'data-setting-id': setting.id });
    const errorEl = el('p', { class: 'settings-v2-row-error', role: 'alert', hidden: true });
    const gotoBtn = el('button', {
      type: 'button',
      class: 'settings-v2-row-goto',
      hidden: true,
      'aria-label': `Go to ${setting.title || setting.id} in ${page.title}`,
      onclick: () => this._goToSetting(setting.id),
    }, [el('span', {}, [page.title]), makeIcon('chevronRight')]);

    let controlNode;
    try {
      resolveDynamicOptions(setting, cfg);
      const value = setting.path ? configBridge.get(setting.path, undefined) : undefined;
      const ctx = { config: cfg, configBridge };
      controlNode = setting.type === 'custom' && setting.renderModule
        ? this._renderCustomModule(setting, value, ctx)
        : renderControl(setting, value, (next) => this._onChange(setting, next), ctx);
    } catch (err) {
      console.error(`[settings] rendering ${setting.id} failed:`, err);
      controlNode = el('div', { class: 'sv-error', role: 'alert' }, [`Couldn't show this setting: ${errorText(err)}`]);
    }
    rowEl.dataset.search = setting._search || '';

    if (bare) {
      rowEl.append(errorEl, gotoBtn, controlNode);
    } else {
      const info = el('div', { class: 'settings-v2-row-info' }, [
        el('h4', { class: 'settings-v2-row-title' }, [setting.title || setting.id]),
        setting.description ? el('p', { class: 'settings-v2-row-description', title: setting.description }, [setting.description]) : null,
        errorEl,
        gotoBtn,
      ]);
      rowEl.append(info, el('div', { class: 'settings-v2-row-control' }, [controlNode]));
    }

    const entry = { setting, rowEl, pageId: page.id, cardKey, visibleIfOk: true };
    this._rows.set(setting.id, entry);
    this._evaluateVisibleIf(entry, cfg);
    return rowEl;
  }

  _renderCustomModule(setting, value, ctx) {
    const fn = customModules[setting.renderModule];
    if (typeof fn !== 'function') {
      return el('div', { class: 'sv-error', role: 'alert' }, [`Missing settings module "${setting.renderModule}"`]);
    }
    const host = el('div', { class: 'sv-custom-module', 'data-module': setting.renderModule });
    try {
      const teardown = fn({ host, setting, value, ctx, configBridge, onChange: (next) => this._onChange(setting, next) });
      if (typeof teardown === 'function') this._moduleTeardowns.push(teardown);
    } catch (err) {
      console.error('[settings] custom module failed:', setting.renderModule, err);
      host.replaceChildren(el('div', { class: 'sv-error', role: 'alert' }, [`Failed to render this section: ${errorText(err)}`]));
    }
    return host;
  }

  _teardownModules() {
    const fns = this._moduleTeardowns;
    this._moduleTeardowns = [];
    for (const fn of fns) {
      try {
        fn();
      } catch (err) {
        // Every teardown must still run and the rebuild must not abort, so the
        // failure is re-raised on its own task where the global error handler
        // reports it.
        setTimeout(() => { throw err; }, 0);
      }
    }
  }

  // -- Visibility --------------------------------------------------------

  _evaluateVisibleIf(entry, cfg) {
    const { setting } = entry;
    if (typeof setting.visibleIf !== 'function') return;
    try {
      entry.visibleIfOk = !!setting.visibleIf(cfg);
    } catch (err) {
      // Keep the row reachable: hiding a configured setting because its
      // predicate broke is worse than showing it with the error.
      entry.visibleIfOk = true;
      console.error(`[settings] visibleIf for ${setting.id} failed:`, err);
      this._showRowError(setting.id, `Visibility rule failed: ${errorText(err)}`);
    }
  }

  _reevaluateVisibility() {
    const cfg = configBridge.snapshot() || {};
    for (const entry of this._rows.values()) this._evaluateVisibleIf(entry, cfg);
    this._applySearch();
  }

  // -- Navigation --------------------------------------------------------

  _showPage(pageId) {
    const target = this._pages.get(pageId);
    if (!target) return;
    const changed = this._activePage !== pageId;
    this._activePage = pageId;
    for (const [id, page] of this._pages) {
      const active = id === pageId;
      page.navEl.classList.toggle('is-active', active);
      if (active) page.navEl.setAttribute('aria-current', 'page');
      else page.navEl.removeAttribute('aria-current');
      if (!this._searchQuery) page.pageEl.hidden = !active;
    }
    if (changed && !this._searchQuery) {
      target.pageEl.classList.remove('is-entering');
      void target.pageEl.offsetWidth;
      target.pageEl.classList.add('is-entering');
      this._contentEl.scrollTop = 0;
    }
  }

  _revealCard(pageId, cardId) {
    const card = this._cards.get(`${pageId}/${cardId}`);
    if (!card) return;
    if (card.el.tagName === 'DETAILS') /** @type {HTMLDetailsElement} */ (card.el).open = true;
    card.el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    this._flash(card.el);
  }

  _goToSetting(settingId) {
    const entry = this._rows.get(settingId);
    if (!entry) return;
    this._clearSearch();
    this._showPage(entry.pageId);
    openAncestors(entry.rowEl, this._contentEl);
    entry.rowEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    this._flash(entry.rowEl);
    const focusable = /** @type {HTMLElement | null} */ (entry.rowEl.querySelector(
      '.settings-v2-row-control input:not([type="hidden"]), .settings-v2-row-control button, .settings-v2-row-control textarea, .sv-custom-module input, .sv-custom-module button'
    ));
    if (focusable) focusable.focus();
  }

  _flash(node) {
    node.classList.remove('is-flash');
    void node.offsetWidth;
    node.classList.add('is-flash');
  }

  _onNavKey(e) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = /** @type {HTMLElement[]} */ (Array.from(this._navEl.querySelectorAll('.settings-v2-nav-item:not([hidden])')));
    if (!items.length) return;
    const idx = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    let next;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else next = (idx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    e.preventDefault();
    items[next].focus();
  }

  _setAllAdvanced(open) {
    for (const node of this._contentEl.querySelectorAll('details.sv-advanced')) {
      const details = /** @type {HTMLDetailsElement} */ (node);
      // During a search, update the remembered state that clearing restores.
      if (details.dataset.preSearchOpen != null) details.dataset.preSearchOpen = open ? '1' : '0';
      details.open = !!open;
      if (details.dataset.advancedId) setCollapsedState(details.dataset.advancedId, !!open);
    }
  }

  // -- Change handling ---------------------------------------------------

  _onChange(setting, newValue) {
    this._clearRowError(setting.id);
    let pending;
    try {
      if (setting.type !== 'button' && setting.path) configBridge.set(setting.path, newValue);
      pending = runSideEffect(setting.sideEffect, newValue, { hideSettings: () => this.hide() });
    } catch (err) {
      console.error(`[settings] applying ${setting.id} failed:`, err);
      this._showRowError(setting.id, `Couldn't apply this change: ${errorText(err)}`);
      return;
    }
    if (pending && typeof pending.then === 'function') {
      pending.then(undefined, (err) => {
        console.error(`[settings] ${setting.sideEffect} for ${setting.id} failed:`, err);
        this._showRowError(setting.id, `Couldn't apply this change: ${errorText(err)}`);
      });
    }
    if (setting.requiresRestart) this.setRestartNeeded(true);
    if (setting.type !== 'button') this._reevaluateVisibility();
  }

  _showRowError(settingId, message) {
    const entry = this._rows.get(settingId);
    if (!entry) return;
    const errorEl = /** @type {HTMLElement | null} */ (entry.rowEl.querySelector('.settings-v2-row-error'));
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = false;
    entry.rowEl.classList.add('has-error');
  }

  _clearRowError(settingId) {
    const entry = this._rows.get(settingId);
    if (!entry) return;
    const errorEl = /** @type {HTMLElement | null} */ (entry.rowEl.querySelector('.settings-v2-row-error'));
    if (errorEl) { errorEl.hidden = true; errorEl.textContent = ''; }
    entry.rowEl.classList.remove('has-error');
  }

  // -- Search ------------------------------------------------------------

  _onSearchInput(query) {
    this._searchQuery = query || '';
    this._searchClearEl.hidden = !this._searchQuery;
    if (this._searchDebounce) clearTimeout(this._searchDebounce);
    this._searchDebounce = setTimeout(() => { this._searchDebounce = null; this._applySearch(); }, SEARCH_DEBOUNCE_MS);
  }

  _clearSearch() {
    if (this._searchDebounce) { clearTimeout(this._searchDebounce); this._searchDebounce = null; }
    if (this._searchInput) this._searchInput.value = '';
    this._searchQuery = '';
    if (this._searchClearEl) this._searchClearEl.hidden = true;
    this._applySearch();
  }

  _onSearchKey(e) {
    if (e.key === 'Escape') {
      if (this._searchQuery) {
        e.preventDefault();
        e.stopPropagation();
        this._clearSearch();
      }
      // Otherwise the Dropdown handles Esc → close.
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this._jumpToTopMatch();
    }
  }

  /**
   * Single visibility pass for both modes. Without a query: only the active
   * page shows and rows follow visibleIf. With a query: every page with a
   * visible match shows, grouped under its page header.
   */
  _applySearch() {
    const tokens = tokenize(this._searchQuery);
    const searching = tokens.length > 0;
    this._contentEl.classList.toggle('is-searching', searching);

    const pageCounts = new Map();
    const cardVisible = new Map();
    let total = 0;
    for (const entry of this._rows.values()) {
      const { setting, rowEl } = entry;
      const selfMatch = !searching || matches(setting._search || '', tokens);
      let knobMatch = false;
      if (searching && !selfMatch) knobMatch = this._filterModuleKnobs(rowEl, tokens);
      else this._resetModuleKnobs(rowEl);
      const visible = entry.visibleIfOk && (selfMatch || knobMatch);
      rowEl.hidden = !visible;
      const goto = /** @type {HTMLElement | null} */ (rowEl.querySelector('.settings-v2-row-goto'));
      if (goto) goto.hidden = !(searching && visible);
      if (visible) {
        cardVisible.set(entry.cardKey, true);
        if (searching) {
          total += 1;
          pageCounts.set(entry.pageId, (pageCounts.get(entry.pageId) || 0) + 1);
          this._applyHighlight(rowEl, tokens);
        }
      }
      if (!searching || !visible) this._clearHighlight(rowEl);
    }

    for (const [key, card] of this._cards) card.el.hidden = !cardVisible.get(key);

    const groupHasMatch = new Set();
    for (const [id, page] of this._pages) {
      const count = pageCounts.get(id) || 0;
      page.pageEl.hidden = searching ? count === 0 : id !== this._activePage;
      const openBtn = /** @type {HTMLElement | null} */ (page.pageEl.querySelector('.settings-v2-page-open'));
      if (openBtn) openBtn.hidden = !searching;
      const badge = /** @type {HTMLElement | null} */ (page.navEl.querySelector('.settings-v2-nav-item-badge'));
      if (badge) {
        badge.hidden = !(searching && count > 0);
        badge.textContent = searching && count > 0 ? String(count) : '';
      }
      page.navEl.classList.toggle('is-dimmed', searching && count === 0);
      page.navEl.classList.toggle('is-active', id === this._activePage);
      if (id === this._activePage) page.navEl.setAttribute('aria-current', 'page');
      else page.navEl.removeAttribute('aria-current');
      if (count > 0) groupHasMatch.add(page.navEl.dataset.groupId);
    }
    for (const [gid, headerEl] of this._groupHeaders) headerEl.classList.toggle('is-dimmed', searching && !groupHasMatch.has(gid));

    this._syncDisclosures(searching, tokens);

    this._matchCountEl.textContent = searching ? (total === 1 ? '1 match' : `${total} matches`) : '';
    this._renderEmptyState(searching && total === 0);
  }

  /**
   * Filter a custom module's own `[data-search]` controls. Returns whether
   * any visible one matched. Non-matching controls (and module cards left
   * with no match) get `.is-search-miss`.
   */
  _filterModuleKnobs(rowEl, tokens) {
    let any = false;
    for (const node of rowEl.querySelectorAll('.sv-custom-module [data-search]')) {
      const knob = /** @type {HTMLElement} */ (node);
      const hit = matches(knob.dataset.search || '', tokens);
      knob.classList.toggle('is-search-miss', !hit);
      if (hit && !hiddenWithin(knob, rowEl)) any = true;
    }
    for (const node of rowEl.querySelectorAll('.sv-custom-module .settings-v2-card')) {
      const card = /** @type {HTMLElement} */ (node);
      const knobs = card.querySelectorAll('[data-search]');
      if (!knobs.length) continue;
      const hasHit = Array.from(knobs).some((k) => !k.classList.contains('is-search-miss'));
      card.classList.toggle('is-search-miss', !hasHit);
    }
    return any;
  }

  _resetModuleKnobs(rowEl) {
    for (const node of rowEl.querySelectorAll('.sv-custom-module .is-search-miss')) node.classList.remove('is-search-miss');
  }

  /**
   * During a search a disclosure opens only when it holds a control whose OWN
   * search text matches — a module row that matched as a whole does not pop
   * open every disclosure inside it. The pre-search state is restored after.
   */
  _syncDisclosures(searching, tokens) {
    for (const node of this._contentEl.querySelectorAll('details.sv-advanced')) {
      const details = /** @type {HTMLDetailsElement} */ (node);
      if (searching) {
        if (details.dataset.preSearchOpen == null) details.dataset.preSearchOpen = details.open ? '1' : '0';
        details.open = Array.from(details.querySelectorAll('[data-search]')).some((n) => {
          const target = /** @type {HTMLElement} */ (n);
          return matches(target.dataset.search || '', tokens) && !hiddenWithin(target, details) && !target.classList.contains('is-search-miss');
        });
      } else if (details.dataset.preSearchOpen != null) {
        details.open = details.dataset.preSearchOpen === '1';
        delete details.dataset.preSearchOpen;
      }
    }
  }

  _renderEmptyState(show) {
    let empty = /** @type {HTMLElement | null} */ (this._contentEl.querySelector('.settings-v2-empty'));
    if (!show) {
      if (empty) empty.hidden = true;
      return;
    }
    if (!empty) {
      empty = el('div', { class: 'settings-v2-empty', role: 'status' }, [
        el('p', { class: 'settings-v2-empty-text' }),
        el('button', { class: 'sv-button', type: 'button', onclick: () => ipcRenderer.send('open-config-file') }, ['Open config file']),
      ]);
      this._contentEl.appendChild(empty);
    }
    empty.querySelector('.settings-v2-empty-text').textContent = `No settings match "${this._searchQuery.trim()}".`;
    empty.hidden = false;
  }

  _applyHighlight(rowEl, tokens) {
    for (const node of rowEl.querySelectorAll('.settings-v2-row-title, .settings-v2-row-description')) {
      const textEl = /** @type {HTMLElement} */ (node);
      if (textEl.dataset.original == null) textEl.dataset.original = textEl.textContent;
      textEl.innerHTML = highlight(textEl.dataset.original, tokens);
    }
  }

  _clearHighlight(rowEl) {
    for (const node of rowEl.querySelectorAll('.settings-v2-row-title, .settings-v2-row-description')) {
      const textEl = /** @type {HTMLElement} */ (node);
      if (textEl.dataset.original != null) {
        textEl.textContent = textEl.dataset.original;
        delete textEl.dataset.original;
      }
    }
  }

  _jumpToTopMatch() {
    const result = filter(REGISTRY, this._searchQuery);
    const visibleTop = result.top && this._rows.get(result.top.setting.id);
    if (visibleTop && visibleTop.visibleIfOk) {
      this._goToSetting(result.top.setting.id);
      return;
    }
    // The best-scoring row is hidden by its visibleIf; take the first visible match.
    for (const entry of this._rows.values()) {
      if (!entry.rowEl.hidden) { this._goToSetting(entry.setting.id); return; }
    }
  }
}

module.exports = new SettingsView();

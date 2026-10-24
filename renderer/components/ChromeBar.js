// ChromeBar.js — Sidebar shell that hosts the logo/settings button, the
// reparented TabBar, and the LLM status pill. In topBar layout the shell is
// hidden entirely; the TabBar (with its right-edge action buttons) lives
// directly under the OS chrome and is the only global header.
//
// History: this controller used to also render a global URL bar and a
// duplicate back/forward/refresh/home strip (both in toolbar and sidebar
// modes). Per-tab TabChromeStrips now own URL + nav above each webview, so
// both surfaces were retired here.

let ipcRenderer;
try {
  ({ ipcRenderer } = require('electron'));
} catch (_) {
  ipcRenderer = { invoke: () => Promise.resolve(null), on: () => {}, send: () => {} };
}

const { icon } = require('./Icon');

const SIDEBAR_COLLAPSE_DELAY = 100;
const VALID_LAYOUTS = ['top', 'bottom', 'left', 'right'];
const HORIZONTAL_BAR_THICKNESS_PX = 30;
const VERTICAL_COLLAPSED_PX = 48;
const VERTICAL_EXPANDED_FALLBACK_PX = 220;

function normalizeLayout(mode) {
  if (mode === 'sidebar') return 'left';
  if (mode === 'topBar') return 'top';
  if (VALID_LAYOUTS.includes(mode)) return mode;
  return 'left';
}

class ChromeBar {
  constructor() {
    this._state = null;
    this._tabBar = null;
    this._panels = null;
    this._sidebar = null;
    this._sidebarExpanded = false;
    this._collapseTimer = null;
    this._applied = null;
    this._tabBarOriginalParent = null;
  }

  initialize({ state, tabBar, panels }) {
    this._state = state;
    this._tabBar = tabBar;
    this._panels = panels || {};

    this._buildSidebar();
    this._wireButtons();
    this._wireLlmStatus();

    const mode = (state && state.get('chromeLayout')) || 'left';
    this._apply(mode);

    if (state) {
      state.on('change:chromeLayout', (value) => this._apply(value));
    }
  }

  // ---------------------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------------------

  _buildSidebar() {
    if (!document || !document.body) return;

    const sidebar = document.createElement('div');
    sidebar.id = 'chrome-sidebar';
    sidebar.className = 'chrome-sidebar';
    sidebar.style.display = 'none';

    // Header — logo doubles as settings menu trigger.
    const header = document.createElement('div');
    header.className = 'chrome-sidebar-header';
    const logoBtn = document.createElement('button');
    logoBtn.id = 'chrome-sidebar-toggle';
    logoBtn.className = 'chrome-btn';
    logoBtn.title = 'Settings';
    logoBtn.style.cssText = '-webkit-app-region: no-drag;';
    const logo = document.createElement('img');
    logo.src = './assets/icon.png';
    logo.className = 'chrome-sidebar-logo';
    logoBtn.appendChild(logo);
    header.appendChild(logoBtn);
    sidebar.appendChild(header);

    // Tab area (TabBar reparents here in sidebar mode). Action buttons live
    // inside TabBar (right edge), so they automatically appear at the bottom
    // of this area when the bar runs vertically.
    const tabArea = document.createElement('div');
    tabArea.className = 'chrome-sidebar-tabs';
    sidebar.appendChild(tabArea);

    const spacer = document.createElement('div');
    spacer.className = 'chrome-sidebar-spacer';
    sidebar.appendChild(spacer);

    const footer = document.createElement('div');
    footer.className = 'chrome-sidebar-footer';
    const pill = document.createElement('div');
    pill.className = 'chrome-llm-pill stopped';
    pill.id = 'chrome-llm-pill';
    pill.title = 'Local LLM: stopped';
    pill.appendChild(icon('dot'));
    footer.appendChild(pill);
    sidebar.appendChild(footer);

    sidebar.addEventListener('mouseenter', () => {
      clearTimeout(this._collapseTimer);
      this._expandSidebar();
    });
    sidebar.addEventListener('mouseleave', () => {
      clearTimeout(this._collapseTimer);
      this._collapseTimer = setTimeout(() => {
        this._collapseSidebar();
      }, SIDEBAR_COLLAPSE_DELAY);
    });

    document.body.insertBefore(sidebar, document.body.firstChild);
    this._sidebar = sidebar;
  }

  // ---------------------------------------------------------------------------
  // Mode switching
  // ---------------------------------------------------------------------------

  _apply(mode) {
    const next = normalizeLayout(mode);
    if (document && document.body) {
      document.body.dataset.chromeLayout = next;
    }
    if (this._applied === next) {
      this._updateChromeVars(next);
      return;
    }

    this._snapshotOriginalPositions();

    const isHorizontal = next === 'top' || next === 'bottom';
    if (isHorizontal) {
      this._applyHorizontal();
    } else {
      this._applyVertical();
    }
    this._updateChromeVars(next);
    this._updateAriaOrientation(next);
    this._applied = next;
  }

  _snapshotOriginalPositions() {
    if (this._tabBarOriginalParent === null && this._tabBar && this._tabBar.bar) {
      this._tabBarOriginalParent = this._tabBar.bar.parentNode;
    }
  }

  _applyHorizontal() {
    if (this._sidebar) this._sidebar.style.display = 'none';

    if (this._tabBar && this._tabBar.bar) {
      this._placeHorizontalBar();
      this._tabBar.bar.classList.add('tab-bar--horizontal');
      this._tabBar.bar.classList.remove('tab-bar--vertical');
    }

    this._collapseSidebar();
  }

  _applyVertical() {
    if (this._sidebar) this._sidebar.style.display = 'flex';

    if (this._tabBar && this._tabBar.bar) {
      const tabArea = this._sidebar.querySelector('.chrome-sidebar-tabs');
      if (tabArea) {
        tabArea.appendChild(this._tabBar.bar);
      }
      this._tabBar.bar.classList.add('tab-bar--vertical');
      this._tabBar.bar.classList.remove('tab-bar--horizontal');
    }
  }

  _updateChromeVars(mode) {
    if (!document || !document.documentElement) return;
    const root = document.documentElement;
    const isHorizontal = mode === 'top' || mode === 'bottom';
    const isVertical = mode === 'left' || mode === 'right';

    root.style.setProperty('--chrome-bar-thickness', isHorizontal ? `${HORIZONTAL_BAR_THICKNESS_PX}px` : '0px');

    let verticalWidth = 0;
    if (isVertical) {
      if (this._sidebarExpanded) {
        const userExpanded = parseInt(getComputedStyle(root).getPropertyValue('--sidebar-expanded-width'), 10);
        verticalWidth = Number.isFinite(userExpanded) && userExpanded > 0 ? userExpanded : VERTICAL_EXPANDED_FALLBACK_PX;
      } else {
        verticalWidth = VERTICAL_COLLAPSED_PX;
      }
    }
    root.style.setProperty('--chrome-sidebar-current-width', `${verticalWidth}px`);
  }

  _updateAriaOrientation(mode) {
    if (!this._tabBar || !this._tabBar.bar) return;
    const isHorizontal = mode === 'top' || mode === 'bottom';
    this._tabBar.bar.setAttribute('aria-orientation', isHorizontal ? 'horizontal' : 'vertical');
  }

  // A horizontal bar is a window-wide strip just before its home (#tab-bar-wrap),
  // never inside it: assistant mode turns the wrap into a collapsible, inert
  // dock, and the bar's buttons must stay reachable and full-width above it.
  _placeHorizontalBar() {
    if (!this._tabBar || !this._tabBar.bar) return;
    const home = this._tabBarOriginalParent;
    if (home && home.parentNode) home.parentNode.insertBefore(this._tabBar.bar, home);
  }

  // ---------------------------------------------------------------------------
  // Sidebar expand/collapse
  // ---------------------------------------------------------------------------

  _expandSidebar() {
    if (this._sidebarExpanded || !this._sidebar) return;
    this._sidebarExpanded = true;
    this._sidebar.classList.add('chrome-sidebar--expanded');
    if (this._applied) this._updateChromeVars(this._applied);
  }

  _collapseSidebar() {
    if (!this._sidebarExpanded || !this._sidebar) return;
    this._sidebarExpanded = false;
    this._sidebar.classList.remove('chrome-sidebar--expanded');
    if (this._applied) this._updateChromeVars(this._applied);
  }

  // ---------------------------------------------------------------------------
  // Button wiring
  // ---------------------------------------------------------------------------

  _wireButtons() {
    const el = document.getElementById('chrome-sidebar-toggle');
    if (el) {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        if (this._panels && this._panels.settingsMenu && this._panels.settingsMenu.toggle) {
          this._panels.settingsMenu.toggle();
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // LLM status pill
  // ---------------------------------------------------------------------------

  async _wireLlmStatus() {
    const pill = document.getElementById('chrome-llm-pill');
    if (!pill) return;

    try {
      const status = await ipcRenderer.invoke('llm:get-status');
      this._renderLlmStatus(pill, status);
    } catch (_) {
      // LLM service may not be available
    }

    if (ipcRenderer.on) {
      ipcRenderer.on('llm:status-changed', (_e, payload) => {
        if (payload && payload.info) {
          this._renderLlmStatus(pill, payload.info);
        }
      });
    }
  }

  _renderLlmStatus(pill, info) {
    if (!pill || !info) return;
    const status = info.status || 'stopped';
    pill.className = 'chrome-llm-pill ' + status;
    const ep = info.endpoint ? ' @ ' + info.endpoint : '';
    pill.title = 'Local LLM: ' + status + ep;
  }
}

module.exports = new ChromeBar();

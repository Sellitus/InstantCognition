// AssistantMenu — overflow popover that consolidates every secondary control
// from the AgentPanel header (projects, engine, quality, persona, conversation
// actions) plus a Settings link. The header keeps only title/status/cost and a
// single ⋯ trigger that toggles this menu.
//
// The menu is portalled to document.body so it escapes the dropdown shell's
// overflow:hidden. The trigger button stays in the header slot; the popover
// itself floats over the rest of the UI at the trigger's screen position.

const { icon } = require('../Icon');

class AssistantMenu {
  constructor(opts) {
    const { panel, host, onOpenSettings } = /** @type {any} */ (opts || {});
    this._panel = panel || null;
    this._host = host || null;
    this._onOpenSettings = typeof onOpenSettings === 'function' ? onOpenSettings : function () {};
    this._triggerEl = null;
    this._menuEl = null;
    this._slots = {};
    this._isOpen = false;
    this._docClickHandler = null;
    this._escHandler = null;
    this._repositionHandler = null;
  }

  mount() {
    if (!this._host) return;
    this._host.innerHTML = ''
      + '<button type="button" class="agent-panel-menu-btn agent-panel-icon-btn" aria-label="Assistant options" aria-haspopup="menu" aria-expanded="false" title="Model, persona and conversation options"></button>';
    this._triggerEl = /** @type {HTMLButtonElement} */ (this._host.querySelector('.agent-panel-menu-btn'));
    this._triggerEl.appendChild(icon('more', { size: 16 }));

    // Portal: build the popover in document.body so overflow:hidden on the
    // dropdown shell or any ancestor cannot clip it.
    const ownerDoc = (this._host.ownerDocument) || (typeof document !== 'undefined' ? document : null);
    if (!ownerDoc || !ownerDoc.body) return;
    this._menuEl = ownerDoc.createElement('div');
    this._menuEl.className = 'assistant-menu';
    this._menuEl.setAttribute('role', 'menu');
    this._menuEl.setAttribute('aria-label', 'Assistant menu');
    this._menuEl.hidden = true;
    this._menuEl.setAttribute('aria-hidden', 'true');
    this._menuEl.innerHTML = ''
      + '<section class="assistant-menu-section" data-section="project">'
      + '  <h3 class="assistant-menu-heading">Project</h3>'
      + '  <div class="assistant-menu-project-slot"></div>'
      + '</section>'
      + '<section class="assistant-menu-section" data-section="inference">'
      + '  <h3 class="assistant-menu-heading">Inference</h3>'
      + '  <div class="assistant-menu-row">'
      + '    <span class="assistant-menu-row-label">Engine</span>'
      + '    <span class="assistant-menu-engine-slot"></span>'
      + '  </div>'
      + '  <div class="assistant-menu-row">'
      + '    <span class="assistant-menu-row-label">Backend</span>'
      + '    <span class="assistant-menu-backend-slot"></span>'
      + '  </div>'
      + '  <div class="assistant-menu-row">'
      + '    <span class="assistant-menu-row-label">Model</span>'
      + '    <span class="assistant-menu-model-slot"></span>'
      + '  </div>'
      + '  <div class="assistant-menu-row">'
      + '    <span class="assistant-menu-row-label">Quality</span>'
      + '    <span class="assistant-menu-quality-slot"></span>'
      + '  </div>'
      + '  <div class="assistant-menu-row">'
      + '    <span class="assistant-menu-row-label">Persona</span>'
      + '    <span class="assistant-menu-persona-slot"></span>'
      + '  </div>'
      + '</section>'
      + '<section class="assistant-menu-section" data-section="conversation">'
      + '  <h3 class="assistant-menu-heading">Conversation</h3>'
      + '  <div class="assistant-menu-actions-slot"></div>'
      + '</section>'
      + '<div class="assistant-menu-divider" role="separator"></div>'
      + '<button type="button" class="assistant-menu-settings" role="menuitem">'
      + '  <span class="assistant-menu-settings-icon"></span>'
      + '  <span>Open Settings</span>'
      + '</button>';
    ownerDoc.body.appendChild(this._menuEl);

    this._slots = {
      project: this._menuEl.querySelector('.assistant-menu-project-slot'),
      engine: this._menuEl.querySelector('.assistant-menu-engine-slot'),
      backend: this._menuEl.querySelector('.assistant-menu-backend-slot'),
      model: this._menuEl.querySelector('.assistant-menu-model-slot'),
      quality: this._menuEl.querySelector('.assistant-menu-quality-slot'),
      persona: this._menuEl.querySelector('.assistant-menu-persona-slot'),
      actions: this._menuEl.querySelector('.assistant-menu-actions-slot'),
    };
    if (this._triggerEl) {
      this._triggerEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggle();
      });
    }
    const settingsBtn = /** @type {HTMLElement} */ (this._menuEl.querySelector('.assistant-menu-settings'));
    if (settingsBtn) {
      const iconHolder = /** @type {HTMLElement} */ (settingsBtn.querySelector('.assistant-menu-settings-icon'));
      if (iconHolder) iconHolder.appendChild(icon('settings', { size: 14 }));
      settingsBtn.addEventListener('click', () => {
        this.hide();
        this._onOpenSettings();
      });
    }
  }

  // Reparents an external element into the named slot. Listeners stay attached.
  adopt(slotName, element) {
    const slot = this._slots[slotName];
    if (!slot || !element) return;
    slot.innerHTML = '';
    slot.appendChild(element);
  }

  isOpen() { return this._isOpen; }

  toggle() { this._isOpen ? this.hide() : this.show(); }

  show() {
    if (!this._menuEl || this._isOpen) return;
    this._menuEl.hidden = false;
    this._menuEl.setAttribute('aria-hidden', 'false');
    if (this._triggerEl) this._triggerEl.setAttribute('aria-expanded', 'true');
    this._isOpen = true;
    this._position();
    this._installDismissHandlers();
  }

  hide() {
    if (!this._menuEl || !this._isOpen) return;
    this._menuEl.hidden = true;
    this._menuEl.setAttribute('aria-hidden', 'true');
    if (this._triggerEl) this._triggerEl.setAttribute('aria-expanded', 'false');
    this._isOpen = false;
    this._removeDismissHandlers();
  }

  // Position the portalled popover under the trigger's right edge using
  // fixed coords so it floats above every ancestor's overflow context.
  _position() {
    if (!this._menuEl || !this._triggerEl) return;
    const rect = this._triggerEl.getBoundingClientRect();
    const MENU_GAP = 6;
    const MIN_MARGIN = 8;
    this._menuEl.style.position = 'fixed';
    this._menuEl.style.top = `${Math.round(rect.bottom + MENU_GAP)}px`;
    // Anchor to trigger's right edge, but keep within the viewport.
    const menuWidth = this._menuEl.offsetWidth || 320;
    let right = Math.max(MIN_MARGIN, window.innerWidth - rect.right);
    const maxLeft = window.innerWidth - menuWidth - MIN_MARGIN;
    if (right > maxLeft) right = Math.max(MIN_MARGIN, maxLeft);
    this._menuEl.style.right = `${Math.round(right)}px`;
    this._menuEl.style.left = 'auto';
  }

  _installDismissHandlers() {
    this._removeDismissHandlers();
    this._docClickHandler = (e) => {
      const t = /** @type {Node} */ (e.target);
      if (this._menuEl && this._menuEl.contains(t)) return;
      if (this._triggerEl && this._triggerEl.contains(t)) return;
      this.hide();
    };
    // Esc closes only the menu: stopping propagation here keeps the panel's
    // own Esc handler from closing the whole Assistant on the same keypress.
    this._escHandler = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      this.hide();
      if (this._triggerEl && this._triggerEl.isConnected) this._triggerEl.focus();
    };
    // Reposition on viewport changes — but only if the trigger is still in DOM
    // (panel closed while menu open).
    this._repositionHandler = () => {
      if (this._isOpen) {
        if (this._triggerEl && this._triggerEl.isConnected) this._position();
        else this.hide();
      }
    };
    // Installed synchronously: the opening click is already past capture phase
    // (the trigger handler runs in target phase and calls stopPropagation), so
    // these listeners only catch subsequent events.
    document.addEventListener('click', this._docClickHandler, true);
    document.addEventListener('keydown', this._escHandler, true);
    window.addEventListener('resize', this._repositionHandler);
    window.addEventListener('scroll', this._repositionHandler, true);
  }

  _removeDismissHandlers() {
    if (this._docClickHandler) document.removeEventListener('click', this._docClickHandler, true);
    if (this._escHandler) document.removeEventListener('keydown', this._escHandler, true);
    if (this._repositionHandler) {
      window.removeEventListener('resize', this._repositionHandler);
      window.removeEventListener('scroll', this._repositionHandler, true);
    }
    this._docClickHandler = null;
    this._escHandler = null;
    this._repositionHandler = null;
  }

  destroy() {
    this._removeDismissHandlers();
    if (this._menuEl && this._menuEl.parentNode) this._menuEl.parentNode.removeChild(this._menuEl);
    this._menuEl = null;
    this._triggerEl = null;
    this._slots = {};
  }
}

module.exports = AssistantMenu;
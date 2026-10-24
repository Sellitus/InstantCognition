// AssistantMenu — unit tests.
//
// Verifies the ⋯ popover structure, toggle lifecycle (open/close on click,
// outside-click, Esc), slot adoption (reparenting preserves elements), and the
// Settings link routing. Runs under jsdom like the other agent-component tests.

const AssistantMenu = require('../../../../../renderer/components/agent/AssistantMenu');

describe('AssistantMenu', () => {
  let host;

  beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  function makeMenu(onOpenSettings) {
    const m = new AssistantMenu({ host, onOpenSettings });
    m.mount();
    return m;
  }

  describe('structure', () => {
    test('mount renders a ⋯ trigger and a hidden menu', () => {
      const m = makeMenu();
      const trigger = host.querySelector('.agent-panel-menu-btn');
      expect(trigger).not.toBeNull();
      expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
      expect(trigger.getAttribute('aria-expanded')).toBe('false');

      // The popover is portalled to document.body so it escapes the dropdown
      // shell's overflow:hidden. Trigger stays in the header slot.
      const menu = document.body.querySelector('.assistant-menu');
      expect(menu).not.toBeNull();
      expect(menu.hidden).toBe(true);
      expect(m.isOpen()).toBe(false);
    });

    test('menu has PROJECT, INFERENCE, CONVERSATION sections + Settings link', () => {
      makeMenu();
      // Sections live in the portalled menu, not in the host slot.
      const menu = document.body.querySelector('.assistant-menu');
      const sections = menu.querySelectorAll('.assistant-menu-section');
      expect(sections.length).toBe(3);
      expect(sections[0].dataset.section).toBe('project');
      expect(sections[1].dataset.section).toBe('inference');
      expect(sections[2].dataset.section).toBe('conversation');
      expect(menu.querySelector('.assistant-menu-settings')).not.toBeNull();
    });

    test('named slots exist for every adopted control', () => {
      makeMenu();
      const menu = document.body.querySelector('.assistant-menu');
      expect(menu.querySelector('.assistant-menu-project-slot')).not.toBeNull();
      expect(menu.querySelector('.assistant-menu-engine-slot')).not.toBeNull();
      expect(menu.querySelector('.assistant-menu-backend-slot')).not.toBeNull();
      expect(menu.querySelector('.assistant-menu-model-slot')).not.toBeNull();
      expect(menu.querySelector('.assistant-menu-quality-slot')).not.toBeNull();
      expect(menu.querySelector('.assistant-menu-persona-slot')).not.toBeNull();
      expect(menu.querySelector('.assistant-menu-actions-slot')).not.toBeNull();
    });
  });

  describe('toggle lifecycle', () => {
    test('clicking the trigger opens the menu', () => {
      const m = makeMenu();
      host.querySelector('.agent-panel-menu-btn').click();
      expect(m.isOpen()).toBe(true);
      // Menu lives in document.body (portalled), not in the host slot.
      const menu = document.body.querySelector('.assistant-menu');
      expect(menu.hidden).toBe(false);
      expect(host.querySelector('.agent-panel-menu-btn').getAttribute('aria-expanded')).toBe('true');
    });

    test('clicking the trigger again closes the menu', () => {
      const m = makeMenu();
      const trigger = host.querySelector('.agent-panel-menu-btn');
      trigger.click();
      expect(m.isOpen()).toBe(true);
      trigger.click();
      expect(m.isOpen()).toBe(false);
      expect(document.body.querySelector('.assistant-menu').hidden).toBe(true);
    });

    test('click outside the menu closes it', () => {
      const m = makeMenu();
      host.querySelector('.agent-panel-menu-btn').click();
      expect(m.isOpen()).toBe(true);
      // Simulate a click on the document body (outside menu + trigger).
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(m.isOpen()).toBe(false);
    });

    test('Esc closes the menu', () => {
      const m = makeMenu();
      host.querySelector('.agent-panel-menu-btn').click();
      expect(m.isOpen()).toBe(true);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(m.isOpen()).toBe(false);
    });

    test('clicks inside the menu do not close it', () => {
      const m = makeMenu();
      host.querySelector('.agent-panel-menu-btn').click();
      // Menu HTML lives in document.body; query from there.
      const inside = document.body.querySelector('.assistant-menu-heading');
      inside.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(m.isOpen()).toBe(true);
    });
  });

  describe('adopt (reparenting)', () => {
    test('adopt moves an external element into the named slot', () => {
      const m = makeMenu();
      const external = document.createElement('button');
      external.className = 'external-ctrl';
      external.textContent = 'Ctrl';
      m.adopt('engine', external);
      const slot = document.body.querySelector('.assistant-menu-engine-slot');
      expect(slot.contains(external)).toBe(true);
      expect(slot.querySelector('.external-ctrl')).not.toBeNull();
    });

    test('adopt is a no-op for a missing slot or element', () => {
      const m = makeMenu();
      const external = document.createElement('button');
      expect(() => m.adopt('nonexistent', external)).not.toThrow();
      expect(() => m.adopt('engine', null)).not.toThrow();
    });
  });

  describe('Settings link', () => {
    test('clicking Open Settings calls onOpenSettings and closes the menu', () => {
      let called = false;
      const m = makeMenu(() => { called = true; });
      host.querySelector('.agent-panel-menu-btn').click();
      expect(m.isOpen()).toBe(true);
      document.body.querySelector('.assistant-menu-settings').click();
      expect(called).toBe(true);
      expect(m.isOpen()).toBe(false);
    });

    test('missing onOpenSettings is tolerated', () => {
      const m = new AssistantMenu({ host });
      m.mount();
      host.querySelector('.agent-panel-menu-btn').click();
      expect(() => document.body.querySelector('.assistant-menu-settings').click()).not.toThrow();
    });
  });

  // The popover is portalled to document.body so it escapes any ancestor's
  // overflow context (the dropdown shell has overflow:hidden). The trigger
  // stays in the header slot; the popover HTML is appended to body on mount.
  // Regression: any future re-introduction of overflow:hidden on the main
  // container trips this test (defense in depth — portal alone is enough).
  describe('popover containment', () => {
    test('.agent-panel-main CSS does not clip the popover', () => {
      const fs = require('fs');
      const path = require('path');
      const css = fs.readFileSync(
        path.resolve(__dirname, '../../../../../renderer/styles/components/agent-panel.css'),
        'utf8',
      );
      // Block may have comments — strip them so the body reflects declarations only.
      const m = css.match(/\.agent-panel-main\s*\{([\s\S]*?)\}/);
      expect(m).not.toBeNull();
      const body = m[1].replace(/\/\*[\s\S]*?\*\//g, '');
      expect(body).not.toMatch(/\boverflow\s*:/);
    });

    test('assistant-menu is positioned fixed via inline styles when shown (so it can be portalled to body)', () => {
      // Positioning moved from the .assistant-menu CSS rule into AssistantMenu._position() — one owner of a single source of truth, no stylesheet/inline duplication left for them to drift apart. This asserts against behavior: after show(), whatever element ends up in document.body must carry position:fixed inline (the thing that makes portaling actually escape an ancestor's overflow context), not "a CSS file somewhere contains the word fixed".
      const m = makeMenu(); // mount() alone is hidden — _position() runs on show, so trigger it to prove where positioning comes from at runtime.
      m.show();
      expect(m.isOpen()).toBe(true);
      const menuEl = document.body.querySelector('.assistant-menu');
      expect(menuEl).not.toBeNull();
      expect(menuEl.style.position).toBe('fixed'); // the actual invariant that keeps this popover unclipped — a future refactor moving _position() back to CSS-only (or dropping it) without keeping position:fixed would fail here, same as before.

      const fs = require('fs');
      const path = require('path');
      const css = fs.readFileSync(
        path.resolve(__dirname, '../../../../../renderer/styles/components/agent-panel.css'),
        'utf8',
      );
      // z-index still belongs in CSS (it's not repositioning logic, just stacking) — keep pinning that the rule exists and carries a real fallback rather than silently defaulting to 0.
      const menu = css.match(/\.assistant-menu\s*\{([\s\S]*?)\}/);
      expect(menu).not.toBeNull();
      const body = menu[1].replace(/\/\*[\s\S]*?\*\//g, '');
      expect(body).toMatch(/\bz-index\s*:\s*var\(--z-popover,\s*(\d+)\)/); // capture the literal fallback so "fix" means matching tokens.css's value (currently 1200), not just "some number is there".
    });
  });

  describe('portal', () => {
    test('mount appends the popover directly to document.body (not to host)', () => {
      makeMenu();
      // Trigger stays in the host slot; the popover lives in document.body
      // so the dropdown shell's overflow:hidden cannot clip it.
      const triggerInHost = host.querySelector('.agent-panel-menu-btn');
      expect(triggerInHost).not.toBeNull();
      const menuInHost = host.querySelector('.assistant-menu');
      expect(menuInHost).toBeNull();
      const menuInBody = document.body.querySelector('.assistant-menu');
      expect(menuInBody).not.toBeNull();
      expect(menuInBody.parentNode).toBe(document.body);
    });

    test('destroy removes the portalled popover from document.body', () => {
      const m = makeMenu();
      expect(document.body.querySelector('.assistant-menu')).not.toBeNull();
      m.destroy();
      expect(document.body.querySelector('.assistant-menu')).toBeNull();
    });
  });
});
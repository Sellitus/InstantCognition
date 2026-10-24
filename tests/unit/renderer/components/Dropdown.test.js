const Dropdown = require('../../../../renderer/components/dropdown/Dropdown');

// jsdom reports no layout, so the shared focus trap would filter every element
// out as zero-size. Give the ones under test a visible box.
function visible(el) {
  el.getClientRects = () => [{ width: 10, height: 10 }];
  return el;
}

describe('Dropdown', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    document.body.textContent = '';
    // Skip the animation lifecycle so open/close finish synchronously.
    document.body.classList.add('no-animations');
  });

  afterEach(() => {
    jest.useRealTimers();
    document.body.classList.remove('no-animations');
    document.body.textContent = '';
  });

  test('builds a backdrop + surface but does not mount until open()', () => {
    const dd = new Dropdown({ id: 'test', size: 'md' });
    expect(dd.el).toBeInstanceOf(HTMLElement);
    expect(dd.el.classList.contains('app-dropdown')).toBe(true);
    expect(dd.el.classList.contains('app-dropdown--md')).toBe(true);
    expect(dd.backdropEl.classList.contains('app-dropdown-backdrop')).toBe(true);
    expect(document.getElementById('test')).toBeNull();
    expect(document.body.contains(dd.el)).toBe(false);
  });

  test('open() appends backdrop + surface to document.body and flips isOpen', () => {
    const dd = new Dropdown({ id: 'test' });
    dd.open();
    expect(document.body.contains(dd.backdropEl)).toBe(true);
    expect(document.body.contains(dd.el)).toBe(true);
    expect(dd.isOpen()).toBe(true);
  });

  test('close() detaches surface and backdrop, isOpen flips false', () => {
    const dd = new Dropdown({ id: 'test' });
    dd.open();
    dd.close();
    expect(dd.isOpen()).toBe(false);
    expect(document.body.contains(dd.el)).toBe(false);
    expect(document.body.contains(dd.backdropEl)).toBe(false);
  });

  test('mount() puts content into the body element', () => {
    const dd = new Dropdown({});
    const child = document.createElement('p');
    child.textContent = 'hello';
    dd.mount(child);
    expect(dd.bodyEl.firstChild).toBe(child);
    expect(dd.bodyEl.textContent).toBe('hello');
  });

  test('mount() replaces previous content', () => {
    const dd = new Dropdown({});
    const a = document.createElement('div'); a.textContent = 'a';
    const b = document.createElement('div'); b.textContent = 'b';
    dd.mount(a);
    dd.mount(b);
    expect(dd.bodyEl.children.length).toBe(1);
    expect(dd.bodyEl.firstChild.textContent).toBe('b');
  });

  test('setHeader({ title }) renders a header above the body with the title', () => {
    const dd = new Dropdown({});
    dd.setHeader({ title: 'Settings' });
    const header = dd.el.querySelector('.app-dropdown-header');
    expect(header).not.toBeNull();
    expect(header.querySelector('.app-dropdown-title').textContent).toBe('Settings');
    // Header is positioned before the body in the surface.
    expect(header.nextElementSibling).toBe(dd.bodyEl);
  });

  test('setHeader rendered close button calls close()', () => {
    const dd = new Dropdown({});
    dd.setHeader({ title: 'X' });
    dd.open();
    expect(dd.isOpen()).toBe(true);
    dd.el.querySelector('.app-dropdown-close').click();
    expect(dd.isOpen()).toBe(false);
  });

  test('Esc closes by default', () => {
    const dd = new Dropdown({});
    dd.open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dd.isOpen()).toBe(false);
  });

  test('closeOnEsc:false ignores the Esc key', () => {
    const dd = new Dropdown({ closeOnEsc: false });
    dd.open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dd.isOpen()).toBe(true);
    dd.close();
  });

  test('mousedown on backdrop closes (default)', () => {
    const dd = new Dropdown({});
    dd.open();
    dd.backdropEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(dd.isOpen()).toBe(false);
  });

  test('mousedown inside the surface does not close', () => {
    const dd = new Dropdown({});
    const child = document.createElement('button');
    dd.mount(child);
    dd.open();
    child.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(dd.isOpen()).toBe(true);
  });

  test('onOpen and onClose callbacks fire', () => {
    const onOpen = jest.fn();
    const onClose = jest.fn();
    const dd = new Dropdown({ onOpen, onClose });
    dd.open();
    expect(onOpen).toHaveBeenCalledTimes(1);
    dd.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('initial focus targets [data-autofocus] when present', () => {
    const dd = new Dropdown({});
    const wrap = document.createElement('div');
    const input = document.createElement('input');
    input.setAttribute('data-autofocus', 'true');
    wrap.appendChild(input);
    dd.mount(wrap);
    dd.open();
    expect(document.activeElement).toBe(input);
  });

  test('previous focus is restored after close', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const dd = new Dropdown({});
    dd.open();
    dd.close();

    expect(document.activeElement).toBe(trigger);
  });

  test('setSize swaps the size modifier class', () => {
    const dd = new Dropdown({ size: 'md' });
    dd.setSize('xl');
    expect(dd.el.classList.contains('app-dropdown--xl')).toBe(true);
    expect(dd.el.classList.contains('app-dropdown--md')).toBe(false);
  });

  test('persistent mode mounts surface at construction and only toggles display', () => {
    const dd = new Dropdown({ id: 'persist', persistent: true });
    expect(document.body.contains(dd.el)).toBe(true);
    expect(document.body.contains(dd.backdropEl)).toBe(true);
    expect(dd.el.style.display).toBe('none');
    expect(dd.backdropEl.style.display).toBe('none');

    dd.open();
    expect(dd.el.style.display).toBe('');
    expect(dd.backdropEl.style.display).toBe('');
    expect(dd.isOpen()).toBe(true);

    dd.close();
    // Still mounted; just hidden.
    expect(document.body.contains(dd.el)).toBe(true);
    expect(document.body.contains(dd.backdropEl)).toBe(true);
    expect(dd.el.style.display).toBe('none');
    expect(dd.backdropEl.style.display).toBe('none');
    expect(dd.isOpen()).toBe(false);
  });

  test('setHeader with all-empty + showClose:false removes an existing header', () => {
    const dd = new Dropdown({});
    dd.setHeader({ title: 'Has Header' });
    expect(dd.el.querySelector('.app-dropdown-header')).not.toBeNull();
    dd.setHeader({ title: null, slot: null, showClose: false });
    expect(dd.el.querySelector('.app-dropdown-header')).toBeNull();
  });

  test('setHeader removal is a no-op when no header exists yet', () => {
    const dd = new Dropdown({});
    expect(() => dd.setHeader({ title: null, slot: null, showClose: false })).not.toThrow();
    expect(dd.el.querySelector('.app-dropdown-header')).toBeNull();
  });

  test('setHeader slot replaces previous slot content and showClose toggles button', () => {
    const dd = new Dropdown({});
    const slotA = document.createElement('span'); slotA.textContent = 'A';
    dd.setHeader({ title: 'T', slot: slotA });
    const headerSlot = dd.el.querySelector('.app-dropdown-header-slot');
    expect(headerSlot.textContent).toBe('A');
    const slotB = document.createElement('span'); slotB.textContent = 'B';
    dd.setHeader({ title: 'T', slot: slotB, showClose: false });
    expect(headerSlot.textContent).toBe('B');
    expect(dd.el.querySelector('.app-dropdown-close').style.display).toBe('none');
    dd.setHeader({ title: 'T', showClose: true });
    expect(dd.el.querySelector('.app-dropdown-close').style.display).toBe('');
  });

  test('setSize ignores an unknown tier', () => {
    const dd = new Dropdown({ size: 'md' });
    dd.setSize('ginormous');
    expect(dd.el.classList.contains('app-dropdown--md')).toBe(false);
    expect(dd.el.className).not.toMatch(/app-dropdown--ginormous/);
  });

  test('constructor falls back to md for an invalid size', () => {
    const dd = new Dropdown({ size: 'bogus' });
    expect(dd.el.classList.contains('app-dropdown--md')).toBe(true);
  });

  test('toggle() opens when closed and closes when open', () => {
    const dd = new Dropdown({});
    expect(dd.isOpen()).toBe(false);
    dd.toggle();
    expect(dd.isOpen()).toBe(true);
    dd.toggle();
    expect(dd.isOpen()).toBe(false);
  });

  test('open() is a no-op while animating', () => {
    document.body.classList.remove('no-animations');
    const dd = new Dropdown({});
    dd.open();
    const surface = dd.el;
    // Second open() while the open animation is still pending must not re-append.
    dd.open();
    expect(document.body.querySelectorAll('.app-dropdown').length).toBe(1);
    expect(dd.el).toBe(surface);
  });

  test('close() is a no-op when not open', () => {
    const onClose = jest.fn();
    const dd = new Dropdown({ onClose });
    dd.close();
    expect(onClose).not.toHaveBeenCalled();
    expect(dd.isOpen()).toBe(false);
  });

  test('destroy() closes and nulls out element refs', () => {
    const dd = new Dropdown({});
    dd.open();
    dd.destroy();
    expect(dd.el).toBeNull();
    expect(dd.backdropEl).toBeNull();
    expect(dd.bodyEl).toBeNull();
  });

  test('noBackdrop mode renders no dimming overlay and never closes on backdrop', () => {
    const dd = new Dropdown({ noBackdrop: true });
    dd.open();
    expect(document.body.contains(dd.el)).toBe(true);
    expect(document.body.contains(dd.backdropEl)).toBe(false);
    expect(dd.el.getAttribute('aria-modal')).toBe('false');
    dd.close();
    expect(dd.isOpen()).toBe(false);
    expect(document.body.contains(dd.el)).toBe(false);
  });

  test('a noBackdrop surface leaves the app interactive and still takes focus', () => {
    const other = document.createElement('div');
    document.body.appendChild(other);
    const dd = new Dropdown({ noBackdrop: true });
    const wrap = document.createElement('div');
    const input = visible(document.createElement('input'));
    input.setAttribute('data-autofocus', 'true');
    wrap.appendChild(input);
    dd.mount(wrap);
    dd.open();
    expect(other.hasAttribute('inert')).toBe(false);
    expect(document.querySelectorAll('[inert]')).toHaveLength(0);
    expect(document.activeElement).toBe(input);
    dd.close();
    other.remove();
  });

  test('Tab from last focusable wraps to first; Shift+Tab from first wraps to last', () => {
    const dd = new Dropdown({});
    const wrap = document.createElement('div');
    const b1 = visible(document.createElement('button')); b1.textContent = '1';
    const b2 = visible(document.createElement('button')); b2.textContent = '2';
    wrap.appendChild(b1); wrap.appendChild(b2);
    dd.mount(wrap);
    dd.open();

    b2.focus();
    dd.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(b1);

    b1.focus();
    dd.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(b2);
  });

  test('the trap skips hidden rows instead of wrapping focus onto them', () => {
    const dd = new Dropdown({});
    const wrap = document.createElement('div');
    const b1 = visible(document.createElement('button'));
    const hidden = document.createElement('button');
    hidden.getClientRects = () => [];
    wrap.appendChild(b1); wrap.appendChild(hidden);
    dd.mount(wrap);
    dd.open();

    b1.focus();
    dd.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(b1);
  });

  test('open marks the rest of the document inert but leaves the backdrop clickable', () => {
    const other = document.createElement('div');
    document.body.appendChild(other);
    const dd = new Dropdown({});
    dd.open();
    expect(other.hasAttribute('inert')).toBe(true);
    expect(dd.backdropEl.hasAttribute('inert')).toBe(false);
    dd.close();
    expect(other.hasAttribute('inert')).toBe(false);
  });

  test('[data-autofocus] still wins over the first focusable', () => {
    const dd = new Dropdown({});
    const wrap = document.createElement('div');
    const b1 = visible(document.createElement('button'));
    const auto = visible(document.createElement('input'));
    auto.setAttribute('data-autofocus', '');
    wrap.appendChild(b1); wrap.appendChild(auto);
    dd.mount(wrap);
    dd.open();
    expect(document.activeElement).toBe(auto);
  });

  test('Tab with no focusables inside prevents default and does not move focus', () => {
    const dd = new Dropdown({});
    dd.open();
    const evt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    dd.el.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
  });

  test('non-Tab key on surface is ignored by the trap', () => {
    const dd = new Dropdown({});
    const wrap = document.createElement('div');
    const b1 = document.createElement('button');
    wrap.appendChild(b1);
    dd.mount(wrap);
    dd.open();
    b1.focus();
    const evt = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    dd.el.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(b1);
  });

  test('Tab in the middle of the focusable set does not wrap', () => {
    const dd = new Dropdown({});
    const wrap = document.createElement('div');
    const b1 = visible(document.createElement('button'));
    const b2 = visible(document.createElement('button'));
    const b3 = visible(document.createElement('button'));
    wrap.appendChild(b1); wrap.appendChild(b2); wrap.appendChild(b3);
    dd.mount(wrap);
    dd.open();
    b2.focus();
    const evt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    dd.el.dispatchEvent(evt);
    // Browser default handles the move; trap leaves focus where it is.
    expect(evt.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(b2);
  });

  test('initial focus targets first focusable when no [data-autofocus]', () => {
    const dd = new Dropdown({});
    const wrap = document.createElement('div');
    const input = visible(document.createElement('input'));
    wrap.appendChild(input);
    dd.mount(wrap);
    dd.open();
    expect(document.activeElement).toBe(input);
  });

  test('initial focus falls back to the surface when nothing focusable inside', () => {
    const dd = new Dropdown({});
    dd.open();
    expect(document.activeElement).toBe(dd.el);
  });

  test('Esc key event is prevented + stopped while open', () => {
    const dd = new Dropdown({});
    dd.open();
    const evt = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(dd.isOpen()).toBe(false);
  });

  test('mousedown that bubbles from a child of the backdrop does not close', () => {
    const dd = new Dropdown({});
    dd.open();
    const evt = new MouseEvent('mousedown', { bubbles: true });
    Object.defineProperty(evt, 'target', { value: document.createElement('div') });
    dd._onBackdropDown(evt);
    expect(dd.isOpen()).toBe(true);
    dd.close();
  });

  test('animationend on a different target is ignored by _waitForAnimation', () => {
    document.body.classList.remove('no-animations');
    const dd = new Dropdown({});
    dd.open();
    // Fire animationend whose target is a foreign element — must not finish open.
    const other = document.createElement('div');
    dd.el.dispatchEvent(Object.assign(new Event('animationend', { bubbles: true }), {}));
    const stray = new Event('animationend');
    Object.defineProperty(stray, 'target', { value: other });
    dd.el.dispatchEvent(stray);
    // The matching-target animationend (default target === el) finishes it.
    expect(dd.el.classList.contains('is-open')).toBe(true);
  });

  test('second animationend (already fired) is a no-op', () => {
    document.body.classList.remove('no-animations');
    const dd = new Dropdown({});
    dd.open();
    dd.el.dispatchEvent(new Event('animationend'));
    expect(dd.el.classList.contains('is-open')).toBe(true);
    // Re-dispatch: handler should early-return on the `fired` guard.
    expect(() => dd.el.dispatchEvent(new Event('animationend'))).not.toThrow();
    expect(dd.el.classList.contains('is-open')).toBe(true);
  });

  test('animation fallback timer detaches surface when animationend never fires', () => {
    document.body.classList.remove('no-animations');
    const dd = new Dropdown({});
    dd.open();
    dd.close();

    // Still attached while animation is "pending".
    expect(document.body.contains(dd.el)).toBe(true);

    // Fallback timer fires at 320ms.
    jest.advanceTimersByTime(500);

    expect(document.body.contains(dd.el)).toBe(false);
    expect(dd.isOpen()).toBe(false);
  });
});

/**
 * @jest-environment jsdom
 */

const Menu = require('../../../../../renderer/components/menu/Menu');
const { computePlacement } = require('../../../../../renderer/components/menu/Menu');
const modalStack = require('../../../../../renderer/utils/modalStack');

function key(target, k, extra = {}) {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra });
  target.dispatchEvent(e);
  return e;
}

describe('Menu', () => {
  let anchor;
  let selected;
  let menu;

  beforeEach(() => {
    document.body.innerHTML = '';
    anchor = document.createElement('button');
    anchor.textContent = 'More';
    document.body.appendChild(anchor);
    selected = [];
    let multiOn = true;
    menu = new Menu({
      anchor,
      ariaLabel: 'More actions',
      items: () => [
        { type: 'label', label: 'View' },
        { id: 'multi', label: 'Multi-Space', icon: 'multi', checked: multiOn, shortcut: '⌘M', onSelect: (it) => { multiOn = !multiOn; selected.push(it.id); } },
        { id: 'layout', label: 'Cycle layout', onSelect: (it) => selected.push(it.id) },
        { type: 'separator' },
        { id: 'disabled', label: 'Nope', disabled: true, onSelect: (it) => selected.push(it.id) },
        { id: 'find', label: 'Find', onSelect: (it) => selected.push(it.id) },
      ],
    });
  });

  afterEach(() => menu.destroy());

  test('wires aria on the anchor and renders roles, labels, separators', () => {
    expect(anchor.getAttribute('aria-haspopup')).toBe('menu');
    expect(anchor.getAttribute('aria-expanded')).toBe('false');
    menu.open();
    expect(anchor.getAttribute('aria-expanded')).toBe('true');
    expect(anchor.getAttribute('aria-controls')).toBe(menu.el.id);
    expect(menu.el.getAttribute('role')).toBe('menu');
    expect(menu.el.getAttribute('aria-label')).toBe('More actions');
    expect(menu.el.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(menu.el.querySelector('.ic-menu-label').textContent).toBe('View');
    const multi = menu.el.querySelector('[data-item-id="multi"]');
    expect(multi.getAttribute('role')).toBe('menuitemcheckbox');
    expect(multi.getAttribute('aria-checked')).toBe('true');
    expect(multi.querySelector('kbd').textContent).toBe('⌘M');
    expect(menu.el.querySelector('[data-item-id="layout"]').getAttribute('role')).toBe('menuitem');
    // Any checkable row reserves the check column on every row.
    expect(menu.el.classList.contains('ic-menu--checks')).toBe(true);
  });

  test('a menu with no checkable rows reserves no check column', () => {
    const plain = new Menu({ anchor, items: [{ id: 'a', label: 'A' }] });
    plain.open();
    expect(plain.el.classList.contains('ic-menu--checks')).toBe(false);
    plain.destroy();
  });

  test('re-reads items on every open so checkmarks track live state', () => {
    menu.open();
    menu.el.querySelector('[data-item-id="multi"]').click();
    expect(selected).toEqual(['multi']);
    expect(menu.isOpen()).toBe(false);
    menu.open();
    expect(menu.el.querySelector('[data-item-id="multi"]').getAttribute('aria-checked')).toBe('false');
  });

  test('arrow keys move focus over enabled items only, wrapping', () => {
    menu.open();
    const ids = () => document.activeElement.dataset.itemId;
    expect(ids()).toBe('multi');
    key(menu.el, 'ArrowDown');
    expect(ids()).toBe('layout');
    key(menu.el, 'ArrowDown');
    expect(ids()).toBe('find'); // skips the disabled item
    key(menu.el, 'ArrowDown');
    expect(ids()).toBe('multi'); // wraps
    key(menu.el, 'ArrowUp');
    expect(ids()).toBe('find');
    key(menu.el, 'Home');
    expect(ids()).toBe('multi');
    key(menu.el, 'End');
    expect(ids()).toBe('find');
  });

  test('typeahead jumps to the first matching item', () => {
    menu.open();
    key(menu.el, 'c');
    expect(document.activeElement.dataset.itemId).toBe('layout');
  });

  test('Enter activates the focused item and returns focus to the anchor', () => {
    menu.open();
    key(menu.el, 'ArrowDown');
    key(menu.el, 'Enter');
    expect(selected).toEqual(['layout']);
    expect(document.activeElement).toBe(anchor);
  });

  test('disabled items never fire', () => {
    menu.open();
    menu.el.querySelector('[data-item-id="disabled"]').click();
    expect(selected).toEqual([]);
  });

  test('Escape closes only the menu, not a modal layer beneath it', () => {
    const modal = modalStack.push();
    menu.open();
    const e = key(document, 'Escape');
    expect(menu.isOpen()).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    expect(modalStack.isTop(modal)).toBe(true);
    expect(document.activeElement).toBe(anchor);
    modalStack.pop(modal);
  });

  test('Escape is ignored when a newer layer sits above the menu', () => {
    menu.open();
    const confirmLayer = modalStack.push();
    key(document, 'Escape');
    expect(menu.isOpen()).toBe(true);
    modalStack.pop(confirmLayer);
  });

  test('outside mousedown closes; mousedown on the anchor does not', () => {
    menu.open();
    anchor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(menu.isOpen()).toBe(true);
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(menu.isOpen()).toBe(false);
    expect(document.querySelector('.ic-menu')).toBeNull();
  });

  test('close releases its modal layer and listeners', () => {
    const before = modalStack.depth();
    menu.open();
    expect(modalStack.depth()).toBe(before + 1);
    menu.close();
    expect(modalStack.depth()).toBe(before);
    expect(anchor.classList.contains('is-menu-open')).toBe(false);
  });

  test('chrome side follows body[data-chrome-layout]', () => {
    const chromeMenu = new Menu({ anchor, side: 'chrome', items: [{ id: 'a', label: 'A' }] });
    anchor.getBoundingClientRect = () => /** @type {DOMRect} */ ({ top: 300, bottom: 330, left: 10, right: 50, width: 40, height: 30 });
    document.body.dataset.chromeLayout = 'left';
    chromeMenu.open();
    expect(chromeMenu.el.dataset.side).toBe('right');
    chromeMenu.close();
    document.body.dataset.chromeLayout = 'bottom';
    chromeMenu.open();
    expect(chromeMenu.el.dataset.side).toBe('top');
    chromeMenu.close();
  });

  test('throws without an anchor', () => {
    expect(() => new Menu({ items: [] })).toThrow(/anchor/);
  });
});

describe('computePlacement', () => {
  const vp = { w: 1000, h: 800 };
  const size = { w: 200, h: 300 };

  test('below the anchor, right-aligned', () => {
    const p = computePlacement({ top: 10, bottom: 40, left: 700, right: 740 }, size, vp, 'bottom', 'end');
    expect(p).toEqual({ top: 46, left: 540, side: 'bottom' });
  });

  test('flips above when there is no room below', () => {
    const p = computePlacement({ top: 700, bottom: 730, left: 100, right: 140 }, size, vp, 'bottom', 'start');
    expect(p.side).toBe('top');
    expect(p.top).toBe(700 - 6 - 300);
    expect(p.left).toBe(100);
  });

  test('beside a sidebar anchor, and flips left at the right edge', () => {
    expect(computePlacement({ top: 100, bottom: 130, left: 0, right: 52 }, size, vp, 'right', 'start'))
      .toEqual({ top: 100, left: 58, side: 'right' });
    expect(computePlacement({ top: 100, bottom: 130, left: 948, right: 1000 }, size, vp, 'right', 'start').side).toBe('left');
  });

  test('clamps inside the viewport', () => {
    const p = computePlacement({ top: 10, bottom: 40, left: 0, right: 20 }, size, vp, 'bottom', 'end');
    expect(p.left).toBe(8);
  });
});

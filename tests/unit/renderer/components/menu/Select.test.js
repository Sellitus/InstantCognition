/**
 * @jest-environment jsdom
 */

const { enhanceSelect, syncSelect } = require('../../../../../renderer/components/menu/Select');

function build(values, selected) {
  const sel = document.createElement('select');
  sel.className = 'sv-select';
  sel.setAttribute('aria-label', 'Theme');
  for (const v of values) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v.toUpperCase();
    if (v === selected) o.selected = true;
    sel.appendChild(o);
  }
  document.body.appendChild(sel);
  return sel;
}

describe('enhanceSelect', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => { document.querySelectorAll('.ic-menu').forEach((m) => m.remove()); });

  test('wraps the native select, hides it from AT, and shows the selected label', () => {
    const sel = build(['dark', 'light', 'system'], 'light');
    const wrap = enhanceSelect(sel);
    expect(wrap.classList.contains('ic-select')).toBe(true);
    expect(wrap.contains(sel)).toBe(true);
    expect(sel.getAttribute('aria-hidden')).toBe('true');
    expect(sel.tabIndex).toBe(-1);
    const trigger = wrap.querySelector('.ic-select-trigger');
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger.getAttribute('aria-label')).toBe('Theme');
    expect(trigger.classList.contains('sv-select-trigger')).toBe(true);
    expect(trigger.textContent).toBe('LIGHT');
  });

  test('choosing an option updates the native value and fires change', () => {
    const sel = build(['dark', 'light'], 'dark');
    const wrap = enhanceSelect(sel);
    const onChange = jest.fn();
    sel.addEventListener('change', onChange);
    wrap.querySelector('.ic-select-trigger').click();
    const listbox = document.querySelector('.ic-menu[role="listbox"]');
    expect(listbox).not.toBeNull();
    const opts = listbox.querySelectorAll('[role="option"]');
    expect(Array.from(opts).map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    opts[1].click();
    expect(sel.value).toBe('light');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(wrap.querySelector('.ic-select-value').textContent).toBe('LIGHT');
  });

  test('re-picking the current option does not fire change', () => {
    const sel = build(['dark', 'light'], 'dark');
    const wrap = enhanceSelect(sel);
    const onChange = jest.fn();
    sel.addEventListener('change', onChange);
    wrap.querySelector('.ic-select-trigger').click();
    document.querySelector('[role="option"]').click();
    expect(onChange).not.toHaveBeenCalled();
  });

  test('change events, option mutations, syncSelect and interaction resync the trigger', async () => {
    const sel = build(['a', 'b'], 'a');
    const wrap = enhanceSelect(sel);
    const trigger = wrap.querySelector('.ic-select-trigger');
    const value = () => wrap.querySelector('.ic-select-value').textContent;
    sel.value = 'b';
    sel.dispatchEvent(new Event('change'));
    expect(value()).toBe('B');
    sel.value = 'a';
    syncSelect(sel);
    expect(value()).toBe('A');
    // populate-then-set in one task: the observer runs after both
    sel.innerHTML = '<option value="y">Why</option><option value="z">Zed</option>';
    sel.value = 'z';
    await Promise.resolve();
    expect(value()).toBe('Zed');
    sel.value = 'y';
    trigger.dispatchEvent(new Event('pointerdown'));
    expect(value()).toBe('Why');
    expect(() => syncSelect(document.createElement('select'))).not.toThrow();
  });

  test('mirrors disabled', async () => {
    const sel = build(['a'], 'a');
    const wrap = enhanceSelect(sel);
    sel.disabled = true;
    await Promise.resolve();
    expect(wrap.querySelector('.ic-select-trigger').disabled).toBe(true);
  });

  test('renders optgroups as labelled sections', () => {
    const sel = document.createElement('select');
    sel.innerHTML = '<optgroup label="Local"><option value="a">A</option></optgroup><optgroup label="Remote"><option value="b">B</option></optgroup>';
    document.body.appendChild(sel);
    const wrap = enhanceSelect(sel);
    wrap.querySelector('.ic-select-trigger').click();
    const menu = document.querySelector('.ic-menu');
    expect(Array.from(menu.querySelectorAll('.ic-menu-label')).map((l) => l.textContent)).toEqual(['Local', 'Remote']);
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(1);
  });

  test('is idempotent and rejects non-selects and multi-selects', () => {
    const sel = build(['a'], 'a');
    const wrap = enhanceSelect(sel);
    expect(enhanceSelect(sel)).toBe(wrap);
    expect(document.querySelectorAll('.ic-select-trigger')).toHaveLength(1);
    expect(() => enhanceSelect(document.createElement('div'))).toThrow(/select/);
    const multi = document.createElement('select');
    multi.multiple = true;
    expect(() => enhanceSelect(multi)).toThrow(/multiple/);
  });

  test('ArrowDown on the trigger opens the listbox focused on the selected option', () => {
    const sel = build(['a', 'b', 'c'], 'b');
    const wrap = enhanceSelect(sel);
    const trigger = wrap.querySelector('.ic-select-trigger');
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement.dataset.itemId).toBe('b');
  });
});

// controls — atomic UI primitives for the registry-driven settings view.
// jsdom env. No electron dependency; Icon is required lazily and is jsdom-safe.

function loadControls() {
  let c;
  jest.isolateModules(() => { c = require('../../../../../renderer/components/settings/controls'); });
  return c;
}

describe('controls.el()', () => {
  test('class, style object, on* handler, boolean attrs, and child filtering', () => {
    const { el } = loadControls();
    const onClick = jest.fn();
    const node = el('div', {
      class: 'foo',
      style: { color: 'red' },
      onClick,
      'data-flag': true,
      'data-skip': false,
      'data-null': null,
      title: 'hi',
    }, ['text', null, false, el('span', {}, ['child'])]);
    expect(node.className).toBe('foo');
    expect(node.style.color).toBe('red');
    expect(node.hasAttribute('data-flag')).toBe(true);
    expect(node.getAttribute('data-flag')).toBe('');
    expect(node.hasAttribute('data-skip')).toBe(false);
    expect(node.hasAttribute('data-null')).toBe(false);
    expect(node.getAttribute('title')).toBe('hi');
    // null/false children skipped; string + element kept.
    expect(node.childNodes.length).toBe(2);
    node.dispatchEvent(new Event('click'));
    expect(onClick).toHaveBeenCalled();
  });
});

describe('controls.render() dispatch', () => {
  test('toggle reflects value and fires onChange with the new checked state', () => {
    const { render } = loadControls();
    const onChange = jest.fn();
    const node = render({ id: 't', type: 'toggle' }, true, onChange);
    const input = node.querySelector('input');
    expect(input.checked).toBe(true);
    input.checked = false;
    input.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  test('select marks the matching option and coerces on change', () => {
    const { render } = loadControls();
    const onChange = jest.fn();
    const setting = { id: 's', type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', hint: 'tip' }] };
    const wrap = render(setting, 'b', onChange);
    expect(wrap.classList.contains('ic-select')).toBe(true);
    const sel = wrap.querySelector('select');
    expect(sel.id).toBe('set-s');
    const selected = sel.querySelector('option[selected]');
    expect(selected.value).toBe('b');
    expect(sel.querySelectorAll('option')[1].title).toBe('tip');
    sel.value = 'a';
    sel.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith('a');
  });

  test('select rejects a value outside its options: reverts, onChange not called', () => {
    const { render } = loadControls();
    const onChange = jest.fn();
    const sel = render({ id: 'sx', type: 'select', options: [{ value: 'a' }, { value: 'b' }] }, 'b', onChange)
      .querySelector('select');
    sel.appendChild(Object.assign(document.createElement('option'), { value: 'rogue' }));
    sel.value = 'rogue';
    sel.dispatchEvent(new Event('change'));
    expect(onChange).not.toHaveBeenCalled();
    expect(sel.value).toBe('b');
    sel.value = 'a';
    sel.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith('a');
  });

  test('select with no options falls back to String(value) label', () => {
    const { render } = loadControls();
    const sel = render({ id: 's2', type: 'select', options: [{ value: 'x' }] }, 'x', jest.fn()).querySelector('select');
    expect(sel.querySelector('option').textContent).toBe('x');
  });

  test('slider: input event updates the output, change event fires onChange(Number)', () => {
    const { render } = loadControls();
    const onChange = jest.fn();
    const setting = { id: 'sl', type: 'slider', title: 'Sidebar width', min: 0, max: 10, step: 1, unit: 'px' };
    const wrap = render(setting, 5, onChange);
    const range = wrap.querySelector('input[type="range"]');
    const out = wrap.querySelector('output');
    expect(range.getAttribute('aria-label')).toBe('Sidebar width');
    expect(range.getAttribute('aria-describedby')).toBe(out.id);
    expect(out.textContent).toBe('5px');
    range.value = '7';
    range.dispatchEvent(new Event('input'));
    expect(out.textContent).toBe('7px');
    range.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith(7);
  });

  test('slider with null value defaults to min and renders empty output', () => {
    const { render } = loadControls();
    const wrap = render({ id: 'sl2', type: 'slider' }, null, jest.fn());
    const range = wrap.querySelector('input[type="range"]');
    expect(range.value).toBe('0'); // default min
    expect(wrap.querySelector('output').textContent).toBe('');
  });

  test('slider formatValue is used; a throwing formatValue falls back to the raw value and logs', () => {
    const { render } = loadControls();
    const ok = render({ id: 'f1', type: 'slider', min: 0, max: 1, step: 0.1, formatValue: (v) => `${Math.round(v * 100)}%` }, 0.5, jest.fn());
    expect(ok.querySelector('output').textContent).toBe('50%');
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const bad = render({ id: 'f2', type: 'slider', min: 0, max: 1, step: 0.1, formatValue: () => { throw new Error('x'); } }, 0.5, jest.fn());
    expect(bad.querySelector('output').textContent).toBe('0.5');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('formatValue for f2 failed'), expect.any(Error));
    errSpy.mockRestore();
  });

  test('text input: plain vs password subtype, value, and change handler', () => {
    const { render } = loadControls();
    const onChange = jest.fn();
    const plain = render({ id: 'tx', type: 'text', placeholder: 'p' }, 'hello', onChange);
    expect(plain.type).toBe('text');
    expect(plain.value).toBe('hello');
    plain.value = 'world';
    plain.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith('world');
    const pw = render({ id: 'pw', type: 'text', subtype: 'password' }, null, jest.fn());
    expect(pw.type).toBe('password');
    expect(pw.value).toBe('');
  });

  test('number input: min/max/step applied, finite value parsed and passed through', () => {
    const { render } = loadControls();
    const onChange = jest.fn();
    const input = render({ id: 'n', type: 'number', title: 'Results returned', min: 1, max: 10, step: 2 }, 4, onChange);
    expect(input.getAttribute('aria-label')).toBe('Results returned');
    expect(input.min).toBe('1');
    expect(input.max).toBe('10');
    expect(input.step).toBe('2');
    input.value = '8';
    input.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith(8);
  });

  test('number input: non-numeric input is rejected, reverted and marked invalid', () => {
    const { render } = loadControls();
    const onChange = jest.fn();
    const input = render({ id: 'nf', type: 'number' }, 4, onChange);
    // jsdom sanitizes invalid <input type=number> to '', so stub the accessor
    // to reach the non-numeric branch and record the revert write.
    let current = 'abc';
    Object.defineProperty(input, 'value', { configurable: true, get: () => current, set: (v) => { current = v; } });
    input.dispatchEvent(new Event('change'));
    expect(onChange).not.toHaveBeenCalled();
    expect(current).toBe('4');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.classList.contains('is-invalid')).toBe(true);
    current = '6';
    input.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith(6);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(input.classList.contains('is-invalid')).toBe(false);
  });

  test('number input: empty input is rejected; out-of-range input is clamped', () => {
    const { render } = loadControls();
    const onChange = jest.fn();
    const input = render({ id: 'nc', type: 'number', min: 1, max: 10 }, 5, onChange);
    input.value = '';
    input.dispatchEvent(new Event('change'));
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('5');
    input.value = '99';
    input.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenLastCalledWith(10);
    expect(input.value).toBe('10');
    input.value = '-3';
    input.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  test('number input with null value defaults to min, or 0 when no min', () => {
    const { render } = loadControls();
    expect(render({ id: 'n1', type: 'number', min: 3 }, null, jest.fn()).value).toBe('3');
    expect(render({ id: 'n2', type: 'number' }, null, jest.fn()).value).toBe('0');
  });

  test('color picker reflects value (or default) and fires onChange', () => {
    const { render } = loadControls();
    const onChange = jest.fn();
    const c = render({ id: 'c', type: 'color' }, '#ff0000', onChange);
    expect(c.type).toBe('color');
    expect(c.value).toBe('#ff0000');
    c.value = '#00ff00';
    c.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith('#00ff00');
    const dflt = render({ id: 'c2', type: 'color' }, null, jest.fn());
    expect(dflt.value).toBe('#888888');
  });

  test('radioGroup: checked option, hint title, only checked change fires onChange', () => {
    const { render } = loadControls();
    const onChange = jest.fn();
    const setting = { id: 'r', type: 'radioGroup', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', hint: 'h' }] };
    const wrap = render(setting, 'a', onChange);
    const inputs = wrap.querySelectorAll('input[type="radio"]');
    expect(inputs[0].checked).toBe(true);
    expect(wrap.querySelectorAll('.sv-radio')[1].title).toBe('h');
    inputs[1].checked = true;
    inputs[1].dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  test('pillGroup: same contract as radioGroup, fires coerced value', () => {
    const { render } = loadControls();
    const onChange = jest.fn();
    const setting = { id: 'p', type: 'pillGroup', options: [{ value: 'x', label: 'X' }, { value: 'y' }] };
    const wrap = render(setting, 'x', onChange);
    const inputs = wrap.querySelectorAll('input[type="radio"]');
    inputs[1].checked = true;
    inputs[1].dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith('y');
  });

  test('button: variant classes, icon presence, onChange(setting), handler error made visible', () => {
    const { render } = loadControls();
    const danger = render({ id: 'b1', type: 'button', variant: 'danger', actionLabel: 'Del', icon: 'trash' }, null, jest.fn());
    expect(danger.className).toContain('sv-button--danger');
    const primary = render({ id: 'b2', type: 'button', variant: 'primary' }, null, jest.fn());
    expect(primary.className).toContain('sv-button--primary');
    const plain = render({ id: 'b3', type: 'button' }, null, jest.fn());
    expect(plain.className).toBe('sv-button');
    expect(plain.querySelector('span').textContent).toBe('Run'); // default label

    const onChange = jest.fn((s) => { expect(s.id).toBe('b1'); });
    const btn = render({ id: 'b1', type: 'button', actionLabel: 'Go' }, null, onChange);
    btn.click();
    expect(onChange).toHaveBeenCalled();

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let fail = true;
    const throwing = render({ id: 'b4', type: 'button', actionLabel: 'Check' }, null, () => { if (fail) throw new Error('handler boom'); });
    expect(() => throwing.click()).not.toThrow();
    expect(throwing.classList.contains('is-error')).toBe(true);
    expect(throwing.title).toBe('Check failed: handler boom');
    expect(errSpy).toHaveBeenCalled();
    fail = false;
    throwing.click();
    expect(throwing.classList.contains('is-error')).toBe(false);
    expect(throwing.hasAttribute('title')).toBe(false);
    errSpy.mockRestore();
  });

  test('custom control runs setting.render and appends a returned node distinct from host', () => {
    const { render } = loadControls();
    const child = document.createElement('p');
    const setting = {
      id: 'cu', type: 'custom',
      render: (host, ctx) => { expect(host.className).toBe('sv-custom'); expect(ctx.value).toBe(42); return child; },
    };
    const node = render(setting, 42, jest.fn(), { some: 'ctx' });
    expect(node.contains(child)).toBe(true);
  });

  test('custom control does NOT double-append when render returns the host itself', () => {
    const { render } = loadControls();
    let host;
    const setting = { id: 'cu2', type: 'custom', render: (h) => { host = h; h.appendChild(document.createElement('b')); return h; } };
    const node = render(setting, null, jest.fn());
    expect(node).toBe(host);
    expect(node.querySelectorAll('b').length).toBe(1);
  });

  test('custom control with no render function yields an empty sv-custom host', () => {
    const { render } = loadControls();
    const node = render({ id: 'cu3', type: 'custom' }, null, jest.fn());
    expect(node.className).toBe('sv-custom');
    expect(node.childNodes.length).toBe(0);
  });

  test('custom control surfaces a render error as an sv-error placeholder', () => {
    const { render } = loadControls();
    const node = render({ id: 'cu4', type: 'custom', render: () => { throw new Error('render bug'); } }, null, jest.fn());
    expect(node.querySelector('.sv-error')).not.toBeNull();
    expect(node.textContent).toContain('Failed to render');
  });

  test('an unknown setting type renders a visible error naming the type', () => {
    const { render } = loadControls();
    const node = render({ id: 'mystery', type: 'nonexistent', title: 'Future thing' }, null, jest.fn());
    expect(node.className).toBe('sv-error');
    expect(node.getAttribute('role')).toBe('alert');
    expect(node.textContent).toBe('Unsupported setting type "nonexistent" for mystery');
  });
});

describe('controls.coerce via select/radio', () => {
  test('setting.coerce(fn) wins over options matching', () => {
    const { render } = loadControls();
    const onChange = jest.fn();
    const setting = { id: 'co', type: 'select', coerce: (raw) => Number(raw), options: [{ value: 1, label: 'one' }] };
    const sel = render(setting, 1, onChange).querySelector('select');
    sel.value = '1';
    sel.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith(1); // number, not '1'
  });

  test('options matching returns the original typed option value', () => {
    const { render } = loadControls();
    const onChange = jest.fn();
    const setting = { id: 'co2', type: 'radioGroup', options: [{ value: 2, label: 'two' }] };
    const wrap = render(setting, 9, onChange);
    const r = wrap.querySelector('input[type="radio"]');
    r.checked = true;
    r.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith(2);
  });

  test('no coerce + no option match is rejected rather than persisted raw', () => {
    const { render } = loadControls();
    const onChange = jest.fn();
    const sel = render({ id: 'co3', type: 'select', options: [{ value: 'a' }] }, 'a', onChange).querySelector('select');
    const extra = document.createElement('option');
    extra.value = 'zzz';
    sel.appendChild(extra);
    sel.value = 'zzz';
    sel.dispatchEvent(new Event('change'));
    expect(onChange).not.toHaveBeenCalled();
    expect(sel.value).toBe('a');
  });

  test('a coerce function admits values outside options (free-form selects)', () => {
    const { render } = loadControls();
    const onChange = jest.fn();
    const sel = render({ id: 'co4', type: 'select', coerce: (raw) => `x:${raw}`, options: [{ value: 'a' }] }, 'a', onChange)
      .querySelector('select');
    sel.appendChild(Object.assign(document.createElement('option'), { value: 'q' }));
    sel.value = 'q';
    sel.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith('x:q');
  });
});

describe('controls.createAdvancedSection()', () => {
  let store;
  let setItemSpy;
  let origDescriptor;
  beforeEach(() => {
    store = {};
    setItemSpy = jest.fn();
    origDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { setItemSpy(k, v); store[k] = String(v); },
        removeItem: (k) => { delete store[k]; },
        clear: () => { store = {}; },
      },
    });
  });
  afterEach(() => {
    if (origDescriptor) Object.defineProperty(window, 'localStorage', origDescriptor);
    jest.useRealTimers();
  });

  test('throws when no id is supplied', () => {
    const { createAdvancedSection } = loadControls();
    expect(() => createAdvancedSection({})).toThrow(/requires an id/);
    expect(() => createAdvancedSection()).toThrow(/requires an id/);
  });

  test('defaultOpen=true with no persisted state opens the section', () => {
    const { createAdvancedSection } = loadControls();
    const sec = createAdvancedSection({ id: 'a1', title: 'Adv One', defaultOpen: true });
    expect(sec.root.hasAttribute('open')).toBe(true);
    expect(sec.isOpen()).toBe(true);
    expect(sec.summary.querySelector('.sv-advanced-title').textContent).toBe('Adv One');
  });

  test('persisted collapsed=false overrides defaultOpen=true', () => {
    store['settings.v2.collapsed'] = JSON.stringify({ a2: false });
    const { createAdvancedSection } = loadControls();
    const sec = createAdvancedSection({ id: 'a2', defaultOpen: true });
    expect(sec.root.hasAttribute('open')).toBe(false);
  });

  test('persisted collapsed=true overrides defaultOpen=false', () => {
    store['settings.v2.collapsed'] = JSON.stringify({ a3: true });
    const { createAdvancedSection } = loadControls();
    const sec = createAdvancedSection({ id: 'a3', defaultOpen: false });
    expect(sec.root.hasAttribute('open')).toBe(true);
  });

  test('corrupt persisted JSON falls back to empty state (no throw)', () => {
    store['settings.v2.collapsed'] = '{not json';
    const { createAdvancedSection } = loadControls();
    expect(() => createAdvancedSection({ id: 'a4', defaultOpen: false })).not.toThrow();
  });

  test('initial badge is shown; setBadge updates and clears it', () => {
    const { createAdvancedSection } = loadControls();
    const sec = createAdvancedSection({ id: 'a5', badge: '3' });
    const badge = sec.summary.querySelector('.sv-advanced-badge');
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('3');
    sec.setBadge('7');
    expect(badge.textContent).toBe('7');
    sec.setBadge('');
    expect(badge.hidden).toBe(true);
    sec.setBadge(null);
    expect(badge.hidden).toBe(true);
  });

  test('no badge → badge element stays hidden', () => {
    const { createAdvancedSection } = loadControls();
    const sec = createAdvancedSection({ id: 'a6' });
    expect(sec.summary.querySelector('.sv-advanced-badge').hidden).toBe(true);
  });

  test('toggle event persists the new open state (debounced write)', () => {
    jest.useFakeTimers();
    const { createAdvancedSection, getCollapsedState } = loadControls();
    const sec = createAdvancedSection({ id: 'a7' });
    sec.setOpen(true);
    sec.root.dispatchEvent(new Event('toggle'));
    jest.advanceTimersByTime(250);
    expect(setItemSpy).toHaveBeenCalled();
    expect(getCollapsedState('a7')).toBe(true);
  });

  test('search-driven toggle (preSearchOpen marker set) does NOT persist', () => {
    jest.useFakeTimers();
    const { createAdvancedSection } = loadControls();
    const sec = createAdvancedSection({ id: 'a8' });
    setItemSpy.mockClear();
    sec.root.dataset.preSearchOpen = 'true';
    sec.root.dispatchEvent(new Event('toggle'));
    jest.advanceTimersByTime(250);
    expect(setItemSpy).not.toHaveBeenCalled();
  });

  test('getCollapsedState returns null for an unknown id, set/get round-trips', () => {
    const { getCollapsedState, setCollapsedState } = loadControls();
    expect(getCollapsedState('never-seen')).toBeNull();
    setCollapsedState('rt', true);
    expect(getCollapsedState('rt')).toBe(true);
    setCollapsedState('rt', false);
    expect(getCollapsedState('rt')).toBe(false);
  });

  test('setOpen reflects on the underlying <details> element', () => {
    const { createAdvancedSection } = loadControls();
    const sec = createAdvancedSection({ id: 'a9' });
    sec.setOpen(true);
    expect(sec.root.open).toBe(true);
    sec.setOpen(false);
    expect(sec.root.open).toBe(false);
  });
});

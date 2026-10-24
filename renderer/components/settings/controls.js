// controls — atomic UI primitives for the registry-driven settings view.
//
// Every control is a pure function `render(setting, value, onChange) → HTMLElement`
// where `setting` is a SettingDef from the registry, `value` is the current
// config value, and `onChange(newValue)` is invoked when the user mutates it.
// Controls don't read config themselves — the SettingsView owns the
// config↔registry binding via configBridge. Controls validate before calling
// onChange: an out-of-range number is clamped, and an empty/non-numeric number
// or a select value outside `options` is rejected (control reverts, nothing
// is persisted).

const { icon: makeIcon } = require('../Icon');
const { enhanceSelect } = require('../menu/Select');

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const k of Object.keys(attrs)) {
    if (k === 'class') node.className = attrs[k];
    else if (k === 'style' && typeof attrs[k] === 'object') Object.assign(node.style, attrs[k]);
    else if (k.startsWith('on') && typeof attrs[k] === 'function') node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
    else if (attrs[k] === true) node.setAttribute(k, '');
    else if (attrs[k] !== false && attrs[k] != null) node.setAttribute(k, String(attrs[k]));
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function toggle(setting, value, onChange) {
  const id = `set-${setting.id}`;
  const input = el('input', { type: 'checkbox', id, checked: !!value, role: 'switch', 'aria-label': controlName(setting) });
  input.addEventListener('change', () => onChange(input.checked));
  const slider = el('span', { class: 'sv-toggle-slider', 'aria-hidden': 'true' });
  return el('label', { class: 'sv-toggle', for: id }, [input, slider]);
}

function selectControl(setting, value, onChange) {
  const id = `set-${setting.id}`;
  const select = el('select', { class: 'sv-select', id, 'aria-label': controlName(setting) });
  for (const opt of setting.options || []) {
    const o = el('option', { value: opt.value }, [opt.label || String(opt.value)]);
    if (opt.value === value) o.setAttribute('selected', '');
    if (opt.hint) o.title = opt.hint;
    select.appendChild(o);
  }
  let committed = select.value;
  select.addEventListener('change', () => {
    const known = (setting.options || []).some((o) => String(o.value) === select.value);
    if (!known && !setting.coerce) {
      select.value = committed;
      return;
    }
    committed = select.value;
    onChange(coerce(select.value, setting));
  });
  return enhanceSelect(select);
}

function slider(setting, value, onChange) {
  const id = `set-${setting.id}`;
  const min = setting.min != null ? setting.min : 0;
  const max = setting.max != null ? setting.max : 100;
  const step = setting.step != null ? setting.step : 1;
  const wrap = el('div', { class: 'sv-slider' });
  const outputId = `${id}-value`;
  const range = el('input', {
    type: 'range',
    id,
    min,
    max,
    step,
    value: value != null ? value : min,
    'aria-label': controlName(setting),
    'aria-describedby': outputId,
  });
  const out = el('output', { id: outputId, class: 'sv-slider-value', for: id }, [formatValue(value, setting)]);
  range.addEventListener('input', () => { out.textContent = formatValue(Number(range.value), setting); });
  range.addEventListener('change', () => onChange(Number(range.value)));
  wrap.append(range, out);
  return wrap;
}

function textInput(setting, value, onChange) {
  const id = `set-${setting.id}`;
  const input = el('input', {
    type: setting.subtype === 'password' ? 'password' : 'text',
    id,
    class: 'sv-text',
    placeholder: setting.placeholder || '',
    value: value != null ? value : '',
    'aria-label': controlName(setting),
  });
  input.addEventListener('change', () => onChange(input.value));
  return input;
}

function numberInput(setting, value, onChange) {
  const id = `set-${setting.id}`;
  const input = el('input', {
    type: 'number',
    id,
    class: 'sv-number',
    value: value != null ? value : (setting.min != null ? setting.min : 0),
    'aria-label': controlName(setting),
  });
  if (setting.min != null) input.min = String(setting.min);
  if (setting.max != null) input.max = String(setting.max);
  if (setting.step != null) input.step = String(setting.step);
  let committed = input.value;
  input.addEventListener('change', () => {
    const raw = input.value.trim();
    const n = raw === '' ? NaN : Number(raw);
    if (!Number.isFinite(n)) {
      input.value = committed;
      input.setAttribute('aria-invalid', 'true');
      input.classList.add('is-invalid');
      return;
    }
    input.removeAttribute('aria-invalid');
    input.classList.remove('is-invalid');
    const clamped = clamp(n, setting.min, setting.max);
    input.value = String(clamped);
    committed = input.value;
    onChange(clamped);
  });
  return input;
}

function clamp(n, min, max) {
  if (min != null && n < min) return min;
  if (max != null && n > max) return max;
  return n;
}

function colorPicker(setting, value, onChange) {
  const id = `set-${setting.id}`;
  const input = el('input', { type: 'color', id, class: 'sv-color', value: value || '#888888', 'aria-label': controlName(setting) });
  input.addEventListener('change', () => onChange(input.value));
  return input;
}

function radioGroup(setting, value, onChange) {
  const wrap = el('div', { class: 'sv-radio-group', role: 'radiogroup', 'aria-label': controlName(setting) });
  for (const opt of setting.options || []) {
    const id = `set-${setting.id}-${opt.value}`;
    const input = el('input', {
      type: 'radio',
      name: `set-${setting.id}`,
      id,
      value: opt.value,
      checked: opt.value === value,
    });
    input.addEventListener('change', () => { if (input.checked) onChange(coerce(opt.value, setting)); });
    const label = el('label', { class: 'sv-radio', for: id }, [input, el('span', {}, [opt.label || String(opt.value)])]);
    if (opt.hint) label.title = opt.hint;
    wrap.appendChild(label);
  }
  return wrap;
}

function pillGroup(setting, value, onChange) {
  const wrap = el('div', { class: 'sv-pills', role: 'radiogroup', 'aria-label': controlName(setting) });
  for (const opt of setting.options || []) {
    const id = `set-${setting.id}-${opt.value}`;
    const input = el('input', {
      type: 'radio',
      name: `set-${setting.id}`,
      id,
      value: opt.value,
      checked: opt.value === value,
    });
    input.addEventListener('change', () => { if (input.checked) onChange(coerce(opt.value, setting)); });
    const label = el('label', { class: 'sv-pill', for: id }, [input, el('span', {}, [opt.label || String(opt.value)])]);
    if (opt.hint) label.title = opt.hint;
    wrap.appendChild(label);
  }
  return wrap;
}

function buttonControl(setting, _value, onChange) {
  const variant = setting.variant === 'danger' ? 'sv-button sv-button--danger'
    : setting.variant === 'primary' ? 'sv-button sv-button--primary'
    : 'sv-button';
  const children = [];
  if (setting.icon) children.push(makeIcon(setting.icon, { className: 'sv-button-icon' }));
  children.push(el('span', {}, [setting.actionLabel || 'Run']));
  const label = setting.actionLabel || setting.title || 'Run setting action';
  const btn = el('button', { type: 'button', class: variant, 'aria-label': label }, children);
  btn.addEventListener('click', () => {
    btn.classList.remove('is-error');
    btn.removeAttribute('title');
    try {
      onChange(setting);
    } catch (err) {
      // Click handlers have no caller to propagate to; mark the button so the
      // failure is visible and keep the details in the console.
      console.error('[settings] button handler failed:', err);
      btn.classList.add('is-error');
      btn.title = `${label} failed: ${(err instanceof Error && err.message) || String(err)}`;
    }
  });
  return btn;
}

function customControl(setting, value, onChange, ctx) {
  const host = el('div', { class: 'sv-custom' });
  if (typeof setting.render === 'function') {
    try {
      const node = setting.render(host, { value, onChange, ctx, setting });
      if (node && node !== host) host.appendChild(node);
    } catch (err) {
      console.error('[settings] custom render failed:', err);
      host.appendChild(el('div', { class: 'sv-error' }, ['Failed to render this setting.']));
    }
  }
  return host;
}

function unsupportedControl(setting) {
  return el('div', { class: 'sv-error', role: 'alert' }, [`Unsupported setting type "${setting.type}" for ${setting.id}`]);
}

// Advanced disclosure — a collapsible <details> wrapper used to hide power-user
// knobs by default. Persists open/closed state across app launches via
// localStorage so the user's choices stick.
const COLLAPSE_KEY = 'settings.v2.collapsed';
let _collapseCache = null;
let _writeTimer = null;

function _loadCollapseState() {
  if (_collapseCache) return _collapseCache;
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(COLLAPSE_KEY) : null;
  _collapseCache = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') _collapseCache = parsed;
    } catch (err) {
      // Corrupt UI-state blob: drop it so every disclosure falls back to its default.
      console.warn('[settings] discarding unreadable collapse state:', (err instanceof Error && err.message) || err);
      localStorage.removeItem(COLLAPSE_KEY);
    }
  }
  return _collapseCache;
}

function _scheduleCollapseWrite() {
  if (_writeTimer) clearTimeout(_writeTimer);
  _writeTimer = setTimeout(() => {
    _writeTimer = null;
    if (typeof localStorage !== 'undefined') localStorage.setItem(COLLAPSE_KEY, JSON.stringify(_collapseCache || {}));
  }, 200);
}

function getCollapsedState(id) {
  const cache = _loadCollapseState();
  return Object.prototype.hasOwnProperty.call(cache, id) ? !!cache[id] : null;
}

function setCollapsedState(id, isOpen) {
  const cache = _loadCollapseState();
  cache[id] = !!isOpen;
  _scheduleCollapseWrite();
}

/**
 * @param {{ id: string, title?: string, defaultOpen?: boolean, badge?: string | null }} opts
 */
function createAdvancedSection(opts) {
  const { id, title, defaultOpen = false, badge = null } = opts || {};
  if (!id) throw new Error('createAdvancedSection requires an id');
  const persisted = getCollapsedState(id);
  const initiallyOpen = persisted != null ? persisted : !!defaultOpen;

  const root = el('details', {
    class: 'sv-advanced',
    id: `sv-advanced-${id}`,
    'data-advanced-id': id,
  });
  if (initiallyOpen) root.setAttribute('open', '');

  const summary = el('summary', { class: 'sv-advanced-header' });
  summary.appendChild(makeIcon('down', { className: 'sv-advanced-caret' }));
  const titleEl = el('span', { class: 'sv-advanced-title' }, [title || 'Advanced']);
  const badgeEl = el('span', { class: 'sv-advanced-badge', hidden: true });
  if (badge != null && badge !== '') { badgeEl.textContent = String(badge); badgeEl.hidden = false; }
  summary.append(titleEl, badgeEl);

  const body = el('div', { class: 'sv-advanced-body' });
  root.append(summary, body);

  root.addEventListener('toggle', () => {
    // Search-driven toggles leave a marker on the element so we don't overwrite
    // the user's saved choice while searching.
    if (root.dataset.preSearchOpen != null) return;
    setCollapsedState(id, root.open);
  });

  return {
    root,
    body,
    summary,
    isOpen: () => root.open,
    setOpen: (v) => { root.open = !!v; },
    setBadge: (b) => {
      if (b == null || b === '') { badgeEl.hidden = true; badgeEl.textContent = ''; }
      else { badgeEl.hidden = false; badgeEl.textContent = String(b); }
    },
  };
}

const REGISTRY = {
  toggle,
  select: selectControl,
  slider,
  text: textInput,
  number: numberInput,
  color: colorPicker,
  radioGroup,
  pillGroup,
  button: buttonControl,
  custom: customControl,
};

function render(setting, value, onChange, ctx) {
  const fn = REGISTRY[setting.type];
  if (typeof fn !== 'function') return unsupportedControl(setting);
  return fn(setting, value, onChange, ctx);
}

function coerce(raw, setting) {
  if (setting.coerce && typeof setting.coerce === 'function') return setting.coerce(raw);
  if (setting.options) {
    const found = setting.options.find((o) => String(o.value) === String(raw));
    if (found) return found.value;
  }
  return raw;
}

function formatValue(value, setting) {
  if (value == null) return '';
  if (setting.formatValue) {
    try {
      return setting.formatValue(value);
    } catch (err) {
      console.error(`[settings] formatValue for ${setting.id} failed; showing the raw value:`, err);
    }
  }
  if (setting.unit) return `${value}${setting.unit}`;
  return String(value);
}

function controlName(setting) {
  return (setting && (setting.title || setting.actionLabel || setting.id)) || 'Setting';
}

module.exports = { render, REGISTRY, el, createAdvancedSection, getCollapsedState, setCollapsedState };

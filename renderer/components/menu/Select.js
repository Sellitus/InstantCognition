/**
 * Select — styled listbox over a native <select>.
 *
 *   const sel = document.createElement('select');   // build options as usual
 *   enhanceSelect(sel);                              // returns the wrapper
 *
 * The native element stays in the DOM (visually hidden) and remains the source
 * of truth: callers keep reading `.value`, listening for `change`, and adding
 * or removing <option>s. The trigger re-syncs on `change`, on option and
 * `disabled` mutations (a microtask later, so populate-then-set lands on the
 * final value), and before every interaction. A bare `.value =` write with no
 * mutation and no event needs `syncSelect(select)` to repaint the label.
 */

const Menu = require('./Menu');
const { icon } = require('../Icon');

const syncers = new WeakMap();

function selectedLabel(select) {
  const opt = select.options[select.selectedIndex];
  return opt ? opt.textContent : '';
}

function itemsFor(select, commit) {
  const items = [];
  let lastGroup = null;
  for (const opt of Array.from(select.options)) {
    const group = opt.parentElement && opt.parentElement.tagName === 'OPTGROUP' ? opt.parentElement : null;
    if (group !== lastGroup) {
      if (group) {
        if (items.length) items.push({ type: 'separator' });
        items.push({ type: 'label', label: group.label });
      }
      lastGroup = group;
    }
    if (opt.hidden) continue;
    items.push({
      id: opt.value,
      label: opt.textContent,
      checked: opt.selected,
      disabled: opt.disabled,
      onSelect: () => commit(opt.value),
    });
  }
  return items;
}

/**
 * @param {HTMLSelectElement} select
 * @param {{ className?: string }} [opts]
 * @returns {HTMLElement} the wrapper now holding `select`
 */
function enhanceSelect(select, opts = {}) {
  if (!select || select.tagName !== 'SELECT') throw new Error('enhanceSelect expects a <select> element');
  if (select.dataset.enhanced === '1') return /** @type {HTMLElement} */ (select.parentElement);
  if (select.multiple) throw new Error('enhanceSelect does not support <select multiple>');
  select.dataset.enhanced = '1';

  const wrap = document.createElement('span');
  wrap.className = `ic-select${opts.className ? ' ' + opts.className : ''}`;
  if (select.parentNode) select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);
  select.classList.add('ic-select-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'ic-select-trigger';
  for (const cls of Array.from(select.classList)) {
    if (cls !== 'ic-select-native') trigger.classList.add(`${cls}-trigger`);
  }
  const label = select.getAttribute('aria-label') || (select.id && document.querySelector(`label[for="${select.id}"]`)?.textContent) || '';
  if (label) trigger.setAttribute('aria-label', label);
  const text = document.createElement('span');
  text.className = 'ic-select-value';
  trigger.appendChild(text);
  trigger.appendChild(icon('down', { className: 'ic-select-chevron' }));
  wrap.appendChild(trigger);

  const sync = () => {
    text.textContent = selectedLabel(select);
    trigger.disabled = select.disabled;
    trigger.title = text.textContent;
  };

  const commit = (value) => {
    if (select.value === value) return;
    select.value = value;
    sync();
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const menu = new Menu({
    anchor: trigger,
    role: 'listbox',
    side: 'bottom',
    align: 'start',
    className: 'ic-select-menu',
    ariaLabel: label || undefined,
    items: () => itemsFor(select, commit),
    onOpen: () => {
      if (menu.el) menu.el.style.minWidth = `${trigger.offsetWidth}px`;
    },
  });

  trigger.addEventListener('pointerdown', sync);
  trigger.addEventListener('focus', sync);
  trigger.addEventListener('click', () => menu.toggle({ focus: 'selected' }));
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      menu.open({ focus: 'selected' });
    }
  });

  select.addEventListener('change', sync);
  syncers.set(select, sync);
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected', 'label'] });
  }
  sync();
  return wrap;
}

/** Repaint an enhanced select's trigger after a bare `.value =` write. */
function syncSelect(select) {
  const sync = select && syncers.get(select);
  if (sync) sync();
}

module.exports = { enhanceSelect, syncSelect };

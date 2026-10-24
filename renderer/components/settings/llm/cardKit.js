// cardKit — DOM builders shared by the Models page cards.
//
// Cards reuse the settings-v2 card/row classes so they sit in the page grid
// next to registry cards and take part in search: every knob row carries
// `data-setting-id` + `data-search`, which SettingsView filters with
// `.is-search-miss` (a card whose knobs all miss is dimmed out the same way).

const { el, REGISTRY, createAdvancedSection } = require('../controls');
const { icon: makeIcon } = require('../../Icon');

/**
 * A Models card. Collapsible cards are a <details> that remembers its open
 * state under `llm.<id>`.
 * @param {{ id: string, title: string, icon?: string, description?: string, collapsible?: boolean, wide?: boolean, actions?: HTMLElement[] }} opts
 * @returns {{ root: HTMLElement, body: HTMLElement }}
 */
function card(opts) {
  const { id, title, icon, description, collapsible = false, wide = false, actions = [] } = opts;
  let root;
  let body;
  if (collapsible) {
    const section = createAdvancedSection({ id: `llm.${id}`, title });
    root = section.root;
    root.classList.add('settings-v2-card', 'is-collapsible');
    body = section.body;
  } else {
    root = el('article', { class: 'settings-v2-card', 'aria-label': title });
    const titleRow = el('div', { class: 'settings-v2-card-heading' }, [
      icon ? makeIcon(icon, { className: 'settings-v2-card-icon' }) : null,
      el('h3', { class: 'settings-v2-card-title' }, [title]),
    ]);
    const header = el('header', { class: 'settings-v2-card-header' }, [titleRow]);
    if (actions.length) titleRow.appendChild(el('div', { class: 'settings-v2-card-actions' }, actions));
    if (description) header.appendChild(el('p', { class: 'settings-v2-card-description' }, [description]));
    body = el('div');
    root.append(header, body);
  }
  root.classList.add('sv-llm-card');
  if (wide) root.classList.add('is-wide');
  root.dataset.cardId = `llm-${id}`;
  body.classList.add('settings-v2-card-body');
  return { root, body };
}

/** Append a collapsed "Advanced" disclosure to a card; returns its body. */
function advanced(cardRef, id) {
  const adv = createAdvancedSection({ id: `llm.${id}.advanced`, title: 'Advanced' });
  adv.body.classList.add('settings-v2-card-body');
  cardRef.root.appendChild(adv.root);
  return adv;
}

/**
 * A searchable knob row: label + description on the left, control on the right.
 * @param {{ id: string, title: string, description?: string, control: HTMLElement, wide?: boolean, toggle?: boolean, search?: string }} opts
 */
function knobRow(opts) {
  const { id, title, description = '', control, wide = false, toggle = false, search = '' } = opts;
  const classes = ['settings-v2-row'];
  if (wide) classes.push('is-wide');
  if (toggle) classes.push('is-toggle');
  const row = el('div', {
    class: classes.join(' '),
    'data-setting-id': `llm.${id}`,
    'data-search': `${title} ${description} ${search}`.toLowerCase().replace(/\s+/g, ' ').trim(),
  });
  const info = el('div', { class: 'settings-v2-row-info' }, [el('h4', { class: 'settings-v2-row-title' }, [title])]);
  if (description) info.appendChild(el('p', { class: 'settings-v2-row-description', title: description }, [description]));
  row.append(info, el('div', { class: 'settings-v2-row-control' }, [control]));
  return row;
}

/** Dense 2-up grid for boolean rows. */
function toggleGrid(rows) {
  return el('div', { class: 'settings-v2-toggle-grid' }, rows);
}

// Control factories over the shared settings controls, so Models knobs get
// the same validation (number clamping, unknown-select rejection) as registry rows.
const toggleCtl = (id, title, value, onChange) => REGISTRY.toggle({ id: `llm-${id}`, title }, value, onChange);
const selectCtl = (id, title, options, value, onChange) => REGISTRY.select({ id: `llm-${id}`, title, options }, value, onChange);
const numberCtl = (id, title, value, onChange, range) => REGISTRY.number({ id: `llm-${id}`, title, ...range }, value, onChange);
const textCtl = (id, title, value, onChange, extra = {}) => REGISTRY.text({ id: `llm-${id}`, title, ...extra }, value, onChange);
const pillsCtl = (id, title, options, value, onChange) => REGISTRY.pillGroup({ id: `llm-${id}`, title, options }, value, onChange);

/**
 * Labeled button. `iconOnly` keeps the label as the accessible name and
 * tooltip but renders just the glyph.
 * @param {{ label: string, onClick: () => any, variant?: string, icon?: string, iconOnly?: boolean }} opts
 */
function button(opts) {
  const { label, onClick, variant = null, icon = null, iconOnly = false } = opts;
  const cls = ['sv-button'];
  if (variant) cls.push(`sv-button--${variant}`);
  if (iconOnly) cls.push('sv-icon-button');
  const children = [];
  if (icon) children.push(makeIcon(icon, { className: 'sv-button-icon' }));
  const labelEl = el('span', { class: iconOnly ? 'sv-visually-hidden' : '' }, [label]);
  children.push(labelEl);
  const btn = el('button', { type: 'button', class: cls.join(' '), title: label, 'aria-label': label }, children);
  btn.addEventListener('click', onClick);
  return btn;
}

/** Inline status line; kind is ok | error | busy | idle. */
function setLine(node, kind, text) {
  node.dataset.state = kind;
  node.textContent = text;
  if (kind === 'error') node.setAttribute('role', 'alert');
  else node.removeAttribute('role');
}

module.exports = { card, advanced, knobRow, toggleGrid, toggleCtl, selectCtl, numberCtl, textCtl, pillsCtl, button, setLine };

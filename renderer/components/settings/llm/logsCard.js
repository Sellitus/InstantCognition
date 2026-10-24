// Logs card (collapsible): recent output from the local inference server.

const { el } = require('../controls');
const { card, knobRow } = require('./cardKit');

function buildLogsCard(tab) {
  const c = card({ id: 'logs', title: 'Server logs', collapsible: true, wide: true });
  c.root.classList.add('sv-llm-logs-card');
  const pre = el('pre', { class: 'sv-llm-logs', tabindex: '0', 'aria-label': 'Server logs' });
  const logsStatus = el('p', { class: 'sv-llm-inline-status', hidden: true });
  c.body.appendChild(knobRow({
    id: 'logs', title: 'Recent output', control: el('div', { class: 'sv-llm-field' }, [pre, logsStatus]), wide: true,
    search: 'logs output errors debug server',
  }));
  Object.assign(tab._refs, { logsEl: pre, logsStatus });
  return c.root;
}

module.exports = { buildLogsCard };

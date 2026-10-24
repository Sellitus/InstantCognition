// Server card: local inference server status, start/stop, port, auto-start.

const { el } = require('../controls');
const { card, knobRow, toggleGrid, numberCtl, toggleCtl, button } = require('./cardKit');

function buildServerCard(tab) {
  const c = card({ id: 'server', title: 'Server', icon: 'power', description: 'The local HTTP server that hosts the selected model.' });
  const llm = tab._llm();

  const statusPill = el('span', { class: 'sv-llm-status-pill stopped', role: 'status' }, ['stopped']);
  const endpointEl = el('code', { class: 'sv-llm-endpoint' });
  const startBtn = button({ label: 'Start', icon: 'play', variant: 'primary', onClick: () => tab._onStartServer() });
  const stopBtn = button({ label: 'Stop', icon: 'stop', variant: 'ghost', onClick: () => tab._onStopServer() });
  c.body.appendChild(knobRow({
    id: 'serverStatus',
    title: 'Status',
    control: el('div', { class: 'sv-llm-server-panel' }, [
      el('div', { class: 'sv-llm-status-line' }, [statusPill, endpointEl]),
      el('div', { class: 'sv-button-row' }, [startBtn, stopBtn]),
    ]),
    wide: true,
    search: 'server status start stop running endpoint',
  }));

  c.body.appendChild(knobRow({
    id: 'serverPort',
    title: 'Port',
    description: 'Port the local server listens on.',
    control: numberCtl('port', 'Port', llm.serverPort || 8421, (v) => tab._setLLM('serverPort', v), { min: 1024, max: 65535, step: 1 }),
    search: 'port http',
  }));
  c.body.appendChild(toggleGrid([knobRow({
    id: 'autoStart',
    title: 'Start with the app',
    description: 'Launch the configured local model when InstantCognition starts.',
    control: toggleCtl('autostart', 'Start with the app', !!llm.autoStart, (v) => tab._setLLM('autoStart', !!v)),
    toggle: true,
    search: 'auto start launch startup',
  })]));

  Object.assign(tab._refs, { statusPill, endpointEl, startBtn, stopBtn });
  return c.root;
}

module.exports = { buildServerCard };

/**
 * @jest-environment jsdom
 */

// Boots the real renderer/renderer.js against index.html's markup to prove a
// private tab survives the config:changed echo of the renderer's own saves:
// config never holds private tabs, and the space-model sync must not read
// their absence as a main-side close. Only electron is mocked.

const fs = require('fs');
const path = require('path');

window.matchMedia = jest.fn(() => ({ matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() }));
window.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
window.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
HTMLCanvasElement.prototype.getContext = () => ({
  globalAlpha: 1,
  createLinearGradient: () => ({ addColorStop() {} }),
  createRadialGradient: () => ({ addColorStop() {} }),
  setTransform() {}, clearRect() {}, translate() {}, rotate() {},
  beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
  fillRect() {}, arc() {}, save() {}, restore() {},
});

jest.mock('electron', () => ({
  ipcRenderer: {
    send: jest.fn(),
    on: jest.fn(),
    once: jest.fn(),
    invoke: jest.fn().mockResolvedValue(undefined),
    removeListener: jest.fn(),
    removeAllListeners: jest.fn(),
    sendSync: jest.fn(() => {
      const { DEFAULT_CONFIG, migrateConfig } = require('../../../shared/configDefaults');
      const cfg = migrateConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), 'darwin');
      return { config: cfg, resetReason: null };
    }),
  },
  shell: { openExternal: jest.fn() },
  clipboard: { writeText: jest.fn(), readText: jest.fn(() => '') },
}));

function bootRenderer() {
  jest.resetModules();
  const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>/g, '');
  require('../../../renderer/renderer');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  return {
    state: window.appState,
    spaceManager: require('../../../renderer/components/TabBar')._spaceManager,
    ipcRenderer: require('electron').ipcRenderer,
  };
}

function broadcastSet(ipcRenderer, pathName, newValue) {
  const calls = ipcRenderer.on.mock.calls.filter((c) => c[0] === 'config:changed');
  expect(calls.length).toBeGreaterThan(0);
  for (const [, handler] of calls) handler({}, { kind: 'set', path: pathName, newValue });
}

describe('renderer wiring: private tabs and the config echo', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    document.body.classList.add('no-animations');
  });

  afterEach(() => { jest.useRealTimers(); });

  test('the echo of a private-free tab list keeps the private tab open and mounted', () => {
    const { state, spaceManager, ipcRenderer } = bootRenderer();
    const priv = spaceManager.openPrivateTab('https://secret.example/');
    const persisted = state.get('config').state.openTabs.slice();
    expect(persisted).not.toContain(priv);

    broadcastSet(ipcRenderer, 'state.openTabs', persisted);

    expect(state.get('openTabs')).toContain(priv);
    expect(state.get('currentSpaceId')).toBe(priv);
    expect(document.getElementById(priv)).not.toBeNull();
    expect(state.get('config').state.openTabs).toEqual(persisted);
  });

  test('a main-side removal still closes the removed tab while the private tab stays', () => {
    const { state, spaceManager, ipcRenderer } = bootRenderer();
    const library = Object.keys(state.get('spaces')).filter((id) => !(state.get('openTabs') || []).includes(id));
    spaceManager.openTab(library[0]);
    const priv = spaceManager.openPrivateTab('https://secret.example/');
    const persisted = state.get('config').state.openTabs.filter((id) => id !== library[0]);

    broadcastSet(ipcRenderer, 'state.openTabs', persisted);

    expect(state.get('openTabs')).not.toContain(library[0]);
    expect(state.get('openTabs')).toContain(priv);
    expect(document.getElementById(library[0])).toBeNull();
  });
});

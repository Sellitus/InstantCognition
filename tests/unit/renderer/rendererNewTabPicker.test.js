/**
 * @jest-environment jsdom
 */

// Boots the real renderer/renderer.js against index.html's markup to prove the
// new-tab picker is wired to live search settings: a config:changed broadcast
// after startup must change where a picked suggestion searches. Only electron
// (the main-process boundary) is mocked.

const fs = require('fs');
const path = require('path');

// Browser APIs jsdom lacks that the boot path touches.
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
  // jsdom fired DOMContentLoaded before the module registered its listener.
  document.dispatchEvent(new Event('DOMContentLoaded'));
  return {
    picker: require('../../../renderer/components/NewTabPicker'),
    ipcRenderer: require('electron').ipcRenderer,
  };
}

function broadcastConfigSet(ipcRenderer, pathName, newValue) {
  const calls = ipcRenderer.on.mock.calls.filter((c) => c[0] === 'config:changed');
  expect(calls.length).toBeGreaterThan(0);
  for (const [, handler] of calls) handler({}, { kind: 'set', path: pathName, newValue });
}

describe('renderer wiring: new-tab picker search settings', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};
    document.body.classList.add('no-animations');
  });

  afterEach(() => { jest.useRealTimers(); });

  test('a picked suggestion searches the engine chosen after startup', async () => {
    const { picker, ipcRenderer } = bootRenderer();
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'bookmarks:search' || channel === 'history:search') return Promise.resolve([]);
      if (channel === 'search:suggest') return Promise.resolve({ ok: true, suggestions: ['kittens'] });
      return Promise.resolve(undefined);
    });
    broadcastConfigSet(ipcRenderer, 'settings.defaultSearchEngine', 'duckduckgo');

    const openAdHocTab = jest.spyOn(picker._spaceManager, 'openAdHocTab').mockImplementation(() => {});
    picker.open();
    picker._input.value = 'kitt';
    picker._input.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(200);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const row = /** @type {HTMLElement} */ (picker._content.querySelector('.omnibox-row-search'));
    expect(row).not.toBeNull();
    row.click();
    expect(openAdHocTab).toHaveBeenCalledWith('https://duckduckgo.com/?q=kittens');
  });
});

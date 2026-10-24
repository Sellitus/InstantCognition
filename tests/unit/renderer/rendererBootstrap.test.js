/**
 * @jest-environment jsdom
 */

// Boots the real renderer/renderer.js module against index.html's markup to
// prove the startup ordering: the shell store must hydrate from the config
// main hands back, not from an unseeded configBridge.

const fs = require('fs');
const path = require('path');

let mockStartupAssistant;

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
      cfg.settings.assistant = { ...(cfg.settings.assistant || {}), ...mockStartupAssistant };
      return { config: cfg, resetReason: null };
    }),
  },
  shell: { openExternal: jest.fn() },
  clipboard: { writeText: jest.fn(), readText: jest.fn(() => '') },
}));

function bootRenderer(assistant) {
  mockStartupAssistant = assistant;
  jest.resetModules();
  const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>/g, '');
  require('../../../renderer/renderer');
  return require('../../../renderer/components/AgentPanel')._viewShell.store;
}

describe('renderer bootstrap: assistant shell hydration', () => {
  test('the shell store restores lastMode and widths from the startup config', () => {
    const snap = bootRenderer({ startMode: 'last', lastMode: 'assistant', sidebarWidth: 700, dockWidth: 900 }).snapshot();
    expect(snap.appMode).toBe('assistant');
    expect(snap.sidebarWidth).toBe(700);
    expect(snap.dockWidth).toBe(900);
  });

  test('an explicit startMode wins over lastMode at startup', () => {
    const store = bootRenderer({ startMode: 'browser', lastMode: 'assistant', sidebarWidth: 700 });
    expect(store.get('appMode')).toBe('browser');
    expect(store.get('sidebarWidth')).toBe(700);
  });
});

describe('renderer bootstrap: saved-password save bar', () => {
  beforeAll(() => {
    // jsdom lacks these; the DOMContentLoaded bootstrap touches all of them.
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
  });

  test('the save bar listens for offers from main once the renderer has booted', () => {
    bootRenderer({});
    document.dispatchEvent(new Event('DOMContentLoaded'));
    const { ipcRenderer } = require('electron');
    const channels = ipcRenderer.on.mock.calls.map((c) => c[0]);
    expect(channels).toEqual(expect.arrayContaining(['passwords:offer', 'passwords:offer-expired', 'passwords:notice']));
  });

  // The shell no longer loads the webview preload, so it installs the host
  // keys itself; Escape closing the find bar is the one users hit most.
  test('host keys reach main from the shell once the renderer has booted', () => {
    const host = require('../../helpers/trustedEvents').recordListeners(window);
    try {
      bootRenderer({});
      document.dispatchEvent(new Event('DOMContentLoaded'));
    } finally {
      host.restore();
    }
    const { ipcRenderer } = require('electron');
    ipcRenderer.send.mockClear();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(ipcRenderer.send).not.toHaveBeenCalledWith('close-find-bar');
    host.fire(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(ipcRenderer.send).toHaveBeenCalledWith('close-find-bar');
  });
});

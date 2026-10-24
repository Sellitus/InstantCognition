/**
 * @jest-environment jsdom
 */

// Boots the real renderer/renderer.js against index.html markup (pattern of
// rendererBootstrap.test.js) and drives the pack:open-panes / updater:result
// mockHandlers to prove their toasts tell the truth: pack panes are counted only
// when they actually opened, and a rejected updater:install invoke surfaces
// toast.error instead of an unhandled rejection.

const fs = require('fs');
const path = require('path');

const mockHandlers = new Map();
window.matchMedia = jest.fn(() => ({ matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() }));
window.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
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
    on: jest.fn((channel, handler) => {
      mockHandlers.set(channel, handler);
    }),
    once: jest.fn((channel, handler) => {
      mockHandlers.set(channel, handler);
    }),
    invoke: jest.fn().mockResolvedValue(undefined),
    removeListener: jest.fn(),
    removeAllListeners: jest.fn(),
    sendSync: jest.fn(() => {
      const { DEFAULT_CONFIG, migrateConfig } = require('../../../shared/configDefaults');
      return { config: migrateConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), 'darwin'), resetReason: null };
    }),
  },
  shell: { openExternal: jest.fn() },
  clipboard: { writeText: jest.fn(), readText: jest.fn(() => '') },
}));

const mockToast = { success: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn(), dismiss: jest.fn() };
jest.mock('../../../renderer/components/Toast', () => mockToast);

// Only openAdHocTab is under test's control; every other method the renderer
// touches during boot becomes a no-op.
function mockSpaceManagerFactory(mockThrowForUrl) {
  const target = {
    openAdHocTab: jest.fn((url) => {
      if (url === mockThrowForUrl) throw new Error('bad url');
    }),
  };
  return new Proxy(target, { get: (t, k) => (k in t ? t[k] : jest.fn()) });
}

let mockSpaceManagerInstance;

function bootRenderer(mockThrowForUrl) {
  jest.resetModules();
  mockHandlers.clear();
  mockToast.success.mockClear();
  mockToast.error.mockClear();
  mockToast.warn.mockClear();
  mockToast.info.mockClear();
  jest.mock('../../../renderer/managers/SpaceManager', () => function SpaceManager() {
    mockSpaceManagerInstance = mockSpaceManagerFactory(mockThrowForUrl);
    return mockSpaceManagerInstance;
  }, { virtual: false });
  const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>/g, '');
  require('../../../renderer/renderer');
  // The channel handlers register inside DOMContentLoaded, which jsdom has
  // already fired by the time the test body runs.
  document.dispatchEvent(new Event('DOMContentLoaded'));
  return mockHandlers;
}

describe('openPackPanes toast honesty', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.dontMock('../../../renderer/managers/SpaceManager');
  });

  test('one of two panes throwing yields a partial toast, not full success', () => {
    jest.useFakeTimers();
    const h = bootRenderer('https://bad.example/');
    h.get('pack:open-panes')(null, {
      label: 'Research',
      panes: [{ url: 'https://good.example/' }, { url: 'https://bad.example/' }],
    });
    jest.advanceTimersByTime(120);
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockToast.warn).toHaveBeenCalledWith(
      'Research: opened 1 of 2 panes (1 failed)',
      expect.anything(),
    );
  });

  test('all panes opening cleanly reports the full count with no failure toast', () => {
    jest.useFakeTimers();
    const h = bootRenderer(null);
    h.get('pack:open-panes')(null, {
      label: 'Research',
      panes: [{ url: 'https://a.example/' }, { url: 'https://b.example/' }],
    });
    jest.advanceTimersByTime(120);
    expect(mockToast.success).toHaveBeenCalledWith('Research: opened 2 panes');
    expect(mockToast.warn).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalled();
  });
  test('every pane failing reports an error toast, not success or warn', () => {
    jest.useFakeTimers();
    const h = bootRenderer('https://a.example/');
    h.get('pack:open-panes')(null, {
      label: 'Research',
      panes: [{ url: 'https://a.example/' }, { url: 'https://a.example/' }],
    });
    jest.advanceTimersByTime(120);
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockToast.warn).not.toHaveBeenCalled();
    expect(mockToast.error).toHaveBeenCalledWith('Research: could not open any panes', { title: 'Research' });
  });
});

describe('updater Restart-now rejection', () => {
  test('a rejected updater:install invoke surfaces toast.error', async () => {
    const h = bootRenderer(null);
    const { ipcRenderer } = require('electron');
    h.get('updater:result')(null, { ok: true, manual: true, status: 'downloaded', version: '9.9.9' });
    const opts = mockToast.success.mock.calls[0][1];
    ipcRenderer.invoke.mockRejectedValueOnce(new Error('channel closed'));
    await opts.action.onClick();
    expect(mockToast.error).toHaveBeenCalledWith('Restart failed: channel closed', { title: 'Updates' });
  });
});

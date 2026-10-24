// Custom search engines settings module: the per-engine suggestions URL and
// keeping settings.defaultSearchEngine valid when its engine is removed.
// jsdom env. Only electron's ipcRenderer (the main-process boundary) is mocked;
// the real ConfirmDialog is driven by clicking its buttons.

jest.mock('electron', () => ({
  ipcRenderer: {
    send: jest.fn(),
    on: jest.fn(),
    removeListener: jest.fn(),
    sendSync: jest.fn(() => ({ config: null })),
    invoke: jest.fn(() => Promise.resolve(null)),
  },
}));

const { ipcRenderer } = require('electron');
const { customSearchEngines } = require('../../../../../renderer/components/settings/modules/search');

function fakeBridge(initialConfig) {
  const store = JSON.parse(JSON.stringify(initialConfig));
  return {
    store,
    get: (path, fb) => {
      let cur = store;
      for (const p of String(path).split('.')) {
        if (cur == null || typeof cur !== 'object') return fb;
        cur = cur[p];
      }
      return cur === undefined ? fb : cur;
    },
    set: jest.fn((path, value) => {
      const parts = String(path).split('.');
      let cur = store;
      for (let i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
    }),
  };
}

function mount(settings) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const bridge = fakeBridge({ settings });
  customSearchEngines({ host, configBridge: bridge });
  return { host, bridge };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const suggestInput = (host) => /** @type {HTMLInputElement} */ (host.querySelector('input[aria-label="Search suggestions URL"]'));

async function removeAndConfirm(host, name) {
  /** @type {HTMLButtonElement} */ (host.querySelector(`button[aria-label="Remove ${name}"]`)).click();
  await flush();
  /** @type {HTMLButtonElement} */ (document.querySelector('.confirm-dialog-confirm')).click();
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.classList.add('no-animations');
});

describe('custom engine suggestions URL', () => {
  const ENGINE = { id: 'mine', name: 'Mine', url: 'https://s.example/?q=%s' };

  test('shows the saved suggest URL', () => {
    const { host } = mount({ customSearchEngines: [{ ...ENGINE, suggest: 'https://s.example/ac?q=%s' }] });
    expect(suggestInput(host).value).toBe('https://s.example/ac?q=%s');
  });

  test('a valid https template with %s is saved as `suggest`', () => {
    const { host, bridge } = mount({ customSearchEngines: [ENGINE] });
    const input = suggestInput(host);
    input.value = ' https://s.example/ac?q=%s ';
    input.dispatchEvent(new Event('change'));
    expect(bridge.set).toHaveBeenCalledWith('settings.customSearchEngines', [{ ...ENGINE, suggest: 'https://s.example/ac?q=%s' }]);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });

  test.each([
    ['plain http', 'http://s.example/ac?q=%s'],
    ['no %s', 'https://s.example/ac?q='],
    ['not a URL', 'suggest %s'],
  ])('%s is rejected with a visible error and not saved', (_label, value) => {
    const { host, bridge } = mount({ customSearchEngines: [{ ...ENGINE, suggest: 'https://s.example/ac?q=%s' }] });
    const input = suggestInput(host);
    input.value = value;
    input.dispatchEvent(new Event('change'));
    expect(bridge.set).not.toHaveBeenCalled();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const status = input.parentElement.querySelector('.sv-validation-status.is-error');
    expect(status.textContent).toBe('Enter an https URL containing %s where the search terms go, or leave it empty for no suggestions.');
    expect(status.getAttribute('role')).toBe('alert');
  });

  test('clearing the field drops `suggest` and clears a previous error', () => {
    const { host, bridge } = mount({ customSearchEngines: [{ ...ENGINE, suggest: 'https://s.example/ac?q=%s' }] });
    const input = suggestInput(host);
    input.value = 'http://bad/%s';
    input.dispatchEvent(new Event('change'));
    input.value = '  ';
    input.dispatchEvent(new Event('change'));
    expect(bridge.set).toHaveBeenLastCalledWith('settings.customSearchEngines', [ENGINE]);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(host.querySelector('.sv-validation-status.is-error')).toBeNull();
  });
});

describe('removing the default engine', () => {
  const ENGINES = [
    { id: 'mine', name: 'Mine', url: 'https://s.example/?q=%s' },
    { id: 'other', name: 'Other', url: 'https://o.example/?q=%s' },
  ];

  test('resets defaultSearchEngine to google before the list without it is written', async () => {
    const { host, bridge } = mount({ defaultSearchEngine: 'mine', customSearchEngines: ENGINES });
    await removeAndConfirm(host, 'Mine');
    expect(bridge.set.mock.calls).toEqual([
      ['settings.defaultSearchEngine', 'google'],
      ['settings.customSearchEngines', [ENGINES[1]]],
    ]);
  });

  test('removing a different engine leaves the default alone', async () => {
    const { host, bridge } = mount({ defaultSearchEngine: 'mine', customSearchEngines: ENGINES });
    await removeAndConfirm(host, 'Other');
    expect(bridge.set.mock.calls).toEqual([['settings.customSearchEngines', [ENGINES[0]]]]);
  });

  test('cancelling the confirm changes nothing', async () => {
    const { host, bridge } = mount({ defaultSearchEngine: 'mine', customSearchEngines: ENGINES });
    /** @type {HTMLButtonElement} */ (host.querySelector('button[aria-label="Remove Mine"]')).click();
    await flush();
    /** @type {HTMLButtonElement} */ (document.querySelector('.confirm-dialog-cancel')).click();
    await flush();
    expect(bridge.set).not.toHaveBeenCalled();
  });
});

describe('Settings view after removing the default engine', () => {
  let view;
  let configBridge;

  beforeEach(() => {
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};
    localStorage.clear();
    ipcRenderer.send.mockClear();
    jest.isolateModules(() => {
      view = require('../../../../../renderer/components/settings/SettingsView');
      configBridge = require('../../../../../renderer/core/configBridge');
    });
  });

  afterEach(() => { view.hide(); });

  test('the default-engine select switches to Google and no longer offers the removed engine', async () => {
    view.initialize({
      settings: { defaultSearchEngine: 'mine', customSearchEngines: [{ id: 'mine', name: 'Mine', url: 'https://s.example/?q=%s' }] },
      spaces: {},
    });
    view.show();
    const select = /** @type {HTMLSelectElement} */ (document.querySelector('[data-setting-id="search.defaultEngine"] select'));
    expect(select.value).toBe('mine');

    const module = /** @type {HTMLElement} */ (document.querySelector('.sv-custom-module[data-module="customSearchEngines"]'));
    await removeAndConfirm(module, 'Mine');

    expect(select.value).toBe('google');
    expect(Array.from(select.options).map((o) => o.value)).not.toContain('mine');
    expect(configBridge.get('settings.defaultSearchEngine')).toBe('google');
    const sent = ipcRenderer.send.mock.calls.filter((c) => c[0] === 'config:set').map((c) => c[1].path);
    expect(sent).toEqual(['settings.defaultSearchEngine', 'settings.customSearchEngines']);
  });
});

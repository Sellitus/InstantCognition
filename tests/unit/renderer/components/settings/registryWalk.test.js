// Registry walk: every REGISTRY row is driven through its real rendered
// control in a live SettingsView, asserting the exact config:set payload, the
// side-effect dispatch, the restart notice, visibleIf both ways, dynamic
// option sources, and rejection of invalid input. The only mock is the
// electron IPC boundary.

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
const { DEFAULT_CONFIG } = require('../../../../../shared/configDefaults');

// Rows rendered by a custom module; each is exercised by the module's own
// suite. A new custom row must be added here (and tested) or the coverage
// test below fails.
const CUSTOM_ROWS = {
  'spaces.editor': 'customModules.test.js › customModules.spaces() add & remove',
  'downloads.location': 'customModules.test.js › downloadLocation',
  'appearance.accentColor': 'customModules.test.js › customModules.accentColor()',
  'language.spellCheckLanguages': 'customModules.test.js › spellCheckLanguages',
  'language.acceptLanguages': 'customModules.test.js › acceptLanguages',
  'voiceReading.voice': 'customModules.test.js › customModules.voiceReading()',
  'llm.tab': 'LLMTab.test.js',
  'llm.perModelOverrides': 'customModules.test.js › customModules.modelOverrides()',
  'agentSafety.egress': 'customModules.test.js › customModules.agentSafety()',
  'agentPermissions.rules': 'agentPermissions.test.js › agentPermissionRules()',
  'agentPermissions.workspaceRoots': 'agentPermissions.test.js › agentWorkspaceRoots()',
  'agentPermissions.instructions': 'agentPermissions.test.js › agentGlobalInstructions()',
  'projects.manager': 'customModules.test.js › customModules.projects()',
  'userMemory.editor': 'customModules.test.js › customModules.userMemory()',
  'personas.editor': 'customModules.test.js › customModules.personas()',
  'packs.catalog': 'customModules.test.js › customModules.packs()',
  'mcp.servers': 'customModules.test.js › customModules.mcpServers()',
  'search.customEngines': 'customModules.test.js › customModules.customSearchEngines()',
  'privacy.adblockerLists': 'customModules.test.js › adblockerLists()',
  'privacy.siteAllowlist': 'customModules.test.js › customModules.siteAllowlist()',
  'privacy.dnsCustomUrl': 'customModules.test.js › dnsCustomUrl()',
  'privacy.permissions': 'customModules.test.js › customModules.permissions() error path',
  'routines.editor': 'customModules.test.js › customModules.routines()',
  'shortcuts.editor': 'customModules.test.js › customModules.shortcuts() edit & reset',
  'skills.gallery': 'skillsModule.test.js › skills settings module (loading, empty, error, toggle, delete, install, import)',
  'passwords.saved': 'passwordsModule.test.js › saved passwords settings module (list, empty, errors, reveal, copy, delete, never-save)',
  'advanced.about': 'customModules.test.js › about',
};

function getPath(obj, path) {
  return path.split('.').reduce((cur, k) => (cur == null ? undefined : cur[k]), obj);
}

const sent = (channel) => ipcRenderer.send.mock.calls.filter((c) => c[0] === channel);
const channels = () => ipcRenderer.send.mock.calls.map((c) => c[0]);

// Expected observable result of each side effect after a value change.
const APPEARANCE = (row, value) => {
  expect(window.applyAppearanceSettings).toHaveBeenCalledTimes(1);
  const applied = window.applyAppearanceSettings.mock.calls[0][0];
  expect(getPath({ settings: applied }, row.path)).toEqual(value);
};
const EFFECT_EXPECT = {
  applyTheme: APPEARANCE,
  applyAnimations: APPEARANCE,
  applySidebarWidth: APPEARANCE,
  applyAppearance: APPEARANCE,
  applyPageZoom: APPEARANCE,
  applyUIDensity: APPEARANCE,
  applyChromeLayout: (row, value) => {
    expect(window.appState.set).toHaveBeenCalledWith('chromeLayout', value);
    APPEARANCE(row, value);
  },
  applyAdblocker: (_row, value) => {
    expect(channels()).toContain(value ? 'call-createAndUpdateaAblocker' : 'call-disableAdblocker');
  },
  applyDns: () => expect(sent('dns:apply').length).toBe(1),
  applyLaunchAtStartup: (_row, value) => {
    expect(channels()).toContain(value ? 'call-enableLaunchAtStartup' : 'call-disableLaunchAtStartup');
  },
  applyAutoDenyCertErrors: (_row, value) => expect(sent('set-auto-deny-cert-errors')).toEqual([['set-auto-deny-cert-errors', value]]),
  applyPrivateIpCertRanges: (row, value) => {
    const calls = sent('set-private-ip-cert-ranges');
    expect(calls.length).toBe(1);
    expect(calls[0][1][row.path.split('.').pop()]).toBe(value);
  },
  applySpellCheck: () => expect(sent('settings:apply-spellcheck').length).toBe(1),
  applyLogLevel: (_row, value) => expect(sent('settings:set-log-level')).toEqual([['settings:set-log-level', value]]),
};

// Button rows: the IPC each one fires.
const BUTTON_EXPECT = {
  'privacy.clearBrowsingData': 'openBrowserDataPanel',
  'advanced.checkForUpdates': 'updater:check-now',
  'advanced.checkForEngineUpdates': 'engine-updater:check-now',
  'advanced.defaultBrowser': 'settings:set-default-browser',
  'advanced.openConfig': 'open-config-file',
  'general.restartApp': 'restart-app',
  'advanced.resetAll': 'settings:reset-all',
};

// visibleIf rows: control steps that show the row, then steps that hide it.
const VISIBLE_IF = {
  'startup.url': { show: [['startup.behavior', 'url']], hide: [['startup.behavior', 'restoreSession']] },
  'appearance.chromeAmbient.intensity': {
    show: [['appearance.chromeAmbient.scene', 'aurora']],
    hide: [['appearance.chromeAmbient.scene', 'off']],
  },
  'search.inBrowserEngine': { show: [['search.provider', 'inBrowser']], hide: [['search.provider', 'brave']] },
  'search.searxngUrl': { show: [['search.provider', 'searxng']], hide: [['search.provider', 'tavily']] },
  'search.braveApiKey': { show: [['search.provider', 'brave']], hide: [['search.provider', 'searxng']] },
  'search.tavilyApiKey': { show: [['search.provider', 'tavily']], hide: [['search.provider', 'inBrowser']] },
  'privacy.adblockerLists': { show: [['privacy.enableAdblocker', true]], hide: [['privacy.enableAdblocker', false]] },
  'privacy.dnsProvider': { show: [['privacy.dnsMode', 'secure']], hide: [['privacy.dnsMode', 'system']] },
  'privacy.dnsCustomUrl': {
    show: [['privacy.dnsMode', 'secure'], ['privacy.dnsProvider', 'custom']],
    hide: [['privacy.dnsProvider', 'cloudflare']],
  },
  'chat.readTopPage': { show: [['chat.webSearch', true]], hide: [['chat.webSearch', false]] },
  'assistant.launcherHotkey': { show: [['assistant.launcherEnabled', true]], hide: [['assistant.launcherEnabled', false]] },
};

function makeConfig() {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.settings.customSearchEngines = [{ id: 'myeng', name: 'MyEngine', url: 'https://e.test/?q=%s' }];
  return cfg;
}

let view;
let registry;
let configBridge;

function loadView(config) {
  let v;
  let reg;
  let bridge;
  jest.isolateModules(() => {
    v = require('../../../../../renderer/components/settings/SettingsView');
    reg = require('../../../../../renderer/components/settings/registry');
    bridge = require('../../../../../renderer/core/configBridge');
  });
  v.initialize(config);
  return { v, reg, bridge };
}

const allRows = () => registry.REGISTRY.flatMap((p) => p.settings);
const rowEl = (id) => document.querySelector(`.settings-v2-row[data-setting-id="${id}"]`);
const entry = (id) => view._rows.get(id);

function drive(id, value) {
  const el = rowEl(id);
  const { setting } = entry(id);
  const control = el.querySelector('.settings-v2-row-control');
  switch (setting.type) {
    case 'toggle': {
      const cb = control.querySelector('input[type="checkbox"]');
      cb.checked = value;
      cb.dispatchEvent(new Event('change'));
      break;
    }
    case 'select': {
      const sel = control.querySelector('select');
      sel.value = String(value);
      sel.dispatchEvent(new Event('change'));
      break;
    }
    case 'radioGroup':
    case 'pillGroup': {
      const r = control.querySelector(`input[type="radio"][value="${value}"]`);
      r.checked = true;
      r.dispatchEvent(new Event('change'));
      break;
    }
    case 'slider':
    case 'number':
    case 'text': {
      const input = control.querySelector('input');
      input.value = String(value);
      input.dispatchEvent(new Event('change'));
      break;
    }
    default:
      throw new Error(`drive(): no driver for ${setting.type} (${id})`);
  }
}

/** A valid value different from the current one, plus the value it must persist as. */
function nextValue(setting) {
  const cur = configBridge.get(setting.path, undefined);
  switch (setting.type) {
    case 'toggle': return !cur;
    case 'select':
    case 'radioGroup':
    case 'pillGroup': {
      const opt = (setting.options || []).find((o) => o.value !== cur);
      if (!opt) throw new Error(`${setting.id}: no alternative option to ${cur}`);
      return opt.value;
    }
    case 'slider':
    case 'number': return cur === setting.max ? setting.min : setting.max;
    case 'text': return `walk-${setting.id}`;
    default: throw new Error(`nextValue(): unhandled ${setting.type}`);
  }
}

beforeAll(() => {
  jest.useFakeTimers();
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};
  document.body.classList.add('no-animations');
  ({ v: view, reg: registry, bridge: configBridge } = loadView(makeConfig()));
});

afterAll(() => {
  jest.useRealTimers();
  document.body.classList.remove('no-animations');
});

beforeEach(() => {
  ipcRenderer.send.mockReset();
  window.applyAppearanceSettings = jest.fn();
  window.appState = { set: jest.fn() };
  view.setRestartNeeded(false);
});

afterEach(() => {
  delete window.applyAppearanceSettings;
  delete window.appState;
});

describe('registry walk: coverage guards', () => {
  test('every custom row is listed with the suite that covers it', () => {
    const custom = allRows().filter((s) => s.type === 'custom').map((s) => s.id).sort();
    expect(custom).toEqual(Object.keys(CUSTOM_ROWS).sort());
  });

  test('every visibleIf row has a both-ways case', () => {
    const gated = allRows().filter((s) => typeof s.visibleIf === 'function').map((s) => s.id).sort();
    expect(gated).toEqual(Object.keys(VISIBLE_IF).sort());
  });

  test('every value row side effect has an expectation, every button an expected IPC', () => {
    for (const s of allRows()) {
      if (s.type === 'button') expect(BUTTON_EXPECT[s.id]).toBeDefined();
      else if (s.sideEffect) expect(EFFECT_EXPECT[s.sideEffect]).toBeDefined();
    }
    expect(Object.keys(BUTTON_EXPECT).sort()).toEqual(allRows().filter((s) => s.type === 'button').map((s) => s.id).sort());
  });

  test('every row renders exactly once with a non-empty search blob', () => {
    for (const s of allRows()) {
      expect(document.querySelectorAll(`.settings-v2-row[data-setting-id="${s.id}"]`).length).toBe(1);
      expect(rowEl(s.id).dataset.search.length).toBeGreaterThan(0);
      expect(rowEl(s.id).querySelector('.sv-error')).toBeNull();
    }
  });
});

const VALUE_ROWS = (() => {
  // REGISTRY rows are static; read them once (outside isolateModules) for test.each titles.
  const { REGISTRY } = require('../../../../../renderer/components/settings/registry');
  return REGISTRY.flatMap((p) => p.settings).filter((s) => s.type !== 'custom' && s.type !== 'button').map((s) => [s.id, s.type]);
})();

describe('registry walk: every value row persists through its control', () => {
  test.each(VALUE_ROWS)('%s (%s)', (id) => {
    const { setting } = entry(id);
    const value = nextValue(setting);
    drive(id, value);
    expect(sent('config:set')).toEqual([['config:set', { path: setting.path, value }]]);
    expect(configBridge.get(setting.path)).toEqual(value);
    if (setting.sideEffect) {
      EFFECT_EXPECT[setting.sideEffect](setting, value);
    } else {
      expect(channels()).toEqual(['config:set']);
      expect(window.applyAppearanceSettings).not.toHaveBeenCalled();
    }
    expect(document.querySelector('.settings-v2-restart-hint').hidden).toBe(!setting.requiresRestart);
    expect(rowEl(id).querySelector('.settings-v2-row-error').hidden).toBe(true);
  });
});

describe('registry walk: buttons', () => {
  test.each(Object.entries(BUTTON_EXPECT))('%s fires %s and persists nothing', async (id, expected) => {
    window.browserDataPanel = { toggle: jest.fn() };
    rowEl(id).querySelector('.settings-v2-row-control button').click();
    if (id === 'advanced.resetAll') {
      expect(channels()).not.toContain('settings:reset-all');
      document.querySelector('.confirm-dialog-overlay .confirm-dialog-confirm').click();
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    }
    if (expected === 'openBrowserDataPanel') {
      jest.advanceTimersByTime(100);
      expect(window.browserDataPanel.toggle).toHaveBeenCalledTimes(1);
    } else {
      expect(channels()).toContain(expected);
    }
    expect(sent('config:set')).toEqual([]);
    expect(rowEl(id).querySelector('.settings-v2-row-error').hidden).toBe(true);
    delete window.browserDataPanel;
  });
});

describe('registry walk: visibleIf both ways', () => {
  test.each(Object.keys(VISIBLE_IF))('%s', (id) => {
    const { show, hide } = VISIBLE_IF[id];
    for (const [ctl, v] of show) drive(ctl, v);
    expect(rowEl(id).hidden).toBe(false);
    expect(entry(id).setting.visibleIf(configBridge.snapshot())).toBe(true);
    for (const [ctl, v] of hide) drive(ctl, v);
    expect(rowEl(id).hidden).toBe(true);
    expect(entry(id).setting.visibleIf(configBridge.snapshot())).toBe(false);
    for (const [ctl, v] of show) drive(ctl, v);
    expect(rowEl(id).hidden).toBe(false);
  });
});

describe('registry walk: invalid input is rejected', () => {
  const NUMBER_ROWS = VALUE_ROWS.filter(([, t]) => t === 'number').map(([id]) => id);
  const SELECT_ROWS = VALUE_ROWS.filter(([, t]) => t === 'select').map(([id]) => id);

  test.each(NUMBER_ROWS)('%s clamps out-of-range input to min/max', (id) => {
    const { setting } = entry(id);
    drive(id, setting.max * 10 + 1);
    expect(sent('config:set').pop()[1]).toEqual({ path: setting.path, value: setting.max });
    drive(id, setting.min - 1000);
    expect(sent('config:set').pop()[1]).toEqual({ path: setting.path, value: setting.min });
  });

  test.each(NUMBER_ROWS)('%s rejects empty input without persisting', (id) => {
    const { setting } = entry(id);
    const before = configBridge.get(setting.path);
    drive(id, '');
    expect(sent('config:set')).toEqual([]);
    const input = rowEl(id).querySelector('.settings-v2-row-control input');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.value).toBe(String(before));
    expect(configBridge.get(setting.path)).toBe(before);
  });

  test.each(SELECT_ROWS)('%s does not persist a value outside its options', (id) => {
    const sel = rowEl(id).querySelector('.settings-v2-row-control select');
    const before = sel.value;
    sel.appendChild(Object.assign(document.createElement('option'), { value: '__rogue__' }));
    sel.value = '__rogue__';
    sel.dispatchEvent(new Event('change'));
    expect(sent('config:set')).toEqual([]);
    expect(sel.value).toBe(before);
    sel.lastElementChild.remove();
  });
});

describe('registry walk: dynamicOptions sources', () => {
  const optionValues = (id) => Array.from(rowEl(id).querySelectorAll('.settings-v2-row-control option')).map((o) => [o.value, o.textContent]);

  test('general.defaultSpace lists the configured spaces by name and is searchable by them', () => {
    const spaces = Object.entries(makeConfig().spaces).map(([sid, sp]) => [sid, sp.name]);
    expect(optionValues('general.defaultSpace')).toEqual(spaces);
    expect(entry('general.defaultSpace').setting._search).toContain('chatgpt');
  });

  test('search.defaultEngine lists the built-in engines followed by custom ones', () => {
    const opts = optionValues('search.defaultEngine');
    expect(opts[0]).toEqual(['google', 'Google']);
    expect(opts[opts.length - 1]).toEqual(['myeng', 'MyEngine']);
    expect(opts.length).toBe(8);
  });

  test('privacy.dnsProvider lists the DoH catalog ending with Custom URL', () => {
    const opts = optionValues('privacy.dnsProvider');
    expect(opts.map(([v]) => v)).toEqual(['cloudflare', 'google', 'quad9', 'nextdns', 'adguard', 'opendns', 'custom']);
  });

  test('an unknown dynamicOptions source renders a visible row error instead of throwing', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    document.body.innerHTML = '';
    let other;
    let reg;
    jest.isolateModules(() => {
      reg = require('../../../../../renderer/components/settings/registry');
      other = require('../../../../../renderer/components/settings/SettingsView');
    });
    const row = reg.REGISTRY.flatMap((p) => p.settings).find((s) => s.id === 'general.defaultSpace');
    row.dynamicOptions = 'nope';
    expect(() => other.initialize(makeConfig())).not.toThrow();
    const err = document.querySelector('.settings-v2-row[data-setting-id="general.defaultSpace"] .sv-error');
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toBe('Couldn\'t show this setting: Unknown dynamicOptions source "nope" on general.defaultSpace');
    errSpy.mockRestore();
  });
});

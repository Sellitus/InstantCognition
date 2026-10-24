// customModules — render functions for `type: 'custom'` registry entries.

// Dialogs are mocked module-wide so tests can drive destructive confirms and
// text prompts without rendering the real ConfirmDialog/PromptDialog DOM.
// Per-test overrides:  ConfirmDialog.confirm.mockResolvedValueOnce(false)
// PromptDialog.prompt.mockResolvedValueOnce('typed')
jest.mock('../../../../../renderer/components/ConfirmDialog', () => ({
  confirm: jest.fn(() => Promise.resolve(true)),
}));
jest.mock('../../../../../renderer/components/PromptDialog', () => ({
  prompt: jest.fn(() => Promise.resolve('')),
}));
const ConfirmDialog = require('../../../../../renderer/components/ConfirmDialog');
const PromptDialog = require('../../../../../renderer/components/PromptDialog');

jest.mock('electron', () => ({
  ipcRenderer: { send: jest.fn(), on: jest.fn(), invoke: jest.fn(() => Promise.resolve(null)) },
}));

beforeEach(() => {
  ConfirmDialog.confirm.mockReset();
  ConfirmDialog.confirm.mockResolvedValue(true);
  PromptDialog.prompt.mockReset();
  PromptDialog.prompt.mockResolvedValue('');
});

const { ipcRenderer } = require('electron');

function loadModules() {
  let mods;
  jest.isolateModules(() => { mods = require('../../../../../renderer/components/settings/customModules'); });
  return mods;
}

function fakeBridge(initialConfig = {}) {
  const store = JSON.parse(JSON.stringify(initialConfig));
  const setCalls = [];
  return {
    snapshot: () => JSON.parse(JSON.stringify(store)),
    get: (path, fb) => {
      const parts = String(path).split('.');
      let cur = store;
      for (const p of parts) {
        if (cur == null || typeof cur !== 'object') return fb;
        cur = cur[p];
      }
      return cur === undefined ? fb : cur;
    },
    set: jest.fn((path, value) => {
      setCalls.push({ path, value });
      const parts = String(path).split('.');
      let cur = store;
      for (let i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
    }),
    update: jest.fn(),
    replace: jest.fn(),
    refresh: jest.fn(),
    _setCalls: setCalls,
  };
}

describe('customModules', () => {
  let host;
  beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    ipcRenderer.send.mockClear();
    ipcRenderer.invoke.mockClear();
  });

  // -- spaces editor --------------------------------------------------------

  test('spaces() renders one row per space + add/reset buttons', () => {
    const mods = loadModules();
    const bridge = fakeBridge({ spaces: { custom1: { name: 'ChatGPT', url: 'https://chatgpt.com/' }, custom2: { name: 'Claude', url: 'https://claude.ai/' } } });
    mods.spaces({ host, configBridge: bridge });
    const rows = host.querySelectorAll('.sv-space-row');
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector('.sv-space-name').value).toBe('ChatGPT');
    expect(host.querySelectorAll('button').length).toBeGreaterThanOrEqual(2); // Add + Reset (+ row removes)
  });

  test('spaces() editing a name writes to spaces.<id>.name via configBridge', () => {
    const mods = loadModules();
    const bridge = fakeBridge({ spaces: { custom1: { name: 'Old', url: 'https://x' } } });
    mods.spaces({ host, configBridge: bridge });
    const nameInput = host.querySelector('.sv-space-name');
    nameInput.value = 'New';
    nameInput.dispatchEvent(new Event('change'));
    expect(bridge._setCalls).toContainEqual({ path: 'spaces.custom1.name', value: 'New' });
  });

  test('spaces() reset button confirms then sends spaces:reset', async () => {
    const mods = loadModules();
    const bridge = fakeBridge({ spaces: {} });
    mods.spaces({ host, configBridge: bridge });
    const resetBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Reset to defaults');
    await resetBtn.click();
    expect(ipcRenderer.send).toHaveBeenCalledWith('spaces:reset');
  });

  // -- shortcuts editor -----------------------------------------------------

  test('shortcuts() renders the search box, list, and reset button', () => {
    const mods = loadModules();
    const bridge = fakeBridge({ settings: { shortcuts: {} } });
    mods.shortcuts({ host, configBridge: bridge });
    expect(host.querySelector('input[type="search"]')).not.toBeNull();
    expect(host.querySelector('.sv-shortcuts-list')).not.toBeNull();
    const resetBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent.includes('Reset'));
    expect(resetBtn).not.toBeNull();
  });

  test('shortcuts() search filter narrows the visible rows', () => {
    const mods = loadModules();
    const bridge = fakeBridge({ settings: { shortcuts: {} } });
    mods.shortcuts({ host, configBridge: bridge });
    const total = host.querySelectorAll('.sv-shortcut-row').length;
    const search = host.querySelector('input[type="search"]');
    search.value = 'asdfqwerzzz';
    search.dispatchEvent(new Event('input'));
    const filtered = host.querySelectorAll('.sv-shortcut-row').length;
    expect(filtered).toBeLessThan(total);
    expect(host.textContent).toContain('No shortcuts match');
  });

  // -- permissions ----------------------------------------------------------

  test('permissions() renders v2 list rows and revokes through IPC', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'notifications:permission:list-overrides') {
        return Promise.resolve({ 'https://example.com|notifications': 'allow' });
      }
      if (channel === 'notifications:permission:clear-override') return Promise.resolve({});
      return Promise.resolve(null);
    });

    const mods = loadModules();
    mods.permissions({ host });
    await Promise.resolve();
    await Promise.resolve();

    expect(host.querySelector('.sv-permission-row')).not.toBeNull();
    expect(host.querySelector('.sv-status-badge.is-allow')).not.toBeNull();
    expect(host.querySelector('.action-button')).toBeNull();

    host.querySelector('.sv-permission-revoke').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('notifications:permission:clear-override', {
      origin: 'https://example.com',
      permission: 'notifications',
    });
  });

  // -- download location ----------------------------------------------------

  test('downloadLocation() renders current path; "Use OS default" clears it', () => {
    const mods = loadModules();
    const bridge = fakeBridge({ settings: { downloadLocation: '/tmp/dl' } });
    mods.downloadLocation({ host, configBridge: bridge });
    expect(host.querySelector('.sv-path').textContent).toBe('/tmp/dl');
    const clearBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Use OS default');
    clearBtn.click();
    expect(bridge._setCalls).toContainEqual({ path: 'settings.downloadLocation', value: null });
  });

  test('downloadLocation() Choose folder writes the picked path', async () => {
    ipcRenderer.invoke.mockResolvedValueOnce('/picked/dir');
    const mods = loadModules();
    const bridge = fakeBridge({ settings: { downloadLocation: null } });
    mods.downloadLocation({ host, configBridge: bridge });
    const browse = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Choose folder…');
    await browse.click();
    // Wait one microtask for the awaited invoke to resolve.
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge._setCalls).toContainEqual({ path: 'settings.downloadLocation', value: '/picked/dir' });
  });

  // -- spell-check / accept languages --------------------------------------

  test('spellCheckLanguages() persists comma-separated list and triggers apply IPC', () => {
    const mods = loadModules();
    const bridge = fakeBridge({ settings: { spellCheck: { languages: ['en-US'] } } });
    mods.spellCheckLanguages({ host, configBridge: bridge });
    const input = host.querySelector('input');
    input.value = 'en-US, en-GB, fr';
    input.dispatchEvent(new Event('change'));
    expect(bridge._setCalls).toContainEqual({ path: 'settings.spellCheck.languages', value: ['en-US', 'en-GB', 'fr'] });
    expect(ipcRenderer.send).toHaveBeenCalledWith('settings:apply-spellcheck');
  });

  test('acceptLanguages() persists list and fires settings:apply-accept-languages', () => {
    const mods = loadModules();
    const bridge = fakeBridge({ settings: { acceptLanguages: ['en-US', 'en'] } });
    mods.acceptLanguages({ host, configBridge: bridge });
    const input = host.querySelector('input');
    input.value = 'fr, en';
    input.dispatchEvent(new Event('change'));
    expect(bridge._setCalls).toContainEqual({ path: 'settings.acceptLanguages', value: ['fr', 'en'] });
    expect(ipcRenderer.send).toHaveBeenCalledWith('settings:apply-accept-languages');
  });

  // -- about panel ----------------------------------------------------------

  test('about() renders version info grid + GitHub/Issues buttons', () => {
    const mods = loadModules();
    mods.about({ host });
    const labels = Array.from(host.querySelectorAll('.sv-about-label')).map((el) => el.textContent);
    expect(labels).toEqual(expect.arrayContaining(['App version', 'Electron', 'Chromium', 'Node', 'V8', 'Platform']));
    const buttons = Array.from(host.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toEqual(expect.arrayContaining(['GitHub', 'Report a bug']));
  });

  test('about() GitHub button uses open-external-url (not the renderer-tab open-url)', () => {
    const mods = loadModules();
    mods.about({ host });
    const githubBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'GitHub');
    githubBtn.click();
    const channels = ipcRenderer.send.mock.calls.map((c) => c[0]);
    expect(channels).toContain('open-external-url');
    expect(channels).not.toContain('open-url'); // catch the C1 regression
  });

  // -- dnsCustomUrl ---------------------------------------------------------

  describe('dnsCustomUrl()', () => {
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.useRealTimers(); });

    test('typing the URL persists it on a debounce — no Apply click required', () => {
      const mods = loadModules();
      const bridge = fakeBridge({ settings: { dns: { customUrl: '' } } });
      mods.dnsCustomUrl({ host, configBridge: bridge });
      const input = host.querySelector('input');
      input.value = 'https://dns.example.com/dns-query';
      input.dispatchEvent(new Event('input'));
      // Save is debounced (~300ms) so a flurry of keystrokes coalesces.
      jest.advanceTimersByTime(350);
      expect(bridge._setCalls).toContainEqual({ path: 'settings.dns.customUrl', value: 'https://dns.example.com/dns-query' });
    });

    test('Apply flushes any pending save and sends dns:apply', () => {
      const mods = loadModules();
      const bridge = fakeBridge({ settings: { dns: { customUrl: '' } } });
      mods.dnsCustomUrl({ host, configBridge: bridge });
      const input = host.querySelector('input');
      input.value = 'https://dns.example.com/dns-query';
      input.dispatchEvent(new Event('input'));
      // Apply BEFORE the debounced save fires — Apply should still flush.
      Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Apply').click();
      expect(bridge._setCalls).toContainEqual({ path: 'settings.dns.customUrl', value: 'https://dns.example.com/dns-query' });
      expect(ipcRenderer.send).toHaveBeenCalledWith('dns:apply');
    });

    test('Apply with empty input shows an error and does NOT send dns:apply', () => {
      const mods = loadModules();
      const bridge = fakeBridge({ settings: { dns: { customUrl: '' } } });
      mods.dnsCustomUrl({ host, configBridge: bridge });
      Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Apply').click();
      expect(host.querySelector('.sv-validation-status').textContent).toMatch(/Enter a URL/);
      expect(ipcRenderer.send).not.toHaveBeenCalledWith('dns:apply');
    });

    test('Validate success surfaces ✓ — Validate is verification only, never gates save', async () => {
      ipcRenderer.invoke.mockImplementation((channel) => {
        if (channel === 'dns:validate') return Promise.resolve({ ok: true });
        return Promise.resolve(null);
      });
      const mods = loadModules();
      const bridge = fakeBridge({ settings: { dns: { customUrl: '' } } });
      mods.dnsCustomUrl({ host, configBridge: bridge });
      host.querySelector('input').value = 'https://dns.example.com/dns-query';
      Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Validate').click();
      await Promise.resolve(); await Promise.resolve();
      expect(host.querySelector('.sv-validation-status').textContent).toMatch(/Valid DoH/);
    });

    test('Validate failure surfaces the error', async () => {
      ipcRenderer.invoke.mockImplementation((channel) => {
        if (channel === 'dns:validate') return Promise.resolve({ ok: false, error: 'Bad URL' });
        return Promise.resolve(null);
      });
      const mods = loadModules();
      const bridge = fakeBridge({ settings: { dns: { customUrl: '' } } });
      mods.dnsCustomUrl({ host, configBridge: bridge });
      host.querySelector('input').value = 'http://x';
      Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Validate').click();
      await Promise.resolve(); await Promise.resolve();
      expect(host.querySelector('.sv-validation-status').textContent).toMatch(/Bad URL/);
    });

    test('input pre-fills from saved config on render', () => {
      const mods = loadModules();
      const bridge = fakeBridge({ settings: { dns: { customUrl: 'https://saved.example.com/dns-query' } } });
      mods.dnsCustomUrl({ host, configBridge: bridge });
      expect(host.querySelector('input').value).toBe('https://saved.example.com/dns-query');
    });
  });

  // -- adblockerLists -------------------------------------------------------

  describe('adblockerLists()', () => {
    test('renders a checkbox per built-in list, checked when enabled', async () => {
      ipcRenderer.invoke.mockImplementation((channel) => {
        if (channel === 'adblocker:get-catalog') return Promise.resolve([
          { id: 'a', label: 'List A', url: 'https://a/' },
          { id: 'b', label: 'List B', url: 'https://b/' },
        ]);
        if (channel === 'adblocker:get-stats') return Promise.resolve({ enabled: true, activeListCount: 1, filterCount: 0, lastReloadAt: 0 });
        return Promise.resolve(null);
      });
      const mods = loadModules();
      const bridge = fakeBridge({ settings: { adblocker: { builtinEnabled: ['a'], customLists: [] } } });
      mods.adblockerLists({ host, configBridge: bridge });
      await Promise.resolve(); await Promise.resolve();
      const cbs = host.querySelectorAll('.sv-blocklist-check');
      expect(cbs.length).toBe(2);
      expect(cbs[0].checked).toBe(true);
      expect(cbs[1].checked).toBe(false);
    });

    test('toggling a built-in updates config and triggers reload', async () => {
      ipcRenderer.invoke.mockImplementation((channel) => {
        if (channel === 'adblocker:get-catalog') return Promise.resolve([{ id: 'a', label: 'List A', url: 'https://a/' }]);
        if (channel === 'adblocker:get-stats') return Promise.resolve({ enabled: true, activeListCount: 0, filterCount: 0, lastReloadAt: 0 });
        return Promise.resolve(null);
      });
      const mods = loadModules();
      const bridge = fakeBridge({ settings: { adblocker: { builtinEnabled: [], customLists: [] } } });
      mods.adblockerLists({ host, configBridge: bridge });
      await Promise.resolve(); await Promise.resolve();
      const cb = host.querySelector('.sv-blocklist-check');
      cb.checked = true;
      cb.dispatchEvent(new Event('change'));
      const persisted = bridge._setCalls.find((c) => c.path === 'settings.adblocker.builtinEnabled');
      expect(persisted).toBeTruthy();
      expect(persisted.value).toEqual(['a']);
      expect(ipcRenderer.send).toHaveBeenCalledWith('adblocker:reload');
    });

    test('valid custom URL is added and triggers reload', async () => {
      ipcRenderer.invoke.mockImplementation((channel) => {
        if (channel === 'adblocker:get-catalog') return Promise.resolve([]);
        if (channel === 'adblocker:get-stats') return Promise.resolve({ enabled: true, activeListCount: 0, filterCount: 0, lastReloadAt: 0 });
        if (channel === 'adblocker:validate') return Promise.resolve({ ok: true, filterCount: 42 });
        return Promise.resolve(null);
      });
      const mods = loadModules();
      const bridge = fakeBridge({ settings: { adblocker: { builtinEnabled: [], customLists: [] } } });
      mods.adblockerLists({ host, configBridge: bridge });
      await Promise.resolve(); await Promise.resolve();
      const urlInput = host.querySelector('.sv-blocklist-add-row input');
      urlInput.value = 'https://example.com/list.txt';
      Array.from(host.querySelectorAll('button')).find((b) => b.textContent.includes('Add')).click();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      const persisted = bridge._setCalls.find((c) => c.path === 'settings.adblocker.customLists');
      expect(persisted).toBeTruthy();
      expect(persisted.value[0].url).toBe('https://example.com/list.txt');
      expect(persisted.value[0].filterCount).toBe(42);
      expect(ipcRenderer.send).toHaveBeenCalledWith('adblocker:reload');
    });

    test('invalid custom URL is NOT persisted', async () => {
      ipcRenderer.invoke.mockImplementation((channel) => {
        if (channel === 'adblocker:get-catalog') return Promise.resolve([]);
        if (channel === 'adblocker:get-stats') return Promise.resolve({ enabled: true, activeListCount: 0, filterCount: 0, lastReloadAt: 0 });
        if (channel === 'adblocker:validate') return Promise.resolve({ ok: false, error: 'Not a filter list' });
        return Promise.resolve(null);
      });
      const mods = loadModules();
      const bridge = fakeBridge({ settings: { adblocker: { builtinEnabled: [], customLists: [] } } });
      mods.adblockerLists({ host, configBridge: bridge });
      await Promise.resolve(); await Promise.resolve();
      const urlInput = host.querySelector('.sv-blocklist-add-row input');
      urlInput.value = 'https://example.com/not-a-list.html';
      Array.from(host.querySelectorAll('button')).find((b) => b.textContent.includes('Add')).click();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      const persisted = bridge._setCalls.find((c) => c.path === 'settings.adblocker.customLists');
      expect(persisted).toBeUndefined();
    });
  });
});

// groupVoices() organizes the flat OS voice list into language/region
// optgroups for the voice picker (jsdom navigator.language is 'en-US', so
// Intl.DisplayNames yields stable English labels).

describe('groupVoices()', () => {
  test('buckets voices by language/region with readable, label-sorted groups', () => {
    const { groupVoices } = loadModules();
    const groups = groupVoices([
      { voiceURI: 'fr', name: 'Zoe', lang: 'fr-FR' },
      { voiceURI: 'us', name: 'Alice', lang: 'en-US' },
      { voiceURI: 'gb', name: 'Bob', lang: 'en-GB' },
    ]);
    const labels = groups.map((g) => g.label);
    expect(labels).toHaveLength(3);
    // Region appears parenthesized; language name is human-readable.
    expect(labels.some((l) => /English \(United States\)/.test(l))).toBe(true);
    expect(labels.some((l) => /English \(United Kingdom\)/.test(l))).toBe(true);
    expect(labels.some((l) => /French \(France\)/.test(l))).toBe(true);
    // Groups are sorted by label ascending.
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  test('voices within a group are sorted by name', () => {
    const { groupVoices } = loadModules();
    const groups = groupVoices([
      { voiceURI: 'z', name: 'Zoe', lang: 'en-US' },
      { voiceURI: 'a', name: 'Alice', lang: 'en-US' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].voices.map((v) => v.name)).toEqual(['Alice', 'Zoe']);
  });

  test('a bare language tag with no region produces an unparenthesized label', () => {
    const { groupVoices } = loadModules();
    const [g] = groupVoices([{ voiceURI: 'en', name: 'Generic', lang: 'en' }]);
    expect(g.label).toBe('English');
    expect(g.label).not.toContain('(');
  });

  test('an empty/missing language tag falls into an "Other" group', () => {
    const { groupVoices } = loadModules();
    const groups = groupVoices([{ voiceURI: 'x', name: 'NoLang', lang: '' }]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Other');
    expect(groups[0].voices[0].name).toBe('NoLang');
  });

  test('underscore-style lang tags (en_GB) are normalized and merged with en-GB', () => {
    const { groupVoices } = loadModules();
    const groups = groupVoices([
      { voiceURI: 'a', name: 'A', lang: 'en_GB' },
      { voiceURI: 'b', name: 'B', lang: 'en-GB' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].voices).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Shared host setup for the appended module suites.
// ---------------------------------------------------------------------------

function freshHost() {
  document.body.innerHTML = '';
  const host = document.createElement('div');
  document.body.appendChild(host);
  return host;
}

const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const findBtn = (host, text) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent.includes(text));

// -- spaces() add / remove (uncovered branches) -----------------------------

describe('customModules.spaces() add & remove', () => {
  beforeEach(() => { ipcRenderer.send.mockClear(); });

  test('Add space prompts twice and sends spaces:add when both answered', async () => {
    PromptDialog.prompt
      .mockResolvedValueOnce('My Space')
      .mockResolvedValueOnce('https://my.example/');
    const mods = loadModules();
    const host = freshHost();
    mods.spaces({ host, configBridge: fakeBridge({ spaces: {} }) });
    await findBtn(host, 'Add space').click();
    await tick();
    expect(ipcRenderer.send).toHaveBeenCalledWith('spaces:add', { name: 'My Space', url: 'https://my.example/', type: 'web-page' });
  });

  test('Add space aborts (no IPC) when the name prompt is cancelled', async () => {
    PromptDialog.prompt.mockResolvedValueOnce(null);
    const mods = loadModules();
    const host = freshHost();
    mods.spaces({ host, configBridge: fakeBridge({ spaces: {} }) });
    await findBtn(host, 'Add space').click();
    expect(ipcRenderer.send).not.toHaveBeenCalledWith('spaces:add', expect.anything());
  });

  test('Add space aborts when the URL prompt is cancelled (name given)', async () => {
    PromptDialog.prompt
      .mockResolvedValueOnce('Named')
      .mockResolvedValueOnce(null);
    const mods = loadModules();
    const host = freshHost();
    mods.spaces({ host, configBridge: fakeBridge({ spaces: {} }) });
    await findBtn(host, 'Add space').click();
    expect(ipcRenderer.send).not.toHaveBeenCalledWith('spaces:add', expect.anything());
  });

  test('Remove confirmed sends spaces:remove and optimistically replaces config sans the space', async () => {
    ConfirmDialog.confirm.mockResolvedValueOnce(true);
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ spaces: { custom1: { name: 'Gone', url: 'https://x' } } });
    mods.spaces({ host, configBridge: bridge });
    expect(host.querySelectorAll('.sv-space-row').length).toBe(1);
    await host.querySelector('.sv-space-remove').click();
    expect(ipcRenderer.send).toHaveBeenCalledWith('spaces:remove', 'custom1');
    // Optimistic local-cache update: replace() is called with the space dropped.
    expect(bridge.replace).toHaveBeenCalledTimes(1);
    expect(bridge.replace.mock.calls[0][0].spaces.custom1).toBeUndefined();
  });

  test('Remove cancelled does NOT send spaces:remove', async () => {
    ConfirmDialog.confirm.mockResolvedValueOnce(false);
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ spaces: { custom1: { name: 'Stay', url: 'https://x' } } });
    mods.spaces({ host, configBridge: bridge });
    await host.querySelector('.sv-space-remove').click();
    expect(ipcRenderer.send).not.toHaveBeenCalledWith('spaces:remove', 'custom1');
    expect(host.querySelectorAll('.sv-space-row').length).toBe(1);
  });

  test('empty spaces map renders the empty-row placeholder', () => {
    const mods = loadModules();
    const host = freshHost();
    mods.spaces({ host, configBridge: fakeBridge({ spaces: {} }) });
    expect(host.querySelector('.sv-empty-row').textContent).toContain('No spaces yet');
  });

  test('editing a url writes spaces.<id>.url', () => {
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ spaces: { c1: { name: 'N', url: 'https://old' } } });
    mods.spaces({ host, configBridge: bridge });
    const urlInput = host.querySelector('.sv-space-url');
    urlInput.value = 'https://new';
    urlInput.dispatchEvent(new Event('change'));
    expect(bridge._setCalls).toContainEqual({ path: 'spaces.c1.url', value: 'https://new' });
  });

  test('reset cancelled does not send spaces:reset', async () => {
    ConfirmDialog.confirm.mockResolvedValueOnce(false);
    const mods = loadModules();
    const host = freshHost();
    mods.spaces({ host, configBridge: fakeBridge({ spaces: {} }) });
    await findBtn(host, 'Reset to defaults').click();
    expect(ipcRenderer.send).not.toHaveBeenCalledWith('spaces:reset');
  });
});

// -- shortcuts() edit / reset (uncovered branches) --------------------------

describe('customModules.shortcuts() edit & reset', () => {
  beforeEach(() => { ipcRenderer.send.mockClear(); });

  test('Edit then pressing a key serializes and persists settings.shortcuts subtree', () => {
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { shortcuts: {} } });
    mods.shortcuts({ host, configBridge: bridge });
    const firstRow = host.querySelector('.sv-shortcut-row');
    expect(firstRow).not.toBeNull();
    findBtn(firstRow, 'Edit').click();
    expect(firstRow.querySelector('.sv-shortcut-key').textContent).toBe('Press keys…');
    // A real (non-modifier) key fires; eventToShortcut yields a key string.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F9', bubbles: true }));
    const persisted = bridge._setCalls.find((c) => c.path === 'settings.shortcuts');
    expect(persisted).toBeTruthy();
    expect(typeof persisted.value).toBe('object');
  });

  test('Escape during recording cancels — key label reverts, nothing persisted', () => {
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { shortcuts: {} } });
    mods.shortcuts({ host, configBridge: bridge });
    const row = host.querySelector('.sv-shortcut-row');
    const before = row.querySelector('.sv-shortcut-key').textContent;
    findBtn(row, 'Edit').click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(row.querySelector('.sv-shortcut-key').textContent).toBe(before);
    expect(bridge._setCalls.find((c) => c.path === 'settings.shortcuts')).toBeUndefined();
  });

  test('Reset confirmed clears settings.shortcuts and re-renders rows', async () => {
    ConfirmDialog.confirm.mockResolvedValueOnce(true);
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { shortcuts: {} } });
    mods.shortcuts({ host, configBridge: bridge });
    await findBtn(host, 'Reset all to defaults').click();
    expect(bridge._setCalls).toContainEqual({ path: 'settings.shortcuts', value: {} });
    expect(host.querySelectorAll('.sv-shortcut-row').length).toBeGreaterThan(0);
  });

  test('Reset cancelled leaves settings.shortcuts untouched', async () => {
    ConfirmDialog.confirm.mockResolvedValueOnce(false);
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { shortcuts: {} } });
    mods.shortcuts({ host, configBridge: bridge });
    await findBtn(host, 'Reset all to defaults').click();
    expect(bridge._setCalls.find((c) => c.path === 'settings.shortcuts')).toBeUndefined();
  });
});

// -- userMemory() -----------------------------------------------------------

describe('customModules.userMemory()', () => {
  beforeEach(() => { ipcRenderer.send.mockClear(); ipcRenderer.invoke.mockClear(); });

  function withFacts(facts, enabled = true) {
    ipcRenderer.invoke.mockImplementation((channel, arg) => {
      if (channel === 'usermemory:list') return Promise.resolve({ enabled, facts });
      return Promise.resolve({ ok: true, count: 1, added: 1, skipped: 0 });
    });
  }

  test('renders one row per live fact, the enable checkbox reflects state', async () => {
    withFacts([
      { id: '1', text: 'Likes Go', pinned: false, archived: false, createdAt: 2 },
      { id: '2', text: 'Uses React', pinned: true, archived: false, createdAt: 1 },
    ], true);
    const mods = loadModules();
    const host = freshHost();
    mods.userMemory({ host });
    await tick();
    expect(host.querySelectorAll('.sv-usermem-row').length).toBe(2);
    expect(host.querySelector('input[type="checkbox"]').checked).toBe(true);
    // Pinned fact sorts first.
    expect(host.querySelector('.sv-usermem-row').classList.contains('is-pinned')).toBe(true);
  });

  test('empty live list shows the empty-row hint and no rows', async () => {
    withFacts([], false);
    const mods = loadModules();
    const host = freshHost();
    mods.userMemory({ host });
    await tick();
    expect(host.querySelector('.sv-empty-row').textContent).toContain('No facts yet');
    expect(host.querySelector('input[type="checkbox"]').checked).toBe(false);
  });

  test('archived facts get a disclosure section', async () => {
    withFacts([
      { id: '1', text: 'live', archived: false, createdAt: 1 },
      { id: '2', text: 'old', archived: true, createdAt: 0 },
    ]);
    const mods = loadModules();
    const host = freshHost();
    mods.userMemory({ host });
    await tick();
    const details = host.querySelector('details.sv-usermem-archived');
    expect(details).not.toBeNull();
    expect(details.querySelector('summary').textContent).toBe('Archived (1)');
  });

  test('Add fact invokes usermemory:add with the typed text and clears the input', async () => {
    withFacts([]);
    const mods = loadModules();
    const host = freshHost();
    mods.userMemory({ host });
    await tick();
    const addInput = host.querySelector('.sv-usermem-add-row input');
    addInput.value = '  I prefer dark mode  ';
    findBtn(host, 'Add fact').click();
    await tick();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('usermemory:add', { text: 'I prefer dark mode' });
    expect(addInput.value).toBe('');
  });

  test('Add fact with blank input does NOT invoke usermemory:add', async () => {
    withFacts([]);
    const mods = loadModules();
    const host = freshHost();
    mods.userMemory({ host });
    await tick();
    host.querySelector('.sv-usermem-add-row input').value = '   ';
    findBtn(host, 'Add fact').click();
    await tick();
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('usermemory:add', expect.anything());
  });

  test('Enter key in the add input submits', async () => {
    withFacts([]);
    const mods = loadModules();
    const host = freshHost();
    mods.userMemory({ host });
    await tick();
    const addInput = host.querySelector('.sv-usermem-add-row input');
    addInput.value = 'via enter';
    addInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('usermemory:add', { text: 'via enter' });
  });

  test('enable toggle sends usermemory:enable with the checkbox state', async () => {
    withFacts([], true);
    const mods = loadModules();
    const host = freshHost();
    mods.userMemory({ host });
    await tick();
    const cb = host.querySelector('input[type="checkbox"]');
    cb.checked = false;
    cb.dispatchEvent(new Event('change'));
    expect(ipcRenderer.send).toHaveBeenCalledWith('usermemory:enable', false);
  });

  test('pin / archive / delete row buttons invoke the matching IPC', async () => {
    ConfirmDialog.confirm.mockResolvedValueOnce(true);
    withFacts([{ id: 'f1', text: 'fact', pinned: false, archived: false, createdAt: 1 }]);
    const mods = loadModules();
    const host = freshHost();
    mods.userMemory({ host });
    await tick();
    host.querySelector('.sv-usermem-pin').click();
    await tick();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('usermemory:pin', { id: 'f1', on: true });
    host.querySelector('.sv-usermem-archive').click();
    await tick();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('usermemory:archive', { id: 'f1', on: true });
    await host.querySelector('.sv-usermem-delete').click();
    await tick();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('usermemory:delete', 'f1');
  });

  test('delete is skipped when the confirm is declined', async () => {
    ConfirmDialog.confirm.mockResolvedValueOnce(false);
    withFacts([{ id: 'f1', text: 'keep', archived: false, createdAt: 1 }]);
    const mods = loadModules();
    const host = freshHost();
    mods.userMemory({ host });
    await tick();
    await host.querySelector('.sv-usermem-delete').click();
    await tick();
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('usermemory:delete', 'f1');
  });

  test('editing a fact textarea to non-empty invokes usermemory:edit; blank is ignored', async () => {
    withFacts([{ id: 'f1', text: 'orig', archived: false, createdAt: 1 }]);
    const mods = loadModules();
    const host = freshHost();
    mods.userMemory({ host });
    await tick();
    const ta = host.querySelector('.sv-usermem-text');
    ta.value = 'updated';
    ta.dispatchEvent(new Event('change'));
    await tick();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('usermemory:edit', { id: 'f1', patch: { text: 'updated' } });
    ipcRenderer.invoke.mockClear();
    withFacts([{ id: 'f1', text: 'orig', archived: false, createdAt: 1 }]);
    ta.value = '   ';
    ta.dispatchEvent(new Event('change'));
    await tick();
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('usermemory:edit', expect.anything());
  });

  test('list IPC rejection renders a visible error row instead of an empty list', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'usermemory:list') return Promise.reject(new Error('boom'));
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    expect(() => mods.userMemory({ host })).not.toThrow();
    await tick();
    const err = host.querySelector('.sv-empty-row--error');
    expect(err).not.toBeNull();
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toBe("Couldn't load memory facts: boom");
    expect(host.querySelector('.sv-empty-row:not(.sv-empty-row--error)')).toBeNull();
  });

  test('Export reports the exported count; Import refreshes; Clear-all confirms once then clears', async () => {
    ConfirmDialog.confirm.mockResolvedValueOnce(true);
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'usermemory:list') return Promise.resolve({ enabled: true, facts: [] });
      if (channel === 'usermemory:export') return Promise.resolve({ ok: true, count: 3 });
      if (channel === 'usermemory:import') return Promise.resolve({ ok: true, added: 2, skipped: 1 });
      if (channel === 'usermemory:clear-all') return Promise.resolve({ ok: true });
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    mods.userMemory({ host });
    await tick();
    const status = host.querySelector('.sv-persona-io-status');
    findBtn(host, 'Export').click();
    await tick();
    expect(status.textContent).toBe('Exported 3 facts.');
    findBtn(host, 'Import').click();
    await tick();
    expect(status.textContent).toContain('Imported 2');
    await findBtn(host, 'Clear all').click();
    await tick();
    expect(ConfirmDialog.confirm).toHaveBeenCalledTimes(1);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('usermemory:clear-all');
  });

  test('Export failure and canceled paths surface distinct messages', async () => {
    let exportResult = { ok: false, error: 'disk full' };
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'usermemory:list') return Promise.resolve({ enabled: true, facts: [] });
      if (channel === 'usermemory:export') return Promise.resolve(exportResult);
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    mods.userMemory({ host });
    await tick();
    const status = host.querySelector('.sv-persona-io-status');
    findBtn(host, 'Export').click();
    await tick();
    expect(status.textContent).toBe('Export failed: disk full');
    exportResult = { canceled: true };
    findBtn(host, 'Export').click();
    await tick();
    expect(status.textContent).toBe('');
  });

  test('Import failure path surfaces the error message', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'usermemory:list') return Promise.resolve({ enabled: true, facts: [] });
      if (channel === 'usermemory:import') return Promise.resolve({ ok: false, error: 'bad file' });
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    mods.userMemory({ host });
    await tick();
    findBtn(host, 'Import').click();
    await tick();
    expect(host.querySelector('.sv-persona-io-status').textContent).toBe('Import failed: bad file');
  });
});

// -- personas() -------------------------------------------------------------

describe('customModules.personas()', () => {
  beforeEach(() => { ipcRenderer.send.mockClear(); ipcRenderer.invoke.mockClear(); });

  function personaList(all) {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'persona:list') return Promise.resolve({ all });
      if (channel === 'persona:test-route') return Promise.resolve({ ok: true, name: 'shopping', source: 'keyword' });
      if (channel === 'persona:clear-cache') return Promise.resolve({ ok: true });
      return Promise.resolve(null);
    });
  }

  test('router + LLM-fallback toggles default ON and persist on change', () => {
    personaList([]);
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: {} });
    mods.personas({ host, configBridge: bridge });
    const [routerCb, llmCb] = host.querySelectorAll('.sv-row--toggles input[type="checkbox"]');
    expect(routerCb.checked).toBe(true);
    expect(llmCb.checked).toBe(true);
    routerCb.checked = false;
    routerCb.dispatchEvent(new Event('change'));
    expect(bridge._setCalls).toContainEqual({ path: 'settings.agentPersonas.routerEnabled', value: false });
    llmCb.checked = false;
    llmCb.dispatchEvent(new Event('change'));
    expect(bridge._setCalls).toContainEqual({ path: 'settings.agentPersonas.routerLLMFallback', value: false });
  });

  test('stored routerEnabled:false renders the toggle unchecked', () => {
    personaList([]);
    const mods = loadModules();
    const host = freshHost();
    mods.personas({ host, configBridge: fakeBridge({ settings: { agentPersonas: { routerEnabled: false, routerLLMFallback: false } } }) });
    const [routerCb, llmCb] = host.querySelectorAll('.sv-row--toggles input[type="checkbox"]');
    expect(routerCb.checked).toBe(false);
    expect(llmCb.checked).toBe(false);
  });

  test('built-in persona toggle adds/removes from enabledPersonas', async () => {
    personaList([{ name: 'shopping', label: 'Shopping', description: 'shop', builtin: true, enabled: true }]);
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { agentPersonas: { enabledPersonas: ['shopping'] } } });
    mods.personas({ host, configBridge: bridge });
    await tick();
    const enabledCb = host.querySelector('.sv-persona-row-head input[type="checkbox"]');
    expect(enabledCb.checked).toBe(true);
    enabledCb.checked = false;
    enabledCb.dispatchEvent(new Event('change'));
    const persisted = bridge._setCalls.find((c) => c.path === 'settings.agentPersonas.enabledPersonas');
    expect(persisted.value).toEqual([]);
  });

  test('built-in notes + starterTabs persist into builtinOverrides', async () => {
    personaList([{ name: 'research', label: 'Research', builtin: true, enabled: true }]);
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { agentPersonas: {} } });
    mods.personas({ host, configBridge: bridge });
    await tick();
    const notes = host.querySelector('.sv-persona-notes');
    notes.value = 'Prefer arXiv';
    notes.dispatchEvent(new Event('change'));
    let p = bridge._setCalls.find((c) => c.path === 'settings.agentPersonas.builtinOverrides');
    expect(p.value.research.notes).toBe('Prefer arXiv');
    const starters = host.querySelector('.sv-persona-starters');
    starters.value = 'https://arxiv.org/\n  \nhttps://scholar.google.com/';
    starters.dispatchEvent(new Event('change'));
    p = bridge._setCalls.reverse().find((c) => c.path === 'settings.agentPersonas.builtinOverrides');
    expect(p.value.research.starterTabs).toEqual([{ url: 'https://arxiv.org/' }, { url: 'https://scholar.google.com/' }]);
  });

  test('custom persona notes persist into customPersonas (not builtinOverrides)', async () => {
    personaList([{ name: 'mine', label: 'Mine', builtin: false, enabled: true, notes: '' }]);
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { agentPersonas: { customPersonas: [{ name: 'mine', notes: '' }] } } });
    mods.personas({ host, configBridge: bridge });
    await tick();
    const notes = host.querySelector('.sv-persona-notes');
    notes.value = 'custom note';
    notes.dispatchEvent(new Event('change'));
    const p = bridge._setCalls.find((c) => c.path === 'settings.agentPersonas.customPersonas');
    expect(p.value[0].notes).toBe('custom note');
  });

  test('persona:list rejection renders the load-error row', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'persona:list') return Promise.reject(new Error('nope'));
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    mods.personas({ host, configBridge: fakeBridge({ settings: {} }) });
    await tick();
    const err = host.querySelector('.sv-personas-list .sv-empty-row--error');
    expect(err.textContent).toBe('Could not load personas: nope');
    expect(err.getAttribute('role')).toBe('alert');
  });

  test('Test routing button shows the resolved persona; cache reset reports cleared', async () => {
    personaList([]);
    const mods = loadModules();
    const host = freshHost();
    mods.personas({ host, configBridge: fakeBridge({ settings: {} }) });
    await tick();
    host.querySelector('.sv-row input[type="text"]').value = 'buy shoes';
    findBtn(host, 'Test').click();
    await tick();
    expect(host.querySelector('.sv-persona-test-out').textContent).toBe('→ shopping (keyword)');
    findBtn(host, 'Reset routing cache').click();
    await tick();
    expect(Array.from(host.querySelectorAll('.sv-persona-test-out')).some((e) => e.textContent === 'Cache cleared.')).toBe(true);
  });

  test('Add custom persona: symbols-only name is rejected by the inline validator', async () => {
    personaList([]);
    PromptDialog.prompt.mockResolvedValueOnce('!!!');
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { agentPersonas: {} } });
    mods.personas({ host, configBridge: bridge });
    await findBtn(host, 'Add custom persona').click();
    await tick();
    expect(bridge._setCalls.find((c) => c.path === 'settings.agentPersonas.customPersonas')).toBeUndefined();
    // No native alert fires — the validator would surface its hint in the
    // real modal (we don't render the modal here, so just assert no crash).
  });

  test('Add custom persona: full happy path pushes a normalized persona + enables it', async () => {
    personaList([]);
    PromptDialog.prompt
      .mockResolvedValueOnce('My Bot')
      .mockResolvedValueOnce('My Bot Label')
      .mockResolvedValueOnce('Be terse.');
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { agentPersonas: {} } });
    mods.personas({ host, configBridge: bridge });
    await findBtn(host, 'Add custom persona').click();
    await tick();
    const customs = bridge._setCalls.find((c) => c.path === 'settings.agentPersonas.customPersonas');
    expect(customs.value[0]).toMatchObject({ name: 'mybot', label: 'My Bot Label', systemOverlay: 'Be terse.', builtin: false });
    const enabled = bridge._setCalls.find((c) => c.path === 'settings.agentPersonas.enabledPersonas');
    expect(enabled.value).toContain('mybot');
  });

  test('Add custom persona aborts when the name prompt is cancelled', async () => {
    personaList([]);
    PromptDialog.prompt.mockResolvedValueOnce(null);
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { agentPersonas: {} } });
    mods.personas({ host, configBridge: bridge });
    await findBtn(host, 'Add custom persona').click();
    await tick();
    expect(bridge._setCalls.find((c) => c.path === 'settings.agentPersonas.customPersonas')).toBeUndefined();
  });

  test('Export success / failure / canceled message branches', async () => {
    let exportRes = { ok: true, count: 2 };
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'persona:list') return Promise.resolve({ all: [] });
      if (channel === 'persona:export') return Promise.resolve(exportRes);
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    mods.personas({ host, configBridge: fakeBridge({ settings: {} }) });
    await tick();
    const io = host.querySelector('.sv-persona-io-status');
    findBtn(host, 'Export').click(); await tick();
    expect(io.textContent).toBe('Exported 2 custom personas.');
    exportRes = { ok: false, error: 'x' };
    findBtn(host, 'Export').click(); await tick();
    expect(io.textContent).toBe('Export failed: x');
    exportRes = { canceled: true };
    findBtn(host, 'Export').click(); await tick();
    expect(io.textContent).toBe('');
  });

  test('Import success refreshes; thrown error is caught and shown', async () => {
    let importImpl = () => Promise.resolve({ ok: true, added: 1, skipped: 0 });
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'persona:list') return Promise.resolve({ all: [] });
      if (channel === 'persona:import') return importImpl();
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    mods.personas({ host, configBridge: fakeBridge({ settings: {} }) });
    await tick();
    const io = host.querySelector('.sv-persona-io-status');
    findBtn(host, 'Import').click(); await tick();
    expect(io.textContent).toContain('Imported 1 persona');
    importImpl = () => Promise.reject(new Error('kaboom'));
    findBtn(host, 'Import').click(); await tick();
    expect(io.textContent).toContain('Import failed: kaboom');
  });
});

// -- packs() ----------------------------------------------------------------

describe('customModules.packs()', () => {
  beforeEach(() => { ipcRenderer.invoke.mockClear(); });

  test('renders a row per pack; non-installed shows Apply, no Installed badge', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'persona:list') return Promise.resolve({ all: [] });
      return Promise.resolve(null);
    });
    const { PACKS } = require('../../../../../shared/personaPacks');
    const mods = loadModules();
    const host = freshHost();
    mods.packs({ host, configBridge: fakeBridge({}) });
    await tick();
    expect(host.querySelectorAll('.sv-persona-row').length).toBe(PACKS.length);
    expect(host.querySelector('.sv-status-badge')).toBeNull();
    expect(findBtn(host, 'Apply')).toBeTruthy();
  });

  test('an installed pack shows the Installed badge and a Re-apply button', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'persona:list') return Promise.resolve({ all: [{ name: 'pack_job_hunt' }] });
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    mods.packs({ host, configBridge: fakeBridge({}) });
    await tick();
    expect(host.querySelector('.sv-status-badge').textContent).toBe('Installed');
    expect(findBtn(host, 'Re-apply')).toBeTruthy();
  });

  test('Apply success updates status and refreshes; failure path shows the error', async () => {
    let applyRes = { ok: true, skipped: false };
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'persona:list') return Promise.resolve({ all: [] });
      if (channel === 'pack:apply') return Promise.resolve(applyRes);
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({});
    mods.packs({ host, configBridge: bridge });
    await tick();
    const status = host.querySelector('.sv-persona-io-status');
    findBtn(host, 'Apply').click();
    await tick();
    expect(status.textContent).toContain('persona installed');
    expect(bridge.refresh).toHaveBeenCalled();
    applyRes = { ok: false, error: 'denied' };
    findBtn(host, 'Apply').click();
    await tick();
    expect(status.textContent).toBe('Apply failed: denied');
  });

  test('Apply rejection is caught and surfaced', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'persona:list') return Promise.resolve({ all: [] });
      if (channel === 'pack:apply') return Promise.reject(new Error('crash'));
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    mods.packs({ host, configBridge: fakeBridge({}) });
    await tick();
    findBtn(host, 'Apply').click();
    await tick();
    expect(host.querySelector('.sv-persona-io-status').textContent).toContain('Apply failed: crash');
  });

  test('Run task success / failure / rejection branches', async () => {
    let runRes = { ok: true };
    let reject = false;
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'persona:list') return Promise.resolve({ all: [] });
      if (channel === 'pack:run-task') return reject ? Promise.reject(new Error('boom')) : Promise.resolve(runRes);
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    mods.packs({ host, configBridge: fakeBridge({}) });
    await tick();
    const status = host.querySelector('.sv-persona-io-status');
    findBtn(host, 'Run task').click(); await tick();
    expect(status.textContent).toContain('task started');
    runRes = { ok: false, error: 'busy' };
    findBtn(host, 'Run task').click(); await tick();
    expect(status.textContent).toBe('Could not start: busy');
    reject = true;
    findBtn(host, 'Run task').click(); await tick();
    expect(status.textContent).toContain('Failed: boom');
  });

  test('persona:list rejection leaves nothing installed but still renders rows', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'persona:list') return Promise.reject(new Error('x'));
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    mods.packs({ host, configBridge: fakeBridge({}) });
    await tick();
    expect(host.querySelectorAll('.sv-persona-row').length).toBeGreaterThan(0);
    expect(host.querySelector('.sv-status-badge')).toBeNull();
    expect(host.querySelector('.sv-persona-io-status').textContent).toBe("Couldn't check which packs are installed: x");
  });
});

// -- agentSafety() ----------------------------------------------------------

describe('customModules.agentSafety()', () => {
  test('open mode: no allow textarea; block textarea present', () => {
    const mods = loadModules();
    const host = freshHost();
    mods.agentSafety({ host, configBridge: fakeBridge({ settings: { llm: { agent: { egress: { mode: 'open', allow: [], block: [] } } } } }) });
    const labels = Array.from(host.querySelectorAll('.sv-field-label')).map((l) => l.textContent);
    expect(labels).toContain('Egress mode');
    expect(labels).not.toContain('Allowed domains');
    expect(labels).toContain('Blocked domains (always refused)');
    const sel = host.querySelector('select.sv-select');
    expect(sel.querySelector('option[selected]').value).toBe('open');
  });

  test('allowlist mode renders the Allowed domains textarea', () => {
    const mods = loadModules();
    const host = freshHost();
    mods.agentSafety({ host, configBridge: fakeBridge({ settings: { llm: { agent: { egress: { mode: 'allowlist', allow: ['a.com'], block: [] } } } } }) });
    const labels = Array.from(host.querySelectorAll('.sv-field-label')).map((l) => l.textContent);
    expect(labels).toContain('Allowed domains');
  });

  test('changing mode persists and re-renders (allow textarea appears)', () => {
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { llm: { agent: { egress: { mode: 'open', allow: [], block: [] } } } } });
    mods.agentSafety({ host, configBridge: bridge });
    const sel = host.querySelector('select.sv-select');
    sel.value = 'allowlist';
    sel.dispatchEvent(new Event('change'));
    expect(bridge._setCalls).toContainEqual({ path: 'settings.llm.agent.egress.mode', value: 'allowlist' });
    expect(Array.from(host.querySelectorAll('.sv-field-label')).map((l) => l.textContent)).toContain('Allowed domains');
  });

  test('editing the block textarea normalizes (dedup, lowercase) via _linesToList', () => {
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { llm: { agent: { egress: { mode: 'open', allow: [], block: [] } } } } });
    mods.agentSafety({ host, configBridge: bridge });
    const ta = host.querySelector('textarea.sv-text');
    ta.value = 'Facebook.com\nfacebook.com, ADS.example.com\n\n';
    ta.dispatchEvent(new Event('change'));
    const persisted = bridge._setCalls.find((c) => c.path === 'settings.llm.agent.egress.block');
    expect(persisted.value).toEqual(['facebook.com', 'ads.example.com']);
  });

  test('onViolation select defaults to prompt and persists on change', () => {
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { llm: { agent: { egress: { mode: 'open', allow: [], block: [] } } } } });
    mods.agentSafety({ host, configBridge: bridge });
    const onv = Array.from(host.querySelectorAll('select.sv-select'))[1];
    expect(onv.querySelector('option[selected]').value).toBe('prompt');
    onv.value = 'deny';
    onv.dispatchEvent(new Event('change'));
    expect(bridge._setCalls).toContainEqual({ path: 'settings.llm.agent.egress.onViolation', value: 'deny' });
  });

  test('no perOrigin grants → "None yet" hint; with grants → revoke removes them', () => {
    const mods = loadModules();
    const host = freshHost();
    const noGrants = fakeBridge({ settings: { llm: { agent: { egress: { mode: 'open' } } } } });
    mods.agentSafety({ host, configBridge: noGrants });
    expect(host.querySelector('.sv-hint').textContent).toContain('None yet');

    const host2 = freshHost();
    const withGrants = fakeBridge({ settings: { llm: { agent: {
      egress: { mode: 'open' },
      approval: { perOrigin: { 'https://a.com': { egress: 'allow' }, 'https://b.com': { egress: 'deny', other: 1 } } },
    } } } });
    mods.agentSafety({ host: host2, configBridge: withGrants });
    expect(host2.querySelectorAll('.sv-grant-row').length).toBe(2);
    expect(host2.textContent).toContain('always allowed');
    expect(host2.textContent).toContain('always blocked');
    // Revoke the first grant — origin with no other keys is deleted entirely.
    findBtn(host2, 'Revoke').click();
    const persisted = withGrants._setCalls.find((c) => c.path === 'settings.llm.agent.approval.perOrigin');
    expect(persisted).toBeTruthy();
    expect(persisted.value['https://a.com']).toBeUndefined();
  });

  test('default egress (missing config) falls back to open mode without throwing', () => {
    const mods = loadModules();
    const host = freshHost();
    expect(() => mods.agentSafety({ host, configBridge: fakeBridge({}) })).not.toThrow();
    expect(host.querySelector('select.sv-select').querySelector('option[selected]').value).toBe('open');
  });
});

// -- voiceReading() ---------------------------------------------------------

describe('customModules.voiceReading()', () => {
  const origDescriptor = Object.getOwnPropertyDescriptor(window, 'speechSynthesis');
  afterEach(() => {
    if (origDescriptor) Object.defineProperty(window, 'speechSynthesis', origDescriptor);
    else delete window.speechSynthesis;
  });

  function installSynth(voices) {
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { getVoices: () => voices, addEventListener: jest.fn(), removeEventListener: jest.fn() },
    });
  }

  test('no speech synthesis → "not available" status, only the default option', () => {
    delete window.speechSynthesis;
    const mods = loadModules(); // tts singleton captures absent synth
    const host = freshHost();
    mods.voiceReading({ host, configBridge: fakeBridge({ settings: { tts: {} } }) });
    expect(host.querySelector('.sv-section-intro').textContent).toContain('not available');
    const opts = host.querySelectorAll('option');
    expect(opts.length).toBe(1);
    expect(opts[0].textContent).toBe('System default');
  });

  test('voices present: optgroups built, count surfaced, saved voice selected', () => {
    installSynth([
      { voiceURI: 'v-en', name: 'Eng', lang: 'en-US', default: true },
      { voiceURI: 'v-fr', name: 'Fra', lang: 'fr-FR' },
    ]);
    const mods = loadModules();
    const host = freshHost();
    mods.voiceReading({ host, configBridge: fakeBridge({ settings: { tts: { voiceURI: 'v-fr' } } }) });
    expect(host.querySelectorAll('optgroup').length).toBe(2);
    expect(host.querySelector('.sv-section-intro').textContent).toBe('2 system voices available.');
    expect(host.querySelector('select').value).toBe('v-fr');
    expect(host.textContent).toContain('Eng — default');
  });

  test('a saved voiceURI no longer installed falls back to System default ("")', () => {
    installSynth([{ voiceURI: 'v-en', name: 'Eng', lang: 'en-US' }]);
    const mods = loadModules();
    const host = freshHost();
    mods.voiceReading({ host, configBridge: fakeBridge({ settings: { tts: { voiceURI: 'gone' } } }) });
    expect(host.querySelector('select').value).toBe('');
  });

  test('synth present but zero voices → "Loading system voices…"', () => {
    installSynth([]);
    const mods = loadModules();
    const host = freshHost();
    mods.voiceReading({ host, configBridge: fakeBridge({ settings: { tts: {} } }) });
    expect(host.querySelector('.sv-section-intro').textContent).toBe('Loading system voices…');
  });

  test('changing the select persists settings.tts.voiceURI', () => {
    installSynth([{ voiceURI: 'v-en', name: 'Eng', lang: 'en-US' }]);
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { tts: {} } });
    mods.voiceReading({ host, configBridge: bridge });
    const sel = host.querySelector('select');
    sel.value = 'v-en';
    sel.dispatchEvent(new Event('change'));
    expect(bridge._setCalls).toContainEqual({ path: 'settings.tts.voiceURI', value: 'v-en' });
  });

  test('singular voice count uses "voice" not "voices"', () => {
    installSynth([{ voiceURI: 'v1', name: 'Only', lang: 'en-US' }]);
    const mods = loadModules();
    const host = freshHost();
    mods.voiceReading({ host, configBridge: fakeBridge({ settings: { tts: {} } }) });
    expect(host.querySelector('.sv-section-intro').textContent).toBe('1 system voice available.');
  });

  test('returns a teardown that removes the exact voiceschanged listener (no leak on re-mount)', () => {
    installSynth([{ voiceURI: 'v-en', name: 'Eng', lang: 'en-US' }]);
    const synth = window.speechSynthesis;
    const mods = loadModules();
    const host = freshHost();
    const teardown = mods.voiceReading({ host, configBridge: fakeBridge({ settings: { tts: {} } }) });
    const reg = synth.addEventListener.mock.calls.find((c) => c[0] === 'voiceschanged');
    expect(reg).toBeDefined();
    expect(typeof teardown).toBe('function');
    teardown();
    // The handler removed must be the same one registered, or the leak persists.
    expect(synth.removeEventListener).toHaveBeenCalledWith('voiceschanged', reg[1]);
  });
});

// -- customSearchEngines() --------------------------------------------------

describe('customModules.customSearchEngines()', () => {
  test('empty list shows the empty row', () => {
    const mods = loadModules();
    const host = freshHost();
    mods.customSearchEngines({ host, configBridge: fakeBridge({ settings: { customSearchEngines: [] } }) });
    expect(host.textContent).toContain('No custom engines yet');
  });

  test('Add engine appends a new entry persisted under settings.customSearchEngines', () => {
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { customSearchEngines: [] } });
    mods.customSearchEngines({ host, configBridge: bridge });
    Array.from(host.querySelectorAll('button')).find((b) => b.textContent.includes('Add engine')).click();
    const setCall = bridge._setCalls.find((c) => c.path === 'settings.customSearchEngines');
    expect(setCall).toBeDefined();
    expect(Array.isArray(setCall.value)).toBe(true);
    expect(setCall.value[0]).toMatchObject({ id: expect.any(String), name: '', url: '' });
  });

  test('editing name/url persists the changed entry without clobbering others', () => {
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { customSearchEngines: [{ id: 'e1', name: 'One', url: 'https://one/?q=' }] } });
    mods.customSearchEngines({ host, configBridge: bridge });
    const url = host.querySelector('.sv-space-url');
    url.value = 'https://one.example/?q=%s';
    url.dispatchEvent(new Event('change'));
    const last = bridge._setCalls.filter((c) => c.path === 'settings.customSearchEngines').pop();
    expect(last.value[0]).toEqual({ id: 'e1', name: 'One', url: 'https://one.example/?q=%s' });
  });

  test('Remove deletes the entry after confirm', async () => {
    ConfirmDialog.confirm.mockResolvedValueOnce(true);
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { customSearchEngines: [{ id: 'e1', name: 'One', url: 'https://one/?q=' }] } });
    mods.customSearchEngines({ host, configBridge: bridge });
    await Array.from(host.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'Remove One').click();
    const last = bridge._setCalls.filter((c) => c.path === 'settings.customSearchEngines').pop();
    expect(last.value).toEqual([]);
  });
});

// -- accentColor() ----------------------------------------------------------

describe('customModules.accentColor()', () => {
  let origApply;
  beforeEach(() => { origApply = window.applyAppearanceSettings; window.applyAppearanceSettings = jest.fn(); });
  afterEach(() => { window.applyAppearanceSettings = origApply; });

  test('seeds the color input from settings.accentColor', () => {
    const mods = loadModules();
    const host = freshHost();
    mods.accentColor({ host, configBridge: fakeBridge({ settings: { accentColor: '#ff8800' } }) });
    expect(host.querySelector('input[type="color"]').value).toBe('#ff8800');
  });

  test('falls back to the default accent when none is set', () => {
    const mods = loadModules();
    const host = freshHost();
    mods.accentColor({ host, configBridge: fakeBridge({ settings: { accentColor: null } }) });
    expect(host.querySelector('input[type="color"]').value).toBe('#0089ab');
  });

  test('change persists the chosen color via configBridge.set', () => {
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: {} });
    mods.accentColor({ host, configBridge: bridge });
    const input = host.querySelector('input[type="color"]');
    input.value = '#123456';
    input.dispatchEvent(new Event('change'));
    expect(bridge._setCalls).toContainEqual({ path: 'settings.accentColor', value: '#123456' });
  });

  test('input live-previews via applyAppearanceSettings without persisting', () => {
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: {} });
    mods.accentColor({ host, configBridge: bridge });
    const input = host.querySelector('input[type="color"]');
    input.value = '#abcdef';
    input.dispatchEvent(new Event('input'));
    expect(window.applyAppearanceSettings).toHaveBeenCalledWith(expect.objectContaining({ accentColor: '#abcdef' }));
    expect(bridge._setCalls.some((c) => c.path === 'settings.accentColor')).toBe(false);
  });

  test('reset clears the override (null) and restores the default swatch', () => {
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { accentColor: '#ff8800' } });
    mods.accentColor({ host, configBridge: bridge });
    Array.from(host.querySelectorAll('button')).find((b) => b.textContent.includes('Reset')).click();
    expect(bridge._setCalls).toContainEqual({ path: 'settings.accentColor', value: null });
    expect(host.querySelector('input[type="color"]').value).toBe('#0089ab');
    expect(window.applyAppearanceSettings).toHaveBeenCalled();
  });
});

// -- routines() -------------------------------------------------------------

describe('customModules.routines()', () => {
  beforeEach(() => { ipcRenderer.invoke.mockClear(); });

  test('empty items list shows the empty row', () => {
    const mods = loadModules();
    const host = freshHost();
    mods.routines({ host, configBridge: fakeBridge({ settings: { routines: { items: [] } } }) });
    expect(host.querySelector('.sv-empty-row').textContent).toContain('No routines yet');
  });

  test('renders one row per routine with schedule description + next-run', () => {
    const mods = loadModules();
    const host = freshHost();
    mods.routines({ host, configBridge: fakeBridge({ settings: { routines: { items: [
      { id: 'r1', name: 'Digest', task: 'do it', schedule: { kind: 'interval', everyMinutes: 60 }, enabled: true },
    ] } } }) });
    expect(host.querySelectorAll('.sv-space-row').length).toBe(1);
    expect(host.querySelector('.sv-persona-sub').textContent).toContain('Every 1 hour');
  });

  test('daily routine renders daily schedule controls (time input visible)', () => {
    const mods = loadModules();
    const host = freshHost();
    mods.routines({ host, configBridge: fakeBridge({ settings: { routines: { items: [
      { id: 'r2', name: 'Morning', task: 'go', schedule: { kind: 'daily', atHour: 7, atMinute: 30 }, enabled: false },
    ] } } }) });
    expect(host.querySelector('.sv-persona-sub').textContent).toContain('Daily at 07:30');
    const timeInput = host.querySelector('input[type="time"]');
    expect(timeInput.value).toBe('07:30');
    expect(timeInput.style.display).toBe('');
    expect(host.querySelector('input[type="number"]').style.display).toBe('none');
  });

  test('toggling enabled checkbox writes the updated items array', () => {
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { routines: { items: [
      { id: 'r1', name: 'R', task: 't', schedule: { kind: 'interval', everyMinutes: 30 }, enabled: true },
    ] } } });
    mods.routines({ host, configBridge: bridge });
    const cb = host.querySelector('.sv-persona-row-head input[type="checkbox"]');
    cb.checked = false;
    cb.dispatchEvent(new Event('change'));
    const persisted = bridge._setCalls.find((c) => c.path === 'settings.routines.items');
    expect(persisted.value[0].enabled).toBe(false);
  });

  test('Save with valid fields persists; invalid (blank name) shows an error', () => {
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { routines: { items: [
      { id: 'r1', name: 'Old', task: 'task here', schedule: { kind: 'interval', everyMinutes: 30 }, enabled: true },
    ] } } });
    mods.routines({ host, configBridge: bridge });
    const row = host.querySelector('.sv-space-row');
    const nameInput = row.querySelector('input[type="text"]');
    nameInput.value = 'New Name';
    findBtn(row, 'Save').click();
    const persisted = bridge._setCalls.find((c) => c.path === 'settings.routines.items');
    expect(persisted.value[0].name).toBe('New Name');
    expect(row.querySelector('.sv-validation-status').textContent).toContain('Saved');
    // Now blank the name and Save → validation error, no further persist.
    bridge._setCalls.length = 0;
    nameInput.value = '   ';
    findBtn(row, 'Save').click();
    expect(row.querySelector('.sv-validation-status').textContent).toContain('Cannot save');
    expect(bridge._setCalls.find((c) => c.path === 'settings.routines.items')).toBeUndefined();
  });

  test('Run now: ok / busy / generic-error / rejection all surface distinct status', async () => {
    let runImpl;
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'routine:run-now') return runImpl();
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    mods.routines({ host, configBridge: fakeBridge({ settings: { routines: { items: [
      { id: 'r1', name: 'R', task: 'task', schedule: { kind: 'interval', everyMinutes: 30 }, enabled: true },
    ] } } }) });
    const row = host.querySelector('.sv-space-row');
    const status = row.querySelector('.sv-validation-status');

    runImpl = () => Promise.resolve({ ok: true });
    findBtn(row, 'Run now').click(); await tick();
    expect(status.textContent).toContain('Started in the agent workspace');

    runImpl = () => Promise.resolve({ ok: false, error: 'busy' });
    findBtn(row, 'Run now').click(); await tick();
    expect(status.textContent).toContain('Agent is busy');

    runImpl = () => Promise.resolve({ ok: false, error: 'whatever' });
    findBtn(row, 'Run now').click(); await tick();
    expect(status.textContent).toContain('Could not start: whatever');

    runImpl = () => Promise.reject(new Error('exploded'));
    findBtn(row, 'Run now').click(); await tick();
    expect(status.textContent).toBe('exploded');
  });

  test('Delete removes the routine and re-renders to empty', () => {
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { routines: { items: [
      { id: 'r1', name: 'R', task: 'task', schedule: { kind: 'interval', everyMinutes: 30 }, enabled: true },
    ] } } });
    mods.routines({ host, configBridge: bridge });
    findBtn(host.querySelector('.sv-space-row'), 'Delete').click();
    const persisted = bridge._setCalls.find((c) => c.path === 'settings.routines.items');
    expect(persisted.value).toEqual([]);
    expect(host.querySelector('.sv-empty-row')).not.toBeNull();
  });

  test('Add routine: valid input appends and clears the form; invalid shows error', () => {
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { routines: { items: [] } } });
    mods.routines({ host, configBridge: bridge });
    const addName = Array.from(host.querySelectorAll('input[type="text"]')).pop();
    const addTask = Array.from(host.querySelectorAll('textarea')).pop();
    addName.value = 'Nightly';
    addTask.value = 'summarize my feeds';
    findBtn(host, 'Add routine').click();
    let persisted = bridge._setCalls.find((c) => c.path === 'settings.routines.items');
    expect(persisted.value).toHaveLength(1);
    expect(persisted.value[0].name).toBe('Nightly');
    expect(addName.value).toBe('');
    // Invalid: blank task.
    bridge._setCalls.length = 0;
    addName.value = 'NoTask';
    addTask.value = '';
    findBtn(host, 'Add routine').click();
    const addStatus = host.querySelectorAll('.sv-validation-status');
    expect(Array.from(addStatus).some((s) => /Cannot add/.test(s.textContent))).toBe(true);
    expect(bridge._setCalls.find((c) => c.path === 'settings.routines.items')).toBeUndefined();
  });

  test('schedule control: switching kind to daily toggles which inputs are visible', () => {
    const mods = loadModules();
    const host = freshHost();
    mods.routines({ host, configBridge: fakeBridge({ settings: { routines: { items: [] } } }) });
    const kindSel = host.querySelector('select.sv-select');
    expect(host.querySelector('input[type="number"]').style.display).toBe('');
    expect(host.querySelector('input[type="time"]').style.display).toBe('none');
    kindSel.value = 'daily';
    kindSel.dispatchEvent(new Event('change'));
    expect(host.querySelector('input[type="number"]').style.display).toBe('none');
    expect(host.querySelector('input[type="time"]').style.display).toBe('');
  });

  test('Add routine with daily schedule reads HH:MM from the time input', () => {
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { routines: { items: [] } } });
    mods.routines({ host, configBridge: bridge });
    const addName = Array.from(host.querySelectorAll('input[type="text"]')).pop();
    const addTask = Array.from(host.querySelectorAll('textarea')).pop();
    const kindSel = host.querySelector('select.sv-select');
    kindSel.value = 'daily';
    kindSel.dispatchEvent(new Event('change'));
    host.querySelector('input[type="time"]').value = '06:15';
    addName.value = 'AM';
    addTask.value = 'do morning thing';
    findBtn(host, 'Add routine').click();
    const persisted = bridge._setCalls.find((c) => c.path === 'settings.routines.items');
    expect(persisted.value[0].schedule).toEqual({ kind: 'daily', atHour: 6, atMinute: 15 });
  });
});

// -- siteAllowlist() --------------------------------------------------------

describe('customModules.siteAllowlist()', () => {
  beforeEach(() => { ipcRenderer.invoke.mockClear(); });

  test('empty config renders the empty-state hint', () => {
    const mods = loadModules();
    const host = freshHost();
    mods.siteAllowlist({ host, configBridge: fakeBridge({ settings: { siteAllowlist: [] } }) });
    expect(host.querySelector('.sv-empty-row').textContent).toContain('No hosts allowlisted');
  });

  test('renders sorted host rows from config', () => {
    const mods = loadModules();
    const host = freshHost();
    mods.siteAllowlist({ host, configBridge: fakeBridge({ settings: { siteAllowlist: ['z.com', 'a.com'] } }) });
    const labels = Array.from(host.querySelectorAll('.sv-list-label')).map((l) => l.textContent);
    expect(labels).toEqual(['a.com', 'z.com']);
  });

  test('Add with blank input shows an error and does not invoke IPC', () => {
    const mods = loadModules();
    const host = freshHost();
    mods.siteAllowlist({ host, configBridge: fakeBridge({ settings: { siteAllowlist: [] } }) });
    findBtn(host, 'Add').click();
    expect(host.querySelector('.sv-validation-status').textContent).toContain('Enter a hostname');
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('site-allowlist:add', expect.anything());
  });

  test('Add success persists the returned list and clears the input', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'site-allowlist:add') return Promise.resolve({ ok: true, hostname: 'good.com', list: ['good.com'] });
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { siteAllowlist: [] } });
    mods.siteAllowlist({ host, configBridge: bridge });
    const input = host.querySelector('input');
    input.value = 'good.com';
    findBtn(host, 'Add').click();
    await tick();
    expect(bridge._setCalls).toContainEqual({ path: 'settings.siteAllowlist', value: ['good.com'] });
    expect(host.querySelector('.sv-validation-status').textContent).toContain('Added good.com');
    expect(input.value).toBe('');
  });

  test('Add failure (ok:false) surfaces the server error', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'site-allowlist:add') return Promise.resolve({ ok: false, error: 'bad host' });
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    mods.siteAllowlist({ host, configBridge: fakeBridge({ settings: { siteAllowlist: [] } }) });
    host.querySelector('input').value = 'nope';
    findBtn(host, 'Add').click();
    await tick();
    expect(host.querySelector('.sv-validation-status').textContent).toContain('bad host');
  });

  test('Add rejection is caught and surfaced', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'site-allowlist:add') return Promise.reject(new Error('net down'));
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    mods.siteAllowlist({ host, configBridge: fakeBridge({ settings: { siteAllowlist: [] } }) });
    host.querySelector('input').value = 'x.com';
    findBtn(host, 'Add').click();
    await tick();
    expect(host.querySelector('.sv-validation-status').textContent).toContain('net down');
  });

  test('Enter key triggers Add', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'site-allowlist:add') return Promise.resolve({ ok: true, hostname: 'k.com', list: ['k.com'] });
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    mods.siteAllowlist({ host, configBridge: fakeBridge({ settings: { siteAllowlist: [] } }) });
    const input = host.querySelector('input');
    input.value = 'k.com';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('site-allowlist:add', 'k.com');
  });

  test('Remove success rewrites the list; remove failure leaves it intact', async () => {
    let removeRes = { ok: true, list: [] };
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'site-allowlist:remove') return Promise.resolve(removeRes);
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { siteAllowlist: ['drop.com'] } });
    mods.siteAllowlist({ host, configBridge: bridge });
    findBtn(host, 'Remove').click();
    await tick();
    expect(bridge._setCalls).toContainEqual({ path: 'settings.siteAllowlist', value: [] });

    const host2 = freshHost();
    const bridge2 = fakeBridge({ settings: { siteAllowlist: ['keep.com'] } });
    removeRes = { ok: false };
    mods.siteAllowlist({ host: host2, configBridge: bridge2 });
    findBtn(host2, 'Remove').click();
    await tick();
    expect(bridge2._setCalls.find((c) => c.path === 'settings.siteAllowlist')).toBeUndefined();
  });
});

// -- downloadLocation() default-path branch ---------------------------------

describe('customModules.downloadLocation() extra branches', () => {
  beforeEach(() => { ipcRenderer.invoke.mockClear(); });

  test('null download location renders the OS-default placeholder text', () => {
    const mods = loadModules();
    const host = freshHost();
    mods.downloadLocation({ host, configBridge: fakeBridge({ settings: { downloadLocation: null } }) });
    expect(host.querySelector('.sv-path').textContent).toBe('(OS default Downloads folder)');
  });

  test('Choose folder cancelled (non-string result) does NOT write config', async () => {
    ipcRenderer.invoke.mockResolvedValueOnce(null);
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { downloadLocation: null } });
    mods.downloadLocation({ host, configBridge: bridge });
    findBtn(host, 'Choose folder').click();
    await tick();
    expect(bridge._setCalls.find((c) => c.path === 'settings.downloadLocation')).toBeUndefined();
  });
});

// -- permissions() error path -----------------------------------------------

describe('customModules.permissions() error path', () => {
  test('renders without throwing when the override list IPC rejects', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'notifications:permission:list-overrides') return Promise.reject(new Error('x'));
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    expect(() => mods.permissions({ host })).not.toThrow();
    await tick();
    expect(host.querySelector('.sv-permission-row')).toBeNull();
    const err = host.querySelector('.sv-empty-row--error');
    expect(err.textContent).toBe('Could not load site permissions: x');
    expect(err.getAttribute('role')).toBe('alert');
  });
});

// -- llmTab() mount ---------------------------------------------------------

describe('customModules.llmTab() mount', () => {
  beforeEach(() => { ipcRenderer.invoke.mockClear(); });

  test('instantiates LLMTab and renders the Mode pill into the host', () => {
    ipcRenderer.invoke.mockResolvedValue(null);
    const mods = loadModules();
    const host = freshHost();
    mods.llmTab({ host, configBridge: fakeBridge({ settings: { llm: { mode: 'local' } } }) });
    expect(host.classList.contains('sv-llm-tab')).toBe(true);
    expect(host.querySelector('.sv-pills')).not.toBeNull();
  });

  test('buildSaveCallback persists LLM changes via granular config:set (not replace)', () => {
    ipcRenderer.invoke.mockResolvedValue(null);
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { llm: {} } });
    mods.llmTab({ host, configBridge: bridge });
    // Mode pill change triggers _setLLM('mode', …) → save → configBridge.set
    // with the dotted path under settings.llm — never a full-tree replace.
    const radios = host.querySelectorAll('.sv-pills input[type="radio"]');
    radios[1].checked = true;
    radios[1].dispatchEvent(new Event('change'));
    expect(bridge.replace).not.toHaveBeenCalled();
    expect(bridge.set).toHaveBeenCalledWith('settings.llm.mode', expect.anything());
  });
});

// ---------------------------------------------------------------------------
// Remaining branch coverage — defensive fallbacks, singular/plural, and the
// less-common conditional arms not hit above.
// ---------------------------------------------------------------------------

describe('customModules residual branches', () => {
  beforeEach(() => { ipcRenderer.send.mockClear(); ipcRenderer.invoke.mockClear(); });

  // userMemory: export count===1 singular, import canceled, sort by editedAt
  test('userMemory Export with count 1 uses singular "fact"; import canceled clears status', async () => {
    let exportRes = { ok: true, count: 1 };
    let importRes = { canceled: true };
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'usermemory:list') return Promise.resolve({ enabled: true, facts: [] });
      if (channel === 'usermemory:export') return Promise.resolve(exportRes);
      if (channel === 'usermemory:import') return Promise.resolve(importRes);
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    mods.userMemory({ host });
    await tick();
    const status = host.querySelector('.sv-persona-io-status');
    findBtn(host, 'Export').click(); await tick();
    expect(status.textContent).toBe('Exported 1 fact.');
    findBtn(host, 'Import').click(); await tick();
    expect(status.textContent).toBe('');
  });

  test('userMemory live list sorts by editedAt when pin state is equal', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'usermemory:list') {
        return Promise.resolve({ enabled: true, facts: [
          { id: 'old', text: 'older', pinned: false, archived: false, editedAt: 100 },
          { id: 'new', text: 'newer', pinned: false, archived: false, editedAt: 900 },
        ] });
      }
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    mods.userMemory({ host });
    await tick();
    const texts = Array.from(host.querySelectorAll('.sv-usermem-text')).map((t) => t.value);
    expect(texts).toEqual(['newer', 'older']);
  });

  test('userMemory Import skipped count appends the "(N skipped)" suffix', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'usermemory:list') return Promise.resolve({ enabled: true, facts: [] });
      if (channel === 'usermemory:import') return Promise.resolve({ ok: true, added: 4, skipped: 2 });
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    mods.userMemory({ host });
    await tick();
    findBtn(host, 'Import').click(); await tick();
    expect(host.querySelector('.sv-persona-io-status').textContent).toBe('Imported 4 (2 skipped — duplicate or invalid).');
  });

  // personas: enabled persona already present (no dup), custom-not-found,
  // export singular, add aborts when overlay prompt returns null.
  test('personas enabling an already-listed built-in does not duplicate it', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'persona:list') return Promise.resolve({ all: [{ name: 'code', label: 'Code', builtin: true, enabled: false }] });
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { agentPersonas: { enabledPersonas: ['code'] } } });
    mods.personas({ host, configBridge: bridge });
    await tick();
    const cb = host.querySelector('.sv-persona-row-head input[type="checkbox"]');
    cb.checked = true; // already in list — branch where idx>=0 and checked
    cb.dispatchEvent(new Event('change'));
    const p = bridge._setCalls.find((c) => c.path === 'settings.agentPersonas.enabledPersonas');
    expect(p.value).toEqual(['code']);
  });

  test('personas custom notes change is a no-op when the persona is not in customPersonas', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'persona:list') return Promise.resolve({ all: [{ name: 'ghost', label: 'Ghost', builtin: false, enabled: true }] });
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { agentPersonas: { customPersonas: [] } } });
    mods.personas({ host, configBridge: bridge });
    await tick();
    const notes = host.querySelector('.sv-persona-notes');
    notes.value = 'orphan';
    notes.dispatchEvent(new Event('change'));
    expect(bridge._setCalls.find((c) => c.path === 'settings.agentPersonas.customPersonas')).toBeUndefined();
  });

  test('personas Export count 1 uses singular "persona"', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'persona:list') return Promise.resolve({ all: [] });
      if (channel === 'persona:export') return Promise.resolve({ ok: true, count: 1 });
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    mods.personas({ host, configBridge: fakeBridge({ settings: {} }) });
    await tick();
    findBtn(host, 'Export').click(); await tick();
    expect(host.querySelector('.sv-persona-io-status').textContent).toBe('Exported 1 custom persona.');
  });

  test('personas Add aborts when the overlay prompt is cancelled (returns null)', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'persona:list') return Promise.resolve({ all: [] });
      return Promise.resolve(null);
    });
    PromptDialog.prompt
      .mockResolvedValueOnce('name')
      .mockResolvedValueOnce('Label')
      .mockResolvedValueOnce(null);
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { agentPersonas: {} } });
    mods.personas({ host, configBridge: bridge });
    await findBtn(host, 'Add custom persona').click();
    await tick();
    expect(bridge._setCalls.find((c) => c.path === 'settings.agentPersonas.customPersonas')).toBeUndefined();
  });

  test('personas Add aborts when the label prompt is cancelled', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'persona:list') return Promise.resolve({ all: [] });
      return Promise.resolve(null);
    });
    PromptDialog.prompt
      .mockResolvedValueOnce('name')
      .mockResolvedValueOnce(null);
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { agentPersonas: {} } });
    mods.personas({ host, configBridge: bridge });
    await findBtn(host, 'Add custom persona').click();
    await tick();
    expect(bridge._setCalls.find((c) => c.path === 'settings.agentPersonas.customPersonas')).toBeUndefined();
  });

  test('personas test-route failure / cache-clear failure surface fallbacks', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'persona:list') return Promise.resolve({ all: [] });
      if (channel === 'persona:test-route') return Promise.resolve({ ok: false });
      if (channel === 'persona:clear-cache') return Promise.resolve({ ok: false, error: 'nope' });
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    mods.personas({ host, configBridge: fakeBridge({ settings: {} }) });
    await tick();
    findBtn(host, 'Test').click(); await tick();
    expect(host.querySelector('.sv-persona-test-out').textContent).toBe('Test failed.');
    findBtn(host, 'Reset routing cache').click(); await tick();
    expect(Array.from(host.querySelectorAll('.sv-persona-test-out')).some((e) => /Failed: nope/.test(e.textContent))).toBe(true);
  });

  test('personas test-route rejection is caught', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'persona:list') return Promise.resolve({ all: [] });
      if (channel === 'persona:test-route') return Promise.reject(new Error('x'));
      if (channel === 'persona:clear-cache') return Promise.reject(new Error('cc'));
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    mods.personas({ host, configBridge: fakeBridge({ settings: {} }) });
    await tick();
    findBtn(host, 'Test').click(); await tick();
    expect(host.querySelector('.sv-persona-test-out').textContent).toBe('Test failed: x');
    findBtn(host, 'Reset routing cache').click(); await tick();
    expect(Array.from(host.querySelectorAll('.sv-persona-test-out')).some((e) => /Failed: cc/.test(e.textContent))).toBe(true);
  });

  // packs: singular pane count + skipped message + persona without name
  test('packs single-pane pack uses singular "pane"; skipped:true notes already present', async () => {
    let applyRes = { ok: true, skipped: true };
    const { PACKS } = require('../../../../../shared/personaPacks');
    const orig = PACKS.map((p) => p.panes.length);
    // Temporarily reduce the first pack to one pane to hit the singular branch.
    PACKS[0].panes = [PACKS[0].panes[0]];
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'persona:list') return Promise.resolve({ all: [] });
      if (channel === 'pack:apply') return Promise.resolve(applyRes);
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    mods.packs({ host, configBridge: fakeBridge({}) });
    await tick();
    expect(host.querySelector('.sv-hint').textContent).toContain('1 starter pane ');
    findBtn(host, 'Apply').click(); await tick();
    expect(host.querySelector('.sv-persona-io-status').textContent).toContain('already present');
    // restore
    const fresh = require('../../../../../shared/personaPacks').PACKS;
    fresh[0].panes = Array.from({ length: orig[0] }, (_, i) => fresh[0].panes[0] || { label: 'x', url: 'https://x' });
  });

  // adblocker: stats disabled, unchecking a built-in, custom remove, dup url,
  // blank url, validate rejection.
  test('adblockerLists: stats disabled → "Adblocker is off."; unchecking removes the id', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'adblocker:get-catalog') return Promise.resolve([{ id: 'a', label: 'A', url: 'https://a/' }]);
      if (channel === 'adblocker:get-stats') return Promise.resolve({ enabled: false });
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { adblocker: { builtinEnabled: ['a'], customLists: [] } } });
    mods.adblockerLists({ host, configBridge: bridge });
    await tick();
    expect(host.querySelector('.sv-stat-footer').textContent).toBe('Adblocker is off.');
    const cb = host.querySelector('.sv-blocklist-check');
    expect(cb.checked).toBe(true);
    cb.checked = false;
    cb.dispatchEvent(new Event('change'));
    const persisted = bridge._setCalls.find((c) => c.path === 'settings.adblocker.builtinEnabled');
    expect(persisted.value).toEqual([]);
  });

  test('adblockerLists: removing a custom list rewrites config + reloads', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'adblocker:get-catalog') return Promise.resolve([]);
      if (channel === 'adblocker:get-stats') return Promise.resolve({ enabled: true, activeListCount: 1, filterCount: 2500, lastReloadAt: Date.now() - 120000 });
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { adblocker: { builtinEnabled: [], customLists: [{ id: 'c1', name: 'List', url: 'https://l/', filterCount: 12 }] } } });
    mods.adblockerLists({ host, configBridge: bridge });
    await tick();
    expect(host.querySelector('.sv-stat-footer').textContent).toContain('3K filters');
    findBtn(host, 'Remove').click();
    const persisted = bridge._setCalls.find((c) => c.path === 'settings.adblocker.customLists');
    expect(persisted.value).toEqual([]);
    expect(ipcRenderer.send).toHaveBeenCalledWith('adblocker:reload');
  });

  test('adblockerLists: blank add URL shows an error; duplicate URL is rejected', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'adblocker:get-catalog') return Promise.resolve([]);
      if (channel === 'adblocker:get-stats') return Promise.resolve({ enabled: true, activeListCount: 0, filterCount: 0, lastReloadAt: 0 });
      if (channel === 'adblocker:validate') return Promise.resolve({ ok: true, filterCount: 5 });
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { adblocker: { builtinEnabled: [], customLists: [{ id: 'x', url: 'https://dup/' }] } } });
    mods.adblockerLists({ host, configBridge: bridge });
    await tick();
    const urlInput = host.querySelector('.sv-blocklist-add-row input');
    findBtn(host, 'Add list').click();
    expect(host.querySelector('.sv-blocklist-add-row .sv-validation-status').textContent).toContain('Enter a URL');
    urlInput.value = 'https://dup/';
    findBtn(host, 'Add list').click();
    await tick(); await tick();
    expect(host.querySelector('.sv-blocklist-add-row .sv-validation-status').textContent).toContain('Already added');
  });

  test('adblockerLists: validate rejection surfaces the thrown message', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'adblocker:get-catalog') return Promise.resolve([]);
      if (channel === 'adblocker:get-stats') return Promise.resolve({ enabled: true, activeListCount: 0, filterCount: 0, lastReloadAt: 0 });
      if (channel === 'adblocker:validate') return Promise.reject(new Error('timeout'));
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    mods.adblockerLists({ host, configBridge: fakeBridge({ settings: { adblocker: { builtinEnabled: [], customLists: [] } } }) });
    await tick();
    host.querySelector('.sv-blocklist-add-row input').value = 'https://new/';
    findBtn(host, 'Add list').click();
    await tick(); await tick();
    expect(host.querySelector('.sv-blocklist-add-row .sv-validation-status').textContent).toContain('timeout');
  });

  test('adblockerLists: get-stats rejection shows the failure in the footer', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'adblocker:get-catalog') return Promise.resolve([]);
      if (channel === 'adblocker:get-stats') return Promise.reject(new Error('x'));
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    mods.adblockerLists({ host, configBridge: fakeBridge({ settings: { adblocker: {} } }) });
    await tick(); await tick();
    const footer = host.querySelector('.sv-stat-footer');
    expect(footer.textContent).toBe("Couldn't read adblocker status: x");
    expect(footer.classList.contains('is-error')).toBe(true);
  });

  test('adblockerLists: catalog rejection shows an error in the built-in section and still renders custom', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'adblocker:get-catalog') return Promise.reject(new Error('x'));
      if (channel === 'adblocker:get-stats') return Promise.resolve({ enabled: true, activeListCount: 0, filterCount: 0, lastReloadAt: 0 });
      return Promise.resolve(null);
    });
    const mods = loadModules();
    const host = freshHost();
    mods.adblockerLists({ host, configBridge: fakeBridge({ settings: { adblocker: {} } }) });
    await tick();
    const sections = host.querySelectorAll('.sv-blocklist-section');
    expect(sections.length).toBe(2);
    const err = sections[0].querySelector('.sv-empty-row--error');
    expect(err.textContent).toBe("Couldn't load the built-in lists: x");
    expect(sections[1].querySelector('.sv-empty-row').textContent).toContain('No custom blocklists');
  });

  // agentSafety: revoke when origin retains other keys (kept, not deleted)
  test('agentSafety revoke keeps the origin when it still has non-egress keys', () => {
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { llm: { agent: {
      egress: { mode: 'open' },
      approval: { perOrigin: { 'https://c.com': { egress: 'allow', clickWrite: 'allow' } } },
    } } } });
    mods.agentSafety({ host, configBridge: bridge });
    findBtn(host, 'Revoke').click();
    const persisted = bridge._setCalls.find((c) => c.path === 'settings.llm.agent.approval.perOrigin');
    expect(persisted.value['https://c.com']).toEqual({ clickWrite: 'allow' });
  });

  // routines: Run-now where lastRunAt/createdAt missing; normalize daily next-run
  test('routines normalizes a malformed schedule and still renders a sub-line', () => {
    const mods = loadModules();
    const host = freshHost();
    mods.routines({ host, configBridge: fakeBridge({ settings: { routines: { items: [
      { id: 'rx', name: 'Bad', task: 'do', schedule: { kind: 'nonsense' } },
    ] } } }) });
    expect(host.querySelector('.sv-persona-sub').textContent).toMatch(/Every|Daily/);
  });

  test('routines Save on a row whose id is absent leaves items untouched', () => {
    const mods = loadModules();
    const host = freshHost();
    // Two items; we mutate the bridge store so the row id no longer matches.
    const bridge = fakeBridge({ settings: { routines: { items: [
      { id: 'r1', name: 'R', task: 'task here', schedule: { kind: 'interval', everyMinutes: 30 }, enabled: true },
    ] } } });
    mods.routines({ host, configBridge: bridge });
    // Replace the underlying item id so save()'s map finds no match.
    bridge.set('settings.routines.items', [{ id: 'OTHER', name: 'X', task: 'y', schedule: { kind: 'interval', everyMinutes: 30 }, enabled: true }]);
    bridge._setCalls.length = 0;
    const row = host.querySelector('.sv-space-row');
    row.querySelector('input[type="text"]').value = 'Renamed';
    findBtn(row, 'Save').click();
    const persisted = bridge._setCalls.find((c) => c.path === 'settings.routines.items');
    // Item id 'r1' isn't present → unchanged array written back.
    expect(persisted.value.find((x) => x.id === 'r1')).toBeUndefined();
    expect(persisted.value[0].id).toBe('OTHER');
  });

  // downloadLocation: choose-folder returns string (already covered) +
  // confirm pathEl updates on success
  test('downloadLocation Choose folder success updates the displayed path', async () => {
    ipcRenderer.invoke.mockResolvedValueOnce('/new/dl/path');
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { downloadLocation: '/old' } });
    mods.downloadLocation({ host, configBridge: bridge });
    findBtn(host, 'Choose folder').click();
    await tick();
    expect(host.querySelector('.sv-path').textContent).toBe('/new/dl/path');
    expect(bridge._setCalls).toContainEqual({ path: 'settings.downloadLocation', value: '/new/dl/path' });
  });

  // spellCheck / acceptLanguages: non-array stored value coerces to String
  test('spellCheckLanguages renders a non-array stored value as a string', () => {
    const mods = loadModules();
    const host = freshHost();
    mods.spellCheckLanguages({ host, configBridge: fakeBridge({ settings: { spellCheck: { languages: 'en-US' } } }) });
    expect(host.querySelector('input').value).toBe('en-US');
  });

  test('acceptLanguages renders a non-array stored value as a string', () => {
    const mods = loadModules();
    const host = freshHost();
    mods.acceptLanguages({ host, configBridge: fakeBridge({ settings: { acceptLanguages: 'fr' } }) });
    expect(host.querySelector('input').value).toBe('fr');
  });
});

// -- mcpServers() -----------------------------------------------------------

describe('customModules.mcpServers()', () => {
  const routeIpc = (handlers) => {
    ipcRenderer.invoke.mockImplementation((channel, ...args) => {
      const h = handlers[channel];
      if (typeof h === 'function') return h(...args);
      if (h !== undefined) return Promise.resolve(h);
      return Promise.resolve(null);
    });
  };
  const mount = (settings) => {
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings });
    mods.mcpServers({ host, configBridge: bridge });
    return { host, bridge };
  };

  test('renders one row per configured server and a clear banner when the SDK is available', async () => {
    routeIpc({ 'mcp:available': { ok: true, available: true }, 'mcp:status': { servers: [] } });
    const { host } = mount({ mcp: { enabled: true, servers: [{ id: 'fs', name: 'Files', transport: 'stdio', command: 'npx' }] } });
    await tick();
    expect(host.querySelectorAll('.sv-space-row').length).toBe(1);
    expect(host.querySelector('.sv-persona-title').textContent).toBe('Files');
    const banner = host.querySelector('.sv-validation-status');
    expect(banner.textContent).toBe('');
    expect(banner.classList.contains('is-error')).toBe(false);
  });

  test('master toggle persists settings.mcp.enabled and reloads McpService', async () => {
    routeIpc({ 'mcp:available': { ok: true, available: true } });
    const { host, bridge } = mount({ mcp: { enabled: false, servers: [] } });
    const cb = host.querySelector('.sv-row > input[type="checkbox"]');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    await tick();
    expect(bridge.set).toHaveBeenCalledWith('settings.mcp.enabled', true);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('mcp:reload');
  });

  test('Save persists a stdio server with parsed args/env and reports Saved', async () => {
    routeIpc({ 'mcp:available': { ok: true, available: true }, 'mcp:status': { servers: [] } });
    const { host, bridge } = mount({ mcp: { enabled: true, servers: [{ id: 'mcp1', transport: 'stdio', command: '' }] } });
    const row = host.querySelector('.sv-space-row');
    row.querySelector('input[placeholder="Display name"]').value = 'Files';
    row.querySelector('input[placeholder^="Command"]').value = 'npx';
    const [argsArea, envArea] = row.querySelectorAll('textarea');
    argsArea.value = '-y\n@mcp/fs\n';
    envArea.value = 'ROOT=/tmp\nbad-line\n';
    findBtn(row, 'Save').click();
    await tick();
    expect(bridge.set).toHaveBeenCalledWith('settings.mcp.servers', [
      { id: 'mcp1', name: 'Files', transport: 'stdio', enabled: true, command: 'npx', args: ['-y', '@mcp/fs'], env: { ROOT: '/tmp' } },
    ]);
    expect(row.querySelector('.sv-actions-row .sv-validation-status').textContent).toBe('Saved.');
  });

  test('Save rejects an http server with an invalid URL and does not persist', async () => {
    routeIpc({ 'mcp:available': { ok: true, available: true }, 'mcp:status': { servers: [] } });
    const { host, bridge } = mount({ mcp: { enabled: true, servers: [{ id: 'h', transport: 'http', url: '' }] } });
    await tick();
    const row = host.querySelector('.sv-space-row');
    row.querySelector('input[placeholder^="https://"]').value = 'ftp://nope';
    findBtn(row, 'Save').click();
    await tick();
    const status = row.querySelector('.sv-actions-row .sv-validation-status');
    expect(status.textContent).toBe('Enter a valid http(s) URL.');
    expect(status.classList.contains('is-error')).toBe(true);
    expect(bridge.set).not.toHaveBeenCalledWith('settings.mcp.servers', expect.anything());
  });

  test('a rejected reload after Save is shown on the row instead of "Saved."', async () => {
    routeIpc({
      'mcp:available': { ok: true, available: true },
      'mcp:status': { servers: [] },
      'mcp:reload': () => Promise.reject(new Error('spawn ENOENT')),
    });
    const { host } = mount({ mcp: { enabled: true, servers: [{ id: 'fs', transport: 'stdio', command: 'npx' }] } });
    const row = host.querySelector('.sv-space-row');
    findBtn(row, 'Save').click();
    await tick(); await tick();
    const status = row.querySelector('.sv-actions-row .sv-validation-status');
    expect(status.textContent).toBe("Couldn't reload MCP servers: spawn ENOENT");
    expect(status.getAttribute('role')).toBe('alert');
  });

  test('a rejected reload from the master toggle is shown in the banner', async () => {
    routeIpc({ 'mcp:available': { ok: true, available: true }, 'mcp:reload': () => Promise.reject(new Error('down')) });
    const { host } = mount({ mcp: { enabled: false, servers: [] } });
    await tick();
    const cb = host.querySelector('.sv-row > input[type="checkbox"]');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    await tick(); await tick();
    expect(host.querySelector('.sv-validation-status').textContent).toBe("Couldn't reload MCP servers: down");
  });

  test('availability rejection and a missing SDK both render a visible banner error', async () => {
    routeIpc({ 'mcp:available': () => Promise.reject(new Error('ipc gone')) });
    let { host } = mount({ mcp: {} });
    await tick();
    expect(host.querySelector('.sv-validation-status').textContent).toBe("Couldn't check MCP availability: ipc gone");
    routeIpc({ 'mcp:available': { ok: true, available: false } });
    ({ host } = mount({ mcp: {} }));
    await tick();
    expect(host.querySelector('.sv-validation-status').textContent).toMatch(/MCP SDK not detected/);
  });

  test('status rejection is surfaced on the row', async () => {
    routeIpc({ 'mcp:available': { ok: true, available: true }, 'mcp:status': () => Promise.reject(new Error('no status')) });
    const { host } = mount({ mcp: { enabled: true, servers: [{ id: 'fs', transport: 'stdio', command: 'npx' }] } });
    await tick();
    expect(host.querySelector('.sv-space-row .sv-actions-row .sv-validation-status').textContent).toBe("Couldn't read server status: no status");
  });

  test('Remove drops the server from config', async () => {
    routeIpc({ 'mcp:available': { ok: true, available: true }, 'mcp:status': { servers: [] } });
    const { host, bridge } = mount({ mcp: { enabled: true, servers: [{ id: 'a', command: 'x' }, { id: 'b', command: 'y' }] } });
    findBtn(host.querySelectorAll('.sv-space-row')[0], 'Remove').click();
    await tick();
    expect(bridge.set).toHaveBeenCalledWith('settings.mcp.servers', [{ id: 'b', command: 'y' }]);
    expect(host.querySelectorAll('.sv-space-row').length).toBe(1);
  });
});

// -- modelOverrides() -------------------------------------------------------

describe('customModules.modelOverrides()', () => {
  const mount = (perModelOverrides) => {
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { llm: { perModelOverrides } } });
    mods.modelOverrides({ host, configBridge: bridge });
    return { host, bridge };
  };

  test('shows a loading state and renders no rows until llm:backends settles', async () => {
    let resolveBackends;
    ipcRenderer.invoke.mockImplementation((channel) => (channel === 'llm:backends'
      ? new Promise((r) => { resolveBackends = r; })
      : Promise.resolve(null)));
    const { host } = mount({ '/m/a.gguf': { backend: 'mlx' } });
    expect(host.querySelector('.sv-empty-hint').textContent).toBe('Loading backends…');
    expect(host.querySelector('.sv-space-row')).toBeNull();
    expect(findBtn(host, 'Add override').disabled).toBe(true);
    resolveBackends({ backends: [{ id: 'llamacpp', label: 'llama.cpp' }, { id: 'mlx', label: 'MLX' }] });
    await tick();
    const sel = host.querySelector('.sv-space-row select');
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(['', 'llamacpp', 'mlx']);
    expect(sel.value).toBe('mlx');
    expect(findBtn(host, 'Add override').disabled).toBe(false);
  });

  test('race: a saved backend survives a re-save even when the catalog fails to load', async () => {
    ipcRenderer.invoke.mockImplementation((channel) => (channel === 'llm:backends'
      ? Promise.reject(new Error('engine offline'))
      : Promise.resolve(null)));
    const { host, bridge } = mount({ '/m/a.gguf': { backend: 'mlx', flags: { contextSize: 8192 } } });
    await tick();
    expect(host.querySelector('.sv-empty-row--error').textContent)
      .toBe("Couldn't load the backend list: engine offline. Saved backends are kept.");
    const row = host.querySelector('.sv-space-row');
    expect(row.querySelector('select').value).toBe('mlx');
    findBtn(row, 'Save').click();
    expect(bridge.set).toHaveBeenLastCalledWith('settings.llm.perModelOverrides', {
      '/m/a.gguf': { backend: 'mlx', flags: { contextSize: 8192 } },
    });
  });

  test('Save renames the key and parses typed flags', async () => {
    ipcRenderer.invoke.mockImplementation(() => Promise.resolve({ backends: [] }));
    const { host, bridge } = mount({ 'model-1': {} });
    await tick();
    const row = host.querySelector('.sv-space-row');
    row.querySelector('input.sv-text').value = '/m/b.gguf';
    row.querySelector('textarea').value = 'contextSize=4096\ntemperature=0.3\nflashAttn=true\nchatTemplate=chatml';
    findBtn(row, 'Save').click();
    expect(bridge.set).toHaveBeenLastCalledWith('settings.llm.perModelOverrides', {
      '/m/b.gguf': { flags: { contextSize: 4096, temperature: 0.3, flashAttn: true, chatTemplate: 'chatml' } },
    });
    expect(row.querySelector('.sv-validation-status').textContent).toBe('Saved.');
  });

  test('Save rejects malformed flag lines and an empty path without persisting', async () => {
    ipcRenderer.invoke.mockImplementation(() => Promise.resolve({ backends: [] }));
    const { host, bridge } = mount({ '/m/a.gguf': {} });
    await tick();
    const row = host.querySelector('.sv-space-row');
    row.querySelector('textarea').value = 'contextSize=4096\njust-a-word';
    findBtn(row, 'Save').click();
    const status = row.querySelector('.sv-validation-status');
    expect(status.textContent).toBe('Not key=value: just-a-word');
    expect(status.classList.contains('is-error')).toBe(true);
    row.querySelector('input.sv-text').value = '  ';
    findBtn(row, 'Save').click();
    expect(status.textContent).toBe('Model path is required.');
    expect(bridge.set).not.toHaveBeenCalled();
  });

  test('Add override never overwrites an existing draft key', async () => {
    ipcRenderer.invoke.mockImplementation(() => Promise.resolve({ backends: [] }));
    const { host, bridge } = mount({ 'model-2': { backend: 'mlx' } });
    await tick();
    findBtn(host, 'Add override').click();
    expect(bridge.set).toHaveBeenLastCalledWith('settings.llm.perModelOverrides', { 'model-2': { backend: 'mlx' }, 'model-3': {} });
  });
});

// -- projects() -------------------------------------------------------------

describe('customModules.projects()', () => {
  const routeIpc = (handlers) => {
    ipcRenderer.invoke.mockImplementation((channel, arg) => {
      const h = handlers[channel];
      if (typeof h === 'function') return h(arg);
      return Promise.resolve(h === undefined ? { ok: true } : h);
    });
  };
  const toastText = () => Array.from(document.querySelectorAll('.toast-error .toast-message')).map((n) => n.textContent);
  const mount = () => {
    const mods = loadModules();
    const host = freshHost();
    mods.projects({ host, configBridge: fakeBridge({}) });
    return host;
  };

  test('renders a card per project with its files', async () => {
    routeIpc({
      'projects:list': { ok: true, projects: [{ id: 'p1', name: 'Research', alwaysInContext: true }] },
      'projects:files': { ok: true, files: [{ id: 'f1', name: 'notes.md', size: 2048, isImage: false }] },
    });
    const host = mount();
    await tick(); await tick();
    expect(host.querySelector('.sv-project-name').value).toBe('Research');
    expect(host.querySelector('.sv-project-toggle-row input').checked).toBe(true);
    expect(host.querySelector('.sv-file-chip-name').textContent).toBe('notes.md');
    expect(host.querySelector('.sv-file-chip-size').textContent).toBe('2.0 KB');
  });

  test('Create sends the trimmed name, clears the input and refreshes', async () => {
    routeIpc({ 'projects:list': { ok: true, projects: [] } });
    const host = mount();
    await tick();
    const input = host.querySelector('.sv-projects-add-row input');
    input.value = '  Q4 Research ';
    findBtn(host, 'Create project').click();
    await tick();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('projects:create', { name: 'Q4 Research' });
    expect(input.value).toBe('');
    expect(ipcRenderer.invoke.mock.calls.filter(([c]) => c === 'projects:list').length).toBe(2);
  });

  test('Create failure ({ok:false}) keeps the typed name and shows an error toast', async () => {
    routeIpc({ 'projects:list': { ok: true, projects: [] }, 'projects:create': { ok: false, error: 'disk full' } });
    const host = mount();
    await tick();
    const input = host.querySelector('.sv-projects-add-row input');
    input.value = 'Specs';
    findBtn(host, 'Create project').click();
    await tick(); await tick();
    expect(input.value).toBe('Specs');
    expect(toastText()).toContain("Couldn't create project: disk full");
  });

  test('list failure renders a visible error row, not "No projects yet"', async () => {
    routeIpc({ 'projects:list': { ok: false, error: 'corrupt index' } });
    const host = mount();
    await tick(); await tick();
    const err = host.querySelector('.sv-projects-list .sv-empty-row--error');
    expect(err.textContent).toBe("Couldn't load projects: corrupt index");
    expect(host.querySelector('.sv-projects-list').textContent).not.toMatch(/No projects yet/);
  });

  test('always-in-context failure reverts the checkbox and toasts', async () => {
    routeIpc({
      'projects:list': { ok: true, projects: [{ id: 'p1', name: 'R', alwaysInContext: false }] },
      'projects:files': { ok: true, files: [] },
      'projects:setContext': () => Promise.reject(new Error('locked')),
    });
    const host = mount();
    await tick(); await tick();
    const cb = host.querySelector('.sv-project-toggle-row input');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    await tick(); await tick();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('projects:setContext', { id: 'p1', on: true });
    expect(cb.checked).toBe(false);
    expect(toastText()).toContain('Couldn\'t change "always in context": locked');
  });

  test('files failure renders a visible error row inside the card', async () => {
    routeIpc({
      'projects:list': { ok: true, projects: [{ id: 'p1', name: 'R' }] },
      'projects:files': () => Promise.reject(new Error('EACCES')),
    });
    const host = mount();
    await tick(); await tick();
    expect(host.querySelector('.sv-project-files-list .sv-empty-row--error').textContent)
      .toBe("Couldn't load project files: EACCES");
  });
});

// -- validation error paths for config-only modules -------------------------

describe('customModules validation error paths', () => {
  test('accentColor: an invalid saved value shows the default and a visible error', () => {
    const mods = loadModules();
    const host = freshHost();
    mods.accentColor({ host, configBridge: fakeBridge({ settings: { accentColor: 'tomato' } }) });
    expect(host.querySelector('input[type="color"]').value).toBe('#0089ab');
    const status = host.querySelector('.sv-validation-status');
    expect(status.textContent).toBe('Saved accent "tomato" is not a #rrggbb color; showing the default.');
    expect(status.classList.contains('is-error')).toBe(true);
  });

  test('customSearchEngines: a URL without %s is rejected and not persisted; a valid one is', () => {
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { customSearchEngines: [{ id: 'e', name: 'E', url: '' }] } });
    mods.customSearchEngines({ host, configBridge: bridge });
    const url = host.querySelector('input[aria-label="Search engine URL"]');
    url.value = 'https://search.example/?q=';
    url.dispatchEvent(new Event('change'));
    expect(bridge.set).not.toHaveBeenCalled();
    expect(url.getAttribute('aria-invalid')).toBe('true');
    expect(host.querySelector('.sv-validation-status').textContent).toBe('Enter an http(s) URL containing %s where the search terms go.');
    url.value = 'https://search.example/?q=%s';
    url.dispatchEvent(new Event('change'));
    expect(bridge.set).toHaveBeenCalledWith('settings.customSearchEngines', [{ id: 'e', name: 'E', url: 'https://search.example/?q=%s' }]);
    expect(url.hasAttribute('aria-invalid')).toBe(false);
  });

  test('agentSafety: a block entry with a port is rejected; scheme/path/wildcard forms are accepted', () => {
    const mods = loadModules();
    const host = freshHost();
    const bridge = fakeBridge({ settings: { llm: { agent: { egress: { mode: 'open', block: [] } } } } });
    mods.agentSafety({ host, configBridge: bridge });
    let ta = host.querySelector('textarea');
    ta.value = 'localhost:8080\nexample.com';
    ta.dispatchEvent(new Event('change'));
    expect(bridge.set).not.toHaveBeenCalled();
    expect(host.querySelector('.sv-validation-status').textContent)
      .toBe('Not a domain: localhost:8080. Use bare hostnames like example.com.');
    ta = host.querySelector('textarea');
    ta.value = 'https://ads.example.com/x\n*.tracker.net';
    ta.dispatchEvent(new Event('change'));
    expect(bridge.set).toHaveBeenCalledWith('settings.llm.agent.egress.block', ['https://ads.example.com/x', '*.tracker.net']);
  });
});

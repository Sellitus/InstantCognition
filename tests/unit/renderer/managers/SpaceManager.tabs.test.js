// Locks in the tab-list contracts the highlight/persistence fix established:
//   - Single-mode focus switches MUST NOT collapse openTabs (the "tabs vanish
//     when I click another one" bug).
//   - toggleMulti multi→single MUST preserve openTabs (mode change is a
//     visibility change, not a close).
//   - reorderTabs MUST reject non-permutations.
//   - Boot replay (multiple selects in multi-mode) MUST not collapse openTabs.

jest.mock('electron', () => ({
  ipcRenderer: { send: jest.fn(), on: jest.fn(), invoke: jest.fn(async () => ({ ok: true })) },
}));
const { ipcRenderer } = require('electron');

const AppState = require('../../../../renderer/core/AppState');
const NavigationManager = require('../../../../renderer/managers/NavigationManager');
const SpaceManager = require('../../../../renderer/managers/SpaceManager');

function setupDom() {
  const container = document.createElement('div');
  container.id = 'space-container';
  document.body.appendChild(container);
}

function makeManager() {
  const state = new AppState();
  const nav = new NavigationManager(state);
  const layout = { refresh: jest.fn() };
  const spaceManager = new SpaceManager(state, nav, layout);
  spaceManager.setSaveCallback(jest.fn());

  state.initFromConfig({
    spaces: {
      custom1: { name: 'ChatGPT', url: 'https://chatgpt.com/', type: 'ai-service' },
      custom2: { name: 'Claude', url: 'https://claude.ai/', type: 'ai-service' },
      custom3: { name: 'Gemini', url: 'https://gemini.google.com/', type: 'ai-service' },
    },
    settings: { multiSpace: false, defaultSpace: 'custom1' },
    state: { activeSpaces: ['custom1'], openTabs: ['custom1'], lastActiveSpaces: [] },
  });

  return { state, spaceManager, layout };
}

describe('SpaceManager tab-list persistence', () => {
  beforeEach(setupDom);
  afterEach(() => {
    document.body.textContent = '';
    jest.clearAllMocks();
  });

  test('single-mode focus switch keeps every other tab in openTabs', () => {
    const { state, spaceManager } = makeManager();
    // Open three tabs while in single-mode (each open call focuses too).
    spaceManager.openTab('custom1');
    spaceManager.openTab('custom2');
    spaceManager.openTab('custom3');

    expect(state.get('openTabs')).toEqual(['custom1', 'custom2', 'custom3']);
    expect(state.get('currentSpaceId')).toBe('custom3');

    // Switching focus back to custom1 must NOT collapse openTabs to [custom1]
    // (this was the bug: _activate single-mode used to overwrite the list).
    spaceManager.focusTab('custom1');

    expect(state.get('currentSpaceId')).toBe('custom1');
    expect(state.get('openTabs')).toEqual(['custom1', 'custom2', 'custom3']);
  });

  test('opening an already-open tab in single-mode does not duplicate it', () => {
    const { state, spaceManager } = makeManager();
    spaceManager.openTab('custom1');
    spaceManager.openTab('custom2');
    spaceManager.openTab('custom1');

    expect(state.get('openTabs')).toEqual(['custom1', 'custom2']);
    expect(state.get('currentSpaceId')).toBe('custom1');
  });

  test('toggleMulti multi→single preserves all openTabs and clears hiddenTabs', () => {
    const { state, spaceManager } = makeManager();
    // Get into multi-mode with three open tabs and one hidden.
    spaceManager.toggleMulti();
    spaceManager.openTab('custom1');
    spaceManager.openTab('custom2');
    spaceManager.openTab('custom3');
    state.set('hiddenTabs', ['custom2']);

    expect(state.get('multiSpace')).toBe(true);
    expect(state.get('openTabs').length).toBe(3);

    spaceManager.toggleMulti();

    // Mode change is a visibility change, not a close — every tab survives.
    expect(state.get('multiSpace')).toBe(false);
    expect(state.get('openTabs').sort()).toEqual(['custom1', 'custom2', 'custom3']);
    // hiddenTabs is a multi-mode concept; cleared so re-enabling multi starts fresh.
    expect(state.get('hiddenTabs')).toEqual([]);
    // currentSpaceId is set to a real, still-open tab.
    expect(state.get('openTabs')).toContain(state.get('currentSpaceId'));
  });

  test('reorderTabs rejects non-permutations and accepts valid permutations', () => {
    const { state, spaceManager, layout } = makeManager();
    spaceManager.toggleMulti();
    spaceManager.openTab('custom1');
    spaceManager.openTab('custom2');
    spaceManager.openTab('custom3');
    layout.refresh.mockClear();

    // Wrong length — rejected, no layout refresh.
    spaceManager.reorderTabs(['custom1', 'custom2']);
    expect(state.get('openTabs')).toEqual(['custom1', 'custom2', 'custom3']);
    expect(layout.refresh).not.toHaveBeenCalled();

    // Same length but contains an unknown id — rejected.
    spaceManager.reorderTabs(['custom1', 'custom2', 'bogus']);
    expect(state.get('openTabs')).toEqual(['custom1', 'custom2', 'custom3']);
    expect(layout.refresh).not.toHaveBeenCalled();

    // Valid permutation — accepted, layout refreshed.
    spaceManager.reorderTabs(['custom3', 'custom1', 'custom2']);
    expect(state.get('openTabs')).toEqual(['custom3', 'custom1', 'custom2']);
    expect(layout.refresh).toHaveBeenCalled();
  });

  test('pruneRemovedTabs tears down removed tabs without touching the tab model', () => {
    const { ipcRenderer } = require('electron');
    const { state, spaceManager } = makeManager();
    spaceManager.openTab('custom1');
    spaceManager.openTab('custom2');
    spaceManager.openTab('custom3');
    // The caller (main-side spaces:remove sync) already applied the
    // post-removal openTabs and re-pointed currentSpaceId.
    state.set('openTabs', ['custom1', 'custom3']);
    state.set('currentSpaceId', 'custom3');

    spaceManager.pruneRemovedTabs(['custom2']);

    // Tab model untouched by the prune itself — the removal is the caller's.
    expect(state.get('openTabs')).toEqual(['custom1', 'custom3']);
    // The removed tab's wrapper is destroyed and main is told to drop it.
    expect(document.getElementById('custom2')).toBeNull();
    expect(ipcRenderer.send).toHaveBeenCalledWith('space-closed', { spaceId: 'custom2' });
  });

  test('pruneRemovedTabs is a safe no-op for empty / non-array input', () => {
    const { ipcRenderer } = require('electron');
    const { state, spaceManager } = makeManager();
    spaceManager.openTab('custom1');
    ipcRenderer.send.mockClear();

    spaceManager.pruneRemovedTabs([]);
    spaceManager.pruneRemovedTabs(null);

    expect(state.get('openTabs')).toEqual(['custom1']);
    expect(ipcRenderer.send).not.toHaveBeenCalledWith('space-closed', expect.anything());
  });

  test('boot-replay: select() called for each persisted activeSpace in multi-mode keeps all tabs', () => {
    // Mirrors renderer.js boot path: enable multi, then call select() for each
    // persisted activeSpace. Previously _activate's single-mode collapse path
    // could be reached on the first select before multi was set, dropping tabs.
    const { state, spaceManager } = makeManager();
    state.set('multiSpace', true);
    const cfg = state.get('config');
    if (cfg && cfg.settings) cfg.settings.multiSpace = true;

    ['custom1', 'custom2', 'custom3'].forEach((id) => {
      spaceManager.select(id, true, true);
    });

    expect(state.get('openTabs').sort()).toEqual(['custom1', 'custom2', 'custom3']);
    const active = state.get('activeSpaces');
    expect(active.custom1).toBe(true);
    expect(active.custom2).toBe(true);
    expect(active.custom3).toBe(true);
  });
});

// Electron's <webview> takes its partition only before the first navigation,
// so the fixture records the partition attribute at the moment src is set.
function recordSrcAssignments() {
  const realCreate = document.createElement.bind(document);
  return jest.spyOn(document, 'createElement').mockImplementation((tag, opts) => {
    const el = realCreate(tag, opts);
    if (tag === 'webview') {
      let src = '';
      Object.defineProperty(el, 'src', {
        configurable: true,
        get: () => src,
        set: (value) => { src = value; el.partitionAtFirstSrc = el.partitionAtFirstSrc ?? el.getAttribute('partition'); },
      });
    }
    return el;
  });
}

describe('SpaceManager private tabs', () => {
  beforeEach(setupDom);
  afterEach(() => {
    document.body.textContent = '';
    jest.clearAllMocks();
  });

  const settle = () => new Promise((r) => setTimeout(r, 0));

  test('openPrivateTab mounts its webview in the private partition before the first src', async () => {
    recordSrcAssignments();
    const { state, spaceManager } = makeManager();
    spaceManager.openTab('custom1');
    const id = spaceManager.openPrivateTab('https://secret.example/inbox');
    const wv = document.getElementById(id);
    await settle();
    expect(wv.getAttribute('partition')).toBe('private');
    expect(wv.partitionAtFirstSrc).toBe('private');
    expect(wv.src).toBe('https://secret.example/inbox');
    expect(state.get('currentSpaceId')).toBe(id);
    expect(spaceManager.isPrivateTab(id)).toBe(true);
  });

  test('with no URL it opens the default new-tab page; a regular ad-hoc tab gets no partition', async () => {
    recordSrcAssignments();
    const { spaceManager } = makeManager();
    const priv = spaceManager.openPrivateTab();
    await settle();
    expect(document.getElementById(priv).src).toBe('https://www.google.com/');
    const regular = spaceManager.openAdHocTab('https://docs.example/');
    expect(document.getElementById(regular).hasAttribute('partition')).toBe(false);
    expect(spaceManager.isPrivateTab(regular)).toBe(false);
  });

  test('a private tab loads nothing until main confirms the last private session is wiped', async () => {
    recordSrcAssignments();
    let answer;
    ipcRenderer.invoke.mockImplementation((channel) => (channel === 'session:private-ready'
      ? new Promise((r) => { answer = r; })
      : Promise.resolve({ ok: true })));
    const { spaceManager } = makeManager();
    const first = spaceManager.openPrivateTab('https://a.example/');
    answer({ ok: true });
    await settle();
    spaceManager.closeTab(first);
    const second = spaceManager.openPrivateTab('https://b.example/');
    const wv = document.getElementById(second);
    await settle();
    const channels = ipcRenderer.invoke.mock.calls.map(([c]) => c);
    expect(channels.lastIndexOf('session:clear-private')).toBeLessThan(channels.lastIndexOf('session:private-ready'));
    expect(wv.src).toBe('');
    answer({ ok: true });
    await settle();
    expect(wv.src).toBe('https://b.example/');
  });

  test('a private tab stays blank and says why when the old session could not be wiped', async () => {
    recordSrcAssignments();
    const Toast = require('../../../../renderer/components/Toast');
    const toastError = jest.spyOn(Toast, 'error').mockImplementation(() => {});
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    ipcRenderer.invoke.mockImplementation(async (channel) => (channel === 'session:private-ready' ? { ok: false, error: 'busy' } : { ok: true }));
    const { spaceManager } = makeManager();
    const id = spaceManager.openPrivateTab('https://secret.example/');
    await settle();
    expect(document.getElementById(id).src).toBe('');
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('could not be cleared'), expect.objectContaining({ title: 'Private tab not loaded' }));
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[privateTabs]'), 'busy');
    toastError.mockRestore();
    consoleError.mockRestore();
    ipcRenderer.invoke.mockImplementation(async () => ({ ok: true }));
  });

  test('private tabs never reach the persisted config; regular ad-hoc tabs still do', () => {
    const { state, spaceManager } = makeManager();
    const save = jest.fn();
    spaceManager.setSaveCallback(save);
    spaceManager.openTab('custom1');
    const regular = spaceManager.openAdHocTab('https://docs.example/');
    const priv = spaceManager.openPrivateTab('https://secret.example/inbox');
    spaceManager.reorderTabs([priv, 'custom1', regular]);
    spaceManager.toggleMulti();
    spaceManager.focusTab(priv);

    const persisted = JSON.stringify(state.get('config'));
    expect(persisted).not.toContain(priv);
    expect(persisted).not.toContain('secret.example');
    expect(persisted).toContain(regular);
    expect(state.get('config').state.openTabs).toEqual(['custom1', regular]);
    expect(state.get('openTabs')).toEqual([priv, 'custom1', regular]);
    expect(save).toHaveBeenCalled();
  });

  test('a private tab cannot be pinned (pins persist across restarts)', () => {
    const { state, spaceManager } = makeManager();
    const priv = spaceManager.openPrivateTab('https://secret.example/');
    spaceManager.pinTab(priv);
    expect(state.get('pinnedTabs')).toEqual([]);
    spaceManager.pinTab('custom1');
    expect(state.get('pinnedTabs')).toEqual(['custom1']);
  });

  test('withPrivateTabs merges live private tabs back into a persisted tab list at their positions', () => {
    const { spaceManager } = makeManager();
    spaceManager.openTab('custom1');
    const p1 = spaceManager.openPrivateTab('https://a.example/');
    spaceManager.openTab('custom2');
    const p2 = spaceManager.openPrivateTab('https://b.example/');
    expect(spaceManager.withPrivateTabs(['custom1', 'custom2'])).toEqual(['custom1', p1, 'custom2', p2]);
    spaceManager.closeTab(p1);
    spaceManager.closeTab(p2);
    expect(spaceManager.withPrivateTabs(['custom1', 'custom2'])).toEqual(['custom1', 'custom2']);
  });
});

describe('SpaceManager reopen closed tab', () => {
  beforeEach(setupDom);
  afterEach(() => {
    document.body.textContent = '';
    jest.clearAllMocks();
  });

  function showing(id, url) {
    const wv = document.getElementById(id);
    wv.getURL = () => url;
    wv.getTitle = () => `Title of ${url}`;
  }

  function adHocUrls(state) {
    const adHoc = state.get('adHocSpaces') || {};
    return (state.get('openTabs') || []).filter((id) => adHoc[id]).map((id) => adHoc[id].url);
  }

  test('an empty stack is a no-op that returns false', () => {
    const { state, spaceManager } = makeManager();
    spaceManager.openTab('custom1');
    expect(spaceManager.reopenClosedTab()).toBe(false);
    expect(state.get('openTabs')).toEqual(['custom1']);
  });

  test('a closed ad-hoc tab reopens at the page it was showing', () => {
    const { state, spaceManager } = makeManager();
    spaceManager.openTab('custom1');
    const id = spaceManager.openAdHocTab('https://docs.example/start');
    showing(id, 'https://docs.example/deep/page');
    spaceManager.closeTab(id);
    expect(adHocUrls(state)).toEqual([]);

    expect(spaceManager.reopenClosedTab()).toBe(true);
    expect(adHocUrls(state)).toEqual(['https://docs.example/deep/page']);
    expect(spaceManager.isPrivateTab(state.get('currentSpaceId'))).toBe(false);
    expect(spaceManager.reopenClosedTab()).toBe(false);
  });

  test('a closed library space reopens and returns to the page it was on, or its home when it was there', () => {
    const { state, spaceManager } = makeManager();
    spaceManager.openTab('custom1');
    spaceManager.openTab('custom2');
    showing('custom2', 'https://claude.ai/chat/42');
    spaceManager.openTab('custom3');
    showing('custom3', 'https://gemini.google.com/');
    spaceManager.closeTab('custom2');
    spaceManager.closeTab('custom3');

    expect(spaceManager.reopenClosedTab()).toBe(true);
    expect(state.get('currentSpaceId')).toBe('custom3');
    expect(document.getElementById('custom3').src).toBe('https://gemini.google.com/');
    expect(spaceManager.reopenClosedTab()).toBe(true);
    expect(state.get('currentSpaceId')).toBe('custom2');
    expect(document.getElementById('custom2').src).toBe('https://claude.ai/chat/42');
    expect(adHocUrls(state)).toEqual([]);
  });

  test('a library space that is open again reopens its page as a new tab instead of navigating it away', () => {
    const { state, spaceManager } = makeManager();
    spaceManager.openTab('custom1');
    spaceManager.openTab('custom2');
    showing('custom2', 'https://claude.ai/chat/42');
    spaceManager.closeTab('custom2');
    spaceManager.openTab('custom2');
    expect(spaceManager.reopenClosedTab()).toBe(true);
    expect(document.getElementById('custom2').src).toBe('https://claude.ai/');
    expect(adHocUrls(state)).toEqual(['https://claude.ai/chat/42']);
  });

  test('a reopened private tab is private again while another private tab is open', () => {
    const { state, spaceManager } = makeManager();
    spaceManager.openTab('custom1');
    spaceManager.openPrivateTab('https://other-secret.example/');
    const id = spaceManager.openPrivateTab('https://secret.example/');
    showing(id, 'https://secret.example/thread/7');
    spaceManager.closeTab(id);
    expect(spaceManager.reopenClosedTab()).toBe(true);
    const reopened = state.get('currentSpaceId');
    expect(spaceManager.isPrivateTab(reopened)).toBe(true);
    expect(document.getElementById(reopened).getAttribute('partition')).toBe('private');
    expect(adHocUrls(state)).toEqual(['https://other-secret.example/', 'https://secret.example/thread/7']);
    expect(JSON.stringify(state.get('config'))).not.toContain('secret.example');
  });

  test('closing the last private tab wipes the private session and forgets every private close', async () => {
    const { state, spaceManager } = makeManager();
    spaceManager.openTab('custom1');
    const regular = spaceManager.openAdHocTab('https://docs.example/');
    spaceManager.closeTab(regular);
    const p1 = spaceManager.openPrivateTab('https://secret.example/a');
    const p2 = spaceManager.openPrivateTab('https://secret.example/b');
    spaceManager.closeTab(p1);
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('session:clear-private');
    spaceManager.closeTab(p2);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('session:clear-private');
    await new Promise((r) => setTimeout(r, 0));

    expect(spaceManager.reopenClosedTab()).toBe(true);
    expect(spaceManager.isPrivateTab(state.get('currentSpaceId'))).toBe(false);
    expect(adHocUrls(state)).toEqual(['https://docs.example/']);
    expect(spaceManager.reopenClosedTab()).toBe(false);
  });

  test('closing normal tabs never touches the private session', () => {
    const { spaceManager } = makeManager();
    spaceManager.openTab('custom1');
    spaceManager.closeTab(spaceManager.openAdHocTab('https://docs.example/'));
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('session:clear-private');
  });

  test('a private session that fails to clear is reported, not ignored', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    ipcRenderer.invoke.mockImplementation(async (channel) => (channel === 'session:clear-private' ? { ok: false, error: 'busy' } : { ok: true }));
    const { spaceManager } = makeManager();
    spaceManager.openTab('custom1');
    spaceManager.closeTab(spaceManager.openPrivateTab('https://secret.example/'));
    await new Promise((r) => setTimeout(r, 0));
    expect(err).toHaveBeenCalledWith(expect.stringContaining('private session could not be cleared'), 'busy');
    expect(document.body.textContent).toMatch(/could not be cleared/);
    ipcRenderer.invoke.mockImplementation(async () => ({ ok: true }));
  });

  test('the stack is most-recent-first and keeps only the last 25 closes', () => {
    const { state, spaceManager } = makeManager();
    spaceManager.openTab('custom1');
    for (let n = 0; n < 26; n += 1) {
      const id = spaceManager.openAdHocTab(`https://site${n}.example/`);
      spaceManager.closeTab(id);
    }
    expect(spaceManager.reopenClosedTab()).toBe(true);
    expect(adHocUrls(state)).toEqual(['https://site25.example/']);
    let reopened = 1;
    while (spaceManager.reopenClosedTab()) reopened += 1;
    expect(reopened).toBe(25);
    expect(adHocUrls(state)).not.toContain('https://site0.example/');
  });

  test('refused closes and main-side prunes are not recorded', () => {
    const { state, spaceManager } = makeManager();
    spaceManager.openTab('custom1');
    spaceManager.closeTab('custom1'); // the last tab never closes
    spaceManager.openTab('custom2');
    spaceManager.pinTab('custom2');
    spaceManager.closeTab('custom2'); // pinned
    spaceManager.openTab('custom3');
    state.set('openTabs', ['custom1', 'custom2']);
    spaceManager.pruneRemovedTabs(['custom3']);
    expect(spaceManager.reopenClosedTab()).toBe(false);
  });
});

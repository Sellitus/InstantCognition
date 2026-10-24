// Unit tests for renderer/managers/AgentWorkspaceManager.
//
// External boundary mocked: electron.ipcRenderer (the only thing the manager
// talks to outside the renderer DOM). AppState is the real observable from
// renderer/core/AppState — it is the project's own collaborator, not a
// boundary, so we use the real implementation per the mocking policy.

jest.mock('electron', () => {
  const { EventEmitter } = require('events');
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  return {
    ipcRenderer: {
      _emitter: emitter,
      // on() registers a real listener so we can drive 'agent-workspace:*'
      // messages exactly the way the main process would.
      on: jest.fn((channel, listener) => {
        emitter.on(channel, listener);
      }),
      send: jest.fn(),
      invoke: jest.fn(() => Promise.resolve(null)),
    },
  };
});

const AppState = require('../../../../renderer/core/AppState');
const AgentWorkspaceManager = require('../../../../renderer/managers/AgentWorkspaceManager');
const { ipcRenderer } = require('electron');

// Deliver an IPC message to whatever listener the manager registered via
// ipcRenderer.on(channel, ...). Mirrors main → renderer delivery.
function deliver(channel, payload) {
  ipcRenderer._emitter.emit(channel, { sender: {} }, payload);
}

const toast = require('../../../../renderer/components/Toast');

// _hydrate surfaces failures through the Toast singleton — reset it between
// tests so a sticky (timeout 0) error from one test can't leak into the next.
function resetToast() {
  toast._queue.length = 0;
  for (const rec of toast._visible.slice()) {
    if (rec.timerId) clearTimeout(rec.timerId);
    if (rec.el && rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
  }
  toast._visible.length = 0;
  toast._lastShown.clear();
  if (toast._container && toast._container.parentNode) {
    toast._container.parentNode.removeChild(toast._container);
  }
  toast._container = null;
}

// _hydrate chains invoke → catch(retry invoke) → then → catch; a few microtask
// ticks flush every hop deterministically.
async function flushMicrotasks() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function setupDom() {
  const container = document.createElement('div');
  container.id = 'agent-workspace-container';
  document.body.appendChild(container);

  const space = document.createElement('div');
  space.id = 'space-container';
  document.body.appendChild(space);

  const wrap = document.createElement('div');
  wrap.id = 'tab-bar-wrap';
  document.body.appendChild(wrap);
  return { container, space, wrap };
}

describe('AgentWorkspaceManager', () => {
  let state;
  let mgr;

  beforeEach(() => {
    resetToast();
    document.body.textContent = '';
    ipcRenderer.send.mockClear();
    ipcRenderer.on.mockClear();
    ipcRenderer.invoke.mockReset();
    ipcRenderer.invoke.mockResolvedValue(null);
    ipcRenderer._emitter.removeAllListeners();
    state = new AppState();
    mgr = new AgentWorkspaceManager({ state });
  });

  afterEach(() => {
    document.body.textContent = '';
  });

  describe('initialize / lifecycle', () => {
    test('wires both agent-workspace IPC channels and is idempotent', () => {
      setupDom();
      mgr.initialize();

      const channels = ipcRenderer.on.mock.calls.map((c) => c[0]);
      expect(channels).toContain('agent-workspace:tab-op');
      expect(channels).toContain('agent-workspace:restore');
      expect(ipcRenderer.on).toHaveBeenCalledTimes(2);

      // Second initialize() must not re-wire IPC.
      mgr.initialize();
      expect(ipcRenderer.on).toHaveBeenCalledTimes(2);
    });

    test('hydrate mirrors persisted workspace state into AppState', async () => {
      setupDom();
      ipcRenderer.invoke.mockResolvedValue({
        tabs: [{ id: 'a', url: 'https://a.test', title: 'A' }],
        currentTabId: 'a',
      });
      mgr.initialize();
      // _hydrate uses Promise.resolve(...).then — flush microtasks.
      await Promise.resolve();
      await Promise.resolve();

      const ws = state.get('agentWorkspace');
      expect(ws.tabs).toEqual([{ id: 'a', url: 'https://a.test', title: 'A' }]);
      expect(ws.currentTabId).toBe('a');
    });

    test('hydrate ignores a malformed get-state response', async () => {
      setupDom();
      ipcRenderer.invoke.mockResolvedValue({ notTabs: true });
      const before = state.get('agentWorkspace');
      mgr.initialize();
      await Promise.resolve();
      await Promise.resolve();
      // Unchanged — same reference, no tab mirror happened.
      expect(state.get('agentWorkspace')).toBe(before);
    });

    test('retries get-state once and hydrates on the second attempt', async () => {
      setupDom();
      const payload = { tabs: [{ id: 'a', url: 'https://a.test', title: 'A' }], currentTabId: 'a' };
      ipcRenderer.invoke
        .mockRejectedValueOnce(new Error('transient ipc failure'))
        .mockResolvedValue(payload);
      mgr.initialize();
      await flushMicrotasks();

      expect(ipcRenderer.invoke).toHaveBeenCalledTimes(2);
      const ws = state.get('agentWorkspace');
      expect(ws.tabs).toEqual(payload.tabs);
      expect(ws.currentTabId).toBe('a');
      // Recovered after one retry — nothing user-visible to complain about.
      expect(document.querySelector('.toast')).toBeNull();
    });

    test('surfaces a toast when get-state fails twice', async () => {
      setupDom();
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      ipcRenderer.invoke.mockRejectedValue(new Error('workspace down'));
      const before = state.get('agentWorkspace');
      mgr.initialize();
      await flushMicrotasks();

      expect(ipcRenderer.invoke).toHaveBeenCalledTimes(2);
      expect(state.get('agentWorkspace')).toBe(before); // stayed empty
      const alert = document.querySelector('.toast[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert.textContent).toContain('Agent workspace');
      expect(alert.textContent).toContain('workspace down');
      errSpy.mockRestore();
    });
  });

  describe('view mode', () => {
    test('viewMode "agent" shows the workspace and hides #space-container', () => {
      const { container, space } = setupDom();
      state.set('viewMode', 'agent');
      mgr.initialize();

      expect(container.style.display).toBe('flex');
      expect(space.style.display).toBe('none');
    });

    test('viewMode "user" hides the workspace and restores #space-container', () => {
      const { container, space } = setupDom();
      mgr.initialize(); // default viewMode is 'user'

      expect(container.style.display).toBe('none');
      expect(space.style.display).toBe('');
    });

    test('reacts to a later change:viewMode emission', () => {
      const { container, space } = setupDom();
      mgr.initialize();
      expect(container.style.display).toBe('none');

      state.set('viewMode', 'agent');
      expect(container.style.display).toBe('flex');
      expect(space.style.display).toBe('none');
    });

    test('container is reparented into #tab-bar-wrap on apply', () => {
      const { container, wrap } = setupDom();
      expect(container.parentNode).toBe(document.body);
      mgr.initialize();
      expect(container.parentNode).toBe(wrap);
    });

    test('toggleViewMode flips user <-> agent on AppState', () => {
      setupDom();
      mgr.initialize();
      expect(state.get('viewMode')).toBe('user');
      mgr.toggleViewMode();
      expect(state.get('viewMode')).toBe('agent');
      mgr.toggleViewMode();
      expect(state.get('viewMode')).toBe('user');
    });

    test('setViewMode rejects unknown values', () => {
      setupDom();
      mgr.initialize();
      mgr.setViewMode('agent');
      expect(state.get('viewMode')).toBe('agent');
      mgr.setViewMode('garbage');
      expect(state.get('viewMode')).toBe('agent');
    });
  });

  describe('tab-op: open', () => {
    test('open creates a webview, marks it current and replies ok with spaceId', () => {
      const { container } = setupDom();
      state.set('viewMode', 'agent');
      mgr.initialize();

      deliver('agent-workspace:tab-op', { requestId: 7, op: 'open', args: { url: 'https://x.test' } });

      const wv = container.querySelector('webview');
      expect(wv).not.toBeNull();
      expect(wv.src).toBe('https://x.test');

      const reply = ipcRenderer.send.mock.calls.find((c) => c[0] === 'agent-workspace:tab-op-result');
      expect(reply).toBeDefined();
      expect(reply[1].requestId).toBe(7);
      expect(reply[1].ok).toBe(true);
      expect(typeof reply[1].spaceId).toBe('string');
      expect(reply[1].spaceId).toMatch(/^agent-tab-/);

      const ws = state.get('agentWorkspace');
      expect(ws.currentTabId).toBe(reply[1].spaceId);
      expect(ws.tabs.map((t) => t.id)).toContain(reply[1].spaceId);
    });

    test('open defaults to about:blank when no url given', () => {
      const { container } = setupDom();
      mgr.initialize();
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open' });
      expect(container.querySelector('webview').src).toBe('about:blank');
    });

    test('open broadcasts the new tab list to main', () => {
      setupDom();
      mgr.initialize();
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url: 'https://b.test' } });

      const broadcast = ipcRenderer.send.mock.calls.find((c) => c[0] === 'agent-workspace:state-update');
      expect(broadcast).toBeDefined();
      expect(broadcast[1].tabs).toHaveLength(1);
      expect(broadcast[1].currentTabId).toBe(broadcast[1].tabs[0].id);
    });
  });

  describe('tab-op: background sessions', () => {
    const SID = 's_bgsess01';
    function lastReply() {
      const calls = ipcRenderer.send.mock.calls.filter((c) => c[0] === 'agent-workspace:tab-op-result');
      return calls[calls.length - 1][1];
    }

    test('a background open adds the tab without taking the current tab', () => {
      const { container } = setupDom();
      mgr.initialize();
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url: 'https://fg.test' } });
      const fg = lastReply().spaceId;
      deliver('agent-workspace:tab-op', { requestId: 2, op: 'open', args: { url: 'https://bg.test', sessionId: SID, background: true } });
      const bg = lastReply().spaceId;
      expect(container.querySelectorAll('webview')).toHaveLength(2);
      expect(bg).not.toBe(fg);
      expect(state.get('agentWorkspace').currentTabId).toBe(fg);
    });

    test('a background open into an empty workspace becomes current', () => {
      setupDom();
      mgr.initialize();
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url: 'https://bg.test', sessionId: SID, background: true } });
      expect(state.get('agentWorkspace').currentTabId).toBe(lastReply().spaceId);
    });

    test('a background focus replies ok and leaves the current tab alone', () => {
      setupDom();
      mgr.initialize();
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url: 'https://one.test' } });
      const one = lastReply().spaceId;
      deliver('agent-workspace:tab-op', { requestId: 2, op: 'open', args: { url: 'https://two.test' } });
      const two = lastReply().spaceId;
      deliver('agent-workspace:tab-op', { requestId: 3, op: 'focus', args: { spaceId: one, sessionId: SID, background: true } });
      expect(lastReply()).toEqual({ requestId: 3, ok: true });
      expect(state.get('agentWorkspace').currentTabId).toBe(two);
    });

    test('space-activity echoes the opening session so main never sees the tab untagged', () => {
      const { container } = setupDom();
      mgr.initialize();
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url: 'https://bg.test', sessionId: SID, background: true } });
      const wv = container.querySelector('webview');
      wv.getWebContentsId = () => 42;
      wv.dispatchEvent(new Event('did-attach'));
      const activity = ipcRenderer.send.mock.calls.filter((c) => c[0] === 'space-activity').pop();
      expect(activity[1]).toMatchObject({ spaceId: lastReply().spaceId, webContentsId: 42, kind: 'agent', sessionId: SID });
    });

    test('an untagged open announces without a sessionId', () => {
      const { container } = setupDom();
      mgr.initialize();
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url: 'https://x.test' } });
      const wv = container.querySelector('webview');
      wv.getWebContentsId = () => 7;
      wv.dispatchEvent(new Event('did-attach'));
      const activity = ipcRenderer.send.mock.calls.filter((c) => c[0] === 'space-activity').pop();
      expect(activity[1]).not.toHaveProperty('sessionId');
    });
  });

  describe('tab-op: close / focus / duplicate / unknown', () => {
    function openTab(url) {
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url } });
      const calls = ipcRenderer.send.mock.calls.filter((c) => c[0] === 'agent-workspace:tab-op-result');
      return calls[calls.length - 1][1].spaceId;
    }

    test('close refuses to close the only remaining tab', () => {
      setupDom();
      mgr.initialize();
      openTab('https://only.test');
      ipcRenderer.send.mockClear();

      deliver('agent-workspace:tab-op', { requestId: 9, op: 'close', args: { spaceId: 'whatever' } });

      const reply = ipcRenderer.send.mock.calls.find((c) => c[0] === 'agent-workspace:tab-op-result');
      expect(reply[1]).toEqual({ requestId: 9, ok: false, error: 'cannot_close_last_tab' });
    });

    test('close removes the targeted webview when more than one tab exists', () => {
      const { container } = setupDom();
      mgr.initialize();
      const id1 = openTab('https://one.test');
      openTab('https://two.test');
      expect(container.querySelectorAll('webview')).toHaveLength(2);
      ipcRenderer.send.mockClear();

      deliver('agent-workspace:tab-op', { requestId: 3, op: 'close', args: { spaceId: id1 } });

      expect(container.querySelectorAll('webview')).toHaveLength(1);
      const reply = ipcRenderer.send.mock.calls.find((c) => c[0] === 'agent-workspace:tab-op-result');
      expect(reply[1]).toEqual({ requestId: 3, ok: true });
      // Main must be told tabRegistry should drop the closed id.
      const closed = ipcRenderer.send.mock.calls.find((c) => c[0] === 'space-closed');
      expect(closed[1]).toEqual({ spaceId: id1 });
    });

    test('closing the current tab moves current to a remaining tab, in state and in the broadcast', () => {
      const { container } = setupDom();
      mgr.initialize();
      const id1 = openTab('https://one.test');
      const id2 = openTab('https://two.test');
      expect(state.get('agentWorkspace').currentTabId).toBe(id2);
      ipcRenderer.send.mockClear();

      deliver('agent-workspace:tab-op', { requestId: 4, op: 'close', args: { spaceId: id2 } });

      expect(state.get('agentWorkspace').currentTabId).toBe(id1);
      const update = ipcRenderer.send.mock.calls.find((c) => c[0] === 'agent-workspace:state-update');
      expect(update[1].currentTabId).toBe(id1);
      expect(container.querySelector(`[data-agent-tab-id="${id1}"]`).classList.contains('is-active')).toBe(true);
    });

    test('closing a non-current tab leaves current alone', () => {
      setupDom();
      mgr.initialize();
      const id1 = openTab('https://one.test');
      const id2 = openTab('https://two.test');
      deliver('agent-workspace:tab-op', { requestId: 5, op: 'close', args: { spaceId: id1 } });
      expect(state.get('agentWorkspace').currentTabId).toBe(id2);
    });

    test('focus on a known tab sets it current and replies ok', () => {
      setupDom();
      mgr.initialize();
      const id1 = openTab('https://one.test');
      openTab('https://two.test');
      ipcRenderer.send.mockClear();

      deliver('agent-workspace:tab-op', { requestId: 4, op: 'focus', args: { spaceId: id1 } });

      expect(state.get('agentWorkspace').currentTabId).toBe(id1);
      const reply = ipcRenderer.send.mock.calls.find((c) => c[0] === 'agent-workspace:tab-op-result');
      expect(reply[1]).toEqual({ requestId: 4, ok: true });
    });

    test('focus on an unknown tab replies tab_not_found', () => {
      setupDom();
      mgr.initialize();
      openTab('https://one.test');
      ipcRenderer.send.mockClear();

      deliver('agent-workspace:tab-op', { requestId: 5, op: 'focus', args: { spaceId: 'nope' } });

      const reply = ipcRenderer.send.mock.calls.find((c) => c[0] === 'agent-workspace:tab-op-result');
      expect(reply[1]).toEqual({ requestId: 5, ok: false, error: 'tab_not_found' });
    });

    test('duplicate is delegated back to main', () => {
      setupDom();
      mgr.initialize();
      deliver('agent-workspace:tab-op', { requestId: 6, op: 'duplicate', args: {} });
      const reply = ipcRenderer.send.mock.calls.find((c) => c[0] === 'agent-workspace:tab-op-result');
      expect(reply[1]).toEqual({ requestId: 6, ok: false, error: 'duplicate_handled_by_main' });
    });

    test('unknown op replies unknown_op', () => {
      setupDom();
      mgr.initialize();
      deliver('agent-workspace:tab-op', { requestId: 8, op: 'wat' });
      const reply = ipcRenderer.send.mock.calls.find((c) => c[0] === 'agent-workspace:tab-op-result');
      expect(reply[1]).toEqual({ requestId: 8, ok: false, error: 'unknown_op' });
    });
  });

  describe('restore', () => {
    test('rebuilds the container from a saved tab list and sets current', () => {
      const { container } = setupDom();
      mgr.initialize();

      deliver('agent-workspace:restore', {
        tabs: [
          { id: 't1', url: 'https://t1.test' },
          { id: 't2', url: 'https://t2.test' },
        ],
        currentTabId: 't2',
      });

      const wvs = container.querySelectorAll('webview');
      expect(Array.from(wvs).map((w) => w.id)).toEqual(['t1', 't2']);
      expect(state.get('agentWorkspace').currentTabId).toBe('t2');
      const broadcast = ipcRenderer.send.mock.calls.find((c) => c[0] === 'agent-workspace:state-update');
      expect(broadcast[1].tabs.map((t) => t.id)).toEqual(['t1', 't2']);
    });

    test('falls back to the first tab when desired current is missing', () => {
      const { container } = setupDom();
      mgr.initialize();
      deliver('agent-workspace:restore', {
        tabs: [{ id: 'first', url: 'https://f.test' }],
        currentTabId: 'gone',
      });
      expect(state.get('agentWorkspace').currentTabId).toBe('first');
      expect(container.querySelectorAll('webview')).toHaveLength(1);
    });

    test('clears existing tabs before rebuilding', () => {
      const { container } = setupDom();
      mgr.initialize();
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url: 'https://stale.test' } });
      expect(container.querySelectorAll('webview')).toHaveLength(1);

      deliver('agent-workspace:restore', { tabs: [{ id: 'r1', url: 'https://r1.test' }] });

      const wvs = container.querySelectorAll('webview');
      expect(wvs).toHaveLength(1);
      expect(wvs[0].id).toBe('r1');
    });

    test('an empty restore payload clears the workspace', () => {
      const { container } = setupDom();
      mgr.initialize();
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url: 'https://a.test' } });
      deliver('agent-workspace:restore', {});
      expect(container.querySelectorAll('webview')).toHaveLength(0);
      expect(state.get('agentWorkspace').currentTabId).toBeNull();
    });
  });

  describe('public tab management', () => {
    function openTab(url) {
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url } });
      const calls = ipcRenderer.send.mock.calls.filter((c) => c[0] === 'agent-workspace:tab-op-result');
      return calls[calls.length - 1][1].spaceId;
    }

    test('closeTab on the active tab promotes a remaining tab', () => {
      const { container } = setupDom();
      mgr.initialize();
      const id1 = openTab('https://one.test');
      const id2 = openTab('https://two.test');
      // open() set id2 current last.
      expect(state.get('agentWorkspace').currentTabId).toBe(id2);

      mgr.closeTab(id2);

      expect(container.querySelectorAll('webview')).toHaveLength(1);
      expect(state.get('agentWorkspace').currentTabId).toBe(id1);
    });

    test('closeTab refuses to close the last tab', () => {
      const { container } = setupDom();
      mgr.initialize();
      const only = openTab('https://only.test');
      mgr.closeTab(only);
      expect(container.querySelectorAll('webview')).toHaveLength(1);
    });

    test('closeTab is a no-op for an unknown id', () => {
      const { container } = setupDom();
      mgr.initialize();
      openTab('https://one.test');
      openTab('https://two.test');
      mgr.closeTab('does-not-exist');
      expect(container.querySelectorAll('webview')).toHaveLength(2);
    });

    test('closeOtherTabs keeps only the given tab and makes it current', () => {
      const { container } = setupDom();
      mgr.initialize();
      const id1 = openTab('https://one.test');
      openTab('https://two.test');
      openTab('https://three.test');

      mgr.closeOtherTabs(id1);

      const wvs = container.querySelectorAll('webview');
      expect(wvs).toHaveLength(1);
      expect(wvs[0].id).toBe(id1);
      expect(state.get('agentWorkspace').currentTabId).toBe(id1);
    });

    test('closeTabsToRight closes only tabs after the anchor', () => {
      const { container } = setupDom();
      mgr.initialize();
      const id1 = openTab('https://one.test');
      const id2 = openTab('https://two.test');
      openTab('https://three.test');

      mgr.closeTabsToRight(id2);

      const ids = Array.from(container.querySelectorAll('webview')).map((w) => w.id);
      expect(ids).toEqual([id1, id2]);
    });

    test('closeTabsToRight reassigns current when the active tab was to the right', () => {
      setupDom();
      mgr.initialize();
      const id1 = openTab('https://one.test');
      openTab('https://two.test');
      const id3 = openTab('https://three.test'); // current = id3 (rightmost)

      mgr.closeTabsToRight(id1);

      expect(state.get('agentWorkspace').currentTabId).toBe(id1);
      expect(state.get('agentWorkspace').currentTabId).not.toBe(id3);
    });
  });

  describe('multi / layout view operations', () => {
    test('toggleMulti flips the agentWorkspace.multiSpace slice only', () => {
      const { container } = setupDom();
      mgr.initialize();
      expect(!!state.get('agentWorkspace').multiSpace).toBe(false);
      mgr.toggleMulti();
      expect(state.get('agentWorkspace').multiSpace).toBe(true);
      expect(container.classList.contains('agent-workspace-multi')).toBe(true);
      // User-view multiSpace untouched.
      expect(state.get('multiSpace')).toBe(false);
    });

    test('cycleLayout toggles single <-> sideBySide and applies the multi class', () => {
      const { container } = setupDom();
      mgr.initialize();
      mgr.cycleLayout();
      expect(state.get('agentWorkspace').currentLayout).toBe('sideBySide');
      expect(container.classList.contains('agent-workspace-multi')).toBe(true);
      mgr.cycleLayout();
      expect(state.get('agentWorkspace').currentLayout).toBe('single');
      expect(container.classList.contains('agent-workspace-multi')).toBe(false);
    });
  });

  describe('reorderTabs (agent-view drag reordering)', () => {
    function openTab(url) {
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url } });
      const calls = ipcRenderer.send.mock.calls.filter((c) => c[0] === 'agent-workspace:tab-op-result');
      return calls[calls.length - 1][1].spaceId;
    }

    test('reorder permutes tabs in state, the DOM, and persists via state-update', () => {
      const { container } = setupDom();
      mgr.initialize();
      const a = openTab('https://a.test');
      const b = openTab('https://b.test');
      const c = openTab('https://c.test');
      expect(state.get('agentWorkspace').tabs.map((t) => t.id)).toEqual([a, b, c]);
      expect(state.get('agentWorkspace').currentTabId).toBe(c);
      ipcRenderer.send.mockClear();

      mgr.reorderTabs([b, c, a]);

      // Tab order + urls follow; current tab is carried through untouched.
      expect(state.get('agentWorkspace').tabs.map((t) => t.id)).toEqual([b, c, a]);
      expect(state.get('agentWorkspace').currentTabId).toBe(c);
      // DOM wrappers follow the new order so the multi-view flex layout repositions.
      const domIds = Array.from(container.querySelectorAll('.agent-tab-wrapper'))
        .map((w) => w.dataset.agentTabId);
      expect(domIds).toEqual([b, c, a]);
      // Main is told to persist the new order.
      const update = ipcRenderer.send.mock.calls.find((ch) => ch[0] === 'agent-workspace:state-update');
      expect(update[1].tabs.map((t) => t.id)).toEqual([b, c, a]);
      expect(update[1].currentTabId).toBe(c);
    });

    test('reorder preserves url/title from the current tabs and keeps current valid', () => {
      setupDom();
      mgr.initialize();
      const a = openTab('https://a.test');
      const b = openTab('https://b.test');

      mgr.reorderTabs([b, a]);

      const tabs = state.get('agentWorkspace').tabs;
      expect(tabs[0]).toEqual({ id: b, url: 'https://b.test', title: '' });
      expect(tabs[1]).toEqual({ id: a, url: 'https://a.test', title: '' });
    });

    test('reorder rejects non-permutations (unknown id or wrong length)', () => {
      setupDom();
      mgr.initialize();
      const a = openTab('https://a.test');
      const b = openTab('https://b.test');
      const before = state.get('agentWorkspace').tabs.map((t) => t.id);
      ipcRenderer.send.mockClear();

      mgr.reorderTabs([a, b, 'ghost']);
      mgr.reorderTabs([a]);
      mgr.reorderTabs('not-an-array');

      expect(state.get('agentWorkspace').tabs.map((t) => t.id)).toEqual(before);
      expect(ipcRenderer.send).not.toHaveBeenCalledWith(
        'agent-workspace:state-update',
        expect.anything(),
      );
    });

    test('reorder is a no-op with no tabs', () => {
      setupDom();
      mgr.initialize();
      ipcRenderer.send.mockClear();
      mgr.reorderTabs([]);
      expect(ipcRenderer.send).not.toHaveBeenCalledWith(
        'agent-workspace:state-update',
        expect.anything(),
      );
    });
  });

  describe('research-report integration', () => {
    function openTab(url) {
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url } });
      const calls = ipcRenderer.send.mock.calls.filter((c) => c[0] === 'agent-workspace:tab-op-result');
      return calls[calls.length - 1][1].spaceId;
    }

    test('revealWorkspace forces agent view + sideBySide layout', () => {
      const { container } = setupDom();
      mgr.initialize();
      mgr.revealWorkspace();
      expect(state.get('viewMode')).toBe('agent');
      expect(state.get('agentWorkspace').currentLayout).toBe('sideBySide');
      expect(container.classList.contains('agent-workspace-multi')).toBe(true);
    });

    test('focusSource reveals workspace, marks the cited pane current, returns true', () => {
      const { container } = setupDom();
      mgr.initialize();
      openTab('https://one.test');
      const id2 = openTab('https://two.test');

      const wrapper2 = Array.from(container.querySelectorAll('.agent-tab-wrapper'))
        .find((w) => w.dataset.agentTabId === id2);
      wrapper2.scrollIntoView = jest.fn();

      const result = mgr.focusSource(id2);

      expect(result).toBe(true);
      expect(state.get('viewMode')).toBe('agent');
      expect(state.get('agentWorkspace').currentTabId).toBe(id2);
      expect(wrapper2.scrollIntoView).toHaveBeenCalled();
      // The citation pane is flashed synchronously; the 1.2s removal is a
      // deferred timer that has not yet fired.
      expect(wrapper2.classList.contains('is-citation-flash')).toBe(true);
    });

    test('focusSource returns false for an unknown source id', () => {
      setupDom();
      mgr.initialize();
      expect(mgr.focusSource('missing')).toBe(false);
      // No view change happened.
      expect(state.get('viewMode')).toBe('user');
    });

    test('focusSource returns false when called with no id', () => {
      setupDom();
      mgr.initialize();
      expect(mgr.focusSource()).toBe(false);
      expect(mgr.focusSource(null)).toBe(false);
    });
  });

  // ─── Branch-coverage extension ────────────────────────────────────────────
  // Exercise BOTH arms of every remaining guard / short-circuit / try-catch.

  describe('container-missing guards', () => {
    test('initialize tolerates a missing #agent-workspace-container', () => {
      // No setupDom() — getElementById returns null, every container guard
      // must take its early-return arm without throwing.
      expect(() => mgr.initialize()).not.toThrow();
      // tab-op open with no container creates no webview but still replies.
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url: 'https://x.test' } });
      const reply = ipcRenderer.send.mock.calls.find((c) => c[0] === 'agent-workspace:tab-op-result');
      expect(reply[1].ok).toBe(true);
    });

    test('_applyViewMode is a no-op when no container exists', () => {
      mgr.initialize(); // no DOM
      expect(() => state.set('viewMode', 'agent')).not.toThrow();
    });

    test('the container is placed in #tab-bar-wrap before its first webview is created', () => {
      const container = document.createElement('div');
      container.id = 'agent-workspace-container';
      document.body.appendChild(container);
      mgr.initialize();
      // TabBar builds the wrap after initialize; no view-mode change has placed the container yet.
      const wrap = document.createElement('div');
      wrap.id = 'tab-bar-wrap';
      document.body.appendChild(wrap);
      expect(container.parentNode).toBe(document.body);
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url: 'https://x.test' } });
      expect(container.parentNode).toBe(wrap);
      expect(container.querySelectorAll('webview')).toHaveLength(1);
    });

    test('a container already holding a webview is never moved, so no live guest reloads', () => {
      const container = document.createElement('div');
      container.id = 'agent-workspace-container';
      document.body.appendChild(container);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mgr.initialize();
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url: 'https://x.test' } });
      const wv = container.querySelector('webview');
      const wrap = document.createElement('div');
      wrap.id = 'tab-bar-wrap';
      document.body.appendChild(wrap);
      state.set('viewMode', 'agent');
      expect(container.parentNode).toBe(document.body);
      expect(container.querySelector('webview')).toBe(wv);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    test('_reparent is a no-op when there is no tab-bar-wrap', () => {
      const container = document.createElement('div');
      container.id = 'agent-workspace-container';
      document.body.appendChild(container);
      // No #tab-bar-wrap, no #space-container.
      mgr.initialize();
      // Container stays where it was (still under body) — wrap branch skipped.
      expect(container.parentNode).toBe(document.body);
    });

    test('_applyViewMode tolerates a missing #space-container', () => {
      const container = document.createElement('div');
      container.id = 'agent-workspace-container';
      document.body.appendChild(container);
      state.set('viewMode', 'agent');
      mgr.initialize();
      expect(container.style.display).toBe('flex');
      // No #space-container present — the spaceContainer guard took the false arm.
    });

    test('_applyMultiClass is a no-op when no container exists', () => {
      mgr.initialize(); // no DOM
      expect(() => mgr.toggleMulti()).not.toThrow();
    });
  });

  describe('view-mode wiring when state has no on()', () => {
    test('_wireViewMode skips subscription but still applies the initial mode', () => {
      const container = document.createElement('div');
      container.id = 'agent-workspace-container';
      document.body.appendChild(container);
      const fakeState = {
        _v: { viewMode: 'agent' },
        get(k) { return this._v[k]; },
        set(k, v) { this._v[k] = v; },
        // no `on` — the typeof !== 'function' arm is taken
      };
      const m = new AgentWorkspaceManager({ state: fakeState });
      expect(() => m.initialize()).not.toThrow();
      // Initial viewMode still applied even without an event subscription.
      expect(container.style.display).toBe('flex');
    });
  });

  describe('tab-op edge branches', () => {
    test('a null tab-op payload replies unknown_op without throwing', () => {
      setupDom();
      mgr.initialize();
      deliver('agent-workspace:tab-op', null);
      const reply = ipcRenderer.send.mock.calls.find((c) => c[0] === 'agent-workspace:tab-op-result');
      expect(reply[1]).toEqual({ requestId: undefined, ok: false, error: 'unknown_op' });
    });

    test('close with more than one tab but no spaceId still succeeds', () => {
      setupDom();
      mgr.initialize();
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url: 'https://a.test' } });
      deliver('agent-workspace:tab-op', { requestId: 2, op: 'open', args: { url: 'https://b.test' } });
      ipcRenderer.send.mockClear();
      // op: close with no args.spaceId → the `if (id) this._closeTab(id)` false arm.
      deliver('agent-workspace:tab-op', { requestId: 3, op: 'close', args: {} });
      const reply = ipcRenderer.send.mock.calls.find((c) => c[0] === 'agent-workspace:tab-op-result');
      expect(reply[1]).toEqual({ requestId: 3, ok: true });
    });

    test('focus with no spaceId replies tab_not_found', () => {
      setupDom();
      mgr.initialize();
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url: 'https://a.test' } });
      ipcRenderer.send.mockClear();
      deliver('agent-workspace:tab-op', { requestId: 4, op: 'focus', args: {} });
      const reply = ipcRenderer.send.mock.calls.find((c) => c[0] === 'agent-workspace:tab-op-result');
      expect(reply[1]).toEqual({ requestId: 4, ok: false, error: 'tab_not_found' });
    });

    test('an exception inside the handler is caught and replied as an error', () => {
      setupDom();
      mgr.initialize();
      // Force _broadcastState to throw so the try/catch error arm runs.
      const spy = jest.spyOn(mgr, '_broadcastState').mockImplementation(() => {
        throw new Error('boom-broadcast');
      });
      deliver('agent-workspace:tab-op', { requestId: 9, op: 'open', args: { url: 'https://a.test' } });
      const reply = ipcRenderer.send.mock.calls.find((c) => c[0] === 'agent-workspace:tab-op-result');
      expect(reply[1]).toEqual({ requestId: 9, ok: false, error: 'boom-broadcast' });
      spy.mockRestore();
    });
  });

  describe('restore edge branches', () => {
    test('restore skips malformed tab entries (missing id or url)', () => {
      const { container } = setupDom();
      mgr.initialize();
      deliver('agent-workspace:restore', {
        tabs: [
          { id: 'good', url: 'https://good.test' },
          { id: 'no-url' },
          { url: 'https://no-id.test' },
          null,
        ],
      });
      const ids = Array.from(container.querySelectorAll('webview')).map((w) => w.id);
      expect(ids).toEqual(['good']);
    });

    test('restore with a non-array tabs payload clears the workspace', () => {
      const { container } = setupDom();
      mgr.initialize();
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url: 'https://a.test' } });
      deliver('agent-workspace:restore', { tabs: 'not-an-array' });
      expect(container.querySelectorAll('webview')).toHaveLength(0);
    });
  });

  describe('_createTab announce / broadcast resilience', () => {
    test('did-attach announce sends a space-activity with the webContents id', () => {
      const { container } = setupDom();
      mgr.initialize();
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url: 'https://a.test' } });
      const wv = container.querySelector('webview');
      wv.getWebContentsId = jest.fn(() => 555);
      ipcRenderer.send.mockClear();
      wv.dispatchEvent(new Event('did-attach'));
      const act = ipcRenderer.send.mock.calls.find((c) => c[0] === 'space-activity');
      expect(act[1]).toMatchObject({ spaceId: wv.id, webContentsId: 555, kind: 'agent' });
    });

    test('announce is a no-op when getWebContentsId returns falsy', () => {
      const { container } = setupDom();
      mgr.initialize();
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url: 'https://a.test' } });
      const wv = container.querySelector('webview');
      wv.getWebContentsId = jest.fn(() => 0);
      ipcRenderer.send.mockClear();
      wv.dispatchEvent(new Event('did-attach'));
      const act = ipcRenderer.send.mock.calls.find((c) => c[0] === 'space-activity');
      expect(act).toBeUndefined();
    });

    test('did-navigate triggers both an announce and a state broadcast', () => {
      const { container } = setupDom();
      mgr.initialize();
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url: 'https://a.test' } });
      const wv = container.querySelector('webview');
      wv.getWebContentsId = jest.fn(() => 777);
      ipcRenderer.send.mockClear();
      wv.dispatchEvent(new Event('did-navigate'));
      const channels = ipcRenderer.send.mock.calls.map((c) => c[0]);
      expect(channels).toContain('space-activity');
      expect(channels).toContain('agent-workspace:state-update');
    });

    test('page-title-updated rebroadcasts the tab list', () => {
      const { container } = setupDom();
      mgr.initialize();
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url: 'https://a.test' } });
      const wv = container.querySelector('webview');
      ipcRenderer.send.mockClear();
      wv.dispatchEvent(new Event('page-title-updated'));
      const bc = ipcRenderer.send.mock.calls.find((c) => c[0] === 'agent-workspace:state-update');
      expect(bc).toBeDefined();
    });

    test('_broadcastState reads getURL/getTitle and survives them throwing', () => {
      const { container } = setupDom();
      mgr.initialize();
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url: 'https://a.test' } });
      const wv = container.querySelector('webview');
      wv.getURL = jest.fn(() => { throw new Error('no url'); });
      wv.getTitle = jest.fn(() => { throw new Error('no title'); });
      ipcRenderer.send.mockClear();
      // did-navigate-in-page → _broadcastState; the catch arms fall back to wv.src.
      expect(() => wv.dispatchEvent(new Event('did-navigate-in-page'))).not.toThrow();
      const bc = ipcRenderer.send.mock.calls.find((c) => c[0] === 'agent-workspace:state-update');
      // getURL threw → catch arm falls back to wv.src.
      expect(bc[1].tabs[0].url).toBe('https://a.test');
      expect(bc[1].tabs[0].title).toBe('');
    });

    test('_broadcastState uses getURL/getTitle when they succeed', () => {
      const { container } = setupDom();
      mgr.initialize();
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url: 'https://a.test' } });
      const wv = container.querySelector('webview');
      wv.getURL = jest.fn(() => 'https://live.example/page');
      wv.getTitle = jest.fn(() => 'Live Title');
      ipcRenderer.send.mockClear();
      wv.dispatchEvent(new Event('did-navigate'));
      const bc = ipcRenderer.send.mock.calls.find((c) => c[0] === 'agent-workspace:state-update');
      expect(bc[1].tabs[0]).toMatchObject({ url: 'https://live.example/page', title: 'Live Title' });
    });
  });

  describe('public tab-management no-op arms', () => {
    function openTab(url) {
      deliver('agent-workspace:tab-op', { requestId: 1, op: 'open', args: { url } });
      const calls = ipcRenderer.send.mock.calls.filter((c) => c[0] === 'agent-workspace:tab-op-result');
      return calls[calls.length - 1][1].spaceId;
    }

    test('closeTab with no id is a no-op', () => {
      const { container } = setupDom();
      mgr.initialize();
      openTab('https://one.test');
      openTab('https://two.test');
      mgr.closeTab();
      expect(container.querySelectorAll('webview')).toHaveLength(2);
    });

    test('closeTab on a non-active tab leaves current untouched', () => {
      setupDom();
      mgr.initialize();
      const id1 = openTab('https://one.test');
      const id2 = openTab('https://two.test'); // current = id2
      mgr.closeTab(id1); // not the active one → no _setCurrent reassignment
      expect(state.get('agentWorkspace').currentTabId).toBe(id2);
    });

    test('closeOtherTabs with no id is a no-op', () => {
      const { container } = setupDom();
      mgr.initialize();
      openTab('https://one.test');
      openTab('https://two.test');
      mgr.closeOtherTabs();
      expect(container.querySelectorAll('webview')).toHaveLength(2);
    });

    test('closeOtherTabs is a no-op when the id is the only tab', () => {
      const { container } = setupDom();
      mgr.initialize();
      const only = openTab('https://only.test');
      mgr.closeOtherTabs(only); // others is empty → early return
      expect(container.querySelectorAll('webview')).toHaveLength(1);
    });

    test('closeTabsToRight with no id is a no-op', () => {
      const { container } = setupDom();
      mgr.initialize();
      openTab('https://one.test');
      openTab('https://two.test');
      mgr.closeTabsToRight();
      expect(container.querySelectorAll('webview')).toHaveLength(2);
    });

    test('closeTabsToRight is a no-op when the anchor is the rightmost tab', () => {
      const { container } = setupDom();
      mgr.initialize();
      openTab('https://one.test');
      const id2 = openTab('https://two.test');
      mgr.closeTabsToRight(id2); // toClose is empty → early return
      expect(container.querySelectorAll('webview')).toHaveLength(2);
    });

    test('closeTabsToRight keeps current when the active tab was NOT to the right', () => {
      setupDom();
      mgr.initialize();
      const id1 = openTab('https://one.test');
      const id2 = openTab('https://two.test');
      openTab('https://three.test');
      // Make id1 the active tab, then close everything right of id2.
      mgr.focusSource && mgr._setCurrent && mgr._setCurrent(id1);
      state.set('agentWorkspace', { ...(state.get('agentWorkspace') || {}), currentTabId: id1 });
      mgr.closeTabsToRight(id2);
      // id1 was not in the closed set → current stays id1.
      expect(state.get('agentWorkspace').currentTabId).toBe(id1);
    });
  });

  describe('revealWorkspace idempotence', () => {
    test('revealWorkspace does not re-set the layout when already sideBySide', () => {
      setupDom();
      mgr.initialize();
      mgr.revealWorkspace(); // sets sideBySide
      const spy = jest.fn();
      state.on('change:agentWorkspace', spy);
      mgr.revealWorkspace(); // already sideBySide → the set is skipped
      const layoutChanges = spy.mock.calls.filter(
        (c) => c[0] && c[0].currentLayout === 'sideBySide',
      );
      // currentLayout is already sideBySide, so the second call must not emit a
      // new layout-changing set (it may emit nothing).
      expect(state.get('agentWorkspace').currentLayout).toBe('sideBySide');
      expect(layoutChanges.length).toBe(0);
    });
  });
});

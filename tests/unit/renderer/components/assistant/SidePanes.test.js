/**
 * @jest-environment jsdom
 */
// SidePanes (AssistantShell.js) — the Sessions/Artifacts/Inbox switcher and
// the history-rail binding, both driven by ShellStore. Covers the tab
// keyboard model, store sync through AssistantShell.sync, opening sessions,
// and that nothing is ever made inert.

const AssistantShell = require('../../../../../renderer/components/assistant/AssistantShell');
const SessionList = require('../../../../../renderer/components/assistant/SessionList');
const HistoryRail = require('../../../../../renderer/components/agent/HistoryRail');
const { ShellStore } = require('../../../../../renderer/core/ShellStore');

const { SidePanes } = AssistantShell;

function makeMockIpc(handlers) {
  const listeners = new Map();
  return {
    invoke: jest.fn(async (ch, arg) => {
      if (!(ch in handlers)) throw new Error(`unexpected channel ${ch}`);
      const h = handlers[ch];
      return typeof h === 'function' ? h(arg) : h;
    }),
    on: jest.fn((ch, cb) => {
      if (!listeners.has(ch)) listeners.set(ch, new Set());
      listeners.get(ch).add(cb);
    }),
    removeListener: jest.fn((ch, cb) => { if (listeners.has(ch)) listeners.get(ch).delete(cb); }),
    emit(ch, payload) { for (const cb of Array.from(listeners.get(ch) || [])) cb({}, payload); },
    listenerCount(ch) { return (listeners.get(ch) || new Set()).size; },
  };
}

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function makeContent() {
  const content = document.createElement('div');
  content.className = 'agent-panel agent-panel-v2';
  content.innerHTML = '<aside class="agent-panel-sidebar"></aside>'
    + '<section class="agent-panel-main"><header class="agent-panel-header">'
    + '<button type="button" class="agent-panel-history-toggle">H</button>'
    + '<span class="agent-panel-title">Assistant</span>'
    + '<button type="button" class="agent-panel-new">New chat</button>'
    + '</header></section>';
  document.body.appendChild(content);
  return content;
}

function makeMockStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
  };
}

function makeStore() {
  return new ShellStore({ bridge: { get: () => ({}), set: jest.fn() } });
}

async function build(opts = {}) {
  const ipc = makeMockIpc({
    'session:list': { ok: true, sessions: [{ id: 's1', title: 'One', updatedAt: 2 }, { id: 's-legacy', title: 'Old run', updatedAt: 1, legacyRunId: 'run-9' }] },
    'session:running': { ok: true, runs: [] },
    'inbox:list': { ok: true, items: [] },
    'artifact:list': { ok: true, artifacts: [] },
    ...(opts.handlers || {}),
  });
  const content = makeContent();
  const sidebarEl = content.querySelector('.agent-panel-sidebar');
  const sessionList = new SessionList({ root: sidebarEl, ipc });
  await sessionList.refresh();
  const historyRail = new HistoryRail({
    panelEl: content,
    sidebarEl,
    historyEl: sessionList.el,
    toggleBtn: content.querySelector('.agent-panel-history-toggle'),
    getStorage: () => makeMockStorage(opts.storage),
  });
  const store = opts.noStore ? null : (opts.store || makeStore());
  const toast = { success: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const host = opts.host || {};
  const panes = new SidePanes({ content, host, getStore: () => store, sessionList, historyRail, ipc, toast, notifier: null });
  if (store) store.on('change', () => panes.sync(store.snapshot()));
  await flush();
  return { panes, content, store, ipc, toast, host, sessionList, historyRail };
}

function tabs(content) { return Array.from(content.querySelectorAll('[role="tab"]')); }
function tab(content, id) { return content.querySelector(`#assistant-side-tab-${id}`); }
function key(target, k) {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev;
}
function inertNodes() {
  return Array.from(document.querySelectorAll('*')).filter((n) => n.hasAttribute('inert') || n.inert === true);
}

afterEach(() => {
  document.body.innerHTML = '';
  document.body.className = '';
});

describe('SidePanes', () => {
  test('requires the content element and getStore', () => {
    expect(() => new SidePanes(/** @type {any} */ ({ getStore: () => null }))).toThrow(TypeError);
    expect(() => new SidePanes(/** @type {any} */ ({ content: document.createElement('div') }))).toThrow(TypeError);
  });

  test('renders an accessible tablist before New chat with one tab in the tab order', async () => {
    const { content } = await build();
    const list = content.querySelector('[role="tablist"]');
    expect(list.getAttribute('aria-label')).toBe('Side panes');
    expect(list.nextElementSibling.classList.contains('agent-panel-new')).toBe(true);
    const all = tabs(content);
    expect(all.map((t) => t.getAttribute('aria-label'))).toEqual(['Sessions', 'Artifacts', 'Inbox']);
    for (const t of all) {
      const panel = document.getElementById(t.getAttribute('aria-controls'));
      expect(panel.getAttribute('role')).toBe('tabpanel');
      expect(panel.getAttribute('aria-labelledby')).toBe(t.id);
      expect(t.getAttribute('aria-selected')).toBe('false');
    }
    expect(all.filter((t) => t.tabIndex === 0)).toHaveLength(1);
    expect(content.querySelector('.assistant-side-pane').hidden).toBe(true);
  });

  test('clicking a tab writes ShellStore.sidePane and shows that pane; clicking it again closes', async () => {
    const { content, store, ipc } = await build();
    tab(content, 'sessions').click();
    expect(store.get('sidePane')).toBe('sessions');
    expect(tab(content, 'sessions').getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('assistant-side-panel-sessions').hidden).toBe(false);
    expect(document.getElementById('assistant-side-panel-inbox').hidden).toBe(true);
    expect(content.classList.contains('has-side-pane')).toBe(true);
    expect(ipc.invoke).toHaveBeenCalledWith('session:running', {});

    tab(content, 'inbox').click();
    expect(store.get('sidePane')).toBe('inbox');
    expect(ipc.invoke).toHaveBeenCalledWith('inbox:list', {});

    tab(content, 'inbox').click();
    expect(store.get('sidePane')).toBeNull();
    expect(content.querySelector('.assistant-side-pane').hidden).toBe(true);
    expect(content.classList.contains('has-side-pane')).toBe(false);
  });

  test('arrow keys, Home and End move focus across tabs without switching panes', async () => {
    const { content, store } = await build();
    const [sessions, artifacts, inbox] = tabs(content);
    sessions.focus();
    expect(key(sessions, 'ArrowRight').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(artifacts);
    expect(artifacts.tabIndex).toBe(0);
    expect(sessions.tabIndex).toBe(-1);
    key(artifacts, 'End');
    expect(document.activeElement).toBe(inbox);
    key(inbox, 'ArrowRight');
    expect(document.activeElement).toBe(sessions);
    key(sessions, 'ArrowLeft');
    expect(document.activeElement).toBe(inbox);
    key(inbox, 'Home');
    expect(document.activeElement).toBe(sessions);
    expect(store.get('sidePane')).toBeNull();
    expect(key(sessions, 'a').defaultPrevented).toBe(false);
  });

  test('Esc in the open pane closes it, returns focus to its tab and does not reach the panel', async () => {
    const { content, store } = await build();
    tab(content, 'inbox').click();
    const outer = jest.fn();
    document.addEventListener('keydown', outer);
    const ev = key(content.querySelector('.assistant-side-pane__close'), 'Escape');
    document.removeEventListener('keydown', outer);
    expect(ev.defaultPrevented).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    expect(store.get('sidePane')).toBeNull();
    expect(document.activeElement).toBe(tab(content, 'inbox'));
  });

  test('the close button closes the pane', async () => {
    const { content, store } = await build();
    tab(content, 'sessions').click();
    content.querySelector('.assistant-side-pane__close').click();
    expect(store.get('sidePane')).toBeNull();
  });

  test('a store change from elsewhere reaches the pane through AssistantShell.sync', async () => {
    const store = makeStore();
    const { content } = await build({ store });
    const shell = new AssistantShell({
      content,
      onFlip: jest.fn(),
      onDockToggle: jest.fn(),
      flipLabel: 'Switch view',
      sidebar: { min: 320, max: 960, getWidth: () => 420, setWidth: jest.fn(), commit: jest.fn() },
      dock: { min: 360, max: 1400, getWidth: () => 520, setWidth: jest.fn(), commit: jest.fn() },
    });
    shell.mount();
    store.removeAllListeners('change');
    store.set('sidePane', 'artifacts');
    shell.sync({ ...store.snapshot() });
    expect(tab(content, 'artifacts').getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('assistant-side-panel-artifacts').hidden).toBe(false);
    expect(SidePanes.forContent(content)).not.toBeNull();
  });

  test('without a bound store the panes keep their own state', async () => {
    const { content, panes } = await build({ noStore: true });
    tab(content, 'sessions').click();
    expect(panes.getPane()).toBe('sessions');
    expect(() => panes.setPane('nope')).toThrow(TypeError);
  });

  test('nothing is made inert in either mode, with any pane open', async () => {
    const { content, store } = await build();
    for (const mode of ['browser', 'assistant']) {
      document.body.classList.toggle('app-mode-assistant', mode === 'assistant');
      store.set('appMode', mode);
      for (const id of ['sessions', 'artifacts', 'inbox']) {
        tab(content, id).click();
        await flush();
        expect(inertNodes()).toEqual([]);
      }
    }
  });

  describe('showHistory', () => {
    test('in the browser-mode sidebar history opens as the Sessions sheet and the rail stays shut', async () => {
      const { panes, store, historyRail } = await build();
      expect(panes.showHistory()).toBe(true);
      expect(store.get('sidePane')).toBe('sessions');
      expect(historyRail.isOpen()).toBe(false);
      expect(panes.showHistory({ toggle: true })).toBe(false);
      expect(store.get('sidePane')).toBeNull();
      expect(historyRail.isOpen()).toBe(false);
    });

    test('in assistant mode history opens the left column and leaves the side pane alone', async () => {
      const { panes, store, historyRail } = await build();
      store.set('appMode', 'assistant');
      panes.setPane('inbox');
      expect(panes.showHistory()).toBe(true);
      expect(historyRail.isOpen()).toBe(true);
      expect(store.get('sidePane')).toBe('inbox');
      expect(panes.showHistory({ toggle: true })).toBe(false);
      expect(historyRail.isOpen()).toBe(false);
    });

    test('the browser-mode sidebar never lays out the history column, rail or toggle', () => {
      const fs = require('fs');
      const path = require('path');
      const css = fs.readFileSync(path.resolve(__dirname, '../../../../../renderer/styles/components/agent-panel.css'), 'utf8');
      const rule = (sel) => {
        const m = css.match(new RegExp(`${sel.replace(/[.()[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
        return m ? m[1] : '';
      };
      expect(rule('body:not(.app-mode-assistant) .agent-panel-v2,\nbody:not(.app-mode-assistant) .agent-panel-v2.is-history-open'))
        .toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
      expect(rule('body:not(.app-mode-assistant) .agent-panel-v2 > .agent-panel-sidebar,\nbody:not(.app-mode-assistant) .agent-panel-history-toggle'))
        .toMatch(/display:\s*none/);
    });
  });

  describe('history rail binding', () => {
    test('the rail state persisted per machine seeds ShellStore.historyRailOpen', async () => {
      const { store, content } = await build({ storage: { 'agent.history.open': '1' } });
      expect(content.classList.contains('is-history-open')).toBe(true);
      expect(store.get('historyRailOpen')).toBe(true);
    });

    test('ShellStore.historyRailOpen drives the rail', async () => {
      const { store, historyRail } = await build();
      store.set('historyRailOpen', true);
      expect(historyRail.isOpen()).toBe(true);
      store.set('historyRailOpen', false);
      expect(historyRail.isOpen()).toBe(false);
    });

    test('toggling the rail directly is mirrored into ShellStore', async () => {
      const { store, content } = await build();
      content.querySelector('.agent-panel-history-toggle').click();
      await flush();
      expect(store.get('historyRailOpen')).toBe(true);
    });
  });

  describe('opening sessions', () => {
    test('a selected row loads through host.loadSession and marks the session active', async () => {
      const host = { loadSession: jest.fn(async () => ({ ok: true })) };
      const { sessionList, panes } = await build({ host });
      sessionList.select('s1');
      await flush();
      expect(host.loadSession).toHaveBeenCalledWith('s1');
      expect(panes.getActiveSession()).toBe('s1');
    });

    test('a loader reply of {ok:false} is shown as an error toast', async () => {
      const host = { loadSession: jest.fn(async () => ({ ok: false, error: 'session_not_found' })) };
      const { panes, toast } = await build({ host });
      await panes.openSession('s1');
      expect(toast.error).toHaveBeenCalledWith('Couldn’t open the session: session_not_found');
    });

    test('a loader that throws is shown as an error toast', async () => {
      const host = { loadSession: jest.fn(() => { throw new Error('thread busy'); }) };
      const { panes, toast } = await build({ host });
      await panes.openSession('s1');
      expect(toast.error).toHaveBeenCalledWith('Couldn’t open the session: thread busy');
    });

    test('a failed load rolls the selection back to the previously active session', async () => {
      const host = { loadSession: jest.fn(async (id) => (id === 's1' ? { ok: true } : { ok: false, error: 'session_not_found' })) };
      const { panes, sessionList, toast } = await build({ host });
      await panes.openSession('s1');
      expect(panes.getActiveSession()).toBe('s1');
      await panes.openSession('s-legacy');
      expect(toast.error).toHaveBeenCalledWith('Couldn’t open the session: session_not_found');
      expect(panes.getActiveSession()).toBe('s1');
      expect(sessionList.getActive()).toBe('s1');
    });

    test('a loader that throws rolls the selection back too', async () => {
      const host = { loadSession: jest.fn(() => { throw new Error('thread busy'); }) };
      const { panes } = await build({ host });
      await panes.openSession('s1');
      expect(panes.getActiveSession()).toBeNull();
    });

    test('a failed load does not undo a session change the host made meanwhile', async () => {
      let notify = null;
      const host = {
        onSessionChange: (cb) => { notify = cb; return () => {}; },
        loadSession: jest.fn(async () => { notify('s-legacy'); return { ok: false, error: 'superseded' }; }),
      };
      const { panes } = await build({ host });
      await panes.openSession('s1');
      expect(panes.getActiveSession()).toBe('s-legacy');
    });

    test('without a loader an imported run replays through its legacy run id', async () => {
      const host = { _openHistoryRun: jest.fn(async () => {}) };
      const { panes, toast } = await build({ host });
      await panes.openSession('s-legacy');
      expect(host._openHistoryRun).toHaveBeenCalledWith('run-9');
      expect(toast.error).not.toHaveBeenCalled();
    });

    test('without any loader the failure is visible', async () => {
      const { panes, toast } = await build({ host: {} });
      await panes.openSession('s1');
      expect(toast.error).toHaveBeenCalledWith('Couldn’t open the session: this Assistant has no session loader');
    });

    test('in the browser-mode sidebar opening a session closes the covering sheet; assistant mode keeps it', async () => {
      const host = { loadSession: jest.fn(async () => ({ ok: true })) };
      const { panes, store } = await build({ host });
      panes.setPane('inbox');
      await panes.openSession('s1');
      expect(store.get('sidePane')).toBeNull();
      store.set('appMode', 'assistant');
      panes.setPane('inbox');
      await panes.openSession('s1');
      expect(store.get('sidePane')).toBe('inbox');
    });
  });

  describe('active session', () => {
    test('host.onSessionChange drives the artifacts pane and the list highlight', async () => {
      let notify = null;
      const off = jest.fn();
      const host = { onSessionChange: jest.fn((cb) => { notify = cb; return off; }) };
      const { panes, ipc, sessionList, content } = await build({ host });
      notify('s1');
      expect(sessionList.getActive()).toBe('s1');
      tab(content, 'artifacts').click();
      await flush();
      expect(ipc.invoke).toHaveBeenCalledWith('artifact:list', { sessionId: 's1' });
      expect(ipc.listenerCount('agent:task-started')).toBe(1); // SessionList's own task map only
      panes.destroy();
      expect(off).toHaveBeenCalled();
    });

    test('without onSessionChange it follows foreground runs in its own scope only', async () => {
      const host = { _scopeMatches: (p) => p.scope === 'global' };
      const { panes, ipc } = await build({ host });
      ipc.emit('agent:task-started', { taskId: 't1', sessionId: 'other-scope', scope: 'tab' });
      expect(panes.getActiveSession()).toBeNull();
      ipc.emit('agent:task-started', { taskId: 't2', sessionId: 's1', scope: 'global' });
      expect(panes.getActiveSession()).toBe('s1');
    });
  });

  test('destroy removes its DOM and listeners and unregisters from the shell', async () => {
    const { panes, content, ipc } = await build();
    tab(content, 'sessions').click();
    panes.destroy();
    expect(content.querySelector('[role="tablist"]')).toBeNull();
    expect(content.querySelector('.assistant-side-pane')).toBeNull();
    expect(content.classList.contains('has-side-pane')).toBe(false);
    expect(ipc.listenerCount('session:event')).toBe(1); // SessionList's own subscription
    expect(ipc.listenerCount('inbox:changed')).toBe(0);
    expect(SidePanes.forContent(content)).toBeNull();
  });
});

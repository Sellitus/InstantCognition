// AgentWorkspaceService — main-process source of truth for the agent's
// isolated tab workspace. Tests cover state lifecycle, broadcast contracts,
// and per-conversation persistence via AgentHistoryService.

const fakeMainWindow = () => ({
  isDestroyed: () => false,
  webContents: { send: jest.fn() },
});

function fakeHistory(initialMeta = {}) {
  const store = JSON.parse(JSON.stringify(initialMeta));
  return {
    writeMeta: jest.fn((id, patch) => {
      store[id] = { ...(store[id] || {}), ...patch };
      return store[id];
    }),
    readMeta: jest.fn((id) => store[id] || null),
    _store: store,
  };
}

function fakeConfig(values = {}) {
  return {
    get: jest.fn((path, fb) => {
      const parts = String(path).split('.');
      let cur = values;
      for (const p of parts) { if (cur == null || typeof cur !== 'object') return fb; cur = cur[p]; }
      return cur === undefined ? fb : cur;
    }),
  };
}

let svc;
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  svc = require('../../../../main/services/AgentWorkspaceService');
  // Reset singleton state between tests.
  svc._setPersistDelay(0);
  svc._state.tabs = [];
  svc._state.currentTabId = null;
  svc._state.conversationId = null;
});

describe('AgentWorkspaceService', () => {
  describe('setActiveConversation', () => {
    test('isNew=true clears state and broadcasts a single fresh blank tab', () => {
      const mw = fakeMainWindow();
      svc.bindWindow(mw);
      svc.bindHistory(fakeHistory());
      svc.bindConfig(fakeConfig({ settings: { browserHomeUrl: 'https://example.com/' } }));

      svc.setActiveConversation({ taskId: 't1', isNew: true });

      const calls = mw.webContents.send.mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe('agent-workspace:restore');
      expect(calls[0][1].tabs).toHaveLength(1);
      expect(calls[0][1].tabs[0].url).toBe('https://example.com/');
    });

    test('isNew=true falls back to about:blank when no homeUrl is configured', () => {
      const mw = fakeMainWindow();
      svc.bindWindow(mw);
      svc.bindHistory(fakeHistory());
      svc.bindConfig(fakeConfig({}));
      svc.setActiveConversation({ isNew: true });
      const payload = mw.webContents.send.mock.calls[0][1];
      expect(payload.tabs[0].url).toBe('about:blank');
    });

    test('existing conversation with saved tabs broadcasts restore payload', () => {
      const mw = fakeMainWindow();
      svc.bindWindow(mw);
      svc.bindHistory(fakeHistory({
        task_42: {
          agentWorkspace: {
            tabs: [
              { id: 'agent-tab-a', url: 'https://reddit.com/' },
              { id: 'agent-tab-b', url: 'https://example.com/' },
            ],
            currentTabId: 'agent-tab-b',
          },
        },
      }));
      svc.bindConfig(fakeConfig({}));

      svc.setActiveConversation({ taskId: 'task_42', isNew: false });

      const calls = mw.webContents.send.mock.calls;
      expect(calls[0][0]).toBe('agent-workspace:restore');
      expect(calls[0][1].tabs).toEqual([
        { id: 'agent-tab-a', url: 'https://reddit.com/' },
        { id: 'agent-tab-b', url: 'https://example.com/' },
      ]);
      expect(calls[0][1].currentTabId).toBe('agent-tab-b');
    });

    test('existing conversation with no saved tabs falls back to a fresh blank tab', () => {
      const mw = fakeMainWindow();
      svc.bindWindow(mw);
      svc.bindHistory(fakeHistory({ task_99: { title: 'something' } }));
      svc.bindConfig(fakeConfig({}));

      svc.setActiveConversation({ taskId: 'task_99', isNew: false });

      const payload = mw.webContents.send.mock.calls[0][1];
      expect(payload.tabs).toHaveLength(1);
      expect(payload.tabs[0].url).toBe('about:blank');
    });
  });

  describe('applyStateFromRenderer + persistence', () => {
    test('persists tab list to <taskId>.meta.json under agentWorkspace key', () => {
      const history = fakeHistory();
      svc.bindWindow(fakeMainWindow());
      svc.bindHistory(history);
      svc.bindConfig(fakeConfig({}));

      // Bind a conversation, then simulate the renderer pushing state.
      svc.bindConversationId('task_77');
      svc.applyStateFromRenderer({
        tabs: [
          { id: 'agent-tab-1', url: 'https://a/' },
          { id: 'agent-tab-2', url: 'https://b/' },
        ],
        currentTabId: 'agent-tab-2',
      });
      svc._flushPersist();

      expect(history.writeMeta).toHaveBeenCalledWith('task_77', {
        agentWorkspace: {
          tabs: [
            { id: 'agent-tab-1', url: 'https://a/' },
            { id: 'agent-tab-2', url: 'https://b/' },
          ],
          currentTabId: 'agent-tab-2',
        },
      });
    });

    test('does not persist when no conversation is bound', () => {
      const history = fakeHistory();
      svc.bindWindow(fakeMainWindow());
      svc.bindHistory(history);
      svc.applyStateFromRenderer({ tabs: [{ id: 'a', url: 'x' }], currentTabId: 'a' });
      svc._flushPersist();
      expect(history.writeMeta).not.toHaveBeenCalled();
    });

    test('debounces writes — multiple rapid updates collapse to one persist', () => {
      const history = fakeHistory();
      svc.bindWindow(fakeMainWindow());
      svc.bindHistory(history);
      svc._setPersistDelay(50);
      svc.bindConversationId('task_d');
      svc.applyStateFromRenderer({ tabs: [{ id: '1', url: 'x' }], currentTabId: '1' });
      svc.applyStateFromRenderer({ tabs: [{ id: '2', url: 'y' }], currentTabId: '2' });
      svc.applyStateFromRenderer({ tabs: [{ id: '3', url: 'z' }], currentTabId: '3' });
      svc._flushPersist();
      expect(history.writeMeta).toHaveBeenCalledTimes(1);
      expect(history.writeMeta.mock.calls[0][1].agentWorkspace.currentTabId).toBe('3');
    });

    test('drops malformed entries (missing id) from the persisted snapshot', () => {
      const history = fakeHistory();
      svc.bindWindow(fakeMainWindow());
      svc.bindHistory(history);
      svc.bindConfig(fakeConfig({}));
      svc.bindConversationId('task_x');
      svc.applyStateFromRenderer({
        tabs: [
          { id: 'good', url: 'https://x/' },
          { url: 'https://noid/' },     // dropped — no id
          { id: '', url: 'https://x2/' }, // dropped — empty id
        ],
        currentTabId: 'good',
      });
      svc._flushPersist();
      const written = history.writeMeta.mock.calls[0][1].agentWorkspace.tabs;
      expect(written).toEqual([{ id: 'good', url: 'https://x/' }]);
    });
  });

  describe('bindConversationId', () => {
    test('attaches state to a freshly-minted taskId without restore', () => {
      const mw = fakeMainWindow();
      svc.bindWindow(mw);
      svc.bindHistory(fakeHistory());
      svc.bindConfig(fakeConfig({}));
      // Pretend the renderer already populated state (e.g. via initial open).
      svc._state.tabs = [{ id: 'agent-tab-1', url: 'https://x/' }];
      svc._state.currentTabId = 'agent-tab-1';
      svc.bindConversationId('task_new');
      expect(svc._state.conversationId).toBe('task_new');
      expect(mw.webContents.send).not.toHaveBeenCalled();
    });
  });

  describe('branch coverage — restore / persist / broadcast guards', () => {
    test('existing conversation uses saved.tabs[0].id when currentTabId is absent', () => {
      const mw = fakeMainWindow();
      svc.bindWindow(mw);
      svc.bindHistory(fakeHistory({
        task_nocur: {
          agentWorkspace: { tabs: [{ id: 'first', url: 'https://a/' }, { id: 'second', url: 'https://b/' }] },
        },
      }));
      svc.bindConfig(fakeConfig({}));
      svc.setActiveConversation({ taskId: 'task_nocur', isNew: false });
      const payload = mw.webContents.send.mock.calls[0][1];
      expect(payload.currentTabId).toBe('first'); // fell back to tabs[0].id
    });

    test('isNew=true with no bound config still emits about:blank', () => {
      const mw = fakeMainWindow();
      svc.bindWindow(mw);
      svc.bindHistory(fakeHistory());
      svc.bindConfig(null);
      svc.setActiveConversation({ taskId: 't', isNew: true });
      expect(mw.webContents.send.mock.calls[0][1].tabs[0].url).toBe('about:blank');
    });

    test('existing conversation with no saved tabs and no config falls back to about:blank', () => {
      const mw = fakeMainWindow();
      svc.bindWindow(mw);
      svc.bindHistory(fakeHistory({ task_x: { title: 't' } }));
      svc.bindConfig(null);
      svc.setActiveConversation({ taskId: 'task_x', isNew: false });
      expect(mw.webContents.send.mock.calls[0][1].tabs[0].url).toBe('about:blank');
    });

    test('config returning a falsy homeUrl falls back to about:blank', () => {
      const mw = fakeMainWindow();
      svc.bindWindow(mw);
      svc.bindHistory(fakeHistory());
      svc.bindConfig({ get: () => '' }); // empty string → falsy → DEFAULT_BLANK_URL
      svc.setActiveConversation({ taskId: 't', isNew: true });
      expect(mw.webContents.send.mock.calls[0][1].tabs[0].url).toBe('about:blank');
    });

    test('setActiveConversation with no taskId is treated as a new conversation', () => {
      const mw = fakeMainWindow();
      svc.bindWindow(mw);
      svc.bindHistory(fakeHistory());
      svc.bindConfig(fakeConfig({ settings: { browserHomeUrl: 'https://h/' } }));
      svc.setActiveConversation({});
      expect(svc._state.conversationId).toBeNull();
      expect(mw.webContents.send.mock.calls[0][1].tabs[0].url).toBe('https://h/');
    });

    test('bindConversationId(null) clears the id and does not schedule a persist', () => {
      const history = fakeHistory();
      svc.bindWindow(fakeMainWindow());
      svc.bindHistory(history);
      svc.bindConversationId(null);
      expect(svc._state.conversationId).toBeNull();
      svc._flushPersist();
      expect(history.writeMeta).not.toHaveBeenCalled();
    });

    test('applyStateFromRenderer ignores a non-array tabs payload', () => {
      svc.bindWindow(fakeMainWindow());
      svc.bindHistory(fakeHistory());
      svc.bindConversationId('task_na');
      svc._state.tabs = [{ id: 'keep', url: 'https://keep/' }];
      svc.applyStateFromRenderer({ tabs: 'not-an-array', currentTabId: 'x' });
      expect(svc._state.tabs).toEqual([{ id: 'keep', url: 'https://keep/' }]); // unchanged
    });

    test('applyStateFromRenderer carries a title through and falls back currentTabId to tabs[0]', () => {
      const history = fakeHistory();
      svc.bindWindow(fakeMainWindow());
      svc.bindHistory(history);
      svc.bindConfig(fakeConfig({}));
      svc.bindConversationId('task_title');
      svc.applyStateFromRenderer({
        tabs: [{ id: 'a', url: 'https://a/', title: 'Tab A' }, { id: 'b', url: 'https://b/' }],
        currentTabId: null, // → falls back to first tab id
      });
      expect(svc._state.tabs[0]).toEqual({ id: 'a', url: 'https://a/', title: 'Tab A' });
      expect(svc._state.tabs[1].title).toBeUndefined();
      expect(svc._state.currentTabId).toBe('a');
    });

    test('applyStateFromRenderer with empty tab list leaves currentTabId null', () => {
      svc.bindWindow(fakeMainWindow());
      svc.bindHistory(fakeHistory());
      svc.bindConversationId('task_empty');
      svc.applyStateFromRenderer({ tabs: [], currentTabId: null });
      expect(svc._state.currentTabId).toBeNull();
    });

    test('_broadcast is a no-op when there is no window or it is destroyed', () => {
      svc.bindWindow(null);
      expect(() => svc.seedStarterTabs(['https://x/'])).not.toThrow();
      const destroyed = { isDestroyed: () => true, webContents: { send: jest.fn() } };
      svc.bindWindow(destroyed);
      svc.seedStarterTabs(['https://y/']);
      expect(destroyed.webContents.send).not.toHaveBeenCalled();
    });

    test('_broadcast swallows a throwing webContents.send', () => {
      const mw = { isDestroyed: () => false, webContents: { send: () => { throw new Error('ipc gone'); } } };
      svc.bindWindow(mw);
      expect(() => svc.seedStarterTabs(['https://z/'])).not.toThrow();
    });

    test('_persistNow no-ops when history lacks writeMeta', () => {
      svc.bindWindow(fakeMainWindow());
      svc.bindHistory({ readMeta: () => null }); // no writeMeta
      svc.bindConversationId('task_nw');
      svc.applyStateFromRenderer({ tabs: [{ id: 'a', url: 'x' }], currentTabId: 'a' });
      expect(() => svc._flushPersist()).not.toThrow();
    });

    test('_persistNow swallows + warns when writeMeta throws', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      svc.bindWindow(fakeMainWindow());
      svc.bindHistory({ writeMeta: () => { throw new Error('disk full'); }, readMeta: () => null });
      svc.bindConversationId('task_pf');
      svc.applyStateFromRenderer({ tabs: [{ id: 'a', url: 'x' }], currentTabId: 'a' });
      svc._flushPersist();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[agent-workspace] persist failed:'), expect.anything());
      warn.mockRestore();
    });

    test('_readMeta returns null when history lacks readMeta or it throws', () => {
      const mw = fakeMainWindow();
      svc.bindWindow(mw);
      svc.bindHistory({ writeMeta: jest.fn() }); // no readMeta
      svc.bindConfig(fakeConfig({}));
      svc.setActiveConversation({ taskId: 'task_nr', isNew: false });
      // No saved meta resolvable → treated as new → fresh blank tab.
      expect(mw.webContents.send.mock.calls[0][1].tabs[0].url).toBe('about:blank');

      const mw2 = fakeMainWindow();
      svc.bindWindow(mw2);
      svc.bindHistory({ readMeta: () => { throw new Error('read boom'); }, writeMeta: jest.fn() });
      svc.setActiveConversation({ taskId: 'task_rt', isNew: false });
      expect(mw2.webContents.send.mock.calls[0][1].tabs[0].url).toBe('about:blank');
    });

    test('_reset clears a pending persist timer', () => {
      svc.bindWindow(fakeMainWindow());
      svc.bindHistory(fakeHistory());
      svc._setPersistDelay(1000);
      svc.bindConversationId('task_timer');
      svc.applyStateFromRenderer({ tabs: [{ id: 'a', url: 'x' }], currentTabId: 'a' });
      expect(svc._persistTimer).not.toBeNull();
      // setActiveConversation(isNew) calls _reset → must clear the timer.
      svc.bindConfig(fakeConfig({}));
      svc.setActiveConversation({ taskId: 'task_timer', isNew: true });
      expect(svc._persistTimer).toBeNull();
    });

    test('_schedulePersist debounce clears a prior timer before arming a new one', () => {
      const history = fakeHistory();
      svc.bindWindow(fakeMainWindow());
      svc.bindHistory(history);
      svc._setPersistDelay(1000);
      svc.bindConversationId('task_deb');
      svc.applyStateFromRenderer({ tabs: [{ id: '1', url: 'a' }], currentTabId: '1' });
      const firstTimer = svc._persistTimer;
      svc.applyStateFromRenderer({ tabs: [{ id: '2', url: 'b' }], currentTabId: '2' });
      expect(svc._persistTimer).not.toBe(firstTimer); // re-armed
      svc._flushPersist();
      expect(history.writeMeta).toHaveBeenCalledTimes(1);
    });
  });

  describe('seedStarterTabs', () => {
    test('replaces tabs with persona starterTabs and broadcasts restore', () => {
      const mw = fakeMainWindow();
      svc.bindWindow(mw);
      svc.bindHistory(fakeHistory());
      svc.seedStarterTabs([{ url: 'https://reddit.com/r/LocalLLaMA/' }, { url: 'https://reddit.com/r/AI_Agents/' }]);
      expect(svc._state.tabs).toHaveLength(2);
      expect(svc._state.tabs[0].url).toBe('https://reddit.com/r/LocalLLaMA/');
      expect(svc._state.currentTabId).toBe(svc._state.tabs[0].id);
      expect(mw.webContents.send).toHaveBeenCalledWith('agent-workspace:restore', expect.objectContaining({ currentTabId: svc._state.tabs[0].id }));
    });

    test('accepts plain string URLs', () => {
      const mw = fakeMainWindow();
      svc.bindWindow(mw);
      svc.seedStarterTabs(['https://amazon.com', 'https://bestbuy.com']);
      expect(svc._state.tabs.map((t) => t.url)).toEqual(['https://amazon.com', 'https://bestbuy.com']);
    });

    test('no-op on empty / non-array input', () => {
      const mw = fakeMainWindow();
      svc.bindWindow(mw);
      svc.seedStarterTabs(null);
      svc.seedStarterTabs([]);
      svc.seedStarterTabs(undefined);
      expect(mw.webContents.send).not.toHaveBeenCalled();
      expect(svc._state.tabs).toEqual([]);
    });

    test('caps starter tab list at 6', () => {
      const mw = fakeMainWindow();
      svc.bindWindow(mw);
      svc.seedStarterTabs(Array.from({ length: 12 }, (_, i) => ({ url: 'https://x' + i + '.test' })));
      expect(svc._state.tabs).toHaveLength(6);
    });

    test('skips entries without a url', () => {
      const mw = fakeMainWindow();
      svc.bindWindow(mw);
      svc.seedStarterTabs([{ url: 'https://ok.test' }, { name: 'no-url' }, null]);
      expect(svc._state.tabs).toHaveLength(1);
      expect(svc._state.tabs[0].url).toBe('https://ok.test');
    });

    test('no-op when every entry is filtered out (non-empty input, zero valid)', () => {
      const mw = fakeMainWindow();
      svc.bindWindow(mw);
      svc._state.tabs = [{ id: 'existing', url: 'https://keep/' }];
      svc.seedStarterTabs([{ name: 'no-url' }, null, { notUrl: true }]);
      // Bailed before replacing state — existing tabs untouched, no broadcast.
      expect(svc._state.tabs).toEqual([{ id: 'existing', url: 'https://keep/' }]);
      expect(mw.webContents.send).not.toHaveBeenCalled();
    });

    test('seedStarterTabs schedules a persist when a conversation is bound', () => {
      const history = fakeHistory();
      svc.bindWindow(fakeMainWindow());
      svc.bindHistory(history);
      svc.bindConversationId('task_seed');
      svc.seedStarterTabs(['https://seed.test']);
      svc._flushPersist();
      expect(history.writeMeta).toHaveBeenCalledWith('task_seed', expect.objectContaining({
        agentWorkspace: expect.objectContaining({ currentTabId: svc._state.tabs[0].id }),
      }));
    });
  });
});

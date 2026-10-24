/**
 * @jest-environment jsdom
 */

// The persisted chat thread inside the real AgentPanel: loadSession renders
// the session tree as Markdown messages with version switchers, the message
// actions send the documented session:* payloads, both lanes carry the
// sessionId to main, and a subagent's approvals belong to the parent run.

jest.mock('electron', () => {
  const { EventEmitter: EE } = require('events');
  const emitter = new EE();
  emitter.setMaxListeners(0);
  const ipcRenderer = {
    _emitter: emitter,
    send: jest.fn(),
    on: jest.fn((ch, fn) => { emitter.on(ch, fn); return ipcRenderer; }),
    once: jest.fn((ch, fn) => { emitter.once(ch, fn); return ipcRenderer; }),
    removeListener: jest.fn((ch, fn) => { emitter.removeListener(ch, fn); return ipcRenderer; }),
    removeAllListeners: jest.fn((ch) => { emitter.removeAllListeners(ch); return ipcRenderer; }),
    invoke: jest.fn(async () => undefined),
    _fire: (ch, ...args) => emitter.emit(ch, {}, ...args),
  };
  return { ipcRenderer, clipboard: { writeText: jest.fn(), readText: jest.fn(() => '') } };
});

const SID = 's_abc123';
const FORK = 's_fork01';
const CHILD = 's_child01';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

const NODES = [
  { id: 'n1', parentId: null, role: 'user', kind: 'message', content: 'First **question**', data: { lane: 'chat' } },
  { id: 'n2', parentId: 'n1', role: 'assistant', kind: 'message', content: 'Answer with **bold** text', data: { lane: 'chat' } },
  { id: 'n3a', parentId: 'n2', role: 'user', kind: 'message', content: 'older version', data: { lane: 'chat' } },
  { id: 'n3', parentId: 'n2', role: 'user', kind: 'message', content: 'Second', data: { lane: 'chat' } },
  { id: 'n4', parentId: 'n3', role: 'assistant', kind: 'message', content: '- item one\n- item two', data: { lane: 'chat' } },
];

const tree = (id = SID) => ({
  ok: true,
  meta: { id, headId: 'n4' },
  nodes: NODES,
  path: ['n1', 'n2', 'n3', 'n4'],
  branches: { n3: { index: 1, count: 2, siblingIds: ['n3a', 'n3'] }, n3a: { index: 0, count: 2, siblingIds: ['n3a', 'n3'] } },
  pendingPlan: null,
});

let ipcRenderer;
let panel;
let handlers;

async function mainInvoke(ch, arg) {
  if (handlers[ch]) return handlers[ch](arg);
  switch (ch) {
    case 'session:list': return { ok: true, sessions: [] };
    case 'persona:list': return { enabled: [], lock: null };
    case 'llm:get-status': return { status: 'stopped', backend: null, isRemote: false };
    case 'permissions:get': return { ok: true, mode: 'ask', effectiveMode: 'ask', sessionModes: {}, rules: {} };
    case 'session:get': return arg && arg.sessionId === FORK ? tree(FORK) : tree();
    case 'session:create': return { ok: true, session: { id: SID } };
    case 'session:context-usage': return { ok: true, tokens: 120, contextSize: 8192, ratio: 120 / 8192, messages: 4 };
    default: return undefined;
  }
}

function context() {
  const wv = document.createElement('div');
  wv.getWebContentsId = jest.fn(() => 4242);
  document.body.appendChild(wv);
  return {
    navigationManager: { getActiveWebview: jest.fn(() => wv) },
    settingsMenu: { showTab: jest.fn() },
    agentWorkspaceManager: { focusSource: jest.fn(), revealWorkspace: jest.fn() },
    spaceManager: {},
  };
}

const calls = (ch) => ipcRenderer.invoke.mock.calls.filter((c) => c[0] === ch).map((c) => c[1]);
const msgs = () => Array.from(panel._transcriptEl.querySelectorAll(':scope > .chat-msg'));
const msgFor = (nodeId) => /** @type {HTMLElement} */ (panel._transcriptEl.querySelector(`.chat-msg[data-node-id="${nodeId}"]`));
const menuItem = (el, action) => /** @type {HTMLButtonElement} */ (el.querySelector(`.chat-msg__menu [data-action="${action}"]`));

beforeEach(async () => {
  jest.clearAllMocks();
  jest.resetModules();
  handlers = { 'chat:web-search': () => ({ ok: true, results: [] }) }; // ok-empty: silent, ungrounded
  document.body.innerHTML = '';
  document.body.classList.add('no-animations');
  global.requestAnimationFrame = (cb) => { cb(Date.now()); return 1; };
  global.cancelAnimationFrame = () => {};
  ({ ipcRenderer } = require('electron'));
  ipcRenderer._emitter.removeAllListeners();
  ipcRenderer.invoke.mockImplementation(mainInvoke);
  panel = require('../../../../../renderer/components/AgentPanel');
  panel.initialize(context);
  panel.open();
  await flush();
});

afterEach(() => {
  panel.close();
  document.body.classList.remove('no-animations');
  document.body.innerHTML = '';
});

describe('loadSession', () => {
  test('an invalid id is refused without any IPC', async () => {
    ipcRenderer.invoke.mockClear();
    await expect(panel.loadSession('../../etc/passwd')).resolves.toEqual({ ok: false, error: 'invalid_session_id' });
    await expect(panel.loadSession(/** @type {any} */ (42))).resolves.toEqual({ ok: false, error: 'invalid_session_id' });
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    expect(panel.activeSessionId()).toBeNull();
  });

  test('a valid id fetches session:get and renders the head path', async () => {
    const seen = jest.fn();
    panel.onSessionChange(seen);
    await expect(panel.loadSession(SID)).resolves.toEqual({ ok: true });
    expect(calls('session:get')).toContainEqual({ sessionId: SID });
    expect(panel.activeSessionId()).toBe(SID);
    expect(seen).toHaveBeenCalledWith(SID);
    expect(msgs().map((el) => el.dataset.nodeId)).toEqual(['n1', 'n2', 'n3', 'n4']);
    expect(panel._chatHistory).toEqual([
      { role: 'user', content: 'First **question**' },
      { role: 'assistant', content: 'Answer with **bold** text' },
      { role: 'user', content: 'Second' },
      { role: 'assistant', content: '- item one\n- item two' },
    ]);
  });

  test('a session main cannot load reports the failure', async () => {
    handlers['session:get'] = () => ({ ok: false, error: 'session_not_found' });
    const res = await panel.loadSession(SID);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('session_not_found');
  });

  test('a failed load keeps the shown session and its thread', async () => {
    await panel.loadSession(SID);
    const seen = jest.fn();
    panel.onSessionChange(seen);
    handlers['session:get'] = () => ({ ok: false, error: 'session_not_found' });
    const res = await panel.loadSession(FORK);
    expect(res.ok).toBe(false);
    expect(panel.activeSessionId()).toBe(SID);
    expect(seen).not.toHaveBeenCalled();
    expect(msgs().map((el) => el.dataset.nodeId)).toEqual(['n1', 'n2', 'n3', 'n4']);
  });

  test('onSessionChange rejects a non-function and unsubscribes', async () => {
    expect(() => panel.onSessionChange(/** @type {any} */ ('nope'))).toThrow(TypeError);
    const seen = jest.fn();
    const off = panel.onSessionChange(seen);
    off();
    await panel.loadSession(SID);
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('thread rendering and actions', () => {
  beforeEach(async () => { await panel.loadSession(SID); });

  test('earlier answers render as Markdown, not plain text', () => {
    expect(msgFor('n2').querySelector('.chat-msg__body strong').textContent).toBe('bold');
    expect(msgFor('n4').querySelectorAll('.chat-msg__body li')).toHaveLength(2);
    expect(msgFor('n1').querySelector('.chat-msg__body strong').textContent).toBe('question');
  });

  test('the version switcher shows 2/2, is disabled at the end, and switches with session:branch', async () => {
    const nav = msgFor('n3').querySelector('.chat-branch-nav');
    expect(/** @type {HTMLElement} */ (nav).hidden).toBe(false);
    expect(nav.querySelector('.chat-branch-nav__label').textContent).toBe('2/2');
    const [prev, next] = /** @type {HTMLButtonElement[]} */ (Array.from(nav.querySelectorAll('button')));
    expect(next.disabled).toBe(true);
    expect(prev.disabled).toBe(false);
    expect(/** @type {HTMLElement} */ (msgFor('n2').querySelector('.chat-branch-nav')).hidden).toBe(true);
    handlers['session:branch'] = () => ({ ...tree(), path: ['n1', 'n2', 'n3a'], meta: { id: SID, headId: 'n3a' } });
    prev.click();
    await flush();
    expect(calls('session:branch')).toEqual([{ sessionId: SID, nodeId: 'n3a' }]);
    expect(msgs().map((el) => el.dataset.nodeId)).toEqual(['n1', 'n2', 'n3a']);
    expect(msgFor('n3a').querySelector('.chat-branch-nav__label').textContent).toBe('1/2');
  });

  test('regenerate sends session:regenerate, then answers that turn on its lane with the session ids', async () => {
    handlers['session:regenerate'] = () => ({ ok: true, node: NODES[3] });
    handlers['chat:ask'] = (arg) => {
      ipcRenderer._fire('chat:token', { id: arg.id, delta: 'Fresh' });
      return { ok: true, sessionId: SID, userNodeId: 'n3', assistantNodeId: 'n5' };
    };
    /** @type {HTMLButtonElement} */ (msgFor('n4').querySelector('.chat-msg__regenerate')).click();
    await flush();
    expect(calls('session:regenerate')).toEqual([{ sessionId: SID, nodeId: 'n4' }]);
    const ask = calls('chat:ask')[0];
    expect(ask.sessionId).toBe(SID);
    expect(ask.userNodeId).toBe('n3');
    expect(ask.messages[ask.messages.length - 1]).toEqual({ role: 'user', content: 'Second' });
    expect(calls('agent:start')).toHaveLength(0);
  });

  test('fork sends session:fork and opens the new session', async () => {
    handlers['session:fork'] = () => ({ ok: true, session: { id: FORK } });
    const seen = jest.fn();
    panel.onSessionChange(seen);
    menuItem(msgFor('n2'), 'fork').click();
    await flush();
    expect(calls('session:fork')).toEqual([{ sessionId: SID, nodeId: 'n2' }]);
    expect(calls('session:get')).toContainEqual({ sessionId: FORK });
    expect(panel.activeSessionId()).toBe(FORK);
    expect(seen).toHaveBeenCalledWith(FORK);
  });

  test('a refused fork keeps the current session', async () => {
    handlers['session:fork'] = () => ({ ok: false, error: 'session_busy' });
    menuItem(msgFor('n2'), 'fork').click();
    await flush();
    expect(panel.activeSessionId()).toBe(SID);
    expect(document.querySelector('.toast-error .toast-message').textContent).toContain('Wait for the current run to finish first.');
  });

  test('an empty edit sends nothing; a real edit goes through session:edit and resends', async () => {
    handlers['session:edit'] = (arg) => ({ ok: true, node: { id: 'n1b', parentId: null, role: 'user', kind: 'message', content: arg.content, data: { lane: 'chat' } } });
    handlers['chat:ask'] = () => ({ ok: true, sessionId: SID, userNodeId: 'n1b' });
    const el = msgFor('n1');
    /** @type {HTMLButtonElement} */ (el.querySelector('.chat-msg__edit')).click();
    const area = /** @type {HTMLTextAreaElement} */ (el.querySelector('.chat-msg__editor-input'));
    area.value = '   ';
    /** @type {HTMLButtonElement} */ (el.querySelector('.chat-msg__editor-save')).click();
    await flush();
    expect(calls('session:edit')).toHaveLength(0);
    expect(calls('chat:ask')).toHaveLength(0);
    expect(el.querySelector('.chat-msg__editor-error').textContent).toBe('Write a message to send.');
    area.value = 'First question, reworded';
    /** @type {HTMLButtonElement} */ (el.querySelector('.chat-msg__editor-save')).click();
    await flush();
    expect(calls('session:edit')).toEqual([{ sessionId: SID, nodeId: 'n1', content: 'First question, reworded' }]);
    expect(calls('chat:ask')[0]).toEqual(expect.objectContaining({ sessionId: SID, userNodeId: 'n1b' }));
  });

  test('Rewind to here opens the in-panel dialog; Cancel sends no rewind', async () => {
    handlers['checkpoint:preview'] = () => ({ ok: true, files: [] });
    menuItem(msgFor('n3'), 'rewind').click();
    await flush();
    expect(calls('checkpoint:preview')).toEqual([{ sessionId: SID, turnId: 'n3' }]);
    const dialog = panel.overlay.querySelector('.rewind-dialog');
    expect(dialog).not.toBeNull();
    /** @type {HTMLButtonElement} */ (dialog.querySelector('.rewind-dialog__cancel')).click();
    expect(panel.overlay.querySelector('.rewind-dialog')).toBeNull();
    expect(calls('session:rewind')).toHaveLength(0);
  });

  test('Create skill drafts from the chat and saves only on Save', async () => {
    handlers['skills:draft-from-session'] = () => ({ ok: true, skill: { name: 'summarize' }, markdown: '---\nname: summarize\n---\nDo it.', warnings: [] });
    handlers['skills:save'] = () => ({ ok: true });
    menuItem(msgFor('n2'), 'skill').click();
    await flush();
    expect(calls('skills:draft-from-session')[0].messages).toEqual([
      { role: 'user', content: 'First **question**' },
      { role: 'assistant', content: 'Answer with **bold** text' },
    ]);
    const card = panel._transcriptEl.querySelector('.chat-skill-draft');
    expect(card).not.toBeNull();
    expect(calls('skills:save')).toHaveLength(0);
    /** @type {HTMLButtonElement} */ (card.querySelector('.chat-skill-draft__save')).click();
    await flush();
    expect(calls('skills:save')).toEqual([{ skill: { markdown: '---\nname: summarize\n---\nDo it.' }, overwrite: false }]);
  });
});

describe('lane persistence', () => {
  test('a new chat-mode turn creates the session lazily and chat:ask carries its id', async () => {
    handlers['chat:ask'] = (arg) => {
      ipcRenderer._fire('chat:token', { id: arg.id, delta: 'Hi there' });
      return { ok: true, sessionId: SID, userNodeId: 'n1', assistantNodeId: 'n2' };
    };
    panel.routeMode = 'chat';
    panel.input.value = 'hello';
    await panel._run();
    await flush();
    expect(calls('session:create')).toHaveLength(1);
    const ask = calls('chat:ask')[0];
    expect(ask.sessionId).toBe(SID);
    expect(ask.userNodeId).toBeUndefined();
    expect(panel.activeSessionId()).toBe(SID);
    const user = panel._transcriptEl.querySelector('.chat-msg--user');
    expect(/** @type {HTMLElement} */ (user).dataset.nodeId).toBe('n1');
    const liveBar = panel.overlay.querySelector('.chat-live-actions .chat-msg');
    expect(/** @type {HTMLElement} */ (liveBar).dataset.nodeId).toBe('n2');
  });

  test('chat:ask carries the typed text as userText while the message carries the grounding', async () => {
    handlers['chat:web-search'] = () => ({ ok: true, results: [{ title: 'Paris', url: 'https://example.com/paris', snippet: 'Capital of France' }] });
    handlers['chat:ask'] = (arg) => { ipcRenderer._fire('chat:token', { id: arg.id, delta: 'Paris' }); return { ok: true, sessionId: SID, userNodeId: 'n1', assistantNodeId: 'n2' }; };
    panel.routeMode = 'chat';
    panel.input.value = 'capital of france?';
    await panel._run();
    await flush();
    const ask = calls('chat:ask')[0];
    expect(ask.userText).toBe('capital of france?');
    const last = ask.messages[ask.messages.length - 1];
    expect(last.content).toContain('--- Web search results');
    expect(last.content).toContain('capital of france?');
  });

  test('a chat turn with project images is saved with its text instead of running unsaved', async () => {
    handlers['chat:web-search'] = () => ({ ok: true, results: [] }); // ok-empty: no grounding block, no failure toast
    handlers['chat:ask'] = (arg) => { ipcRenderer._fire('chat:token', { id: arg.id, delta: 'A cat' }); return { ok: true, sessionId: SID, userNodeId: 'n1', assistantNodeId: 'n2' }; };
    panel._projectComposer = {
      collectAttachments: async () => ({ text: '', images: [{ dataUrl: 'data:image/png;base64,AAAA' }] }),
      clearPending: jest.fn(),
    };
    panel.routeMode = 'chat';
    panel.input.value = 'what is in the image?';
    await panel._run();
    await flush();
    const ask = calls('chat:ask')[0];
    expect(ask.sessionId).toBe(SID);
    expect(ask.userText).toBe('what is in the image?');
    expect(ask.messages[ask.messages.length - 1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
    expect(document.querySelector('.toast-warn')).toBeNull();
    expect(/** @type {HTMLElement} */ (panel._transcriptEl.querySelector('.chat-msg--user')).dataset.nodeId).toBe('n1');
  });

  test('a refused session:create still answers, unsaved', async () => {
    handlers['session:create'] = () => ({ ok: false, error: 'disk_full' });
    handlers['chat:ask'] = (arg) => { ipcRenderer._fire('chat:token', { id: arg.id, delta: 'ok' }); return { ok: true }; };
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    panel.routeMode = 'chat';
    panel.input.value = 'hello';
    await panel._run();
    err.mockRestore();
    expect(calls('chat:ask')[0].sessionId).toBeUndefined();
    expect(panel._answerView.getMarkdown()).toBe('ok');
  });

  describe('persist failure warnings', () => {
    const toastMod = () => require('../../../../../renderer/components/Toast');
    const warns = () => toastMod()._visible.filter((v) => v.entry.kind === 'warn');

    test('a refused session:create warns with a sticky Open-sessions toast', async () => {
      handlers['session:create'] = () => ({ ok: false, error: 'disk_full' });
      handlers['chat:ask'] = (arg) => { ipcRenderer._fire('chat:token', { id: arg.id, delta: 'ok' }); return { ok: true }; };
      const err = jest.spyOn(console, 'error').mockImplementation(() => {});
      panel.routeMode = 'chat';
      panel.input.value = 'hello';
      await panel._run();
      err.mockRestore();
      await flush();

      const shown = warns();
      expect(shown).toHaveLength(1);
      expect(shown[0].entry.timeout).toBe(0);
      expect(shown[0].el.querySelector('.toast-message').textContent).toBe('This conversation is not being saved: disk_full');
      const actBtn = /** @type {HTMLButtonElement} */ (shown[0].el.querySelector('.toast-action'));
      expect(actBtn.textContent).toBe('Open sessions');
      const { SidePanes } = require('../../../../../renderer/components/assistant/AssistantShell');
      const panes = SidePanes.forContent(panel.overlay);
      expect(panes.getPane()).toBeNull();
      actBtn.click();
      // Outside assistant mode the history column is hidden, so sessions open as the sheet.
      expect(panes.getPane()).toBe('sessions');
      expect(panel._historyRail.isOpen()).toBe(false);
      expect(toastMod()._visible).toHaveLength(0);
    });

    test('a chat:ask persistError warns sticky and dedupes across failed turns', async () => {
      handlers['chat:ask'] = (arg) => { ipcRenderer._fire('chat:token', { id: arg.id, delta: 'ok' }); return { ok: true, sessionId: SID, persistError: 'db_locked' }; };
      panel.routeMode = 'chat';
      panel.input.value = 'one';
      await panel._run();
      await flush();
      let shown = warns();
      expect(shown).toHaveLength(1);
      expect(shown[0].entry.timeout).toBe(0);
      expect(shown[0].el.querySelector('.toast-action').textContent).toBe('Open sessions');
      expect(panel._persistWarned).toBe(true);

      // A different error on the next failed turn: Toast's 3s message dedup
      // cannot coalesce these, so only the panel-level guard can hold it to one.
      handlers['chat:ask'] = (arg) => { ipcRenderer._fire('chat:token', { id: arg.id, delta: 'ok' }); return { ok: true, sessionId: SID, persistError: 'disk_full' }; };
      panel.input.value = 'two';
      await panel._run();
      await flush();
      shown = warns();
      expect(shown).toHaveLength(1); // one warning per failure episode, not per failed turn
      expect(panel._persistToastId).toBe(shown[0].entry.id);
    });

    test('a superseded turn with persistError still warns (stale path)', async () => {
      let resolveAsk = null;
      handlers['chat:ask'] = () => new Promise((r) => { resolveAsk = r; });
      panel.routeMode = 'chat';
      panel.input.value = 'hello';
      const turn = panel._run();
      await flush();
      expect(calls('chat:ask')).toHaveLength(1); // the turn is parked inside chat:ask

      // New chat supersedes the streaming turn; the running status asks for confirmation.
      /** @type {HTMLButtonElement} */ (panel.overlay.querySelector('.agent-panel-new')).click();
      await flush();
      const dlg = document.querySelector('.confirm-dialog');
      expect(dlg).not.toBeNull();
      /** @type {HTMLButtonElement} */ (dlg.querySelector('.confirm-dialog-confirm')).click();
      await flush();

      resolveAsk({ ok: true, sessionId: SID, persistError: 'db_locked' });
      await turn;
      await flush();

      const shown = warns();
      expect(shown).toHaveLength(1);
      expect(shown[0].entry.timeout).toBe(0);
      expect(shown[0].el.querySelector('.toast-message').textContent).toBe('This reply was not saved: db_locked');
    });

    test('a later persisted turn clears the warning and re-arms it', async () => {
      handlers['chat:ask'] = (arg) => { ipcRenderer._fire('chat:token', { id: arg.id, delta: 'ok' }); return { ok: true, sessionId: SID, persistError: 'db_locked' }; };
      panel.routeMode = 'chat';
      panel.input.value = 'one';
      await panel._run();
      await flush();
      expect(warns()).toHaveLength(1);

      handlers['chat:ask'] = (arg) => { ipcRenderer._fire('chat:token', { id: arg.id, delta: 'fine' }); return { ok: true, sessionId: SID, userNodeId: 'n1', assistantNodeId: 'n2' }; };
      panel.input.value = 'two';
      await panel._run();
      await flush();
      expect(panel._persistWarned).toBe(false);
      expect(panel._persistToastId).toBeNull();
      expect(toastMod()._visible).toHaveLength(0); // the warning is gone

      // Re-armed: a fresh failure warns again (different message than the first
      // episode, so Toast's 3s dedup window cannot swallow it).
      handlers['chat:ask'] = (arg) => { ipcRenderer._fire('chat:token', { id: arg.id, delta: 'ok' }); return { ok: true, sessionId: SID, persistError: 'disk_full' }; };
      panel.input.value = 'three';
      await panel._run();
      await flush();
      expect(warns()).toHaveLength(1);
      expect(warns()[0].el.querySelector('.toast-message').textContent).toBe('This reply was not saved: disk_full');
    });

    test('switching sessions clears a stale warning', async () => {
      handlers['chat:ask'] = (arg) => { ipcRenderer._fire('chat:token', { id: arg.id, delta: 'ok' }); return { ok: true, sessionId: SID, persistError: 'db_locked' }; };
      panel.routeMode = 'chat';
      panel.input.value = 'one';
      await panel._run();
      await flush();
      expect(warns()).toHaveLength(1);

      await panel.loadSession(FORK);
      expect(panel._persistWarned).toBe(false);
      expect(panel._persistToastId).toBeNull();
      expect(toastMod()._visible).toHaveLength(0);
    });
  });

  test('an agent run in a loaded session carries the sessionId', async () => {
    await panel.loadSession(SID);
    panel.routeMode = 'agent';
    panel.input.value = 'click the button';
    await panel._run();
    const start = calls('agent:start')[0];
    expect(start.sessionId).toBe(SID);
    expect(start.description).toBe('click the button');
  });

  describe('agent outcome binding', () => {
    const liveBarId = () => {
      const el = panel.overlay.querySelector('.chat-live-actions .chat-msg');
      return el ? /** @type {HTMLElement} */ (el).dataset.nodeId : null;
    };
    const startRun = async () => {
      await panel.loadSession(SID);
      ipcRenderer._fire('agent:task-started', { taskId: 't1', sessionId: SID, task: { description: 'tidy up' }, scope: 'global', turnNodeId: 'n5' });
      await flush();
      ipcRenderer.invoke.mockClear();
    };

    test('task-completed with assistantNodeId binds that node without refetching the session', async () => {
      await startRun();
      ipcRenderer._fire('agent:task-completed', { taskId: 't1', sessionId: SID, scope: 'global', ok: true, summary: 'All tidy now.', assistantNodeId: 'n6' });
      await flush();
      expect(liveBarId()).toBe('n6');
      expect(calls('session:get')).toHaveLength(0);
    });

    test('without assistantNodeId the session is refetched and its assistant head is bound', async () => {
      await startRun();
      ipcRenderer._fire('agent:task-completed', { taskId: 't1', sessionId: SID, scope: 'global', ok: true, summary: 'All tidy now.' });
      await flush();
      expect(calls('session:get')).toEqual([{ sessionId: SID }]);
      expect(liveBarId()).toBe('n4');
    });

    test('a plan proposal node is never bound as the answer', async () => {
      await startRun();
      ipcRenderer._fire('agent:task-completed', { taskId: 't1', sessionId: SID, scope: 'global', ok: false, reason: 'awaiting_plan_approval', assistantNodeId: 'n6' });
      await flush();
      expect(liveBarId()).toBeNull();
      expect(calls('session:get')).toHaveLength(0);
    });
  });

  test("another session's agent events do not touch this thread", async () => {
    await panel.loadSession(SID);
    const before = panel._transcriptEl.innerHTML;
    ipcRenderer._fire('agent:task-started', { taskId: 't9', sessionId: 's_other99', task: { description: 'elsewhere' }, scope: 'global' });
    ipcRenderer._fire('agent:step-planned', { sessionId: 's_other99', step: 0, calls: [{ id: 'c1', name: 'browser.click', args: {} }] });
    await flush();
    expect(panel._transcriptEl.innerHTML).toBe(before);
  });
});

describe('subagent approvals', () => {
  const approval = (requestId, sessionId) => ({
    requestId, sessionId, kind: 'shell', toolName: 'shell.run', argv: ['ls'], cwd: '/w', suggestedRule: null,
  });

  test("a subagent's request is queued for the parent and dropped when the parent run ends", async () => {
    await panel.loadSession(SID);
    ipcRenderer._fire('session:event', { sessionId: SID, channel: 'subagent-started', payload: { childSessionId: CHILD, task: 'scan', depth: 1, readOnly: false } });
    ipcRenderer._fire('agent:approval-request', approval('r-child', CHILD));
    ipcRenderer._fire('agent:approval-request', approval('r-other', 's_other99'));
    expect(panel._sessionStore.approvalState()).toEqual({ pending: 1, requestIds: ['r-child'] });
    expect(panel._agentLane.approvals.has('r-child')).toBe(true);
    ipcRenderer._fire('agent:task-completed', { sessionId: SID, taskId: 't1', result: { ok: true, summary: 'done' } });
    await flush();
    expect(panel._agentLane.approvals.has('r-child')).toBe(false);
    expect(panel._agentLane.approvals.has('r-other')).toBe(true);
  });

  test('a resolved request drops only its own card, from either channel', async () => {
    await panel.loadSession(SID);
    ipcRenderer._fire('agent:approval-request', approval('r1', SID));
    ipcRenderer._fire('agent:approval-request', approval('r2', SID));
    ipcRenderer._fire('agent:approval-request', approval('r3', 's_other99'));
    ipcRenderer._fire('agent:approval-resolved', { requestId: 'r1', sessionId: SID, decision: 'approve' });
    expect(panel._agentLane.approvals.has('r1')).toBe(false);
    expect(panel._sessionStore.approvalState()).toEqual({ pending: 1, requestIds: ['r2'] });
    ipcRenderer._fire('session:event', { sessionId: 's_other99', channel: 'approval-resolved', payload: { requestId: 'r3', decision: 'reject', reason: 'background_timeout' } });
    expect(panel._agentLane.approvals.has('r3')).toBe(false);
    expect(panel._agentLane.approvals.has('r2')).toBe(true);
  });

  test('an unknown requestId leaves every queued card in place', async () => {
    await panel.loadSession(SID);
    ipcRenderer._fire('agent:approval-request', approval('r1', SID));
    ipcRenderer._fire('agent:approval-resolved', { requestId: 'r-unknown', sessionId: SID, decision: 'approve' });
    ipcRenderer._fire('session:event', { sessionId: SID, channel: 'approval-resolved', payload: { requestId: 'r-unknown' } });
    ipcRenderer._fire('agent:approval-resolved', null);
    expect(panel._agentLane.approvals.has('r1')).toBe(true);
    expect(panel._sessionStore.approvalState()).toEqual({ pending: 1, requestIds: ['r1'] });
  });
});

describe('compaction', () => {
  const COMPACTED = [
    ...NODES,
    { id: 'c1', parentId: 'n4', role: 'system', kind: 'compaction', content: 'Summary: they asked two questions.', data: { coveredMessages: 4 } },
    { id: 'n5', parentId: 'c1', role: 'user', kind: 'message', content: 'Third', data: { lane: 'chat' } },
    { id: 'n6', parentId: 'n5', role: 'assistant', kind: 'message', content: 'Third answer', data: { lane: 'chat' } },
  ];
  const compactedTree = () => ({ ...tree(), meta: { id: SID, headId: 'n6' }, nodes: COMPACTED, path: ['n1', 'n2', 'n3', 'n4', 'c1', 'n5', 'n6'] });
  const askChat = async (text) => {
    handlers['chat:ask'] = (arg) => { ipcRenderer._fire('chat:token', { id: arg.id, delta: 'ok' }); return { ok: true }; };
    panel.routeMode = 'chat';
    panel.input.value = text;
    await panel._run();
    await flush();
    return calls('chat:ask').pop().messages;
  };

  test('a chat turn after a compaction sends the summary in the one system message and only later turns', async () => {
    handlers['session:get'] = compactedTree;
    await panel.loadSession(SID);
    expect(panel._transcriptEl.querySelector('.chat-divider')).not.toBeNull();
    const sent = await askChat('Fourth');
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(sent[0].content).toContain('Summary: they asked two questions.');
    expect(sent.slice(1).map((m) => m.content)).toEqual(['Third', 'Third answer', 'Fourth']);
  });

  test('without a compaction the system message carries no summary', async () => {
    await panel.loadSession(SID);
    const sent = await askChat('Next');
    expect(sent[0].content).not.toMatch(/summary/i);
    expect(sent.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['First **question**', 'Second', 'Next']);
  });

  test('a compacted event for the open session reloads it so the next turn is built from the summary', async () => {
    await panel.loadSession(SID);
    handlers['session:get'] = compactedTree;
    ipcRenderer._fire('session:event', { sessionId: SID, channel: 'compacted', payload: { nodeId: 'c1', coveredMessages: 4 } });
    await flush();
    expect(panel._transcriptEl.querySelector('.chat-divider')).not.toBeNull();
    const sent = await askChat('Fourth');
    expect(sent[0].content).toContain('Summary: they asked two questions.');
    expect(sent.map((m) => m.content)).not.toContain('Second');
  });

  test('a compacted event for another session changes nothing', async () => {
    await panel.loadSession(SID);
    handlers['session:get'] = compactedTree;
    ipcRenderer._fire('session:event', { sessionId: 's_other99', channel: 'compacted', payload: { nodeId: 'c1' } });
    await flush();
    expect(panel._transcriptEl.querySelector('.chat-divider')).toBeNull();
  });
});

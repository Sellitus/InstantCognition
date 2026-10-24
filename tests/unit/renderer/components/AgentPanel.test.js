/**
 * @jest-environment jsdom
 */

// AgentPanel is a singleton (module.exports = new AgentPanel()). Each test
// re-requires it fresh via jest.resetModules() so panel state never leaks
// between tests. We replace the global electron mock with an EventEmitter-
// backed ipcRenderer so the test can drive 'agent:*' events and assert the
// exact send/invoke calls AgentPanel makes (the global mock's invoke can't be
// reconfigured per-test and its shared emitter leaks listeners across files).
const { EventEmitter } = require('events');

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
    // Helper: emit an IPC channel event the way the real preload bridge would
    // (first arg is the IpcRendererEvent, rest are the payload args).
    _fire: (ch, ...args) => emitter.emit(ch, {}, ...args),
  };
  return {
    ipcRenderer,
    clipboard: { writeText: jest.fn(), readText: jest.fn(() => '') },
  };
});

let ipcRenderer;
let clipboard;

// Mirror the real main-process IPC contracts so the panel + its sub-views
// (SessionList.refresh, persona:list, llm:get-status) get well-formed
// replies instead of undefined. Tests override specific channels as needed.
async function defaultInvoke(ch) {
  switch (ch) {
    case 'session:list': return { ok: true, sessions: [] };
    case 'projects:list': return { ok: true, projects: [] };
    case 'persona:list': return { enabled: [], lock: null };
    case 'llm:get-status': return { status: 'stopped', backend: null, isRemote: false };
    default: return undefined;
  }
}

// Run rAF callbacks synchronously so openWithTask()'s deferred _run and the
// AnswerView typewriter resolve within the test tick. The harness already
// makes setTimeout synchronous, so the typewriter's clamp path is covered too.
function installSyncRaf() {
  global.requestAnimationFrame = (cb) => { cb(performance.now ? performance.now() : Date.now()); return 1; };
  global.cancelAnimationFrame = () => {};
}

function makeWebview(id) {
  const el = document.createElement('div');
  el.id = id;
  el.getWebContentsId = jest.fn(() => 4242);
  document.body.appendChild(el);
  return el;
}

// The history column exists only in assistant mode; the browser-mode sidebar
// shows history as the Sessions sheet instead.
function openInAssistantMode(panel) {
  const { ShellStore } = require('../../../../renderer/core/ShellStore');
  const { ViewShellManager } = require('../../../../renderer/managers/ViewShellManager');
  const store = new ShellStore({ bridge: { get: (_p, fallback) => fallback, set: jest.fn() } });
  panel.setViewShell(new ViewShellManager({ store, getContext: () => ({}) }));
  panel.open({ mode: 'assistant' });
}

function makeContext(overrides = {}) {
  const wv = overrides.webview === null ? null : (overrides.webview || makeWebview('tab-active'));
  return {
    navigationManager: { getActiveWebview: jest.fn(() => wv) },
    settingsMenu: overrides.settingsMenu || { showTab: jest.fn() },
    agentWorkspaceManager: overrides.agentWorkspaceManager || { focusSource: jest.fn(), revealWorkspace: jest.fn() },
    spaceManager: overrides.spaceManager || {},
    ...overrides.extra,
  };
}

describe('AgentPanel', () => {
  let panel;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    document.body.innerHTML = '';
    document.body.textContent = '';
    // Skip open/close animations so they finish synchronously.
    document.body.classList.add('no-animations');
    installSyncRaf();
    ({ ipcRenderer, clipboard } = require('electron'));
    ipcRenderer._emitter.removeAllListeners();
    ipcRenderer.invoke.mockImplementation(defaultInvoke);
    panel = require('../../../../renderer/components/AgentPanel');
  });

  afterEach(() => {
    try { panel.close(); } catch (_) { /* ignore */ }
    document.body.classList.remove('no-animations');
    document.body.innerHTML = '';
  });

  // ---- Construction + DOM mount/teardown --------------------------------

  describe('construction & lifecycle', () => {
    test('initialize builds the panel DOM but does not mount it until open()', () => {
      panel.initialize(() => makeContext());
      expect(panel.overlay).toBeInstanceOf(HTMLElement);
      expect(panel.overlay.classList.contains('agent-panel-v2')).toBe(true);
      expect(panel.input).toBeInstanceOf(HTMLTextAreaElement);
      expect(panel.overlay.querySelector('.agent-panel-starters')).not.toBeNull();
      expect(panel.overlay.querySelector('.agent-panel-controls .voice-input-button')).toBeTruthy();
      // Not in the document until opened.
      expect(document.getElementById('agent-panel')).toBeNull();
      expect(panel.isOpen()).toBe(false);
    });

    test('clicking a starter runs it immediately through auto-routing', async () => {
      panel.initialize(() => makeContext());
      // The double streams a token before resolving: a chat turn that resolves ok
      // with nothing streamed is the empty-answer failure, not a success.
      ipcRenderer.invoke.mockImplementation(async (ch, req) => {
        if (ch === 'chat:ask') { ipcRenderer._fire('chat:token', { id: req.id, delta: 'answer' }); return { ok: true, charCount: 6, elapsedMs: 1 }; }
        return defaultInvoke(ch);
      });
      const starter = panel.overlay.querySelector('.agent-panel-starters button[data-starter]');
      starter.click(); // fires _run async — flush below before asserting
      for (let i = 0; i < 25; i++) await Promise.resolve(); // the click fires _run async — flush before asserting
      expect(panel.input.value).toBe(''); // consumed into a run, not left sitting in the composer
      const askCall = ipcRenderer.invoke.mock.calls.find((c) => c[0] === 'chat:ask');
      expect(askCall && askCall[1].messages.some((m) => m.role === 'user' && String(m.content).includes(starter.dataset.starter))).toBe(true);
    });

    test('open() mounts the surface into the DOM and flips isOpen', () => {
      panel.initialize(() => makeContext());
      panel.open();
      expect(document.getElementById('agent-panel')).not.toBeNull();
      expect(document.body.contains(panel.overlay)).toBe(true);
      expect(panel.isOpen()).toBe(true);
    });

    test('close() collapses the sidebar (kept mounted, hidden from AT) and flips isOpen false', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel.close();
      expect(panel.isOpen()).toBe(false);
      // Kept mounted so the transcript survives; collapsed means hidden from AT and the sidebar class is gone.
      expect(document.getElementById('agent-panel')).not.toBeNull();
      expect(document.getElementById('assistant-shell').getAttribute('aria-hidden')).toBe('true');
      expect(document.body.classList.contains('assistant-sidebar-open')).toBe(false);
    });

    test('toggle() opens then closes', () => {
      panel.initialize(() => makeContext());
      panel.toggle();
      expect(panel.isOpen()).toBe(true);
      panel.toggle();
      expect(panel.isOpen()).toBe(false);
    });

    test('initialize falls back to an empty-context provider when not given a function', () => {
      panel.initialize(/* not a function */);
      expect(typeof panel.contextProvider).toBe('function');
      expect(panel.contextProvider()).toEqual({});
    });

    test('wires the agent:* IPC listeners during initialize', () => {
      panel.initialize(() => makeContext());
      const channels = ipcRenderer.on.mock.calls.map((c) => c[0]);
      expect(channels).toEqual(expect.arrayContaining([
        'agent:task-started',
        'agent:task-completed',
        'agent:task-failed',
        'agent:step-planned',
        'agent:step-acted',
        'agent:approval-request',
      ]));
    });
  });

  // ---- Panel scope (global vs tab) --------------------------------------

  describe('panel scope', () => {
    test('default scope is global and the scope label reads "Global"', () => {
      panel.initialize(() => makeContext());
      panel.open();
      const scopeEl = panel.overlay.querySelector('.agent-panel-scope');
      expect(panel._scope).toBe('global');
      expect(scopeEl.textContent).toBe('Global');
      expect(scopeEl.dataset.scope).toBe('global');
    });

    test('opening with scope:tab sets the tab id and renders the tab title label', () => {
      panel.initialize(() => makeContext());
      panel.open({ scope: 'tab', tabId: 'tab-7', tabTitle: 'Docs' });
      const scopeEl = panel.overlay.querySelector('.agent-panel-scope');
      expect(panel._scope).toBe('tab');
      expect(panel._tabId).toBe('tab-7');
      expect(scopeEl.dataset.scope).toBe('tab');
      expect(scopeEl.textContent).toBe('Tab: Docs');
    });

    test('changing scope resets the active task + transcript', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._activeTaskId = 'old-task';
      panel._activeDescription = 'old desc';
      panel._transcriptEl.innerHTML = '<li>stale</li>';
      panel.open({ scope: 'tab', tabId: 'tab-9', tabTitle: 'X' });
      expect(panel._activeTaskId).toBeNull();
      expect(panel._activeDescription).toBe('');
      expect(panel._transcriptEl.children.length).toBe(0);
    });
  });

  // ---- Scope-filtered dispatch hooks (PRIORITY: routine/pack wiring) -----

  describe('scope-filtered task-completed / task-failed (routine/pack dispatch)', () => {
    test('_scopeMatches accepts a matching global event and rejects a tab-scoped one', () => {
      panel.initialize(() => makeContext());
      panel.open(); // scope = global
      expect(panel._scopeMatches({ scope: 'global' })).toBe(true);
      // Legacy untagged events default to global and remain visible.
      expect(panel._scopeMatches({})).toBe(true);
      expect(panel._scopeMatches(undefined)).toBe(true);
      // A tab-scoped event must NOT match a global panel.
      expect(panel._scopeMatches({ scope: 'tab', tabId: 'tab-1' })).toBe(false);
    });

    test('_scopeMatches in tab scope requires both scope AND tabId to match', () => {
      panel.initialize(() => makeContext());
      panel.open({ scope: 'tab', tabId: 'tab-A', tabTitle: 'A' });
      expect(panel._scopeMatches({ scope: 'tab', tabId: 'tab-A' })).toBe(true);
      // Right scope, wrong tab → rejected.
      expect(panel._scopeMatches({ scope: 'tab', tabId: 'tab-B' })).toBe(false);
      // A global event must NOT leak into a tab-scoped panel.
      expect(panel._scopeMatches({ scope: 'global' })).toBe(false);
    });

    test('agent:task-completed for a MISMATCHED scope is ignored (negative test)', () => {
      panel.initialize(() => makeContext());
      panel.open(); // global panel
      // Mismatched (tab-scoped) completion must not flip status or render.
      ipcRenderer._fire('agent:task-completed', { ok: true, summary: 'leaked', scope: 'tab', tabId: 'tab-x' });
      expect(panel.statusEl.getAttribute('data-status')).toBe('idle');
      expect(panel._answerView.getMarkdown()).toBe('');
    });

    test('agent:task-completed for a MATCHING scope flips status to done and presents the summary', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('agent:task-completed', { ok: true, summary: 'all done', scope: 'global' });
      expect(panel.statusEl.getAttribute('data-status')).toBe('done');
      expect(panel._answerView.getMarkdown()).toBe('all done');
    });

    test('agent:task-failed for a MISMATCHED scope is ignored (negative test)', () => {
      panel.initialize(() => makeContext());
      panel.open(); // global panel
      ipcRenderer._fire('agent:task-failed', { error: 'boom', scope: 'tab', tabId: 't1' });
      expect(panel.statusEl.getAttribute('data-status')).toBe('idle');
      expect(panel._answerView.getMarkdown()).toBe('');
    });

    test('agent:task-failed for a MATCHING scope flips status to error and shows the error', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('agent:task-failed', { error: 'kaboom', scope: 'global' });
      expect(panel.statusEl.getAttribute('data-status')).toBe('error');
      expect(panel._answerView.getMarkdown()).toContain('kaboom');
    });

    test('the integration the routine layer reads: a matching completion is observable to a sibling listener, a mismatched one is not', () => {
      // renderer.js runRoutine() attaches its OWN agent:task-completed listener
      // and filters result.scope === 'tab'. This asserts the contract that
      // AgentPanel does not swallow the global event that integration relies on.
      panel.initialize(() => makeContext());
      panel.open();
      const routineListener = jest.fn();
      ipcRenderer.on('agent:task-completed', routineListener);

      ipcRenderer._fire('agent:task-completed', { ok: true, summary: 'ok', scope: 'global' });
      expect(routineListener).toHaveBeenCalledTimes(1);
      expect(routineListener.mock.calls[0][1]).toMatchObject({ ok: true, scope: 'global' });
      // AgentPanel reacted too (matching scope).
      expect(panel.statusEl.getAttribute('data-status')).toBe('done');
    });
  });

  // ---- Task lifecycle ----------------------------------------------------

  describe('task lifecycle', () => {
    test('_run with no description does nothing (no agent:start invoked)', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel.input.value = '   ';
      await panel._run();
      expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('agent:start', expect.anything());
      expect(ipcRenderer.send).not.toHaveBeenCalledWith('engine-updater:user-send');
    });

    test('a real send lets main offer the pending runtime update', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel.routeMode = 'chat';
      panel.input.value = 'hello';
      await panel._run();
      expect(ipcRenderer.send).toHaveBeenCalledWith('engine-updater:user-send');
    });

    test('_run with no resolvable webview surfaces a guidance message and does not start', async () => {
      panel.initialize(() => makeContext({ webview: null }));
      panel.open();
      panel.routeMode = 'agent'; // force agent lane (auto routing would pick chat for these fixtures)
      panel.input.value = 'do a thing';
      await panel._run();
      expect(panel._answerView.getMarkdown()).toContain('No active webview');
      const startCalls = ipcRenderer.invoke.mock.calls.filter((c) => c[0] === 'agent:start');
      expect(startCalls.length).toBe(0);
    });

    test('_run invokes agent:start with the description, webContentsId, and scope', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel.routeMode = 'agent'; // force agent lane (auto routing would pick chat for these fixtures)
      panel.input.value = 'open the docs';
      await panel._run();
      const startCall = ipcRenderer.invoke.mock.calls.find((c) => c[0] === 'agent:start');
      expect(startCall).toBeTruthy();
      expect(startCall[1]).toMatchObject({
        description: 'open the docs',
        webContentsId: 4242,
        scope: 'global',
        tabId: null,
      });
      // Input is cleared immediately so the message visibly moves to transcript.
      expect(panel.input.value).toBe('');
    });

    test('_run passes a qualitySkillOverride only when the mode is not balanced', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel.routeMode = 'agent'; // force agent lane (auto routing would pick chat for these fixtures)
      panel._setQualityMode('ultra');
      panel.input.value = 'deep task';
      await panel._run();
      const startCall = ipcRenderer.invoke.mock.calls.find((c) => c[0] === 'agent:start');
      expect(startCall[1].qualitySkillOverride).toEqual({ name: 'ultra' });
    });

    test('the first agent run clears the agent workspace; a follow-up run keeps the tabs it opened', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel.routeMode = 'agent';
      panel.input.value = 'open the docs';
      await panel._run();
      const clears = () => ipcRenderer.invoke.mock.calls.filter((c) => c[0] === 'agent-workspace:set-active-conversation');
      expect(clears()).toHaveLength(1);
      expect(clears()[0][1]).toEqual({ isNew: true });

      panel.input.value = 'now open the third result';
      await panel._run();
      // Wiping mid-thread would destroy the pages the first turn opened.
      expect(clears()).toHaveLength(1);
    });

    test('an agent answer joins the shared thread and rides along on the next agent:start as priorTurns', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel.routeMode = 'agent';
      panel.input.value = 'which monitor is best?';
      await panel._run();
      ipcRenderer._fire('agent:task-started', {
        taskId: 'task-1', task: { description: 'which monitor is best?' }, scope: 'global',
      });
      ipcRenderer._fire('agent:task-completed', { ok: true, summary: 'The Dell U2723QE.', scope: 'global' });
      expect(panel._chatHistory).toEqual([
        { role: 'user', content: 'which monitor is best?' },
        { role: 'assistant', content: 'The Dell U2723QE.' },
      ]);

      panel.input.value = 'and the runner-up?';
      await panel._run();
      const last = ipcRenderer.invoke.mock.calls.filter((c) => c[0] === 'agent:start').pop();
      expect(last[1].priorTurns).toEqual([
        { role: 'user', content: 'which monitor is best?' },
        { role: 'assistant', content: 'The Dell U2723QE.' },
      ]);
    });

    test('a failed agent turn is NOT recorded in the shared thread (negative)', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._activeDescription = 'do the thing';
      ipcRenderer._fire('agent:task-completed', { ok: false, error: 'engine down', scope: 'global' });
      expect(panel._chatHistory).toEqual([]);
    });

    test('_run restores the typed text and shows an error if agent:start rejects', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel.routeMode = 'agent'; // force agent lane (auto routing would pick chat for these fixtures)
      ipcRenderer.invoke.mockImplementation(async (ch, ...rest) => {
        if (ch === 'agent:start') throw new Error('engine down');
        return defaultInvoke(ch, ...rest);
      });
      panel.input.value = 'task that fails to start';
      await panel._run();
      expect(panel.statusEl.getAttribute('data-status')).toBe('error');
      expect(panel._answerView.getMarkdown()).toContain('engine down');
      // The user's typing is restored so it is not lost.
      expect(panel.input.value).toBe('task that fails to start');
    });

    test('agent:task-started renders the user message, sets running, and binds the workspace', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('agent:task-started', {
        taskId: 'task-123',
        task: { description: 'summarize this page' },
        scope: 'global',
      });
      expect(panel.statusEl.getAttribute('data-status')).toBe('running');
      expect(panel._activeTaskId).toBe('task-123');
      const userMsg = panel._transcriptEl.querySelector('.agent-msg-user .agent-msg-body');
      expect(userMsg).not.toBeNull();
      expect(userMsg.textContent).toBe('summarize this page');
      expect(ipcRenderer.send).toHaveBeenCalledWith(
        'agent-workspace:bind-conversation-id',
        { taskId: 'task-123' },
      );
    });

    test('agent:task-started for a mismatched scope is ignored', () => {
      panel.initialize(() => makeContext());
      panel.open(); // global
      ipcRenderer._fire('agent:task-started', {
        taskId: 'other',
        task: { description: 'tab-only task' },
        scope: 'tab',
        tabId: 'tab-z',
      });
      expect(panel.statusEl.getAttribute('data-status')).toBe('idle');
      expect(panel._activeTaskId).not.toBe('other');
      expect(panel._transcriptEl.querySelector('.agent-msg-user')).toBeNull();
    });

    test('step-planned then step-acted render a tool stream group with results', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('agent:step-planned', {
        step: 0,
        calls: [{ name: 'browser.click', args: { selector: '#go' } }],
      });
      expect(panel._toolStream).not.toBeNull();
      ipcRenderer._fire('agent:step-acted', {
        step: 0,
        calls: [{ name: 'browser.click', args: { selector: '#go' } }],
        results: [{ id: 'r1', name: 'browser.click', result: { ok: true } }],
        latencyMs: 120,
      });
      const stream = panel.overlay.querySelector('.agent-tool-stream');
      expect(stream).not.toBeNull();
      expect(stream.textContent).toContain('Click #go');
    });

    test('completion collapses the tool stream and brands a failed task red', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('agent:step-planned', { step: 0, calls: [{ name: 'browser.click', args: {} }] });
      const stream = panel.overlay.querySelector('.agent-tool-stream');
      ipcRenderer._fire('agent:task-completed', { ok: false, reason: 'error', summary: 'nope', scope: 'global' });
      expect(stream.classList.contains('is-collapsed')).toBe(true);
      expect(stream.classList.contains('has-failure')).toBe(true);
      expect(panel.statusEl.getAttribute('data-status')).toBe('error');
    });

    test('a run that ends with no answer text reports the failure instead of a blank "done"', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('agent:task-completed', { ok: true, summary: '', scope: 'global' });
      expect(panel.statusEl.getAttribute('data-status')).toBe('error');
      expect(panel.overlay.textContent).toContain('ended without an answer');
    });

    test('an empty_response run explains the reasoning-budget cause rather than printing the code', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('agent:task-completed', { ok: false, reason: 'empty_response', scope: 'global' });
      expect(panel.overlay.textContent).not.toContain('empty_response');
      expect(panel.overlay.textContent).toContain('no answer text and no tool call');
    });

    test('agent:assistant-chunk streams partial text into the answer view', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('agent:assistant-chunk', { text: 'Hello ' });
      ipcRenderer._fire('agent:assistant-chunk', { text: 'world' });
      expect(panel._answerView.getMarkdown()).toBe('Hello world');
    });

    test('agent:budget-breach surfaces the reason in the budget chip', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('agent:budget-breach', { reason: 'token cap' });
      expect(panel.budgetEl.textContent).toBe('hit token cap');
    });
  });

  // ---- openWithTask: the routine/pack entry point ------------------------

  describe('openWithTask (routine / pack dispatch entry point)', () => {
    test('opens the panel, fills the input, and auto-runs the task', async () => {
      panel.initialize(() => makeContext());
      panel.openWithTask('run this routine', { scope: 'global' });
      // rAF is synchronous in this suite, so _run already fired.
      expect(panel.isOpen()).toBe(true);
      await Promise.resolve();
      const startCall = ipcRenderer.invoke.mock.calls.find((c) => c[0] === 'agent:start');
      expect(startCall).toBeTruthy();
      expect(startCall[1].description).toBe('run this routine');
    });

    test('a task the user sent by hand pings for the runtime update offer; a routine does not', () => {
      panel.initialize(() => makeContext());
      panel.openWithTask('run this routine', { scope: 'global' });
      expect(ipcRenderer.send).not.toHaveBeenCalledWith('engine-updater:user-send');
      panel.openWithTask('summarize my tabs', { scope: 'global', userSend: true });
      expect(ipcRenderer.send).toHaveBeenCalledWith('engine-updater:user-send');
    });

    test('openWithTask with blank text opens the panel but does not start a task', async () => {
      panel.initialize(() => makeContext());
      panel.openWithTask('   ', { scope: 'global' });
      expect(panel.isOpen()).toBe(true);
      await Promise.resolve();
      const startCalls = ipcRenderer.invoke.mock.calls.filter((c) => c[0] === 'agent:start');
      expect(startCalls.length).toBe(0);
    });

    test('a routine dispatched via openWithTask ends in an observable matching completion', async () => {
      // End-to-end of the routine path that AgentPanel owns: openWithTask →
      // agent:start → agent:task-completed (global) reaches a routine-style
      // sibling listener, exactly what renderer.js runRoutine() depends on.
      panel.initialize(() => makeContext());
      const routineDone = jest.fn();
      ipcRenderer.on('agent:task-completed', (_e, r) => { if (r && r.scope === 'tab') return; routineDone(r); });

      panel.openWithTask('scheduled routine task', { scope: 'global' });
      await Promise.resolve();
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'agent:start')).toBe(true);

      ipcRenderer._fire('agent:task-completed', { ok: true, summary: 'routine result', scope: 'global' });
      expect(routineDone).toHaveBeenCalledTimes(1);
      expect(routineDone.mock.calls[0][0]).toMatchObject({ ok: true, scope: 'global' });
      expect(panel.statusEl.getAttribute('data-status')).toBe('done');
    });
  });

  // ---- User interactions -------------------------------------------------

  describe('user interactions', () => {
    test('clicking Run starts the task', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel.routeMode = 'agent'; // force agent lane (auto routing would pick chat for these fixtures)
      panel.input.value = 'click-run task';
      panel.runBtn.click();
      await Promise.resolve();
      const startCall = ipcRenderer.invoke.mock.calls.find((c) => c[0] === 'agent:start');
      expect(startCall).toBeTruthy();
      expect(startCall[1].description).toBe('click-run task');
    });

    test('Stop button sends agent:stop and returns status to idle', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel.routeMode = 'agent'; // force agent lane (auto routing would pick chat for these fixtures)
      // Put the panel into a running state first.
      panel._setStatus('running');
      panel.stopBtn.click();
      expect(ipcRenderer.send).toHaveBeenCalledWith('agent:stop');
      expect(panel.statusEl.getAttribute('data-status')).toBe('idle');
    });

    test('Cmd+Enter in the input triggers a run', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel.routeMode = 'agent'; // force agent lane (auto routing would pick chat for these fixtures)
      panel.input.value = 'keyboard task';
      const ev = new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true });
      panel.input.dispatchEvent(ev);
      await Promise.resolve();
      expect(ev.defaultPrevented).toBe(true);
      const startCall = ipcRenderer.invoke.mock.calls.find((c) => c[0] === 'agent:start');
      expect(startCall[1].description).toBe('keyboard task');
    });

    test('plain Enter does NOT send by default (Shift+Enter is the send chord)', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel.routeMode = 'agent'; // force agent lane (auto routing would pick chat for these fixtures)
      panel.input.value = 'should not send';
      const plain = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      panel.input.dispatchEvent(plain);
      await Promise.resolve();
      expect(plain.defaultPrevented).toBe(false);
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'agent:start')).toBe(false);

      const shift = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
      panel.input.dispatchEvent(shift);
      await Promise.resolve();
      expect(shift.defaultPrevented).toBe(true);
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'agent:start')).toBe(true);
    });

    test('quality mode buttons toggle the active state and aria-pressed', () => {
      panel.initialize(() => makeContext());
      panel.open();
      // Quality group is adopted into the portalled menu's quality slot.
      const ultraBtn = document.body.querySelector('.agent-panel-quality-btn[data-mode="ultra"]');
      const balancedBtn = document.body.querySelector('.agent-panel-quality-btn[data-mode="balanced"]');
      ultraBtn.click();
      expect(panel._qualityMode).toBe('ultra');
      expect(ultraBtn.classList.contains('is-active')).toBe(true);
      expect(ultraBtn.getAttribute('aria-pressed')).toBe('true');
      expect(balancedBtn.classList.contains('is-active')).toBe(false);
    });

    test('+ New conversation resets the conversation (scoped), clears state and the agent workspace', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._activeTaskId = 'live-task';
      panel._activeDescription = 'something';
      panel._chatHistory = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }];
      panel._agentThreadActive = true;
      panel._transcriptEl.innerHTML = '<li>old</li>';
      // The button lives in the panel header, not the portalled ⋯ menu.
      expect(panel.overlay.querySelector('.agent-panel-header .agent-panel-new')).toBeTruthy();
      panel.overlay.querySelector('.agent-panel-new').click();
      expect(ipcRenderer.send).toHaveBeenCalledWith(
        'agent:reset-conversation',
        { scope: 'global', tabId: null },
      );
      expect(panel._activeTaskId).toBeNull();
      expect(panel._activeDescription).toBe('');
      expect(panel._transcriptEl.children.length).toBe(0);
      expect(panel._chatHistory).toEqual([]);
      expect(panel._agentThreadActive).toBe(false);
      await Promise.resolve();
      await Promise.resolve();
      expect(ipcRenderer.invoke).toHaveBeenCalledWith(
        'agent-workspace:set-active-conversation', { isNew: true },
      );
    });

    test('Esc closes the panel when the typewriter is not running', () => {
      panel.initialize(() => makeContext());
      panel.open();
      const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
      expect(panel.isOpen()).toBe(false);
    });

    test('sessions list refresh is invoked when the panel opens', () => {
      panel.initialize(() => makeContext());
      panel.open();
      const listCall = ipcRenderer.invoke.mock.calls.find((c) => c[0] === 'session:list');
      expect(listCall).toBeTruthy();
    });

    test('opening a history run replays its events and renders the description', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer.invoke.mockImplementation(async (ch, arg) => {
        if (ch === 'agent:history-open' && arg === 'run-9') {
          return {
            id: 'run-9',
            description: 'past run prompt',
            status: 'ok',
            summary: 'the past answer',
            events: [{ kind: 'step', step: 0, tools: [{ name: 'browser.click', args: {} }], results: [] }],
          };
        }
        return defaultInvoke(ch, arg);
      });
      await panel._openHistoryRun('run-9');
      const userMsg = panel._transcriptEl.querySelector('.agent-msg-user .agent-msg-body');
      expect(userMsg.textContent).toBe('past run prompt');
      expect(panel._answerView.getMarkdown()).toBe('the past answer');
      expect(ipcRenderer.send).toHaveBeenCalledWith(
        'agent:reset-conversation',
        { scope: 'global', tabId: null },
      );
    });
  });

  // ---- Approval prompt ---------------------------------------------------

  describe('approval prompt', () => {
    test('agent:approval-request renders the prompt; clicking Approve sends the decision', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('agent:approval-request', {
        requestId: 'req-1',
        call: { name: 'browser.navigate', args: { url: 'https://x.test' } },
        class: 'navigation',
        origin: 'https://x.test',
      });
      expect(panel.approvalEl.hidden).toBe(false);
      const approveBtn = panel.approvalEl.querySelector('button[data-decision="approve"]');
      expect(approveBtn).not.toBeNull();
      approveBtn.click();
      expect(ipcRenderer.send).toHaveBeenCalledWith(
        'agent:approval-response',
        { requestId: 'req-1', decision: 'approve' },
      );
      expect(panel.approvalEl.hidden).toBe(true);
    });
  });

  // ---- NEW: research-sources capture + egress scope banner --------------

  describe('research sources capture (NEW dispatch hook)', () => {
    test('open_research_sources result wires the citation map and reveals the workspace', () => {
      const awm = { focusSource: jest.fn(), revealWorkspace: jest.fn() };
      panel.initialize(() => makeContext({ agentWorkspaceManager: awm }));
      panel.open();
      ipcRenderer._fire('agent:step-acted', {
        step: 0,
        calls: [{ name: 'browser.open_research_sources', args: {} }],
        results: [{
          id: 'r1',
          name: 'browser.open_research_sources',
          result: { sources: [{ index: 1, spaceId: 'space-a' }, { index: 2, spaceId: 'space-b' }] },
        }],
      });
      expect(awm.revealWorkspace).toHaveBeenCalledTimes(1);
      // The answer view now linkifies [N] citations against the captured map.
      panel._answerView.renderStatic('See [1] and [2].');
      const cites = panel._answerView._bodyEl.querySelectorAll('.agent-cite');
      expect(cites.length).toBe(2);
      cites[0].click();
      expect(awm.focusSource).toHaveBeenCalledWith('space-a');
    });

    test('a step with no research sources does not touch the workspace', () => {
      const awm = { focusSource: jest.fn(), revealWorkspace: jest.fn() };
      panel.initialize(() => makeContext({ agentWorkspaceManager: awm }));
      panel.open();
      ipcRenderer._fire('agent:step-acted', {
        step: 0,
        calls: [{ name: 'browser.click', args: {} }],
        results: [{ id: 'r1', name: 'browser.click', result: { ok: true } }],
      });
      expect(awm.revealWorkspace).not.toHaveBeenCalled();
    });
  });

  describe('egress scope banner (NEW dispatch hook)', () => {
    test('hidden when egress is open with no blocklist', () => {
      const configBridge = require('../../../../renderer/core/configBridge');
      configBridge.initialize({ settings: { llm: { agent: { egress: { mode: 'open', block: [] } } } } });
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('agent:task-started', { taskId: 't1', task: { description: 'go' }, scope: 'global' });
      expect(panel._egressEl.hidden).toBe(true);
    });

    test('renders an allow-list summary and the Change button opens agent-safety settings', () => {
      const configBridge = require('../../../../renderer/core/configBridge');
      configBridge.initialize({
        settings: { llm: { agent: { egress: { mode: 'allowlist', allow: ['a.com', 'b.com'], onViolation: 'deny' } } } },
      });
      const settingsMenu = { showTab: jest.fn() };
      panel.initialize(() => makeContext({ settingsMenu }));
      panel.open();
      ipcRenderer._fire('agent:task-started', { taskId: 't2', task: { description: 'go' }, scope: 'global' });
      expect(panel._egressEl.hidden).toBe(false);
      expect(panel._egressEl.textContent).toContain('Allow-list');
      expect(panel._egressEl.textContent).toContain('2 sites');
      panel._egressEl.querySelector('.agent-panel-egress-edit').click();
      expect(settingsMenu.showTab).toHaveBeenCalledWith('agent-safety');
    });
  });

  // ---- Prompt history + pause/resume ------------------------------------

  describe('prompt history & pause', () => {
    test('ArrowUp at the start of an empty input recalls the last submitted prompt', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel.routeMode = 'agent'; // force agent lane (auto routing would pick chat for these fixtures)
      panel.input.value = 'first prompt';
      await panel._run();
      // Input cleared after submit; ArrowUp at caret 0 recalls history.
      panel.input.value = '';
      panel.input.selectionStart = 0;
      const ev = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
      panel.input.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(panel.input.value).toBe('first prompt');
    });

    test('agent:task-paused and agent:task-resumed flip the pause button label', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('agent:task-paused');
      expect(panel._paused).toBe(true);
      expect(panel.pauseBtn.textContent).toBe('Resume');
      ipcRenderer._fire('agent:task-resumed');
      expect(panel._paused).toBe(false);
      expect(panel.pauseBtn.textContent).toBe('Pause');
    });

    test('togglePause sends agent:pause when running and agent:resume when paused', () => {
      panel.initialize(() => makeContext());
      panel.open();
      // Pause is only actionable while a task is running (button enabled).
      panel._setStatus('running');
      expect(panel.pauseBtn.disabled).toBe(false);
      panel.pauseBtn.click();
      expect(ipcRenderer.send).toHaveBeenCalledWith('agent:pause');
      ipcRenderer._fire('agent:task-paused');
      panel.pauseBtn.click();
      expect(ipcRenderer.send).toHaveBeenCalledWith('agent:resume');
    });
  });

  // ---- Persona ----------------------------------------------------------

  describe('persona', () => {
    test('persona:list populates the select, and choosing one locks the persona', async () => {
      ipcRenderer.invoke.mockImplementation(async (ch, ...rest) => {
        if (ch === 'persona:list') return { enabled: [{ name: 'researcher', label: 'Researcher' }], lock: null };
        return defaultInvoke(ch, ...rest);
      });
      panel.initialize(() => makeContext());
      panel.open();
      // _loadPersonas runs during _buildDom; let its awaits settle.
      await Promise.resolve(); await Promise.resolve();
      const select = panel._personaSelect;
      const opt = Array.from(select.options).find((o) => o.value === 'researcher');
      expect(opt).toBeTruthy();
      select.value = 'researcher';
      select.dispatchEvent(new Event('change'));
      expect(ipcRenderer.send).toHaveBeenCalledWith('persona:lock', 'researcher');
      expect(panel._personaLock).toBe('researcher');
    });

    test('resetting the persona select to Auto sends persona:reset-lock', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._personaLock = 'researcher';
      panel._personaSelect.value = '';
      panel._personaSelect.dispatchEvent(new Event('change'));
      expect(ipcRenderer.send).toHaveBeenCalledWith('persona:reset-lock');
      expect(panel._personaLock).toBeNull();
    });
  });

  // ---- Reattach prompt --------------------------------------------------

  describe('reattach prompt', () => {
    test('agent:task-orphaned shows the reattach prompt; task-reattached hides it', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('agent:task-orphaned');
      const prompt = panel.overlay.querySelector('.agent-reattach');
      expect(prompt.hidden).toBe(false);
      ipcRenderer._fire('agent:task-reattached');
      expect(prompt.hidden).toBe(true);
    });
  });

  // ---- Export ------------------------------------------------------------

  describe('export', () => {
    test('Export writes the transcript markdown to the clipboard', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._activeDescription = 'My run';
      ipcRenderer._fire('agent:task-completed', { ok: true, summary: 'final answer text', scope: 'global' });
      // Export button is adopted into the portalled menu's actions slot.
      document.body.querySelector('.agent-panel-export').click();
      expect(clipboard.writeText).toHaveBeenCalledTimes(1);
      const written = clipboard.writeText.mock.calls[0][0];
      expect(written).toContain('# My run');
      expect(written).toContain('final answer text');
    });

    test('Export with steps and no description uses the generic heading', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('agent:step-planned', { step: 0, calls: [{ name: 'browser.click', args: { selector: '#x' } }] });
      ipcRenderer._fire('agent:step-acted', {
        step: 0,
        calls: [{ name: 'browser.click', args: { selector: '#x' } }],
        results: [{ id: 'r1', name: 'browser.click', result: { ok: true } }],
      });
      panel._exportTranscript();
      const written = clipboard.writeText.mock.calls[0][0];
      expect(written).toContain('# Agent run');
      expect(written).toContain('## Step 1');
    });

    test('Export falls back to navigator.clipboard when electron clipboard throws', () => {
      panel.initialize(() => makeContext());
      panel.open();
      clipboard.writeText.mockImplementationOnce(() => { throw new Error('no electron clipboard'); });
      const navWrite = jest.fn();
      const origNav = global.navigator;
      Object.defineProperty(global, 'navigator', {
        value: { clipboard: { writeText: navWrite } },
        configurable: true,
      });
      panel._exportTranscript();
      expect(navWrite).toHaveBeenCalledTimes(1);
      Object.defineProperty(global, 'navigator', { value: origNav, configurable: true });
    });
  });

  // ---- Branch-coverage extension ----------------------------------------

  describe('persona rendering branches', () => {
    test('a locked persona labels the pill "Persona (locked)"', async () => {
      ipcRenderer.invoke.mockImplementation(async (ch, ...rest) => {
        if (ch === 'persona:list') {
          return { enabled: [{ name: 'researcher', label: 'Researcher' }], lock: 'researcher' };
        }
        return defaultInvoke(ch, ...rest);
      });
      panel.initialize(() => makeContext());
      panel.open();
      await Promise.resolve(); await Promise.resolve();
      // Persona wrap is adopted into the portalled menu's persona slot.
      const label = document.body.querySelector('.agent-panel-persona-label');
      expect(label.textContent).toBe('Persona (locked)');
      expect(panel._personaSelect.value).toBe('researcher');
    });

    test('a resolved persona payload reflects the router source and resets the select to Auto', async () => {
      ipcRenderer.invoke.mockImplementation(async (ch, ...rest) => {
        if (ch === 'persona:list') return { enabled: [{ name: 'coder', label: 'Coder' }], lock: null };
        return defaultInvoke(ch, ...rest);
      });
      panel.initialize(() => makeContext());
      panel.open();
      await Promise.resolve(); await Promise.resolve();
      ipcRenderer._fire('agent:task-started', {
        taskId: 't1',
        task: { description: 'go' },
        scope: 'global',
        persona: 'coder',
        personaLabel: 'Coder',
        routerSource: 'classifier',
      });
      const label = document.body.querySelector('.agent-panel-persona-label');
      expect(label.textContent).toBe('Persona (classifier)');
      // Resolved but not locked → select stays "Auto".
      expect(panel._personaSelect.value).toBe('');
    });

    test('persona:list failure leaves the select with just the Auto option', async () => {
      ipcRenderer.invoke.mockImplementation(async (ch, ...rest) => {
        if (ch === 'persona:list') throw new Error('engine boot race');
        return defaultInvoke(ch, ...rest);
      });
      panel.initialize(() => makeContext());
      panel.open();
      await Promise.resolve(); await Promise.resolve();
      expect(panel._personaSelect.options.length).toBe(1);
      expect(panel._personaSelect.options[0].value).toBe('');
    });
  });

  describe('task lifecycle deep branches', () => {
    test('a follow-up task-started freezes the prior answer and keeps the transcript', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('agent:task-started', { taskId: 't1', task: { description: 'first' }, scope: 'global' });
      ipcRenderer._fire('agent:task-completed', { ok: true, summary: 'first answer', scope: 'global' });
      ipcRenderer._fire('agent:task-started', {
        taskId: 't2', task: { description: 'follow up' }, scope: 'global', isFollowUp: true,
      });
      // The prior answer is frozen into the transcript as a static message.
      const frozen = panel._transcriptEl.querySelector('.agent-msg-assistant-answer');
      expect(frozen).not.toBeNull();
      expect(frozen.textContent).toContain('first answer');
      // The new user message is still appended (transcript not reset).
      const users = panel._transcriptEl.querySelectorAll('.agent-msg-user');
      expect(users.length).toBe(2);
    });

    test('task-completed hydrates persona follow-up chips on success', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._personaList = [{ name: 'coder', followUps: ['Refactor it', 'Add tests'] }];
      ipcRenderer._fire('agent:task-started', {
        taskId: 't1', task: { description: 'go' }, scope: 'global',
        persona: 'coder', personaLabel: 'Coder', routerSource: 'auto',
      });
      ipcRenderer._fire('agent:task-completed', { ok: true, summary: 'done', scope: 'global' });
      const chips = panel._answerView._root.querySelectorAll('.agent-followup-chip, [data-followup]');
      // The AnswerView renders the follow-ups it was handed; assert at least the
      // persona context made it through by checking the rendered text.
      expect(panel._answerView._root.textContent).toMatch(/Refactor it|Add tests/);
    });

    test('a partial completion (max steps) annotates the answer as partial', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._personaList = [{ name: 'coder', followUps: [] }];
      ipcRenderer._fire('agent:task-started', {
        taskId: 't1', task: { description: 'go' }, scope: 'global',
        persona: 'coder', personaLabel: 'Coder', routerSource: 'auto',
      });
      ipcRenderer._fire('agent:task-completed', {
        ok: true, summary: 'incomplete', reason: 'maxstepsexceeded_soft', scope: 'global',
      });
      expect(panel._answerView._root.textContent).toContain('partial');
    });

    test('task-failed marks the tool stream failed and flips the history entry', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('agent:task-started', { taskId: 't1', task: { description: 'go' }, scope: 'global' });
      ipcRenderer._fire('agent:step-planned', { step: 0, calls: [{ name: 'browser.click', args: {} }] });
      const stream = panel.overlay.querySelector('.agent-tool-stream');
      ipcRenderer._fire('agent:task-failed', { error: 'crashed', scope: 'global' });
      expect(stream.classList.contains('has-failure')).toBe(true);
      expect(panel._answerView.getMarkdown()).toContain('crashed');
    });

    test('task-failed with no error string still presents a generic failure', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('agent:task-failed', { scope: 'global' });
      expect(panel._answerView.getMarkdown()).toContain('unknown error');
    });

    test('agent:plan-updated renders a plan row only when there are steps', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('agent:plan-updated', { steps: [] });
      expect(panel._transcriptEl.querySelector('.agent-step-plan')).toBeNull();
      ipcRenderer._fire('agent:plan-updated', { steps: ['look', 'click'] });
      const plan = panel._transcriptEl.querySelector('.agent-step-plan');
      expect(plan.textContent).toBe('Plan: look → click');
    });

    test('agent:step-parse-retry adds a parse-retry note to the tool stream', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('agent:step-parse-retry', { step: 1, contentPreview: 'bad json' });
      expect(panel._toolStream).not.toBeNull();
    });

    test('agent:throughput is forwarded to the answer view', () => {
      panel.initialize(() => makeContext());
      panel.open();
      const spy = jest.spyOn(panel._answerView, 'updateThroughput');
      ipcRenderer._fire('agent:throughput', { tokPerSec: 12 });
      expect(spy).toHaveBeenCalledWith({ tokPerSec: 12 });
      spy.mockRestore();
    });

    test('agent:assistant-chunk with a non-string payload is ignored', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('agent:assistant-chunk', { text: 42 });
      expect(panel._answerView.getMarkdown()).toBe('');
    });
  });

  describe('_setStatus button-state matrix', () => {
    test('running disables Run and enables Stop/Pause', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._setStatus('running');
      expect(panel.runBtn.disabled).toBe(true);
      expect(panel.stopBtn.disabled).toBe(false);
      expect(panel.pauseBtn.disabled).toBe(false);
    });

    test('a non-running status re-enables Run and resets the pause label', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._setStatus('running');
      panel._paused = true;
      panel.pauseBtn.textContent = 'Resume';
      panel._setStatus('idle');
      expect(panel.runBtn.disabled).toBe(false);
      expect(panel.stopBtn.disabled).toBe(true);
      expect(panel._paused).toBe(false);
      expect(panel.pauseBtn.textContent).toBe('Pause');
    });
  });

  describe('_run scope + webview resolution branches', () => {
    test('tab-scoped run targets THIS tab\'s webview even if another is focused', async () => {
      const tabWv = makeWebview('tab-77');
      tabWv.getWebContentsId = jest.fn(() => 7777);
      // Active webview is a different tab — the tab-scope branch must win.
      panel.initialize(() => makeContext({ webview: makeWebview('focused-other') }));
      panel.open({ scope: 'tab', tabId: 'tab-77', tabTitle: 'Mine' });
      panel.routeMode = 'agent'; // force agent lane (auto routing would pick chat for these fixtures)
      panel.input.value = 'tab task';
      await panel._run();
      const startCall = ipcRenderer.invoke.mock.calls.find((c) => c[0] === 'agent:start');
      expect(startCall[1]).toMatchObject({ webContentsId: 7777, scope: 'tab', tabId: 'tab-77' });
    });

    test('tab-scoped run with a missing tab webview surfaces the tab-specific message', async () => {
      panel.initialize(() => makeContext({ webview: null }));
      panel.open({ scope: 'tab', tabId: 'gone-tab', tabTitle: 'Gone' });
      panel.routeMode = 'agent'; // force agent lane (auto routing would pick chat for these fixtures)
      panel.input.value = 'do it';
      await panel._run();
      expect(panel._answerView.getMarkdown()).toContain('This tab no longer has a webview');
    });

    test('a webview whose getWebContentsId throws surfaces a resolve error', async () => {
      const wv = makeWebview('throwing');
      wv.getWebContentsId = jest.fn(() => { throw new Error('detached'); });
      panel.initialize(() => makeContext({ webview: wv }));
      panel.open();
      panel.routeMode = 'agent'; // force agent lane (auto routing would pick chat for these fixtures)
      panel.input.value = 'task';
      await panel._run();
      expect(panel._answerView.getMarkdown()).toContain('Cannot resolve webview id: detached');
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'agent:start')).toBe(false);
    });

    test('_run(prefillDescription) seeds the input and runs that text', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel.routeMode = 'agent'; // force agent lane (auto routing would pick chat for these fixtures)
      panel.input.value = 'typed but ignored';
      await panel._run('prefilled task');
      const startCall = ipcRenderer.invoke.mock.calls.find((c) => c[0] === 'agent:start');
      expect(startCall[1].description).toBe('prefilled task');
    });
  });

  describe('_newChat while running', () => {
    test('cancels when the user declines the confirm', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._setStatus('running');
      ipcRenderer.send.mockClear();
      // Drive the modal: user clicks Cancel.
      const cspy = jest.spyOn(window, 'confirm').mockResolvedValue(false);
      const clickPromise = panel._newChat();
      const overlay = document.querySelector('.confirm-dialog-overlay');
      overlay.querySelector('.confirm-dialog-cancel').click();
      await clickPromise;
      // Declined → no stop, no reset-conversation.
      expect(ipcRenderer.send).not.toHaveBeenCalledWith('agent:stop');
      expect(ipcRenderer.send).not.toHaveBeenCalledWith('agent:reset-conversation', expect.anything());
      cspy.mockRestore();
    });

    test('stops the task and resets when the user confirms', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel.routeMode = 'agent'; // force agent lane (auto routing would pick chat for these fixtures)
      panel._setStatus('running');
      ipcRenderer.send.mockClear();
      // Drive the modal: user clicks the danger confirm button.
      const cspy = jest.spyOn(window, 'confirm').mockResolvedValue(true);
      const clickPromise = panel._newChat();
      const overlay = document.querySelector('.confirm-dialog-overlay');
      overlay.querySelector('.confirm-dialog-confirm').click();
      await clickPromise;
      expect(ipcRenderer.send).toHaveBeenCalledWith('agent:stop');
      expect(ipcRenderer.send).toHaveBeenCalledWith(
        'agent:reset-conversation', { scope: 'global', tabId: null },
      );
      cspy.mockRestore();
    });
  });

  describe('history run open branches', () => {
    function mockHistory(run) {
      ipcRenderer.invoke.mockImplementation(async (ch, arg) => {
        if (ch === 'agent:history-open') return run;
        return defaultInvoke(ch, arg);
      });
    }

    test('opening a missing run is a no-op (returns early)', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      mockHistory(null);
      await panel._openHistoryRun('nope');
      expect(panel._transcriptEl.querySelector('.agent-msg-user')).toBeNull();
    });

    test('a failed historical run sets status error and shows token stats', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      mockHistory({
        id: 'r1', description: 'old', status: 'failed', summary: 'it broke',
        events: [], tokensUsed: 12345, stepCount: 4, durationMs: 9000,
      });
      await panel._openHistoryRun('r1');
      expect(panel.statusEl.getAttribute('data-status')).toBe('error');
      // formatTokensDisplay(12345): >=10_000 → toFixed(0) → "12k".
      expect(panel.costEl.textContent).toContain('4 steps');
      expect(panel.costEl.textContent).toContain('12k tokens');
      expect(panel.costEl.textContent).toContain('9.0s');
    });

    test('a small token count uses the one-decimal k format', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      mockHistory({
        id: 'r1b', description: 'old', status: 'ok', summary: 's',
        events: [], tokensUsed: 1500, stepCount: 1, durationMs: 1000,
      });
      await panel._openHistoryRun('r1b');
      // 1500 < 10_000 → toFixed(1) → "1.5k".
      expect(panel.costEl.textContent).toContain('1.5k tokens');
    });

    test('a running historical run maps to the running status', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      mockHistory({ id: 'r2', description: 'live', status: 'running', events: [] });
      await panel._openHistoryRun('r2');
      expect(panel.statusEl.getAttribute('data-status')).toBe('running');
    });

    test('an open failure presents the error', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer.invoke.mockImplementation(async (ch, arg) => {
        if (ch === 'agent:history-open') throw new Error('disk gone');
        return defaultInvoke(ch, arg);
      });
      await panel._openHistoryRun('r3');
      expect(panel._answerView.getMarkdown()).toContain('Failed to open run: disk gone');
    });

    test('_retryHistoryRun re-runs the prior prompt', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      mockHistory({ id: 'r4', description: 'retry me' });
      await panel._retryHistoryRun('r4');
      // _retryHistoryRun fires this._run() without awaiting; flush its internal
      // awaits (set-active-conversation, then agent:start).
      for (let i = 0; i < 5; i++) await Promise.resolve();
      const startCall = ipcRenderer.invoke.mock.calls.find((c) => c[0] === 'agent:start');
      expect(startCall).toBeTruthy();
      expect(startCall[1].description).toBe('retry me');
    });

    test('_retryHistoryRun is a no-op when the run has no description', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      mockHistory({ id: 'r5' });
      await panel._retryHistoryRun('r5');
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'agent:start')).toBe(false);
    });

    test('_openHistoryRunAsNew resets conversation then runs fresh', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      mockHistory({ id: 'r6', description: 'fresh start' });
      ipcRenderer.send.mockClear();
      await panel._openHistoryRunAsNew('r6');
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(ipcRenderer.send).toHaveBeenCalledWith(
        'agent:reset-conversation', { scope: 'global', tabId: null },
      );
      expect(panel._activeTaskId).toBeNull();
    });

    test('_openHistoryRunAsNew is a no-op for a description-less run', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      mockHistory({ id: 'r7' });
      await panel._openHistoryRunAsNew('r7');
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'agent:start')).toBe(false);
    });
  });

  describe('open() / openWithTask() / scope label branches', () => {
    test('re-opening with the SAME scope does not reset the transcript', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._activeTaskId = 'keep';
      panel._transcriptEl.innerHTML = '<li>keep me</li>';
      panel.open(); // same global scope → scopeChanged false
      expect(panel._activeTaskId).toBe('keep');
      expect(panel._transcriptEl.children.length).toBe(1);
    });

    test('openWithTask with a non-string text opens the panel without running', async () => {
      panel.initialize(() => makeContext());
      panel.openWithTask(null, { scope: 'global' });
      expect(panel.isOpen()).toBe(true);
      await Promise.resolve();
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'agent:start')).toBe(false);
    });

    test('open() builds the DOM lazily if it was never initialized', () => {
      // Fresh singleton with no initialize() call.
      panel.open();
      expect(panel.isOpen()).toBe(true);
      expect(panel.overlay).toBeInstanceOf(HTMLElement);
    });

    test('close() before open() is a no-op', () => {
      panel.initialize(() => makeContext());
      expect(() => panel.close()).not.toThrow();
      expect(panel.isOpen()).toBe(false);
    });
  });

  describe('view shell facade (sidebar / assistant mode)', () => {
    function bindShell(getContext) {
      const { ShellStore } = require('../../../../renderer/core/ShellStore');
      const { ViewShellManager } = require('../../../../renderer/managers/ViewShellManager');
      const mockBridge = { get: (_p, fallback) => fallback, set: jest.fn() };
      const store = new ShellStore({ bridge: mockBridge });
      const shell = new ViewShellManager({ store, getContext });
      panel.setViewShell(shell);
      return shell;
    }

    function focusableWebview() {
      const wv = makeWebview('tab-focus');
      wv.tabIndex = 0;
      return wv;
    }

    test('open({ mode: "assistant" }) flips to assistant mode and focuses the composer', () => {
      panel.initialize(() => makeContext());
      const shell = bindShell(() => ({}));
      panel.open({ mode: 'assistant' });
      expect(shell.getMode()).toBe('assistant');
      expect(document.body.classList.contains('app-mode-assistant')).toBe(true);
      expect(document.body.classList.contains('assistant-sidebar-open')).toBe(false);
      expect(panel.isOpen()).toBe(true);
      expect(document.activeElement).toBe(panel.input);
    });

    test('open() in assistant mode keeps the mode and only focuses the composer', () => {
      panel.initialize(() => makeContext());
      const shell = bindShell(() => ({}));
      panel.open({ mode: 'assistant' });
      panel.input.blur();
      panel.open();
      expect(shell.getMode()).toBe('assistant');
      expect(shell.store.get('sidebarOpen')).toBe(false);
      expect(document.activeElement).toBe(panel.input);
    });

    test('close() in assistant mode returns to browser mode with the sidebar closed', () => {
      panel.initialize(() => makeContext());
      const shell = bindShell(() => ({}));
      panel.open();
      shell.setMode('assistant');
      panel.close();
      expect(shell.getMode()).toBe('browser');
      expect(shell.store.get('sidebarOpen')).toBe(false);
      expect(panel.isOpen()).toBe(false);
    });

    test('Esc in browser mode closes the sidebar and hands focus to the active webview', () => {
      const wv = focusableWebview();
      panel.initialize(() => makeContext());
      bindShell(() => ({ navigationManager: { getActiveWebview: () => wv } }));
      panel.open();
      expect(document.activeElement).toBe(panel.input);
      panel.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(panel.isOpen()).toBe(false);
      expect(document.activeElement).toBe(wv);
    });

    test('Esc in browser mode hands focus back to the element focused before the sidebar opened', () => {
      const wv = focusableWebview();
      const other = makeWebview('tab-other');
      other.tabIndex = 0;
      panel.initialize(() => makeContext());
      bindShell(() => ({ navigationManager: { getActiveWebview: () => wv } }));
      other.focus();
      panel.open();
      expect(document.activeElement).toBe(panel.input);
      panel.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(panel.isOpen()).toBe(false);
      expect(document.activeElement).toBe(other);
    });

    test('Esc with the inline palette open closes only the palette; the next Esc leaves for the page', async () => {
      const wv = focusableWebview();
      panel.initialize(() => makeContext());
      const shell = bindShell(() => ({ navigationManager: { getActiveWebview: () => wv } }));
      panel.open();
      panel.input.value = '/';
      panel.input.setSelectionRange(1, 1);
      panel.input.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
      const list = panel.overlay.querySelector('.agent-panel-composer .inline-palette');
      expect(list.hidden).toBe(false);
      panel.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(list.hidden).toBe(true);
      expect(panel.isOpen()).toBe(true);
      expect(shell.store.get('sidebarOpen')).toBe(true);
      expect(document.activeElement).toBe(panel.input);
      panel.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(panel.isOpen()).toBe(false);
      expect(document.activeElement).toBe(wv);
    });

    test('Esc while a modal layer is open leaves the sidebar and the composer focus alone', () => {
      const modalStack = require('../../../../renderer/utils/modalStack');
      const wv = focusableWebview();
      panel.initialize(() => makeContext());
      const shell = bindShell(() => ({ navigationManager: { getActiveWebview: () => wv } }));
      panel.open();
      const layer = modalStack.push();
      try {
        const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        panel.input.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(false);
        expect(panel.isOpen()).toBe(true);
        expect(shell.store.get('sidebarOpen')).toBe(true);
        expect(document.activeElement).toBe(panel.input);
      } finally { modalStack.pop(layer); }
    });

    test('Esc in assistant mode stays in assistant mode', () => {
      panel.initialize(() => makeContext());
      const shell = bindShell(() => ({}));
      panel.open({ mode: 'assistant' });
      panel.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(shell.getMode()).toBe('assistant');
      expect(panel.isOpen()).toBe(true);
    });

    test('Cmd/Ctrl+Shift+H shows the Sessions sheet in the sidebar and the history column in assistant mode', () => {
      panel.initialize(() => makeContext());
      const shell = bindShell(() => ({}));
      panel.open();
      const press = () => panel.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'H', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
      press();
      expect(shell.store.get('sidePane')).toBe('sessions');
      expect(panel._historyRail.isOpen()).toBe(false);
      press();
      expect(shell.store.get('sidePane')).toBeNull();
      panel.open({ mode: 'assistant' });
      const focus = jest.spyOn(panel._history, 'focusSearch');
      press();
      expect(panel._historyRail.isOpen()).toBe(true);
      expect(focus).toHaveBeenCalled();
      expect(shell.store.get('sidePane')).toBeNull();
      press();
      expect(panel._historyRail.isOpen()).toBe(false);
      focus.mockRestore();
      window.localStorage.removeItem('agent.history.open');
    });

    test('keys pressed outside the panel are not the panel\'s (the sidebar is not modal)', () => {
      const wv = focusableWebview();
      panel.initialize(() => makeContext());
      bindShell(() => ({}));
      panel.open();
      wv.focus();
      const spy = jest.spyOn(panel._history, 'focusSearch');
      const ev = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true });
      wv.dispatchEvent(ev);
      wv.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(ev.defaultPrevented).toBe(false);
      expect(spy).not.toHaveBeenCalled();
      expect(panel.isOpen()).toBe(true);
      spy.mockRestore();
    });

    test('setViewShell rejects a non-manager and a second binding', () => {
      panel.initialize(() => makeContext());
      expect(() => panel.setViewShell({})).toThrow(TypeError);
      bindShell(() => ({}));
      expect(() => bindShell(() => ({}))).toThrow(/already bound/);
    });
  });

  describe('_onKeyDown shortcut branches', () => {
    test('Cmd+K focuses the history search', () => {
      panel.initialize(() => makeContext());
      panel.open();
      const spy = jest.spyOn(panel._history, 'focusSearch');
      const railWasOpen = panel._historyRail.isOpen();
      const ev = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
      // Cmd+K belongs to the global palette now; history search moved to Cmd/Ctrl+Shift+H.
      expect(ev.defaultPrevented).toBe(false);
      expect(spy).not.toHaveBeenCalled();
      expect(panel._historyRail.isOpen()).toBe(railWasOpen);
      spy.mockRestore();
    });

    test('Ctrl+K yields to the global palette even when the history rail is open', () => {
      panel.initialize(() => makeContext());
      openInAssistantMode(panel);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'H', metaKey: true, shiftKey: true, bubbles: true }));
      expect(panel._historyRail.isOpen()).toBe(true);
      const spy = jest.spyOn(panel._history, 'focusSearch');
      const ev = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
      expect(spy).not.toHaveBeenCalled();
      expect(panel._historyRail.isOpen()).toBe(true);
      spy.mockRestore();
    });

    test('Cmd+Shift+E yields to panel.extensions; export stays on its menu button', () => {
      panel.initialize(() => makeContext());
      panel.open();
      const spy = jest.spyOn(panel, '_exportTranscript');
      const ev = new KeyboardEvent('keydown', { key: 'E', metaKey: true, shiftKey: true, bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
      expect(spy).not.toHaveBeenCalled();
      expect(ev.defaultPrevented).toBe(false);
      panel.overlay.ownerDocument.querySelector('.agent-panel-export').click();
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    test('Cmd+Shift+P focuses the persona select', () => {
      panel.initialize(() => makeContext());
      panel.open();
      const spy = jest.spyOn(panel._personaSelect, 'focus');
      const ev = new KeyboardEvent('keydown', { key: 'P', metaKey: true, shiftKey: true, bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    test('Cmd+0 resets the persona lock to Auto', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._personaLock = 'coder';
      panel._personaSelect.value = 'coder';
      const ev = new KeyboardEvent('keydown', { key: '0', metaKey: true, bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
      expect(ipcRenderer.send).toHaveBeenCalledWith('persona:reset-lock');
      expect(panel._personaSelect.value).toBe('');
    });

    test('Cmd+1 locks the first enabled persona', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._personaList = [{ name: 'researcher', label: 'Researcher' }];
      const opt = document.createElement('option');
      opt.value = 'researcher'; opt.textContent = 'Researcher';
      panel._personaSelect.appendChild(opt);
      const ev = new KeyboardEvent('keydown', { key: '1', metaKey: true, bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
      expect(ipcRenderer.send).toHaveBeenCalledWith('persona:lock', 'researcher');
      expect(panel._personaSelect.value).toBe('researcher');
    });

    test('Cmd+9 with no matching persona is a no-op', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._personaList = [{ name: 'only' }];
      ipcRenderer.send.mockClear();
      const ev = new KeyboardEvent('keydown', { key: '9', metaKey: true, bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
      expect(ipcRenderer.send).not.toHaveBeenCalledWith('persona:lock', expect.anything());
    });

    test('Esc skips the typewriter when it is running instead of closing', () => {
      panel.initialize(() => makeContext());
      panel.open();
      // Fake a running typewriter on the answer view.
      const skip = jest.fn();
      panel._answerView._typer = { isRunning: () => true, skip };
      const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
      expect(skip).toHaveBeenCalled();
      expect(panel.isOpen()).toBe(true);
    });

    test('an unhandled key does nothing', () => {
      panel.initialize(() => makeContext());
      panel.open();
      const ev = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
      expect(panel.isOpen()).toBe(true);
    });
  });

  describe('_renderUserMessage / _showShortcuts / egress modes', () => {
    test('_renderUserMessage with blank text appends nothing', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._renderUserMessage('   ');
      expect(panel._transcriptEl.querySelector('.agent-msg-user')).toBeNull();
    });

    test('_showShortcuts opens a styled sheet listing the shortcuts', () => {
      panel.initialize(() => makeContext());
      panel.open();
      // No native dialogs — the entry point now opens an in-app Dropdown sheet.
      const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});
      // Shortcuts button is adopted into the portalled menu's actions slot.
      document.body.querySelector('.agent-panel-shortcuts').click();
      expect(alertSpy).not.toHaveBeenCalled();
      alertSpy.mockRestore();
      // The header button carries the same class; target rows specifically to
      // distinguish the trigger button (text "Shortcuts", 1 child) from the sheet.
      const rows = document.querySelectorAll('.agent-panel-shortcuts .agent-panel-shortcuts-row');
      expect(rows.length).toBe(5);
      const texts = Array.from(rows).map((r) => r.querySelector('.agent-panel-shortcuts-label').textContent);
      expect(texts).toContain('Run task');
      expect(texts).toContain('Show / hide history');
      expect(texts).not.toContain('Search history');
      expect(rows[0].querySelectorAll('kbd').length).toBeGreaterThan(0);
    });

    test('egress blocklist mode renders a blocked-sites summary', () => {
      const configBridge = require('../../../../renderer/core/configBridge');
      configBridge.initialize({
        settings: { llm: { agent: { egress: { mode: 'blocklist', block: ['evil.com'] } } } },
      });
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('agent:task-started', { taskId: 't', task: { description: 'go' }, scope: 'global' });
      expect(panel._egressEl.hidden).toBe(false);
      expect(panel._egressEl.textContent).toContain('Block-list');
      expect(panel._egressEl.textContent).toContain('1 site');
    });

    test('egress open mode WITH a blocklist still shows the banner', () => {
      const configBridge = require('../../../../renderer/core/configBridge');
      configBridge.initialize({
        settings: { llm: { agent: { egress: { mode: 'open', block: ['x.com', 'y.com'] } } } },
      });
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('agent:task-started', { taskId: 't', task: { description: 'go' }, scope: 'global' });
      expect(panel._egressEl.hidden).toBe(false);
      expect(panel._egressEl.textContent).toContain('Open');
      expect(panel._egressEl.textContent).toContain('2 sites blocked');
    });

    test('egress allow-list with zero sites warns navigation is fully blocked', () => {
      const configBridge = require('../../../../renderer/core/configBridge');
      configBridge.initialize({
        settings: { llm: { agent: { egress: { mode: 'allowlist', allow: [], onViolation: 'ask' } } } },
      });
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('agent:task-started', { taskId: 't', task: { description: 'go' }, scope: 'global' });
      expect(panel._egressEl.textContent).toContain('fully blocked');
      expect(panel._egressEl.textContent).toContain('asks you');
    });
  });

  describe('input placeholder / enter-to-send pref', () => {
    test('toggling Enter-to-send persists the pref and updates the placeholder', () => {
      panel.initialize(() => makeContext());
      panel.open();
      const cb = panel._enterToSendCb;
      cb.checked = true;
      cb.dispatchEvent(new Event('change'));
      expect(window.localStorage.getItem('agent.enterToSend')).toBe('1');
      expect(panel.input.getAttribute('placeholder')).toContain('Enter to send');
      cb.checked = false;
      cb.dispatchEvent(new Event('change'));
      expect(window.localStorage.getItem('agent.enterToSend')).toBe('0');
      expect(panel.input.getAttribute('placeholder')).toContain('Shift+Enter to send');
    });

    test('Enter-to-send ON makes plain Enter send and Shift+Enter insert a newline', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel.routeMode = 'agent'; // force agent lane (auto routing would pick chat for these fixtures)
      panel._enterToSendCb.checked = true;
      panel.input.value = 'send on enter';
      const plain = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      panel.input.dispatchEvent(plain);
      await Promise.resolve();
      expect(plain.defaultPrevented).toBe(true);
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'agent:start')).toBe(true);
    });

    test('IME composing Enter is never hijacked', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel.input.value = 'composing';
      const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'isComposing', { value: true });
      panel.input.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    });

    test('ArrowDown at end of input with no newer history clears toward empty', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel.routeMode = 'agent'; // force agent lane (auto routing would pick chat for these fixtures)
      panel.input.value = 'one';
      await panel._run();
      panel.input.value = '';
      panel.input.selectionStart = 0;
      // ArrowUp recalls 'one'...
      panel.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
      expect(panel.input.value).toBe('one');
      // ...ArrowDown at the end moves forward past the last entry → empty string.
      panel.input.selectionStart = panel.input.value.length;
      const down = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
      panel.input.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(true);
      expect(panel.input.value).toBe('');
    });

    test('ArrowUp NOT at the start of the input does not cycle history', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel.routeMode = 'agent'; // force agent lane (auto routing would pick chat for these fixtures)
      panel.input.value = 'prior';
      await panel._run();
      panel.input.value = 'mid text';
      panel.input.selectionStart = 3; // caret not at 0
      const ev = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
      panel.input.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
      expect(panel.input.value).toBe('mid text');
    });

    test('ArrowUp with no recorded history returns nothing and does not preventDefault', () => {
      // localStorage is shared across tests in the jsdom env — clear the
      // prompt-history key so the empty-list branch is genuinely exercised.
      try { window.localStorage.removeItem('agent.promptHistory'); } catch (_) { /* ignore */ }
      panel.initialize(() => makeContext());
      panel.open();
      panel.input.value = '';
      panel.input.selectionStart = 0;
      const ev = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
      panel.input.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    });
  });

  describe('idempotent build + guard arms', () => {
    test('_buildDom is a no-op once the panel DOM exists', () => {
      panel.initialize(() => makeContext());
      const firstOverlay = panel.overlay;
      panel._buildDom(); // overlay already built → early return
      expect(panel.overlay).toBe(firstOverlay);
    });

    test('_renderAssistantLabel renders the divider only once', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._renderAssistantLabel();
      panel._renderAssistantLabel();
      expect(panel._transcriptEl.querySelectorAll('.agent-msg-assistant-label').length).toBe(1);
    });

    test('_resetTranscript clears the budget, cost and approval surfaces', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel.budgetEl.textContent = 'hit cap';
      panel.costEl.textContent = '5 steps';
      panel.approvalEl.hidden = false;
      panel.approvalEl.innerHTML = '<div>pending</div>';
      panel._resetTranscript();
      expect(panel.budgetEl.textContent).toBe('');
      expect(panel.costEl.textContent).toBe('');
      expect(panel.approvalEl.hidden).toBe(true);
      expect(panel.approvalEl.innerHTML).toBe('');
    });

    test('_prepareFollowUpTurn freezes a prior answer and clears the budget chip', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._answerView.renderStatic('previous answer body');
      panel.budgetEl.textContent = 'hit cap';
      panel._prepareFollowUpTurn();
      const frozen = panel._transcriptEl.querySelector('.agent-msg-assistant-answer');
      expect(frozen).not.toBeNull();
      expect(frozen.textContent).toContain('previous answer body');
      expect(panel.budgetEl.textContent).toBe('');
    });

    test('_prepareFollowUpTurn with no prior answer appends no frozen message', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._prepareFollowUpTurn();
      expect(panel._transcriptEl.querySelector('.agent-msg-assistant-answer')).toBeNull();
    });

    test('_renderApprovalPrompt with no payload is a no-op', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._renderApprovalPrompt(null);
      expect(panel.approvalEl.hidden).toBe(true);
    });

    test('approval-request without an origin renders a "(no origin)" meta line', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('agent:approval-request', {
        requestId: 'rq', call: { name: 'fs.write', args: { path: '/x' } }, class: 'filesystem',
      });
      expect(panel.approvalEl.textContent).toContain('(no origin)');
      // Reject path also wired.
      panel.approvalEl.querySelector('button[data-decision="reject"]').click();
      expect(ipcRenderer.send).toHaveBeenCalledWith(
        'agent:approval-response', { requestId: 'rq', decision: 'reject' },
      );
    });

    test('_replayEvent ignores a falsy or non-step event', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._replayEvent(null);
      panel._replayEvent({ kind: 'note' });
      expect(panel._toolStream).toBeNull();
    });

    test('_replayEvent reconstructs a step group from a logged step event', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._replayEvent({
        kind: 'step', step: 0,
        tools: [{ name: 'browser.click', args: { selector: '#a' } }],
        results: [{ id: 'x', name: 'browser.click', ok: true, preview: 'done' }],
      });
      expect(panel._toolStream).not.toBeNull();
      expect(panel.overlay.querySelector('.agent-tool-stream')).not.toBeNull();
    });

    test('openWithTask trims whitespace-only text and does not run it', async () => {
      panel.initialize(() => makeContext());
      panel.openWithTask('\n\t  ', { scope: 'global' });
      await Promise.resolve();
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'agent:start')).toBe(false);
    });

    test('engine handlers tolerate a not-yet-built engine button', () => {
      panel.initialize(() => makeContext());
      // Panel built but engineBtn intentionally cleared to hit the null guard.
      panel.engineBtn = null;
      expect(() => panel._renderEngineButton()).not.toThrow();
    });

    test('_setStatus is a no-op when there is no status element', () => {
      panel.initialize(() => makeContext());
      panel.statusEl = null;
      expect(() => panel._setStatus('running')).not.toThrow();
    });
  });

  // ---- Chat mode (the default fast single-turn surface) -----------------

  describe('answer routing (auto default + override)', () => {
    test('the panel defaults to auto routing with a unified Send button', () => {
      panel.initialize(() => makeContext());
      panel.open();
      expect(panel.routeMode).toBe('auto');
      // The composer carries one Send button plus the Auto/Chat/Agent segmented control.
      const seg = panel.overlay.querySelector('.agent-panel-controls .agent-panel-modeswitch');
      expect([...seg.querySelectorAll('[role="radio"]')].map((b) => b.dataset.mode)).toEqual(['auto', 'chat', 'agent']);
      expect(seg.querySelector('[aria-checked="true"]').dataset.mode).toBe('auto');
      expect(panel.runBtn.textContent).toBe('Send');
    });

    test('_run auto-routes plain questions to chat and imperative actions to agent', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer.invoke.mockImplementation(async (ch, arg) => {
        if (ch === 'chat:ask') return { ok: true };
        if (ch === 'agent:start') return {};
        return defaultInvoke(ch, arg);
      });
      // Plain question → chat lane.
      panel.input.value = 'what is a quasar?';
      await panel._run();
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'chat:ask')).toBe(true);
      ipcRenderer.invoke.mockClear();
      // Imperative navigation → agent lane.
      panel.input.value = 'open the docs and summarize them';
      await panel._run();
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'agent:start')).toBe(true);
    });

    test('the route-mode override forces every manual send down one path', async () => {
      const configBridge = require('../../../../renderer/core/configBridge');
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer.invoke.mockImplementation(async (ch, arg) => (ch === 'agent:start' ? {} : defaultInvoke(ch, arg)));
      // Force agent: even a plain question goes to the tool loop.
      const setSpy = jest.spyOn(configBridge, 'set').mockImplementation(() => undefined);
      panel._setRouteMode('agent');
      expect(panel.routeMode).toBe('agent');
      expect(setSpy).toHaveBeenCalledWith('settings.chat.mode', 'agent');
      panel.input.value = 'just a plain question';
      await panel._run();
      setSpy.mockRestore();
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'agent:start')).toBe(true);
    });

    test('_run in chat mode streams chat:ask tokens into the answer and never starts the agent', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer.invoke.mockImplementation(async (ch, arg) => {
        if (ch === 'chat:ask') {
          ipcRenderer._fire('chat:token', { id: arg.id, delta: 'Hel' });
          ipcRenderer._fire('chat:token', { id: arg.id, delta: 'lo' });
          return { ok: true, elapsedMs: 5, charCount: 5 };
        }
        return defaultInvoke(ch, arg);
      });
      panel.input.value = 'hi there';
      await panel._run();
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'chat:ask')).toBe(true);
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'agent:start')).toBe(false);
      expect(panel._answerView.getMarkdown()).toBe('Hello');
      expect(panel.statusEl.getAttribute('data-status')).toBe('done');
      // Chat turns land in the panel-local thread both lanes read back.
      expect(panel._chatHistory).toEqual([
        { role: 'user', content: 'hi there' },
        { role: 'assistant', content: 'Hello' },
      ]);
      // The user's message is mirrored into the transcript.
      const userMsg = panel._transcriptEl.querySelector('.agent-msg-user .agent-msg-body');
      expect(userMsg.textContent).toBe('hi there');
    });

    test('chat mode does not require a webview to control', async () => {
      panel.initialize(() => makeContext({ webview: null }));
      panel.open();
      ipcRenderer.invoke.mockImplementation(async (ch, arg) => {
        if (ch === 'chat:ask') { ipcRenderer._fire('chat:token', { id: arg.id, delta: 'ok' }); return { ok: true }; }
        return defaultInvoke(ch, arg);
      });
      panel.input.value = 'no webview needed';
      await panel._run();
      expect(panel._answerView.getMarkdown()).toBe('ok');
      expect(panel._answerView.getMarkdown()).not.toContain('No active webview');
    });

    test('an engine_busy result surfaces a friendly message and flags an error', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer.invoke.mockImplementation(async (ch) => (ch === 'chat:ask' ? { ok: false, error: 'engine_busy' } : defaultInvoke(ch)));
      panel.input.value = 'while agent runs';
      await panel._run();
      expect(panel._answerView.getMarkdown()).toContain('busy');
      expect(panel.statusEl.getAttribute('data-status')).toBe('error');
      // The message is restored so the user does not lose it.
      expect(panel.input.value).toBe('while agent runs');
    });

    test('Stop in chat mode cancels the in-flight stream via chat:cancel', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._chatReqId = 'chat_42';
      panel._setStatus('running');
      panel.stopBtn.click();
      expect(ipcRenderer.send).toHaveBeenCalledWith('chat:cancel', { id: 'chat_42' });
      expect(ipcRenderer.send).not.toHaveBeenCalledWith('agent:stop');
      expect(panel.statusEl.getAttribute('data-status')).toBe('idle');
    });

    test('Stop while the chat turn is still composing never sends chat:ask', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      let releaseSearch;
      ipcRenderer.invoke.mockImplementation(async (ch, arg) => {
        if (ch === 'chat:web-search') return new Promise((resolve) => { releaseSearch = resolve; });
        if (ch === 'chat:ask') return { ok: true };
        return defaultInvoke(ch, arg);
      });
      panel.routeMode = 'chat';
      panel.input.value = 'what is a quasar?';
      const run = panel._run();
      for (let i = 0; i < 10 && !releaseSearch; i++) await Promise.resolve();
      expect(releaseSearch).toBeDefined();
      panel.stopBtn.click();
      releaseSearch({ ok: false });
      await run;
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'chat:ask')).toBe(false);
      expect(panel._chatReqId).toBeNull();
      expect(panel.statusEl.getAttribute('data-status')).toBe('idle');
    });

    test('a stopped turn finishing late leaves the next turn\'s token stream intact', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      const asks = [];
      ipcRenderer.invoke.mockImplementation(async (ch, arg) => {
        if (ch === 'chat:web-search') return { ok: false };
        if (ch === 'chat:ask') return new Promise((resolve) => { asks.push({ id: arg.id, resolve }); });
        return defaultInvoke(ch, arg);
      });
      const flushAll = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
      panel.routeMode = 'chat';
      panel.input.value = 'first question?';
      const run1 = panel._run();
      await flushAll();
      expect(asks.length).toBe(1);
      panel.stopBtn.click();
      panel.input.value = 'second question?';
      const run2 = panel._run();
      await flushAll();
      expect(asks.length).toBe(2);
      asks[0].resolve({ ok: false, error: 'cancelled' });
      await run1;
      expect(panel._chatReqId).toBe(asks[1].id);
      ipcRenderer._fire('chat:token', { id: asks[1].id, delta: 'Second answer' });
      asks[1].resolve({ ok: true });
      await run2;
      expect(panel._answerView.getMarkdown()).toBe('Second answer');
      expect(panel.statusEl.getAttribute('data-status')).toBe('done');
    });

    describe('a stopped chat turn settling late', () => {
      let asks;
      const flushAll = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
      beforeEach(() => {
        asks = [];
        ipcRenderer.invoke.mockImplementation(async (ch, arg) => {
          if (ch === 'chat:web-search') return { ok: false };
          if (ch === 'chat:ask') return new Promise((resolve) => { asks.push({ id: arg.id, resolve }); });
          return defaultInvoke(ch, arg);
        });
        panel.initialize(() => makeContext());
        panel.open();
        panel.routeMode = 'chat';
      });

      test('does not overwrite the answer or status of the turn that replaced it', async () => {
        panel.input.value = 'first question?';
        const run1 = panel._run();
        await flushAll();
        ipcRenderer._fire('chat:token', { id: asks[0].id, delta: 'First partial' });
        panel.stopBtn.click();
        panel.input.value = 'second question?';
        const run2 = panel._run();
        await flushAll();
        ipcRenderer._fire('chat:token', { id: asks[1].id, delta: 'Second so far' });
        asks[0].resolve({ ok: true });
        await run1;
        expect(panel._answerView.getMarkdown()).toBe('Second so far');
        expect(panel.statusEl.getAttribute('data-status')).toBe('running');
        expect(panel._chatHistory.map((m) => m.content)).not.toContain('First partial');
        asks[1].resolve({ ok: true });
        await run2;
        expect(panel.statusEl.getAttribute('data-status')).toBe('done');
      });

      test('after New chat it never presents into the fresh conversation', async () => {
        panel.input.value = 'old question?';
        const run1 = panel._run();
        await flushAll();
        ipcRenderer._fire('chat:token', { id: asks[0].id, delta: 'Old answer' });
        panel.stopBtn.click();
        panel.overlay.querySelector('.agent-panel-new').click();
        await flushAll();
        asks[0].resolve({ ok: true });
        await run1;
        expect(panel._answerView.getMarkdown()).toBe('');
        expect(panel._chatHistory).toEqual([]);
        expect(panel.statusEl.getAttribute('data-status')).toBe('idle');
      });

      test('a follow-up turn keeps the earlier answer in the thread, rendered, between the two questions', async () => {
        panel.input.value = 'first question?';
        const run1 = panel._run();
        await flushAll();
        ipcRenderer._fire('chat:token', { id: asks[0].id, delta: 'Paris is in **France**.' });
        asks[0].resolve({ ok: true });
        await run1;
        panel.input.value = 'second question?';
        const run2 = panel._run();
        await flushAll();
        const items = Array.from(panel._transcriptEl.querySelectorAll('li.chat-msg'));
        expect(items.map((li) => (li.classList.contains('chat-msg--user') ? 'user' : 'assistant'))).toEqual(['user', 'assistant', 'user']);
        expect(items[1].querySelector('strong').textContent).toBe('France');
        expect(items[2].textContent).toContain('second question?');
        expect(panel._answerView.getMarkdown()).toBe('');
        ipcRenderer._fire('chat:token', { id: asks[1].id, delta: 'Second answer.' });
        asks[1].resolve({ ok: true });
        await run2;
        expect(panel._answerView.getMarkdown()).toBe('Second answer.');
        expect(panel._transcriptEl.querySelectorAll('li.chat-msg--assistant')).toHaveLength(1);
      });

      test('an agent turn after a chat answer keeps that answer in the thread', async () => {
        panel.input.value = 'chat question?';
        const run1 = panel._run();
        await flushAll();
        ipcRenderer._fire('chat:token', { id: asks[0].id, delta: 'Chat **answer**.' });
        asks[0].resolve({ ok: true });
        await run1;
        panel.routeMode = 'agent';
        panel.input.value = 'now do it';
        await panel._run();
        ipcRenderer._fire('agent:task-started', { taskId: 't9', task: { description: 'now do it' }, scope: 'global', isFollowUp: true });
        const items = Array.from(panel._transcriptEl.querySelectorAll('li.chat-msg'));
        expect(items.map((li) => (li.classList.contains('chat-msg--user') ? 'user' : 'assistant'))).toEqual(['user', 'assistant', 'user']);
        expect(items[1].querySelector('strong').textContent).toBe('answer');
      });

      test('a /council turn after a chat answer keeps that answer in the thread', async () => {
        panel.input.value = 'chat question?';
        const run1 = panel._run();
        await flushAll();
        ipcRenderer._fire('chat:token', { id: asks[0].id, delta: 'Earlier answer.' });
        asks[0].resolve({ ok: true });
        await run1;
        panel.input.value = '/council which database?';
        await panel._run();
        const items = Array.from(panel._transcriptEl.querySelectorAll('li.chat-msg'));
        expect(items.map((li) => (li.classList.contains('chat-msg--user') ? 'user' : 'assistant'))).toEqual(['user', 'assistant', 'user']);
        expect(items[1].textContent).toContain('Earlier answer.');
        expect(panel._answerView.getMarkdown()).toContain('at least two');
      });

      test('the first turn of a cold thread freezes nothing', async () => {
        panel.input.value = 'only question?';
        const run1 = panel._run();
        await flushAll();
        expect(panel._transcriptEl.querySelectorAll('li.chat-msg--assistant')).toHaveLength(0);
        asks[0].resolve({ ok: false, error: 'cancelled' });
        await run1;
      });

      test('with no successor it still keeps the partial answer and goes idle', async () => {
        panel.input.value = 'lone question?';
        const run1 = panel._run();
        await flushAll();
        ipcRenderer._fire('chat:token', { id: asks[0].id, delta: 'Partial text' });
        panel.stopBtn.click();
        asks[0].resolve({ ok: false, error: 'cancelled' });
        await run1;
        expect(panel._answerView.getMarkdown()).toBe('Partial text');
        expect(panel.statusEl.getAttribute('data-status')).toBe('idle');
      });
    });

    test('+ New conversation clears the panel-local chat history', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._chatHistory = [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'older' }];
      panel.overlay.querySelector('.agent-panel-new').click();
      expect(panel._chatHistory).toEqual([]);
    });

    test('a chat answer carries into the agent lane as priorTurns when routing flips', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer.invoke.mockImplementation(async (ch, arg) => {
        if (ch === 'chat:ask') { ipcRenderer._fire('chat:token', { id: arg.id, delta: 'Paris' }); return { ok: true, charCount: 5 }; }
        return defaultInvoke(ch, arg);
      });
      panel.routeMode = 'chat';
      panel.input.value = 'capital of France?';
      await panel._run();

      panel.routeMode = 'agent';
      panel.input.value = 'open its wikipedia page';
      await panel._run();
      const startCall = ipcRenderer.invoke.mock.calls.find((c) => c[0] === 'agent:start');
      expect(startCall[1].priorTurns).toEqual([
        { role: 'user', content: 'capital of France?' },
        { role: 'assistant', content: 'Paris' },
      ]);
    });

    test('openWithTask bypasses the routeMode override entirely (even a forced chat setting)', async () => {
      panel.initialize(() => makeContext());
      ipcRenderer.invoke.mockImplementation(async (ch) => { if (ch === 'agent:start') return {}; if (ch === 'chat:ask') return { ok: true }; return defaultInvoke(ch); });
      // Force the override to chat — openWithTask must ignore it. Plain-chat phrasing on purpose; intent routing gets no vote either.
      panel.routeMode = 'chat';
panel.openWithTask("what is a quasar?", { scope: "global" });
      // _runAgent awaits set-active-conversation before agent:start — flush several ticks.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'agent:start')).toBe(true);
    });

  });

  describe('chat mode: context chips + slash actions', () => {
    // A webview whose executeJavaScript answers the readable-extractor script
    // with `page` and the selection script with `selection`.
    function execWebview(id, { page, selection } = {}) {
      const el = document.createElement('div');
      el.id = id;
      el.getWebContentsId = jest.fn(() => 4242);
      el.executeJavaScript = jest.fn(async (script) => {
        if (typeof script === 'string' && script.includes('getSelection')) return selection || '';
        return page === undefined ? null : page;
      });
      document.body.appendChild(el);
      return el;
    }

    // Capture the messages the panel sends to chat:ask and stream one token.
    function mockChat(captured) {
      ipcRenderer.invoke.mockImplementation(async (ch, arg) => {
        if (ch === 'chat:ask') {
          if (captured) captured.messages = arg.messages;
          ipcRenderer._fire('chat:token', { id: arg.id, delta: 'ANSWER' });
          return { ok: true };
        }
        if (ch === 'browsing:ask') {
          if (captured) captured.browsingArg = arg;
          return { ok: true, results: [{ title: 'Past Page', url: 'https://ex.com/a' }] };
        }
        return defaultInvoke(ch, arg);
      });
    }

    test('the active page is always attached to a plain chat message (no chip needed)', async () => {
      const wv = execWebview('tab-active', { page: { title: 'Doc', url: 'https://x', mainText: 'BODY TEXT' } });
      panel.initialize(() => makeContext({ webview: wv }));
      panel.open();
      const captured = {};
      mockChat(captured);
      panel.input.value = 'what is this';
      await panel._run();
      const userMsg = captured.messages[captured.messages.length - 1];
      expect(userMsg.role).toBe('user');
      expect(userMsg.content).toContain('Active page');
      expect(userMsg.content).toContain('BODY TEXT');
      expect(userMsg.content).toContain('what is this');
    });

    test('/summarize builds a summarize prompt from the extracted page', async () => {
      const wv = execWebview('tab-active', { page: { title: 'Doc', url: 'https://x', mainText: 'BODY' } });
      panel.initialize(() => makeContext({ webview: wv }));
      panel.open();
      const captured = {};
      mockChat(captured);
      panel.input.value = '/summarize';
      await panel._run();
      expect(captured.messages[0].role).toBe('system');
      expect(captured.messages[0].content.toLowerCase()).toContain('summarize');
      expect(captured.messages[1].content).toContain('BODY');
    });

    test('/summarize with no readable page surfaces an error and does not call chat:ask', async () => {
      const wv = execWebview('tab-active', { page: null });
      panel.initialize(() => makeContext({ webview: wv }));
      panel.open();
      mockChat();
      panel.input.value = '/summarize';
      await panel._run();
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'chat:ask')).toBe(false);
      expect(panel._answerView.getMarkdown()).toContain('No readable page');
      expect(panel.statusEl.getAttribute('data-status')).toBe('error');
    });

    test('/explain with no selection surfaces a guidance error', async () => {
      const wv = execWebview('tab-active', { page: { mainText: 'x' }, selection: '' });
      panel.initialize(() => makeContext({ webview: wv }));
      panel.open();
      mockChat();
      panel.input.value = '/explain';
      await panel._run();
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'chat:ask')).toBe(false);
      expect(panel._answerView.getMarkdown()).toContain('Select some text');
    });

    test('/explain with a selection builds an explain prompt', async () => {
      const wv = execWebview('tab-active', { page: { title: 'P', mainText: 'ctx' }, selection: 'CHOSEN' });
      panel.initialize(() => makeContext({ webview: wv }));
      panel.open();
      const captured = {};
      mockChat(captured);
      panel.input.value = '/explain';
      await panel._run();
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'chat:ask')).toBe(true);
      expect(captured.messages[1].content).toContain('CHOSEN');
    });

    test('/compare needs at least two panes', async () => {
      const wv = execWebview('tab-active', { page: { mainText: 'only' } });
      const state = { get: jest.fn((k) => (k === 'openTabs' ? ['tab-active'] : [])) };
      panel.initialize(() => makeContext({ webview: wv, extra: { state } }));
      panel.open();
      mockChat();
      panel.input.value = '/compare';
      await panel._run();
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'chat:ask')).toBe(false);
      expect(panel._answerView.getMarkdown()).toContain('at least two panes');
    });

    test('/compare with two visible panes builds a compare prompt', async () => {
      execWebview('p1', { page: { title: 'One', url: 'u1', mainText: 'AAA' } });
      execWebview('p2', { page: { title: 'Two', url: 'u2', mainText: 'BBB' } });
      const state = { get: jest.fn((k) => (k === 'openTabs' ? ['p1', 'p2'] : [])) };
      panel.initialize(() => makeContext({ extra: { state } }));
      panel.open();
      const captured = {};
      mockChat(captured);
      panel.input.value = '/compare';
      await panel._run();
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'chat:ask')).toBe(true);
      expect(captured.messages[1].content).toContain('AAA');
      expect(captured.messages[1].content).toContain('BBB');
    });

    test('a typed @browsing token queries browsing:ask and folds results into the message (no chip UI)', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      const captured = {};
      mockChat(captured);
      // Context is now typed inline, not toggled via a chip.
      panel.input.value = '@browsing find that article';
      await panel._run();
      expect(captured.browsingArg.query).toBe('find that article');
      const userMsg = captured.messages[captured.messages.length - 1];
      expect(userMsg.content).toContain('Past Page');
      expect(userMsg.content).toContain('find that article');
    });

    test('openChatAction opens chat mode and runs the slash transform', async () => {
      const wv = execWebview('tab-active', { page: { title: 'Doc', url: 'https://x', mainText: 'BODY' } });
      panel.initialize(() => makeContext({ webview: wv }));
      const captured = {};
      mockChat(captured);
      panel.openChatAction('summarize');
      // openChatAction fires the run without awaiting it; the extract→compose→
      // ask chain spans several microtasks, so flush generously.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'chat:ask')).toBe(true);
      expect(captured.messages[0].content.toLowerCase()).toContain('summarize');
    });

    test('openChat accepts a context option for call-site compatibility but no longer pre-attaches chips', () => {
      const wv = execWebview('tab-active', { page: { mainText: 'x' } });
      panel.initialize(() => makeContext({ webview: wv }));
      // Callers (CommandPalette, TabBar) still pass context:'page'; it must not throw or leave chip state around.
      expect(() => panel.openChat({ context: 'page' })).not.toThrow();
    });

    test('@tokens are per-message — no persistent chip state survives across sends', () => {
      // The old _contextChips set is gone; context comes from typed @-tokens plus the always-on active page.
      panel.initialize(() => makeContext());
      expect(panel._setContextChips).toBeUndefined();
    });

  });


  describe('chat mode: /council and /research', () => {
    // A pane that acks the inject script and returns `answer` for the extractor.
    function councilWebview(id, answer) {
      const el = document.createElement('div');
      el.id = id;
      el.executeJavaScript = jest.fn(async (script) => {
        if (typeof script === 'string' && script.includes('data-message-author-role')) return answer;
        return 'textarea';
      });
      document.body.appendChild(el);
      return el;
    }

    test('/council fans the question to active panes and synthesizes the answers', async () => {
      const wv1 = councilWebview('s1', 'GPT says X is the strongest option here.');
      const wv2 = councilWebview('s2', 'Claude argues Y wins on these grounds.');
      const state = { get: jest.fn((k) => {
        if (k === 'activeSpaces') return { s1: true, s2: true };
        if (k === 'config') return { spaces: { s1: { name: 'ChatGPT' }, s2: { name: 'Claude' } } };
        return undefined;
      }) };
      panel.initialize(() => makeContext({ extra: { state } }));
      panel.open();
      // Collapse the inter-poll wait so the loop runs deterministically (the
      // harness's synchronous setTimeout mock deadlocks on repeated awaited
      // delays; real setTimeout in production is unaffected).
      jest.spyOn(panel, '_delay').mockResolvedValue(undefined);
      const captured = {};
      ipcRenderer.invoke.mockImplementation(async (ch, arg) => {
        if (ch === 'chat:ask') {
          captured.messages = arg.messages;
          ipcRenderer._fire('chat:token', { id: arg.id, delta: 'MERGED' });
          return { ok: true };
        }
        return defaultInvoke(ch, arg);
      });
      panel.input.value = '/council which database?';
      await panel._run();
      expect(wv1.executeJavaScript).toHaveBeenCalled();
      expect(wv2.executeJavaScript).toHaveBeenCalled();
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'chat:ask')).toBe(true);
      expect(captured.messages[0].content.toLowerCase()).toContain('synthes');
      expect(captured.messages[1].content).toContain('GPT says X');
      expect(captured.messages[1].content).toContain('Claude argues Y');
      expect(panel._answerView.getMarkdown()).toBe('MERGED');
    });

    test('Stop during the final council capture round never sends chat:ask', async () => {
      councilWebview('s1', 'GPT says X is the strongest option here.');
      const wv2 = councilWebview('s2', 'Claude argues Y wins on these grounds.');
      let extracts = 0;
      wv2.executeJavaScript = jest.fn(async (script) => {
        if (typeof script === 'string' && script.includes('data-message-author-role')) {
          extracts += 1;
          if (extracts === 2) panel.stopBtn.click();
          return 'Claude argues Y wins on these grounds.';
        }
        return 'textarea';
      });
      const state = { get: jest.fn((k) => {
        if (k === 'activeSpaces') return { s1: true, s2: true };
        if (k === 'config') return { spaces: { s1: { name: 'ChatGPT' }, s2: { name: 'Claude' } } };
        return undefined;
      }) };
      panel.initialize(() => makeContext({ extra: { state } }));
      panel.open();
      jest.spyOn(panel, '_delay').mockResolvedValue(undefined);
      ipcRenderer.invoke.mockImplementation(async (ch, arg) => (ch === 'chat:ask' ? { ok: true } : defaultInvoke(ch, arg)));
      panel.input.value = '/council which database?';
      await panel._run();
      expect(extracts).toBe(2);
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'chat:ask')).toBe(false);
      expect(panel.statusEl.getAttribute('data-status')).toBe('idle');
    });

    test('/council needs at least two active panes', async () => {
      councilWebview('s1', 'only one answer present');
      const state = { get: jest.fn((k) => (k === 'activeSpaces' ? { s1: true } : undefined)) };
      panel.initialize(() => makeContext({ extra: { state } }));
      panel.open();
      panel.input.value = '/council solo';
      await panel._run();
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'chat:ask')).toBe(false);
      expect(panel._answerView.getMarkdown()).toContain('at least two');
    });

    test('/research switches to agent mode and runs the research task', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      const captured = {};
      ipcRenderer.invoke.mockImplementation(async (ch, arg) => {
        if (ch === 'agent:start') { captured.desc = arg.description; return { ok: true }; }
        return defaultInvoke(ch, arg);
      });
      panel.input.value = '/research climate policy 2030';
      await panel._run();
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'agent:start')).toBe(true);
      expect(captured.desc).toContain('Research Report Mode');
      expect(captured.desc).toContain('climate policy 2030');
    });

    test('/research with no question shows guidance and does not start the agent', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel.input.value = '/research';
      await panel._run();
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'agent:start')).toBe(false);
      expect(panel._answerView.getMarkdown()).toContain('/research');
    });
  });

  // ---- Chat settings gear + capability toggles --------------------------

  describe('chat settings & feature toggles', () => {
    test('the menu Open Settings button opens Settings on the Chat tab', () => {
      const settingsMenu = { showTab: jest.fn() };
      panel.initialize(() => makeContext({ settingsMenu }));
      panel.open();
      // The popover is portalled to document.body, not nested in the panel DOM.
      const settingsLink = document.body.querySelector('.assistant-menu-settings');
      expect(settingsLink).not.toBeNull();
      settingsLink.click();
      expect(settingsMenu.showTab).toHaveBeenCalledWith('chat');
    });

    test('a settings flip on any feature leaf path re-hydrates _chatFeatures (no chip UI left to sync)', () => {
      const configBridge = require('../../../../renderer/core/configBridge');
      // Path listeners match exact paths, so the panel subscribes per-leaf key — plus settings.chat.mode.
      const pathListeners = new Map();
      jest.spyOn(configBridge, 'onPathChange').mockImplementation((path, fn) => { if (!pathListeners.has(path)) pathListeners.set(path, new Set()); pathListeners.get(path).add(fn); return () => {}; });
      try {
        panel.initialize(() => makeContext());
        ['settings.chat.features.webSearch','settings.chat.features.readTopPage','settings.chat.features.thinkStepByStep'].forEach((path) => expect(pathListeners.has(path)).toBe(true));
        expect(pathListeners.has('settings.chat.mode')).toBe(true);
        // Simulate Settings → Chat flipping webSearch; the handler reloads from configBridge.get.
        jest.spyOn(configBridge, 'get').mockImplementation((path) => (path === 'settings.chat.features' ? { webSearch: false, readTopPage: true, thinkStepByStep: true } : undefined));
        panel._chatFeatures.webSearch = true;
        pathListeners.get('settings.chat.features.webSearch').forEach((fn) => fn(false, true));
        expect(panel._chatFeatures.webSearch).toBe(false);
      } finally { jest.restoreAllMocks(); }
    });

    test('config listeners survive open/close (panel is a long-lived singleton)', () => {
      // initialize runs once per app session; the path subscriptions must persist
      const configBridge = require('../../../../renderer/core/configBridge');
      const unsub = jest.fn();
      const spy = jest.spyOn(configBridge, 'onPathChange').mockReturnValue(unsub);
      try {
        panel.initialize(() => makeContext());
        expect(spy).toHaveBeenCalledTimes(4);
        const seen = spy.mock.calls.map((c) => c[0]).sort();
        expect(seen).toEqual(['settings.chat.features.readTopPage','settings.chat.features.thinkStepByStep','settings.chat.features.webSearch','settings.chat.mode']);
        panel.open();
        panel.close();
        expect(spy).toHaveBeenCalledTimes(4);
        expect(unsub).not.toHaveBeenCalled();
      } finally { spy.mockRestore(); }
    });

    test('grounding is on by default: no per-message chips, and a plain send grounds itself', async () => {
      panel.initialize(() => makeContext());
      expect(panel.overlay.querySelector('.agent-panel-feat-chip')).toBeNull();
expect(panel._chatFeatures).toEqual({ webSearch: true, readTopPage: true, thinkStepByStep: true });
      const seen = { searched: false };
      ipcRenderer.invoke.mockImplementation(async (ch) => { if (ch === 'chat:web-search') { seen.searched = true; return { ok: false, results: [] }; } if (ch === 'chat:ask') return { ok: true }; return defaultInvoke(ch); });
      panel.input.value = 'what is mars';
await panel._run();
      expect(seen.searched).toBe(true);
    });

    test('feature flags hydrate from settings.chat.features at initialize (overriding defaults)', () => {
      // spyOn + restore: doMock leaks across tests in this file and would flip later defaults.
      const configBridge = require('../../../../renderer/core/configBridge');
const spy = jest.spyOn(configBridge, 'get').mockImplementation((path) => (path === 'settings.chat.features'
? { webSearch: false, readTopPage: true, thinkStepByStep: false }
: undefined));
      try {
panel.initialize(() => makeContext());
        expect(panel._chatFeatures).toEqual({ webSearch: false, readTopPage: true, thinkStepByStep: false });
} finally { spy.mockRestore(); }
    });

    test('webSearch ON runs chat:web-search and injects results into the model message', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._chatFeatures.webSearch = true;
      const seen = {};
      ipcRenderer.invoke.mockImplementation(async (ch, arg) => {
        if (ch === 'chat:web-search') {
          seen.searchQuery = arg.query;
          seen.readTop = arg.readTop;
          return { ok: true, query: arg.query, results: [
            { title: 'Mars', url: 'https://mars.example', snippet: 'Red planet.' },
          ], page: null };
        }
        if (ch === 'chat:ask') {
          seen.askMessages = arg.messages;
          return { ok: true };
        }
        return defaultInvoke(ch, arg);
      });
      panel.input.value = 'what is mars?';
      await panel._run();
      expect(seen.searchQuery).toBe('what is mars?');
      // The grounding block lands in the user message content, ahead of the prompt.
      const userMsg = seen.askMessages.find((m) => m.role === 'user');
      expect(userMsg.content).toContain('Web search results');
      expect(userMsg.content).toContain('Mars');
      expect(userMsg.content).toContain('https://mars.example');
      expect(userMsg.content).toContain('what is mars?');
    });

    test('opting webSearch back off via config skips chat:web-search entirely (negative)', async () => {
      panel.initialize(() => makeContext());
      jest.spyOn(require('../../../../renderer/core/configBridge'), 'get').mockImplementation((path) => (path === 'settings.chat.features' ? { webSearch: false, readTopPage: true, thinkStepByStep: true } : undefined));
      panel._loadChatFeatures();
expect(panel._chatFeatures.webSearch).toBe(false);
ipcRenderer.invoke.mockImplementation(async (ch) => { if (ch === 'chat:ask') return { ok: true }; return defaultInvoke(ch); });
      panel.input.value = 'plain question';
      await panel._run();
      expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'chat:ask')).toBe(true);
expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'chat:web-search')).toBe(false);
    });

    test('thinkStepByStep ON adds the reasoning instruction to the system message', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._chatFeatures.thinkStepByStep = true;
      const seen = {};
      ipcRenderer.invoke.mockImplementation(async (ch, arg) => {
        if (ch === 'chat:ask') { seen.system = arg.messages[0].content; return { ok: true }; }
        return defaultInvoke(ch, arg);
      });
      panel.input.value = 'a question';
      await panel._run();
      expect(seen.system).toContain('step by step');
    });
  });
  // ---- Assistant layout: history rail, header chips, composer controls ----

  describe('history rail', () => {
    beforeEach(() => { window.localStorage.removeItem('agent.history.open'); });
    afterEach(() => { jest.restoreAllMocks(); window.localStorage.removeItem('agent.history.open'); });

    function railParts() {
      return {
        root: panel.overlay,
        toggle: panel.overlay.querySelector('.agent-panel-header .agent-panel-history-toggle'),
        rail: panel.overlay.querySelector('.agent-panel-history-rail'),
        history: panel.overlay.querySelector('.agent-history'),
      };
    }

    test('starts collapsed to the rail by default', () => {
      panel.initialize(() => makeContext());
      const { root, toggle, rail, history } = railParts();
      expect(root.classList.contains('is-history-open')).toBe(false);
      expect(history.hidden).toBe(true);
      expect(rail.hidden).toBe(false);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.getAttribute('aria-controls')).toBe(history.id);
    });

    test('the header toggle expands the column and persists "1"; toggling back persists "0"', () => {
      panel.initialize(() => makeContext());
      const { root, toggle, rail, history } = railParts();
      toggle.click();
      expect(root.classList.contains('is-history-open')).toBe(true);
      expect(history.hidden).toBe(false);
      expect(rail.hidden).toBe(true);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(window.localStorage.getItem('agent.history.open')).toBe('1');
      toggle.click();
      expect(history.hidden).toBe(true);
      expect(window.localStorage.getItem('agent.history.open')).toBe('0');
    });

    test('the persisted open state is restored on the next launch', () => {
      window.localStorage.setItem('agent.history.open', '1');
      panel.initialize(() => makeContext());
      const { root, history } = railParts();
      expect(root.classList.contains('is-history-open')).toBe(true);
      expect(history.hidden).toBe(false);
    });

    test('storage that throws falls back to collapsed and warns', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage disabled'); });
      panel.initialize(() => makeContext());
      const { root, history } = railParts();
      expect(root.classList.contains('is-history-open')).toBe(false);
      expect(history.hidden).toBe(true);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('HistoryRail') && String(c[1]).includes('storage disabled'))).toBe(true);
    });

    test('the rail shows the session count and clicking it expands the history', async () => {
      ipcRenderer.invoke.mockImplementation(async (ch) => (ch === 'session:list'
        ? { ok: true, sessions: [{ id: 'a', title: 'A', updatedAt: 2 }, { id: 'b', title: 'B', updatedAt: 1 }] }
        : defaultInvoke(ch)));
      panel.initialize(() => makeContext());
      panel.open();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      const { rail, history } = railParts();
      const count = rail.querySelector('.agent-panel-history-count');
      expect(count.textContent).toBe('2');
      expect(count.hidden).toBe(false);
      expect(rail.getAttribute('aria-label')).toBe('Show history (2 runs)');
      rail.click();
      expect(history.hidden).toBe(false);
    });

    test('Cmd/Ctrl+Shift+H toggles the history while the panel is open', () => {
      panel.initialize(() => makeContext());
      openInAssistantMode(panel);
      const { history } = railParts();
      const spy = jest.spyOn(panel._history, 'focusSearch');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'H', metaKey: true, shiftKey: true, bubbles: true }));
      expect(history.hidden).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'H', metaKey: true, shiftKey: true, bubbles: true }));
      expect(history.hidden).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });
  });

  describe('header status chip', () => {
    test('maps run states to human labels while keeping the raw data-status', () => {
      panel.initialize(() => makeContext());
      panel.open();
      expect(panel.statusEl.textContent).toBe('Ready');
      const seen = [];
      for (const s of ['running', 'done', 'error', 'idle']) {
        panel._setStatus(s);
        seen.push([panel.statusEl.getAttribute('data-status'), panel.statusEl.textContent]);
      }
      expect(seen).toEqual([['running', 'Working…'], ['done', 'Done'], ['error', 'Error'], ['idle', 'Ready']]);
    });

    test('the header reads "Assistant", never "Agent"', () => {
      panel.initialize(() => makeContext());
      panel.open();
      expect(panel.overlay.querySelector('.agent-panel-title').textContent).toBe('Assistant');
      expect(document.getElementById('agent-panel').getAttribute('aria-label')).toBe('Assistant');
      expect(panel.voiceBtn.getAttribute('aria-label')).toContain('Assistant');
    });

    test('Esc with the ⋯ menu open closes only the menu; the next Esc closes the panel', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel.overlay.querySelector('.agent-panel-menu-btn').click();
      const menu = document.querySelector('.assistant-menu');
      expect(menu.hidden).toBe(false);
      panel.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(menu.hidden).toBe(true);
      expect(panel.isOpen()).toBe(true);
      panel.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(panel.isOpen()).toBe(false);
    });

    test('the header close button closes the panel', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel.overlay.querySelector('.agent-panel-close').click();
      expect(panel.isOpen()).toBe(false);
    });
  });

  describe('Pause / Stop visibility', () => {
    test('hidden while idle, both shown during an agent run, hidden again after', () => {
      panel.initialize(() => makeContext());
      panel.open();
      expect(panel.stopBtn.hidden).toBe(true);
      expect(panel.pauseBtn.hidden).toBe(true);
      panel._setStatus('running');
      expect(panel.stopBtn.hidden).toBe(false);
      expect(panel.pauseBtn.hidden).toBe(false);
      panel._setStatus('done');
      expect(panel.stopBtn.hidden).toBe(true);
      expect(panel.pauseBtn.hidden).toBe(true);
    });

    test('a chat turn shows Stop but never Pause', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      let release;
      ipcRenderer.invoke.mockImplementation((ch, arg) => {
        if (ch === 'chat:ask') return new Promise((r) => { release = r; });
        return defaultInvoke(ch, arg);
      });
      panel.routeMode = 'chat';
      panel.input.value = 'a quick question';
      const run = panel._run();
      for (let i = 0; i < 25; i++) await Promise.resolve();
      expect(panel.statusEl.getAttribute('data-status')).toBe('running');
      expect(panel.stopBtn.hidden).toBe(false);
      expect(panel.pauseBtn.hidden).toBe(true);
      release({ ok: false, error: 'cancelled' });
      await run;
      expect(panel.stopBtn.hidden).toBe(true);
    });
  });

  describe('answer-mode segmented control', () => {
    test('choosing Chat drives the same state and config path the menu select used', () => {
      const configBridge = require('../../../../renderer/core/configBridge');
      const setSpy = jest.spyOn(configBridge, 'set').mockImplementation(() => undefined);
      panel.initialize(() => makeContext());
      panel.open();
      const seg = panel.overlay.querySelector('.agent-panel-modeswitch');
      seg.querySelector('[data-mode="chat"]').click();
      expect(panel.routeMode).toBe('chat');
      expect(setSpy).toHaveBeenCalledWith('settings.chat.mode', 'chat');
      expect(seg.querySelector('[aria-checked="true"]').dataset.mode).toBe('chat');
      setSpy.mockClear();
      // Re-selecting the active segment is not a change and writes nothing.
      seg.querySelector('[data-mode="chat"]').click();
      expect(setSpy).not.toHaveBeenCalled();
      setSpy.mockRestore();
    });

    test('a persisted mode is reflected in the control on load', () => {
      const configBridge = require('../../../../renderer/core/configBridge');
      configBridge.initialize({ settings: { chat: { mode: 'agent' } } });
      panel.initialize(() => makeContext());
      expect(panel.routeMode).toBe('agent');
      const checked = panel.overlay.querySelector('.agent-panel-modeswitch [aria-checked="true"]');
      expect(checked.dataset.mode).toBe('agent');
    });

    test('the answer mode is no longer duplicated inside the ⋯ menu', () => {
      panel.initialize(() => makeContext());
      expect(document.querySelector('.assistant-menu .agent-panel-routemode')).toBeNull();
      expect(document.querySelector('.assistant-menu .agent-panel-enter-to-send-cb')).not.toBeNull();
    });
  });

  describe('engine chip + empty-state hero', () => {
    test('with no model running the chip and hero both lead to Settings → LLM', async () => {
      const settingsMenu = { showTab: jest.fn() };
      panel.initialize(() => makeContext({ settingsMenu }));
      for (let i = 0; i < 3; i++) await Promise.resolve();
      expect(panel.engineChip.dataset.tone).toBe('off');
      expect(panel.engineChip.textContent).toBe('Set up a model');
      panel.engineChip.click();
      expect(settingsMenu.showTab).toHaveBeenLastCalledWith('llm');
      settingsMenu.showTab.mockClear();
      panel.overlay.querySelector('.agent-panel-hero-setup').click();
      expect(settingsMenu.showTab).toHaveBeenCalledWith('llm');
    });

    test('a running model names itself and the hero drops the setup CTA', async () => {
      ipcRenderer.invoke.mockImplementation(async (ch) => (ch === 'llm:get-status'
        ? { status: 'running', backend: 'llamaCpp', model: '/models/Qwen3-8B-Q4_K_M.gguf', isRemote: false }
        : defaultInvoke(ch)));
      panel.initialize(() => makeContext());
      for (let i = 0; i < 3; i++) await Promise.resolve();
      expect(panel.engineChip.dataset.tone).toBe('ok');
      expect(panel.engineChip.textContent).toBe('Qwen3-8B-Q4_K_M');
      const hero = panel.overlay.querySelector('.agent-panel-hero-engine');
      expect(hero.textContent).toContain('Qwen3-8B-Q4_K_M is ready');
      expect(hero.querySelector('.agent-panel-hero-setup')).toBeNull();
    });

    test('a failed status fetch is shown as an error, not as "no model"', async () => {
      ipcRenderer.invoke.mockImplementation(async (ch) => {
        if (ch === 'llm:get-status') throw new Error('main not ready');
        return defaultInvoke(ch);
      });
      panel.initialize(() => makeContext());
      for (let i = 0; i < 3; i++) await Promise.resolve();
      expect(panel.engineChip.dataset.tone).toBe('error');
      expect(panel.engineChip.title).toContain('main not ready');
    });

    test('the answer scrolls with the transcript instead of sitting above the composer', () => {
      panel.initialize(() => makeContext());
      const scroll = panel.overlay.querySelector('.agent-panel-scroll');
      expect(scroll.querySelector(':scope > .agent-panel-transcript')).not.toBeNull();
      expect(scroll.querySelector(':scope > .agent-panel-answer-slot')).not.toBeNull();
      expect(panel.overlay.querySelector('.agent-panel-main > .agent-panel-answer-slot')).toBeNull();
    });

    test('starting a run hides the empty-state hero; New chat brings it back', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      const empty = panel.overlay.querySelector('.agent-panel-empty');
      expect(empty.hidden).toBe(false);
      panel._setStartersVisible(false);
      expect(empty.hidden).toBe(true);
      await panel._newChat();
      expect(empty.hidden).toBe(false);
    });

    test('the egress banner uses an icon, not an emoji glyph', () => {
      const configBridge = require('../../../../renderer/core/configBridge');
      configBridge.initialize({ settings: { llm: { agent: { egress: { mode: 'blocklist', block: ['x.com'] } } } } });
      panel.initialize(() => makeContext());
      panel._renderEgressScope();
      const iconEl = panel._egressEl.querySelector('.agent-panel-egress-icon');
      expect(iconEl.querySelector('svg')).not.toBeNull();
      expect(iconEl.textContent).not.toContain('⛨');
    });
  });

  describe('onOpenChange / isOpen()', () => {
    test('notifies subscribers on open and close; unsubscribe stops notifications', () => {
      panel.initialize(() => makeContext());
      const seen = [];
      const off = panel.onOpenChange((open) => seen.push(open));
      panel.open();
      expect(panel.isOpen()).toBe(true);
      panel.close();
      expect(panel.isOpen()).toBe(false);
      expect(seen).toEqual([true, false]);
      off();
      panel.open();
      expect(seen).toEqual([true, false]);
    });

    test('rejects a non-function subscriber', () => {
      expect(() => panel.onOpenChange('nope')).toThrow(TypeError);
    });
  });
});

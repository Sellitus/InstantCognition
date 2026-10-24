/**
 * @jest-environment jsdom
 */

// EngineControls — the three engine control describe blocks relocated from
// AgentPanel.test.js. The panel singleton is re-required per test via
// jest.resetModules() exactly as in that file, so the moved tests drive the
// same host surface (panel.engineBtn, panel._toggleEngine(), etc.) unchanged.
// We replace the global electron mock with an EventEmitter-backed ipcRenderer
// so the test can drive 'llm:*' events and assert the exact invoke calls
// EngineControls makes (the global mock's invoke can't be reconfigured
// per-test and its shared emitter leaks listeners across files).
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

describe('AgentPanel → EngineControls', () => {
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
    panel = require('../../../../../renderer/components/AgentPanel');
  });

  afterEach(() => {
    try { panel.close(); } catch (_) { /* ignore */ }
    document.body.classList.remove('no-animations');
    document.body.innerHTML = '';
  });

  // ---- Engine button -----------------------------------------------------

  describe('engine controls', () => {
    test('llm:status-changed running state relabels the engine button to "Stop engine"', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('llm:status-changed', { info: { status: 'running', backend: 'llama' } });
      expect(panel.engineBtn.dataset.engineState).toBe('running');
      expect(panel.engineBtn.textContent).toBe('Stop engine');
    });

    test('clicking the engine button while stopped invokes llm:start', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._engineStatus = { status: 'stopped' };
      panel._renderEngineButton();
      await panel._toggleEngine();
      expect(ipcRenderer.invoke).toHaveBeenCalledWith('llm:start', {});
    });
  });

  describe('engine button rendering (all status labels)', () => {
    test('remote engine disables the button and shows the remote label', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('llm:status-changed', { info: { status: 'running', isRemote: true } });
      expect(panel.engineBtn.textContent).toBe('Remote engine');
      expect(panel.engineBtn.disabled).toBe(true);
      expect(panel.engineBtn.title).toContain('remote endpoint');
      expect(panel.engineBtn.getAttribute('aria-label')).toContain('remote endpoint');
      expect(panel.engineStartStopBtn.disabled).toBe(true);
      expect(panel.engineStartStopBtn.getAttribute('aria-label')).toContain('remote endpoint');
    });

    test('a remote-to-local status change clears the stale remote aria label', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('llm:status-changed', { info: { status: 'running', isRemote: true } });
      ipcRenderer._fire('llm:status-changed', { info: { status: 'running', backend: 'llama' } });
      expect(panel.engineBtn.getAttribute('aria-label')).toBeNull();
      expect(panel.engineStartStopBtn.getAttribute('aria-label')).toBeNull();
      expect(panel.engineStartStopBtn.getAttribute('title')).toBeNull();
      expect(panel.engineStartStopBtn.disabled).toBe(false);
    });

    test('starting / stopping states disable the button with progress labels', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('llm:status-changed', { info: { status: 'starting' } });
      expect(panel.engineBtn.textContent).toBe('Starting…');
      expect(panel.engineBtn.disabled).toBe(true);
      ipcRenderer._fire('llm:status-changed', { info: { status: 'stopping' } });
      expect(panel.engineBtn.textContent).toBe('Stopping…');
    });

    test('error status with a lastError surfaces the message in the tooltip', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('llm:status-changed', { info: { status: 'error', lastError: 'port in use' } });
      expect(panel.engineBtn.textContent).toBe('Start engine');
      expect(panel.engineBtn.title).toContain('port in use');
    });

    test('error status without a lastError uses the generic error tooltip', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('llm:status-changed', { info: { status: 'error' } });
      expect(panel.engineBtn.title).toContain('Engine error. Click to retry');
    });

    test('running status appends the backend name to the tooltip', () => {
      panel.initialize(() => makeContext());
      panel.open();
      ipcRenderer._fire('llm:status-changed', { info: { status: 'running', backend: 'llama' } });
      expect(panel.engineBtn.title).toContain('· llama');
    });

    test('llm:status-changed with only a "current" field patches just the status', () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._engineStatus = { status: 'stopped', backend: 'mlx' };
      ipcRenderer._fire('llm:status-changed', { current: 'running' });
      expect(panel._engineStatus.status).toBe('running');
      expect(panel._engineStatus.backend).toBe('mlx');
    });
  });

  describe('_toggleEngine guards', () => {
    test('does nothing while an engine action is already pending', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._engineActionPending = true;
      await panel._toggleEngine();
      expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('llm:stop');
      expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('llm:start', {});
    });

    test('does nothing when the engine is starting or stopping', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._engineStatus = { status: 'starting' };
      await panel._toggleEngine();
      expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('llm:start', {});
    });

    test('running engine → invokes llm:stop', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._engineStatus = { status: 'running' };
      await panel._toggleEngine();
      expect(ipcRenderer.invoke).toHaveBeenCalledWith('llm:stop');
    });

    test('a failing engine action presents the error message', async () => {
      panel.initialize(() => makeContext());
      panel.open();
      panel._engineStatus = { status: 'stopped' };
      ipcRenderer.invoke.mockImplementation(async (ch, ...rest) => {
        if (ch === 'llm:start') throw new Error('cannot bind');
        return defaultInvoke(ch, ...rest);
      });
      await panel._toggleEngine();
      expect(panel._answerView.getMarkdown()).toContain('cannot bind');
      expect(panel._engineActionPending).toBe(false);
    });
  });
});

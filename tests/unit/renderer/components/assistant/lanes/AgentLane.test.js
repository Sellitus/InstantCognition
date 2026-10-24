/**
 * @jest-environment jsdom
 */

// AgentLane.run()'s agent-workspace bind on a new thread. The external
// boundary mocked is electron.ipcRenderer (same harness style as
// tests/unit/renderer/components/AgentPanel.test.js); the host is a minimal
// stub carrying only the fields run() touches. Toast is the real singleton —
// assertions read the jsdom DOM it renders.

const toast = require('../../../../../../renderer/components/Toast');

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

jest.mock('electron', () => {
  const { EventEmitter: EE } = require('events');
  const emitter = new EE();
  emitter.setMaxListeners(0);
  const ipcRenderer = {
    _emitter: emitter,
    send: jest.fn(),
    on: jest.fn((ch, fn) => { emitter.on(ch, fn); return ipcRenderer; }),
    invoke: jest.fn(async () => undefined),
  };
  return { ipcRenderer };
});

const { ipcRenderer } = require('electron');
const AgentLane = require('../../../../../../renderer/components/assistant/lanes/AgentLane');

const BIND_CHANNEL = 'agent-workspace:set-active-conversation';

function makeHost() {
  const tabEl = document.createElement('div');
  tabEl.id = 'tab-1';
  tabEl.getWebContentsId = jest.fn(() => 4242);
  document.body.appendChild(tabEl);

  return {
    input: { value: 'do the thing', style: {} },
    _transcript: {
      setStartersVisible: jest.fn(),
      prepareFollowUpTurn: jest.fn(),
      setStatus: jest.fn(),
    },
    _answerView: { markWaiting: jest.fn(), present: jest.fn() },
    _composer: { recordPrompt: jest.fn() },
    _projectComposer: null,
    _pendingProjectImages: [],
    _sessionStore: { activeSessionId: null },
    _chatHistory: [],
    _scope: 'tab',
    _tabId: 'tab-1',
    _qualityMode: 'balanced',
    _agentThreadActive: false,
    contextProvider: () => ({}),
  };
}

// Route invoke per channel: `bind` decides 'agent-workspace:set-active-conversation'
// outcomes per call; everything else (agent:start) uses `start`.
function stubInvoke({ bind, start }) {
  ipcRenderer.invoke.mockImplementation((ch) => {
    if (ch === BIND_CHANNEL) return bind();
    if (ch === 'agent:start') return start ? start() : Promise.resolve(undefined);
    return Promise.resolve(undefined);
  });
}

function bindCalls() {
  return ipcRenderer.invoke.mock.calls.filter((c) => c[0] === BIND_CHANNEL);
}

function startCalls() {
  return ipcRenderer.invoke.mock.calls.filter((c) => c[0] === 'agent:start');
}

describe('AgentLane.run agent-workspace bind', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.body.textContent = '';
    resetToast();
  });

  test('retries set-active-conversation once before surfacing', async () => {
    let bindAttempts = 0;
    stubInvoke({
      bind: () => {
        bindAttempts += 1;
        return bindAttempts === 1
          ? Promise.reject(new Error('transient ipc failure'))
          : Promise.resolve(undefined);
      },
    });
    const host = makeHost();
    const lane = new AgentLane(host);

    await lane.run();

    expect(bindAttempts).toBe(2);
    expect(startCalls()).toHaveLength(1);
    // Recovered after one retry — no user-visible complaint.
    expect(document.querySelector('.toast')).toBeNull();
    expect(host._transcript.setStatus).not.toHaveBeenCalledWith('error');
  });

  test('surfaces a toast when set-active-conversation fails twice', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    stubInvoke({ bind: () => Promise.reject(new Error('workspace gone')) });
    const host = makeHost();
    const lane = new AgentLane(host);

    await lane.run();

    expect(bindCalls()).toHaveLength(2);
    const alert = document.querySelector('.toast[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert.textContent).toContain('Agent workspace');
    expect(alert.textContent).toContain('workspace tabs and restore are disabled');
    // The run itself still proceeds — the agent start path is independent.
    expect(startCalls()).toHaveLength(1);
    expect(host._transcript.setStatus).not.toHaveBeenCalledWith('error');
    errSpy.mockRestore();
  });

  test('restores the composer when agent:start fails', async () => {
    stubInvoke({
      bind: () => Promise.resolve(undefined),
      start: () => Promise.reject(new Error('nope')),
    });
    const host = makeHost();
    const lane = new AgentLane(host);

    await lane.run();

    expect(host.input.value).toBe('do the thing');
    expect(host._transcript.setStatus).toHaveBeenCalledWith('error');
    expect(host._answerView.present).toHaveBeenCalledWith('Start failed: nope');
    expect(document.querySelector('.toast')).toBeNull();
  });
});

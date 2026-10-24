/**
 * @jest-environment jsdom
 */

// Wiring of the approval queue and the permission-mode pill into the real
// AgentPanel: the pill sits in the composer and reads the mode from main,
// Shift+Tab in the composer switches it unless a listbox is open, and a new
// foreground task drops approvals left over from the previous one.

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

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

let ipcRenderer, panel;

async function mainInvoke(ch, arg) {
  switch (ch) {
    case 'persona:list': return { enabled: [], lock: null };
    case 'llm:get-status': return { status: 'stopped', backend: null, isRemote: false };
    case 'permissions:get': return { ok: true, mode: 'ask', effectiveMode: 'ask', sessionModes: {}, rules: {} };
    case 'permissions:set-mode': return { ok: true, mode: arg.mode };
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

const shiftTab = () => panel.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
const pill = () => panel.overlay.querySelector('.agent-panel-composer .permission-mode__pill');
const setModes = () => ipcRenderer.invoke.mock.calls.filter((c) => c[0] === 'permissions:set-mode').map((c) => c[1].mode);

beforeEach(async () => {
  jest.clearAllMocks();
  jest.resetModules();
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

test('the composer carries the permission pill, loaded from main', () => {
  expect(pill()).not.toBeNull();
  expect(pill().textContent).toBe('Ask');
  expect(ipcRenderer.invoke).toHaveBeenCalledWith('permissions:get', {});
});

test('Shift+Tab in the composer switches the mode', async () => {
  panel.input.focus();
  shiftTab();
  await flush();
  expect(setModes()).toEqual(['auto-edit']);
  expect(pill().textContent).toBe('Auto-edit');
});

test('Shift+Tab leaves the mode alone while a composer listbox is open', async () => {
  const list = document.createElement('div');
  list.setAttribute('role', 'listbox');
  panel.overlay.querySelector('.agent-panel-composer').appendChild(list);
  panel.input.focus();
  shiftTab();
  await flush();
  expect(setModes()).toEqual([]);
  list.hidden = true;
  shiftTab();
  await flush();
  expect(setModes()).toEqual(['auto-edit']);
});

test('a new foreground task drops approvals left from the last one', () => {
  ipcRenderer._fire('agent:approval-request', {
    requestId: 'old-1', call: { name: 'shell.run', args: { argv: ['ls'] } }, class: 'exec', origin: null,
    sessionId: null, kind: 'shell', toolName: 'shell.run', argv: ['ls'], cwd: '/w', suggestedRule: null,
  });
  expect(panel.overlay.querySelector('.approval-card[data-request-id="old-1"]')).not.toBeNull();
  ipcRenderer._fire('agent:task-started', { taskId: 't2', task: { description: 'next' }, scope: 'global' });
  expect(panel.overlay.querySelector('.approval-card')).toBeNull();
  expect(ipcRenderer.send).not.toHaveBeenCalledWith('agent:approval-response', expect.anything());
});

function fireBackgroundApproval(requestId, sessionId = 's_bgsession1') {
  ipcRenderer._fire('agent:approval-request', {
    requestId, call: { name: 'shell.run', args: { argv: ['ls'] } }, class: 'exec', origin: null,
    sessionId, kind: 'shell', toolName: 'shell.run', argv: ['ls'], cwd: '/w', suggestedRule: null,
  });
}

test('a transcript reset keeps a still-queued approval card on screen', () => {
  fireBackgroundApproval('bg-1');
  panel._transcript.reset();
  const approvalEl = panel.overlay.querySelector('.agent-panel-approval');
  expect(approvalEl.hidden).toBe(false);
  expect(approvalEl.querySelector('.approval-card[data-request-id="bg-1"]')).not.toBeNull();
});

test('a follow-up turn keeps a still-queued approval card on screen', () => {
  fireBackgroundApproval('bg-2');
  panel._transcript.prepareFollowUpTurn();
  const approvalEl = panel.overlay.querySelector('.agent-panel-approval');
  expect(approvalEl.hidden).toBe(false);
  expect(approvalEl.querySelector('.approval-card[data-request-id="bg-2"]')).not.toBeNull();
});

test('a transcript reset with nothing queued leaves the approval area hidden and empty', () => {
  panel._transcript.reset();
  const approvalEl = panel.overlay.querySelector('.agent-panel-approval');
  expect(approvalEl.hidden).toBe(true);
  expect(approvalEl.querySelector('.approval-card')).toBeNull();
});

const sessionTag = () => panel.overlay.querySelector('.approval-card .approval-card__session');

test('a background session\'s approval card names that session', () => {
  panel._history._rows = [{ id: 's_bgsession1', title: 'Nightly report' }];
  fireBackgroundApproval('bg-3');
  expect(sessionTag().textContent).toBe('From session: Nightly report');
});

test('an untitled background session is named by its id prefix', () => {
  fireBackgroundApproval('bg-4', 's_zz9999aa');
  expect(sessionTag().textContent).toBe('From session: Untitled session (s_zz9999)');
});

test('the foreground session\'s own approval card carries no session tag', () => {
  panel._sessionStore.setActive('s_bgsession1');
  fireBackgroundApproval('fg-1');
  expect(panel.overlay.querySelector('.approval-card[data-request-id="fg-1"]')).not.toBeNull();
  expect(sessionTag()).toBeNull();
});

test('switching to the requesting session drops the tag; switching away restores it', () => {
  panel._history._rows = [{ id: 's_bgsession1', title: 'Nightly report' }];
  fireBackgroundApproval('bg-5');
  expect(sessionTag()).not.toBeNull();
  panel._sessionStore.setActive('s_bgsession1');
  expect(sessionTag()).toBeNull();
  panel._sessionStore.setActive('s_other1234');
  expect(sessionTag().textContent).toBe('From session: Nightly report');
});

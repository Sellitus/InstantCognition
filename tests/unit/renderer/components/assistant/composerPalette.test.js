/**
 * @jest-environment jsdom
 */

// The composer's inline palette and context meter inside the real AgentPanel:
// palette keys win over send / permission cycling / panel Esc, `/compact`
// (typed, from the palette, or the meter) compacts the session instead of
// starting a run, `/<skill>` runs an enabled skill through skills:run, and the
// session-scoped controls follow the session the panel shows.

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

const flush = () => new Promise((r) => setTimeout(r, 0));

let ipcRenderer, panel, runSpy, handlers;

const COMMANDS = [
  { name: 'summarize', description: 'Summarize', kind: 'builtin' },
  { name: 'compact', description: 'Compact the conversation', kind: 'builtin' },
  { name: 'tidy-tabs', description: 'Close duplicate tabs', kind: 'skill' },
];

const snapshot = (id) => ({ ok: true, meta: { id, headId: null }, nodes: [], path: [], branches: {}, pendingPlan: null });

async function mainInvoke(ch, arg) {
  if (handlers[ch]) return handlers[ch](arg);
  switch (ch) {
    case 'persona:list': return { enabled: [], lock: null };
    case 'llm:get-status': return { status: 'stopped', backend: null, isRemote: false };
    case 'permissions:get': return { ok: true, mode: 'ask', effectiveMode: 'ask', sessionModes: {}, rules: {} };
    case 'permissions:set-mode': return { ok: true, mode: arg.mode };
    case 'commands:list': return { ok: true, commands: COMMANDS };
    case 'session:context-usage': return { ok: true, tokens: 900, contextSize: 1000, ratio: 0.9, messages: 3 };
    case 'session:compact': return { ok: true, nodeId: 'n_1', coveredMessages: 3 };
    case 'session:get': return snapshot(arg.sessionId);
    case 'skills:run': return { ok: true, summary: 'Closed 3 duplicate tabs.' };
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

const keydown = (key, opts = {}) => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
  panel.input.dispatchEvent(e);
  return e;
};
async function type(text) {
  panel.input.value = text;
  panel.input.setSelectionRange(text.length, text.length);
  panel.input.dispatchEvent(new Event('input', { bubbles: true }));
  await flush(); await flush();
}
const palette = () => panel.overlay.querySelector('.agent-panel-composer .inline-palette');
const meter = () => panel.overlay.querySelector('.agent-panel-controls .context-meter');
const calls = (ch) => ipcRenderer.invoke.mock.calls.filter((c) => c[0] === ch);

beforeEach(async () => {
  jest.clearAllMocks();
  jest.resetModules();
  document.body.innerHTML = '';
  handlers = {};
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
  runSpy = jest.spyOn(panel, '_run').mockImplementation(() => {});
  panel.input.focus();
});

afterEach(() => {
  runSpy.mockRestore();
  panel.close();
  document.body.classList.remove('no-animations');
  document.body.innerHTML = '';
});

test('the meter sits in the composer controls and the palette starts closed', () => {
  expect(meter()).not.toBeNull();
  expect(meter().dataset.level).toBe('unknown');
  expect(palette().getAttribute('role')).toBe('listbox');
  expect(palette().hidden).toBe(true);
});

test('with the palette open, Enter chooses instead of sending and Shift+Tab never cycles the mode', async () => {
  await type('/su');
  expect(palette().hidden).toBe(false);
  keydown('Tab', { shiftKey: true });
  await flush();
  expect(calls('permissions:set-mode')).toEqual([]);
  keydown('Enter');
  expect(panel.input.value).toBe('/summarize ');
  expect(runSpy).not.toHaveBeenCalled();
  keydown('Enter', { metaKey: true });
  expect(runSpy).toHaveBeenCalledTimes(1);
});

test('Esc closes only the palette; the document never sees it', async () => {
  const docKeys = jest.fn();
  document.addEventListener('keydown', docKeys);
  try {
    await type('/');
    const e = keydown('Escape');
    expect(e.defaultPrevented).toBe(true);
    expect(palette().hidden).toBe(true);
    expect(docKeys).not.toHaveBeenCalled();
    keydown('Escape');
    expect(docKeys).toHaveBeenCalledTimes(1);
  } finally { document.removeEventListener('keydown', docKeys); }
});

test('typing /compact and sending compacts the current session instead of starting a run', async () => {
  ipcRenderer._fire('agent:task-started', { taskId: 't1', sessionId: 's_cmpt0001', scope: 'global', task: { description: 'x' } });
  await flush();
  expect(meter().dataset.level).toBe('warn');
  panel.input.value = '/compact';
  keydown('Enter', { metaKey: true });
  await flush(); await flush();
  expect(runSpy).not.toHaveBeenCalled();
  expect(calls('session:compact')).toEqual([['session:compact', { sessionId: 's_cmpt0001' }]]);
  expect(panel.input.value).toBe('');
});

test('choosing /compact in the palette compacts; the run button does the same for typed /compact', async () => {
  ipcRenderer._fire('agent:task-started', { taskId: 't1', sessionId: 's_cmpt0002', scope: 'global', task: { description: 'x' } });
  ipcRenderer._fire('agent:task-completed', { taskId: 't1', sessionId: 's_cmpt0002', scope: 'global', ok: true, summary: 'done' });
  await flush();
  await type('/comp');
  keydown('Enter');
  await flush(); await flush();
  expect(calls('session:compact')).toHaveLength(1);
  expect(panel.input.value).toBe('');
  await type('/compact');
  keydown('Escape');
  expect(panel.runBtn.disabled).toBe(false);
  panel.runBtn.click();
  await flush(); await flush();
  expect(calls('session:compact')).toHaveLength(2);
  expect(runSpy).not.toHaveBeenCalled();
});

test('ordinary text still goes to the run path', () => {
  panel.input.value = 'compact this article';
  panel.runBtn.click();
  expect(runSpy).toHaveBeenCalledTimes(1);
  expect(calls('session:compact')).toEqual([]);
});

describe('session-scoped controls follow the panel session', () => {
  test('loading a session points the permission pill and the context meter at it', async () => {
    const res = await panel.loadSession('s_load0001');
    await flush(); await flush();
    expect(res).toEqual({ ok: true });
    expect(calls('permissions:get').map((c) => c[1])).toContainEqual({ sessionId: 's_load0001' });
    expect(calls('session:context-usage')).toEqual([['session:context-usage', { sessionId: 's_load0001' }]]);
    expect(meter().dataset.level).toBe('warn');
  });

  test('a new chat drops the session scope back to the default', async () => {
    await panel.loadSession('s_load0002');
    await flush(); await flush();
    const before = calls('permissions:get').length;
    await panel._newChat();
    await flush(); await flush();
    const after = calls('permissions:get').slice(before).map((c) => c[1]);
    expect(after).toEqual([{}]);
    expect(meter().dataset.level).toBe('unknown');
  });

  test('a panel built while a session is already active scopes the controls to it from the start', async () => {
    jest.resetModules();
    const fresh = require('electron').ipcRenderer;
    fresh.invoke.mockImplementation(mainInvoke);
    const lone = require('../../../../../renderer/components/AgentPanel');
    lone._sessionStore.setActive('s_init0001');
    lone.initialize(context);
    await flush(); await flush();
    const seen = fresh.invoke.mock.calls.filter((c) => c[0] === 'session:context-usage' || c[0] === 'permissions:get').map((c) => c[1]);
    expect(seen).toContainEqual({ sessionId: 's_init0001' });
    expect(fresh.invoke.mock.calls.filter((c) => c[0] === 'session:context-usage')).toEqual([['session:context-usage', { sessionId: 's_init0001' }]]);
  });
});

describe('/<skill> sends', () => {
  const toastText = () => {
    const el = document.querySelector('.toast-error .toast-message');
    return el ? el.textContent : '';
  };
  async function send(text) {
    panel.input.value = text;
    panel.runBtn.click();
    await flush(); await flush();
  }

  test('an enabled skill runs through skills:run on the active webview with the rest as its task', async () => {
    await send('/tidy-tabs close the dupes');
    expect(calls('skills:run')).toEqual([['skills:run', { name: 'tidy-tabs', task: 'close the dupes', webContentsId: 4242 }]]);
    expect(runSpy).not.toHaveBeenCalled();
    expect(panel.input.value).toBe('');
    expect(toastText()).toBe('');
  });

  test('with a session shown, the skill runs as a turn in it', async () => {
    panel._sessionStore.setActive('s_skill001');
    await send('/tidy-tabs close the dupes');
    expect(calls('skills:run')).toEqual([['skills:run', { name: 'tidy-tabs', task: 'close the dupes', webContentsId: 4242, sessionId: 's_skill001' }]]);
  });

  test('a bare /skill sends no task', async () => {
    await send('/tidy-tabs');
    expect(calls('skills:run')).toEqual([['skills:run', { name: 'tidy-tabs', webContentsId: 4242 }]]);
  });

  test('an unknown /word stays plain text for the run path', async () => {
    await send('/tidyup the desk');
    expect(calls('skills:run')).toEqual([]);
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(panel.input.value).toBe('/tidyup the desk');
  });

  test('a built-in slash action goes straight to the run path without a skill lookup', () => {
    panel.input.value = '/summarize this page';
    panel.runBtn.click();
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(calls('commands:list')).toEqual([]);
    expect(calls('skills:run')).toEqual([]);
  });

  test('a rejected skills:run shows an error toast and puts the text back', async () => {
    handlers['skills:run'] = () => { throw new Error('ipc channel closed'); };
    await send('/tidy-tabs close the dupes');
    expect(toastText()).toContain('Couldn’t run /tidy-tabs: ipc channel closed');
    expect(panel.input.value).toBe('/tidy-tabs close the dupes');
    expect(runSpy).not.toHaveBeenCalled();
  });

  test('main refusing the run ({ok:false}) is surfaced the same way', async () => {
    handlers['skills:run'] = () => ({ ok: false, error: 'Agent already running' });
    await send('/tidy-tabs');
    expect(toastText()).toContain('Couldn’t run /tidy-tabs: Agent already running');
    expect(panel.input.value).toBe('/tidy-tabs');
  });

  test('a /skill with no resolvable webview shows the plain-language no-tab toast', async () => {
    panel._agentLane.resolveTargetWebview = jest.fn(() => null);
    await send('/tidy-tabs');
    expect(toastText()).toContain('Couldn’t run /tidy-tabs: No tab is open. Open a tab first.');
    expect(calls('skills:run')).toEqual([]);
    expect(runSpy).not.toHaveBeenCalled();
    expect(panel.input.value).toBe('/tidy-tabs');
  });

  test('a failed skill lookup shows an error and sends nothing', async () => {
    handlers['commands:list'] = () => ({ ok: false, error: 'skills_unavailable' });
    await send('/tidy-tabs');
    expect(toastText()).toContain('Couldn’t check the /tidy-tabs skill: skills_unavailable');
    expect(calls('skills:run')).toEqual([]);
    expect(runSpy).not.toHaveBeenCalled();
  });

  test('a second send while the first is resolving does not start the skill twice', async () => {
    panel.input.value = '/tidy-tabs';
    panel.runBtn.click();
    panel.runBtn.click();
    await flush(); await flush();
    expect(calls('skills:run')).toHaveLength(1);
  });

  test('a tab-scoped panel runs the skill through the agent lane, naming it for agent.use_skill', async () => {
    const tabWv = document.createElement('div');
    tabWv.id = 'tab-skill';
    tabWv.getWebContentsId = jest.fn(() => 77);
    document.body.appendChild(tabWv);
    panel.open({ scope: 'tab', tabId: 'tab-skill' });
    await send('/tidy-tabs close the dupes');
    expect(calls('skills:run')).toEqual([]);
    const start = calls('agent:start');
    expect(start).toHaveLength(1);
    expect(start[0][1]).toMatchObject({ webContentsId: 77, scope: 'tab', tabId: 'tab-skill' });
    expect(start[0][1].description).toContain('Use the "tidy-tabs" skill (load it with agent.use_skill)');
    expect(start[0][1].description).toContain('Task: close the dupes');
  });
});

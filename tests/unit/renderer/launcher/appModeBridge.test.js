// appModeBridge — main window handling of 'app-mode:set' from the launcher.
// Drives a real ViewShellManager over a real ShellStore; only the agent panel
// (the shell's attached UI host) is a test double.
const { handleAppModeSet } = require('../../../../renderer/launcher/appModeBridge');
const { ShellStore } = require('../../../../renderer/core/ShellStore');
const { ViewShellManager } = require('../../../../renderer/managers/ViewShellManager');

function makeShell() {
  const cfg = {};
  const bridge = {
    get: (key, fallback) => (key in cfg ? cfg[key] : fallback),
    set: (key, value) => { cfg[key] = value; },
  };
  const store = new ShellStore({ bridge });
  store.hydrate();
  const viewShell = new ViewShellManager({ store, getContext: () => ({}) });
  const mockPanel = {
    focusComposer: jest.fn(),
    getContent: () => document.createElement('div'),
    open: jest.fn((opts) => { if (opts && opts.mode === 'assistant') viewShell.setMode('assistant', { focus: false }); mockPanel.focusComposer(); }),
  };
  viewShell.attachPanel(mockPanel);
  return { viewShell, mockPanel };
}

describe('handleAppModeSet', () => {
  test('assistant mode flips the shell and focuses the composer', () => {
    const { viewShell, mockPanel } = makeShell();
    expect(viewShell.getMode()).toBe('browser');
    const res = handleAppModeSet({ mode: 'assistant' }, { viewShell, agentPanel: mockPanel });
    expect(res).toEqual({ ok: true });
    expect(viewShell.getMode()).toBe('assistant');
    expect(mockPanel.focusComposer).toHaveBeenCalled();
  });

  test('loads the session when the panel exposes loadSession', () => {
    const { viewShell, mockPanel } = makeShell();
    mockPanel.loadSession = jest.fn();
    const res = handleAppModeSet({ mode: 'assistant', sessionId: 's_abc12345' }, { viewShell, agentPanel: mockPanel });
    expect(res).toEqual({ ok: true, sessionLoaded: true });
    expect(mockPanel.loadSession).toHaveBeenCalledWith('s_abc12345');
  });

  test('reports an unloaded session when the panel has no loadSession hook', () => {
    const { viewShell, mockPanel } = makeShell();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = handleAppModeSet({ mode: 'assistant', sessionId: 's_abc12345' }, { viewShell, agentPanel: mockPanel });
    expect(res).toEqual({ ok: true, sessionLoaded: false });
    expect(viewShell.getMode()).toBe('assistant');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('s_abc12345'));
  });

  test('browser mode flips back', () => {
    const { viewShell, mockPanel } = makeShell();
    handleAppModeSet({ mode: 'assistant' }, { viewShell, agentPanel: mockPanel });
    expect(handleAppModeSet({ mode: 'browser' }, { viewShell, agentPanel: mockPanel })).toEqual({ ok: true });
    expect(viewShell.getMode()).toBe('browser');
  });

  test.each([[null], [{}], [{ mode: 'settings' }]])('rejects an invalid mode %#', (payload) => {
    const { viewShell, mockPanel } = makeShell();
    expect(handleAppModeSet(payload, { viewShell, agentPanel: mockPanel })).toEqual({ ok: false, error: 'invalid_mode' });
    expect(viewShell.getMode()).toBe('browser');
    expect(mockPanel.open).not.toHaveBeenCalled();
  });

  test('rejects a malformed session id before changing anything', () => {
    const { viewShell, mockPanel } = makeShell();
    mockPanel.loadSession = jest.fn();
    const res = handleAppModeSet({ mode: 'assistant', sessionId: '../../x' }, { viewShell, agentPanel: mockPanel });
    expect(res).toEqual({ ok: false, error: 'invalid_session_id' });
    expect(viewShell.getMode()).toBe('browser');
    expect(mockPanel.loadSession).not.toHaveBeenCalled();
  });
});

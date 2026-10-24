/**
 * @jest-environment jsdom
 */

// ReattachPrompt — shown when the agent's tab closes mid-run. External
// boundary mocked: electron.ipcRenderer (invoke/send). The injected
// getContext() callback is a fake supplying a navigationManager + webview.

jest.mock('electron', () => ({
  ipcRenderer: {
    invoke: jest.fn(),
    send: jest.fn(),
    on: jest.fn(),
  },
}));

const { ipcRenderer } = require('electron');
const ReattachPrompt = require('../../../../../renderer/components/agent/ReattachPrompt');

function makeRoot() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return root;
}

function makeContext(webContentsId, { throwOnId = false, missing = false } = {}) {
  const wv = missing ? null : {
    getWebContentsId: throwOnId
      ? () => { throw new Error('boom'); }
      : () => webContentsId,
  };
  return {
    navigationManager: { getActiveWebview: () => wv },
  };
}

describe('ReattachPrompt', () => {
  beforeEach(() => {
    document.body.textContent = '';
    ipcRenderer.invoke.mockReset();
    ipcRenderer.send.mockReset();
  });

  afterEach(() => {
    document.body.textContent = '';
  });

  test('builds the prompt, appends it to root, and starts hidden', () => {
    const root = makeRoot();
    const p = new ReattachPrompt({ root, getContext: () => null });
    const el = root.querySelector('.agent-reattach');
    expect(el).not.toBeNull();
    expect(el.getAttribute('aria-live')).toBe('assertive');
    expect(el.querySelector('.agent-reattach-title').textContent)
      .toBe('The tab the agent was using closed.');
    expect(el.hidden).toBe(true);
    expect(el.classList.contains('is-open')).toBe(false);
    expect(p).toBeInstanceOf(ReattachPrompt);
  });

  test('show() reveals the prompt, hide() conceals it', () => {
    const root = makeRoot();
    const p = new ReattachPrompt({ root, getContext: () => null });
    const el = root.querySelector('.agent-reattach');
    p.show();
    expect(el.hidden).toBe(false);
    expect(el.classList.contains('is-open')).toBe(true);
    p.hide();
    expect(el.hidden).toBe(true);
    expect(el.classList.contains('is-open')).toBe(false);
  });

  test('Re-attach to active tab invokes agent:reattach with the webContents id and hides on ok', async () => {
    const root = makeRoot();
    ipcRenderer.invoke.mockResolvedValue({ ok: true });
    const p = new ReattachPrompt({ root, getContext: () => makeContext(42) });
    p.show();
    root.querySelector('[data-action="active"]').click();
    await Promise.resolve(); await Promise.resolve();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('agent:reattach', { webContentsId: 42 });
    expect(root.querySelector('.agent-reattach').hidden).toBe(true);
    expect(root.querySelector('.agent-reattach-error')).toBeNull();
  });

  test('reattach failure (result.ok false) shows the returned error and stays open', async () => {
    const root = makeRoot();
    ipcRenderer.invoke.mockResolvedValue({ ok: false, error: 'session gone' });
    const p = new ReattachPrompt({ root, getContext: () => makeContext(7) });
    p.show();
    root.querySelector('[data-action="active"]').click();
    await Promise.resolve(); await Promise.resolve();
    const err = root.querySelector('.agent-reattach-error');
    expect(err).not.toBeNull();
    expect(err.textContent).toBe('session gone');
    expect(root.querySelector('.agent-reattach').hidden).toBe(false);
  });

  test('reattach IPC rejection shows the thrown error message', async () => {
    const root = makeRoot();
    ipcRenderer.invoke.mockRejectedValue(new Error('ipc exploded'));
    const p = new ReattachPrompt({ root, getContext: () => makeContext(9) });
    p.show();
    root.querySelector('[data-action="active"]').click();
    await Promise.resolve(); await Promise.resolve();
    expect(root.querySelector('.agent-reattach-error').textContent).toBe('ipc exploded');
  });

  test('no active webview surfaces a guidance error and never calls invoke', async () => {
    const root = makeRoot();
    const p = new ReattachPrompt({ root, getContext: () => makeContext(0, { missing: true }) });
    p.show();
    root.querySelector('[data-action="active"]').click();
    await Promise.resolve();
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    expect(root.querySelector('.agent-reattach-error').textContent)
      .toBe('No active webview to re-attach to. Open a tab first.');
  });

  test('getWebContentsId throwing surfaces the resolve error and never calls invoke', async () => {
    const root = makeRoot();
    const p = new ReattachPrompt({ root, getContext: () => makeContext(1, { throwOnId: true }) });
    p.show();
    root.querySelector('[data-action="active"]').click();
    await Promise.resolve();
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    expect(root.querySelector('.agent-reattach-error').textContent)
      .toBe('Cannot resolve webview id: boom');
  });

  test('Abort run sends agent:stop and hides the prompt', () => {
    const root = makeRoot();
    const p = new ReattachPrompt({ root, getContext: () => makeContext(3) });
    p.show();
    root.querySelector('[data-action="abort"]').click();
    expect(ipcRenderer.send).toHaveBeenCalledWith('agent:stop');
    expect(root.querySelector('.agent-reattach').hidden).toBe(true);
  });

  test('error message is HTML-escaped (no injected element)', async () => {
    const root = makeRoot();
    ipcRenderer.invoke.mockResolvedValue({ ok: false, error: '<img src=x onerror=1>' });
    const p = new ReattachPrompt({ root, getContext: () => makeContext(5) });
    p.show();
    root.querySelector('[data-action="active"]').click();
    await Promise.resolve(); await Promise.resolve();
    const err = root.querySelector('.agent-reattach-error');
    expect(err.querySelector('img')).toBeNull();
    expect(err.textContent).toBe('<img src=x onerror=1>');
  });
});

/**
 * @jest-environment jsdom
 */

// SiteBlockedPrompt — singleton modal queue driven by 'site-blocked:show';
// replies via 'site-blocked:retry' (send) and 'site-allowlist:add' (invoke).
// External boundary: electron.ipcRenderer as a real EventEmitter so requests
// can be delivered and replies observed. Fresh singleton per test via
// jest.resetModules(); fake timers drive trap()'s deferred setTimeout(0).

let bus;
jest.mock('electron', () => {
  const { EventEmitter: EE } = require('events');
  const em = new EE();
  em.__sent = [];
  em.send = jest.fn((channel, payload) => { em.__sent.push({ channel, payload }); });
  em.invoke = jest.fn(() => Promise.resolve());
  global.__sbBus = em;
  return { ipcRenderer: em };
});

function fresh() {
  jest.resetModules();
  const prompt = require('../../../../renderer/components/SiteBlockedPrompt');
  bus = global.__sbBus;
  return prompt;
}

function deliver(request) {
  bus.emit('site-blocked:show', { sender: bus }, request);
}

describe('SiteBlockedPrompt', () => {
  let prompt;

  beforeEach(() => {
    jest.useFakeTimers();
    document.body.textContent = '';
    prompt = fresh();
    bus.send.mockClear();
    bus.invoke.mockClear();
    bus.invoke.mockResolvedValue(undefined);
    bus.__sent.length = 0;
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    bus.removeAllListeners();
    document.body.textContent = '';
  });

  test('initialize() wires the IPC listener exactly once', () => {
    expect(bus.listenerCount('site-blocked:show')).toBe(0);
    prompt.initialize();
    prompt.initialize();
    expect(bus.listenerCount('site-blocked:show')).toBe(1);
  });

  test('a request without a url is ignored (no overlay)', () => {
    prompt.initialize();
    deliver({ errorCode: -20 });
    expect(document.querySelector('.site-blocked-overlay')).toBeNull();
  });

  test('app-blocked error (-20) shows the hostname, mapped copy, and the allowlist button', () => {
    prompt.initialize();
    deliver({ url: 'https://tracker.example.com/path', errorCode: -20, webContentsId: 11 });
    const overlay = document.querySelector('.site-blocked-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.querySelector('.permission-prompt-origin').textContent)
      .toBe('tracker.example.com');
    expect(overlay.querySelector('.permission-prompt-detail').textContent)
      .toBe('The site was blocked by the in-app ad/tracker filter.');
    expect(overlay.querySelector('.site-blocked-allowlist')).not.toBeNull();
    expect(overlay.querySelector('.site-blocked-allowlist-hint')).not.toBeNull();
  });

  test('non-app error (-105 DNS) shows mapped copy and NO allowlist button', () => {
    prompt.initialize();
    deliver({ url: 'https://gone.example', errorCode: -105, webContentsId: 2 });
    const overlay = document.querySelector('.site-blocked-overlay');
    expect(overlay.querySelector('.permission-prompt-detail').textContent)
      .toBe('The site\'s address could not be resolved (DNS).');
    expect(overlay.querySelector('.site-blocked-allowlist')).toBeNull();
    expect(overlay.querySelector('.site-blocked-allowlist-hint')).toBeNull();
  });

  test('unknown error code falls back to the raw errorDescription', () => {
    prompt.initialize();
    deliver({ url: 'https://x.example', errorCode: -99999, errorDescription: 'ERR_WEIRD', webContentsId: 3 });
    expect(document.querySelector('.permission-prompt-detail').textContent)
      .toBe('This site couldn\'t be loaded (ERR_WEIRD).');
  });

  test('Retry sends site-blocked:retry with the webContentsId and tears down', () => {
    prompt.initialize();
    deliver({ url: 'https://x.example', errorCode: -105, webContentsId: 77 });
    document.querySelector('.site-blocked-retry').click();
    expect(bus.send).toHaveBeenCalledWith('site-blocked:retry', { webContentsId: 77 });
    expect(document.querySelector('.site-blocked-overlay')).toBeNull();
  });

  test('a failed HTTPS-only upgrade offers Continue over HTTP, which asks main to load it', () => {
    prompt.initialize();
    deliver({ url: 'https://plain.example/', errorCode: -105, webContentsId: 41, httpFallback: 'http://plain.example/' });
    expect(document.querySelector('.site-blocked-http-hint')).not.toBeNull();
    document.querySelector('.site-blocked-http').click();
    expect(bus.send).toHaveBeenCalledWith('site-blocked:continue-http', { webContentsId: 41 });
    expect(document.querySelector('.site-blocked-overlay')).toBeNull();
  });

  test('an HTTPS page that redirected back to HTTP is not blamed on the ad blocker', () => {
    prompt.initialize();
    deliver({
      url: 'http://legacy.example/home', errorCode: -20, webContentsId: 42,
      httpFallback: 'http://legacy.example/home', httpsDowngrade: true,
    });
    const detail = document.querySelector('.permission-prompt-detail').textContent;
    expect(detail).not.toMatch(/ad\/tracker filter/);
    expect(detail).toMatch(/back to HTTP/);
    expect(document.querySelector('.site-blocked-allowlist')).toBeNull();
    expect(document.querySelector('.site-blocked-allowlist-hint')).toBeNull();
    // Retrying would hit the same redirect, so HTTP is the only way forward.
    expect(document.querySelector('.site-blocked-retry')).toBeNull();
    jest.advanceTimersByTime(0);
    expect(document.activeElement).toBe(document.querySelector('.site-blocked-http'));
  });

  test('an ordinary load failure has no HTTP option', () => {
    prompt.initialize();
    deliver({ url: 'https://x.example', errorCode: -105, webContentsId: 6, httpFallback: null });
    expect(document.querySelector('.site-blocked-http')).toBeNull();
    expect(document.querySelector('.site-blocked-http-hint')).toBeNull();
  });

  test('Close tears down without sending retry or invoking allowlist', () => {
    prompt.initialize();
    deliver({ url: 'https://x.example', errorCode: -105, webContentsId: 5 });
    document.querySelector('.site-blocked-close').click();
    expect(bus.send).not.toHaveBeenCalled();
    expect(bus.invoke).not.toHaveBeenCalled();
    expect(document.querySelector('.site-blocked-overlay')).toBeNull();
  });

  test('Add to allowlist invokes site-allowlist:add then retries', async () => {
    bus.invoke.mockResolvedValueOnce({ ok: true, hostname: 'ads.example.com', list: ['ads.example.com'] });
    prompt.initialize();
    deliver({ url: 'https://ads.example.com', errorCode: -20, webContentsId: 9 });
    document.querySelector('.site-blocked-allowlist').click();
    expect(bus.invoke).toHaveBeenCalledWith('site-allowlist:add', 'ads.example.com');
    await Promise.resolve(); await Promise.resolve();
    expect(bus.send).toHaveBeenCalledWith('site-blocked:retry', { webContentsId: 9 });
  });

  test('an allowlist the main side refused is reported and the page is not retried', async () => {
    bus.invoke.mockResolvedValueOnce({ ok: false, error: 'The ad blocker could not apply the change: engine down' });
    prompt.initialize();
    deliver({ url: 'https://ads.example.com', errorCode: -20, webContentsId: 9 });
    document.querySelector('.site-blocked-allowlist').click();
    await Promise.resolve(); await Promise.resolve();
    expect(bus.send).not.toHaveBeenCalledWith('site-blocked:retry', expect.anything());
    expect(document.querySelector('.toast-error').textContent).toContain('engine down');
  });

  test('Escape closes (no retry); Enter triggers the primary button (retry)', () => {
    prompt.initialize();
    deliver({ url: 'https://x.example', errorCode: -105, webContentsId: 8 });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(bus.send).not.toHaveBeenCalled();
    expect(document.querySelector('.site-blocked-overlay')).toBeNull();

    deliver({ url: 'https://y.example', errorCode: -105, webContentsId: 12 });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(bus.send).toHaveBeenCalledWith('site-blocked:retry', { webContentsId: 12 });
  });

  test('Enter prefers the allowlist button when present', () => {
    prompt.initialize();
    deliver({ url: 'https://ads.example.com', errorCode: -20, webContentsId: 4 });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(bus.invoke).toHaveBeenCalledWith('site-allowlist:add', 'ads.example.com');
  });

  test('mousedown on the backdrop closes', () => {
    prompt.initialize();
    deliver({ url: 'https://x.example', errorCode: -105, webContentsId: 6 });
    const overlay = document.querySelector('.site-blocked-overlay');
    overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.querySelector('.site-blocked-overlay')).toBeNull();
  });

  test('duplicate (webContents, host) failures are coalesced into one modal', () => {
    prompt.initialize();
    deliver({ url: 'https://dup.example/a', errorCode: -105, webContentsId: 1 });
    deliver({ url: 'https://dup.example/b', errorCode: -105, webContentsId: 1 });
    expect(document.querySelectorAll('.site-blocked-overlay')).toHaveLength(1);
  });

  test('after resolving, the same (webContents, host) can prompt again', () => {
    prompt.initialize();
    deliver({ url: 'https://dup.example', errorCode: -105, webContentsId: 1 });
    document.querySelector('.site-blocked-close').click();
    expect(document.querySelector('.site-blocked-overlay')).toBeNull();
    deliver({ url: 'https://dup.example', errorCode: -105, webContentsId: 1 });
    expect(document.querySelectorAll('.site-blocked-overlay')).toHaveLength(1);
  });

  test('distinct hosts queue and show one at a time', () => {
    prompt.initialize();
    deliver({ url: 'https://one.example', errorCode: -105, webContentsId: 1 });
    deliver({ url: 'https://two.example', errorCode: -105, webContentsId: 2 });
    expect(document.querySelectorAll('.site-blocked-overlay')).toHaveLength(1);
    expect(document.querySelector('.permission-prompt-origin').textContent).toBe('one.example');
    document.querySelector('.site-blocked-close').click();
    expect(document.querySelectorAll('.site-blocked-overlay')).toHaveLength(1);
    expect(document.querySelector('.permission-prompt-origin').textContent).toBe('two.example');
  });

  test('no DOM body → drops the request and frees the inflight key', () => {
    prompt.initialize();
    const realBody = document.body;
    Object.defineProperty(document, 'body', { value: null, configurable: true });
    try {
      deliver({ url: 'https://x.example', errorCode: -105, webContentsId: 1 });
    } finally {
      Object.defineProperty(document, 'body', { value: realBody, configurable: true });
    }
    expect(document.querySelector('.site-blocked-overlay')).toBeNull();
    // Key was freed, so the next identical failure can prompt.
    deliver({ url: 'https://x.example', errorCode: -105, webContentsId: 1 });
    expect(document.querySelectorAll('.site-blocked-overlay')).toHaveLength(1);
  });
});

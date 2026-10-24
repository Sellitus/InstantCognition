// BrowsingPrivacyService — header rewriting, HTTPS-only upgrades and
// clear-cookies-on-quit. Boundaries mocked: Electron session/app/webContents
// (fakes injected through initialize) and the on-disk config store.
jest.mock('../../../../main/services/ConfigService', () => ({ get: jest.fn() }));

const { EventEmitter } = require('events');

let service;
let settings;
let app;
let session;
let listener;
let responseListener;

function fakeConfig() {
  return { get: (path, fallback) => (path in settings ? settings[path] : fallback) };
}

function fakeWebview(url = 'https://news.example/article', type = 'webview') {
  return {
    getType: () => type,
    getURL: () => url,
    isDestroyed: () => false,
    loadURL: jest.fn(() => Promise.resolve()),
  };
}

function request(overrides = {}) {
  return {
    url: 'https://news.example/app.js',
    method: 'GET',
    resourceType: 'script',
    requestHeaders: { 'User-Agent': 'UA', Cookie: 'sid=1' },
    ...overrides,
  };
}

function send(details) {
  let response;
  listener(details, (r) => { response = r; });
  return response;
}

beforeEach(() => {
  jest.resetModules();
  service = require('../../../../main/services/BrowsingPrivacyService');
  settings = {};
  app = new EventEmitter();
  app.quit = jest.fn();
  session = {
    defaultSession: {
      webRequest: {
        onBeforeSendHeaders: jest.fn((fn) => { listener = fn; }),
        onHeadersReceived: jest.fn((filter, fn) => { responseListener = fn; }),
      },
      clearStorageData: jest.fn(() => Promise.resolve()),
    },
  };
  service.initialize(fakeConfig(), { app, session });
});

describe('request headers', () => {
  test('with every toggle off, requests pass through unchanged', () => {
    const details = request({ webContents: fakeWebview(), url: 'https://cdn.tracker.example/p.gif' });
    expect(send(details)).toEqual({ requestHeaders: details.requestHeaders });
  });

  test('Do Not Track sends DNT and Sec-GPC', () => {
    settings['settings.doNotTrack'] = true;
    const { requestHeaders } = send(request());
    expect(requestHeaders).toMatchObject({ DNT: '1', 'Sec-GPC': '1', 'User-Agent': 'UA' });
  });

  test('blocking third-party cookies strips Cookie from a cross-site subresource', () => {
    settings['settings.blockThirdPartyCookies'] = true;
    const { requestHeaders } = send(request({ webContents: fakeWebview(), url: 'https://ads.tracker.example/p.gif' }));
    expect(requestHeaders).toEqual({ 'User-Agent': 'UA' });
  });

  test('a lower-case cookie header name is stripped too', () => {
    settings['settings.blockThirdPartyCookies'] = true;
    const details = request({
      webContents: fakeWebview(), url: 'https://ads.tracker.example/p.gif', requestHeaders: { cookie: 'a=1' },
    });
    expect(send(details).requestHeaders).toEqual({});
  });

  test('same-site subdomains keep their cookies', () => {
    settings['settings.blockThirdPartyCookies'] = true;
    const { requestHeaders } = send(request({ webContents: fakeWebview(), url: 'https://static.news.example/x.css' }));
    expect(requestHeaders.Cookie).toBe('sid=1');
  });

  test('different sites under one private suffix are third parties to each other', () => {
    settings['settings.blockThirdPartyCookies'] = true;
    const details = request({ webContents: fakeWebview('https://alice.github.io/'), url: 'https://bob.github.io/x.js' });
    expect(send(details).requestHeaders.Cookie).toBeUndefined();
  });

  test('the top-level page request itself keeps its cookies', () => {
    settings['settings.blockThirdPartyCookies'] = true;
    const details = request({ webContents: fakeWebview(), resourceType: 'mainFrame', url: 'https://other.example/' });
    expect(send(details).requestHeaders.Cookie).toBe('sid=1');
  });

  test('a same-site WebSocket keeps its cookies and a cross-site one loses them', () => {
    settings['settings.blockThirdPartyCookies'] = true;
    const own = request({ webContents: fakeWebview(), resourceType: 'webSocket', url: 'wss://live.news.example/feed' });
    expect(send(own).requestHeaders.Cookie).toBe('sid=1');
    const other = request({ webContents: fakeWebview(), resourceType: 'webSocket', url: 'wss://push.tracker.example/' });
    expect(send(other).requestHeaders.Cookie).toBeUndefined();
  });

  test('requests with no webview (main-process fetches) are not cookie-filtered', () => {
    settings['settings.blockThirdPartyCookies'] = true;
    expect(send(request({ url: 'https://api.other.example/v1' })).requestHeaders.Cookie).toBe('sid=1');
  });

  test('a worker request with no webview is judged by the origin that issued it, referrer or not', () => {
    settings['settings.blockThirdPartyCookies'] = true;
    const crossSite = request({ url: 'https://ads.tracker.example/sync', initiatorOrigin: 'https://news.example', referrer: '' });
    expect(send(crossSite).requestHeaders.Cookie).toBeUndefined();
    const sameSite = request({ url: 'https://api.news.example/feed', initiatorOrigin: 'https://news.example', referrer: '' });
    expect(send(sameSite).requestHeaders.Cookie).toBe('sid=1');
  });

  test('a same-site worker request keeps its cookies even when its referrer is another site', () => {
    settings['settings.blockThirdPartyCookies'] = true;
    const details = request({
      url: 'https://news.example/account', initiatorOrigin: 'https://news.example', referrer: 'https://search.example/results',
    });
    expect(send(details).requestHeaders.Cookie).toBe('sid=1');
  });

  test.each(['mainFrame', 'subFrame'])('a %s document a service worker forwards keeps its own cookies', (resourceType) => {
    settings['settings.blockThirdPartyCookies'] = true;
    const details = request({
      url: 'https://news.example/', resourceType, initiatorOrigin: 'https://search.example', referrer: 'https://search.example/',
    });
    expect(send(details).requestHeaders.Cookie).toBe('sid=1');
  });

  test('a cross-site frame inside a webview still loses its cookies', () => {
    settings['settings.blockThirdPartyCookies'] = true;
    const details = request({ webContents: fakeWebview(), resourceType: 'subFrame', url: 'https://ads.tracker.example/frame' });
    expect(send(details).requestHeaders.Cookie).toBeUndefined();
  });
});

describe('response Set-Cookie', () => {
  function respond(details) {
    let response;
    let calls = 0;
    responseListener(details, (r) => { response = r; calls += 1; });
    expect(calls).toBe(1);
    return response;
  }

  function response(overrides = {}) {
    return {
      url: 'https://ads.tracker.example/p.gif',
      method: 'GET',
      resourceType: 'image',
      webContents: fakeWebview(),
      responseHeaders: { 'Set-Cookie': ['uid=1'], 'set-cookie': ['b=2'], 'Content-Type': ['image/gif'] },
      ...overrides,
    };
  }

  test('the listener covers every URL of the session', () => {
    expect(session.defaultSession.webRequest.onHeadersReceived)
      .toHaveBeenCalledWith({ urls: ['<all_urls>'] }, expect.any(Function));
  });

  test('a cross-site subresource response loses Set-Cookie in any casing', () => {
    settings['settings.blockThirdPartyCookies'] = true;
    expect(respond(response())).toEqual({ responseHeaders: { 'Content-Type': ['image/gif'] } });
  });

  test('same-site, top-level and setting-off responses keep their cookies', () => {
    expect(respond(response())).toEqual({});
    settings['settings.blockThirdPartyCookies'] = true;
    expect(respond(response({ url: 'https://static.news.example/x.css' }))).toEqual({});
    expect(respond(response({ resourceType: 'mainFrame', url: 'https://other.example/' }))).toEqual({});
  });

  test('a worker response with no webview is judged by its initiator; with no initiator it is left alone', () => {
    settings['settings.blockThirdPartyCookies'] = true;
    const worker = response({ webContents: undefined, initiatorOrigin: 'https://news.example', referrer: '' });
    expect(respond(worker).responseHeaders).toEqual({ 'Content-Type': ['image/gif'] });
    expect(respond(response({ webContents: undefined, initiatorOrigin: 'https://www.tracker.example', referrer: 'https://news.example/' }))).toEqual({});
    expect(respond(response({ webContents: undefined, referrer: 'https://news.example/' }))).toEqual({});
    const forwardedDoc = response({ webContents: undefined, resourceType: 'subFrame', initiatorOrigin: 'https://news.example' });
    expect(respond(forwardedDoc)).toEqual({});
  });

  test('with the ad blocker on, its result runs first and Set-Cookie is stripped from it', () => {
    settings['settings.blockThirdPartyCookies'] = true;
    const blocker = {
      onHeadersReceived: jest.fn((details, cb) => cb({
        responseHeaders: { ...details.responseHeaders, 'content-security-policy': ['script-src none'] },
      })),
    };
    service.setResponseBlocker(session.defaultSession, blocker);
    const details = response();
    expect(respond(details)).toEqual({
      responseHeaders: { 'Content-Type': ['image/gif'], 'content-security-policy': ['script-src none'] },
    });
    expect(blocker.onHeadersReceived).toHaveBeenCalledWith(details, expect.any(Function));
  });

  test('a blocker result with no headers falls back to the response headers', () => {
    settings['settings.blockThirdPartyCookies'] = true;
    service.setResponseBlocker(session.defaultSession, { onHeadersReceived: (d, cb) => cb({}) });
    expect(respond(response())).toEqual({ responseHeaders: { 'Content-Type': ['image/gif'] } });
  });

  test('a cancel from the blocker passes through untouched', () => {
    settings['settings.blockThirdPartyCookies'] = true;
    service.setResponseBlocker(session.defaultSession, { onHeadersReceived: (d, cb) => cb({ cancel: true }) });
    expect(respond(response())).toEqual({ cancel: true });
  });

  test('clearing the blocker re-registers a listener that no longer calls it', () => {
    const blocker = { onHeadersReceived: jest.fn((d, cb) => cb({})) };
    service.setResponseBlocker(session.defaultSession, blocker);
    service.setResponseBlocker(session.defaultSession, null);
    expect(session.defaultSession.webRequest.onHeadersReceived).toHaveBeenCalledTimes(3);
    settings['settings.blockThirdPartyCookies'] = true;
    expect(respond(response()).responseHeaders).toEqual({ 'Content-Type': ['image/gif'] });
    expect(blocker.onHeadersReceived).not.toHaveBeenCalled();
  });
});

describe('HTTPS-only', () => {
  beforeEach(() => { settings['settings.httpsOnly'] = true; });

  async function settle() { await new Promise((r) => setImmediate(r)); }

  test('an http page load is cancelled and reloaded over https', async () => {
    const wc = fakeWebview();
    expect(send(request({ webContents: wc, resourceType: 'mainFrame', url: 'http://plain.example/a?b=1' })))
      .toEqual({ cancel: true });
    await settle();
    expect(wc.loadURL).toHaveBeenCalledWith('https://plain.example/a?b=1');
    expect(service.isUpgradeCancel(wc, 'http://plain.example/a?b=1')).toBe(true);
  });

  test('off by default: http loads are left alone', () => {
    settings['settings.httpsOnly'] = false;
    const res = send(request({ webContents: fakeWebview(), resourceType: 'mainFrame', url: 'http://plain.example/' }));
    expect(res.cancel).toBeUndefined();
  });

  test.each([
    'http://localhost:3000/', 'http://127.0.0.1:7860/', 'http://192.168.1.1/', 'http://10.0.0.8/',
    'http://172.20.0.1/', 'http://printer.local/', 'http://router/', 'http://[::1]:8080/',
    'http://nas.lan/', 'http://hub.home.arpa/', 'http://build.internal/', 'http://100.101.2.3/',
    'http://169.254.1.1/',
  ])('local host %s is exempt', (url) => {
    const res = send(request({ webContents: fakeWebview(), resourceType: 'mainFrame', url }));
    expect(res.cancel).toBeUndefined();
  });

  test('a public address in 172.x outside the private block is upgraded', () => {
    const res = send(request({ webContents: fakeWebview(), resourceType: 'mainFrame', url: 'http://172.32.0.1/' }));
    expect(res).toEqual({ cancel: true });
  });

  test('a space configured with an http URL is exempt', () => {
    settings.spaces = { s1: { url: 'http://intranet.corp.example:8080/' } };
    const res = send(request({ webContents: fakeWebview(), resourceType: 'mainFrame', url: 'http://intranet.corp.example:8080/x' }));
    expect(res.cancel).toBeUndefined();
  });

  test('a form POST over http is not replayed as a GET', () => {
    const res = send(request({ webContents: fakeWebview(), resourceType: 'mainFrame', method: 'POST', url: 'http://plain.example/login' }));
    expect(res.cancel).toBeUndefined();
  });

  test('subresources and non-webview contents are not upgraded', () => {
    expect(send(request({ webContents: fakeWebview(), url: 'http://plain.example/x.js' })).cancel).toBeUndefined();
    const shell = fakeWebview('file:///index.html', 'window');
    expect(send(request({ webContents: shell, resourceType: 'mainFrame', url: 'http://plain.example/' })).cancel).toBeUndefined();
  });

  test('a failed upgrade offers the original http URL, and continuing exempts the host', async () => {
    const wc = fakeWebview();
    send(request({ webContents: wc, resourceType: 'mainFrame', url: 'http://plain.example/page' }));
    expect(service.httpFallbackFor(wc, 'https://plain.example/page')).toBe('http://plain.example/page');
    expect(service.httpFallbackFor(wc, 'https://elsewhere.example/')).toBeNull();

    expect(service.continueOverHttp(wc)).toBe(true);
    expect(wc.loadURL).toHaveBeenLastCalledWith('http://plain.example/page');
    const again = send(request({ webContents: wc, resourceType: 'mainFrame', url: 'http://plain.example/other' }));
    expect(again.cancel).toBeUndefined();
    expect(service.continueOverHttp(wc)).toBe(false);
  });

  test('an https page that redirects back to http stops and offers http instead of looping', async () => {
    const wc = fakeWebview();
    send(request({ id: 1, webContents: wc, resourceType: 'mainFrame', url: 'http://legacy.example/' }));
    await settle();
    expect(send(request({ id: 2, webContents: wc, resourceType: 'mainFrame', url: 'https://legacy.example/' })).cancel).toBeUndefined();
    // The server's 301 to http arrives on the same request.
    expect(send(request({ id: 2, webContents: wc, resourceType: 'mainFrame', url: 'http://legacy.example/home' })))
      .toEqual({ cancel: true });
    await settle();
    expect(wc.loadURL).toHaveBeenCalledTimes(1);
    // That cancel is a real failure the user must see, with HTTP on offer.
    expect(service.isUpgradeCancel(wc, 'http://legacy.example/home')).toBe(false);
    expect(service.httpFallbackFor(wc, 'http://legacy.example/home')).toBe('http://legacy.example/home');
    expect(service.continueOverHttp(wc)).toBe(true);
    expect(wc.loadURL).toHaveBeenLastCalledWith('http://legacy.example/home');
  });

  test('an https hop between the upgrade and a downgrade (an SSO bounce) still stops the loop', async () => {
    const wc = fakeWebview();
    send(request({ id: 1, webContents: wc, resourceType: 'mainFrame', url: 'http://legacy.example/' }));
    await settle();
    send(request({ id: 2, webContents: wc, resourceType: 'mainFrame', url: 'https://legacy.example/' }));
    expect(send(request({ id: 2, webContents: wc, resourceType: 'mainFrame', url: 'https://sso.example/login' })).cancel)
      .toBeUndefined();
    expect(send(request({ id: 2, webContents: wc, resourceType: 'mainFrame', url: 'http://legacy.example/home' })))
      .toEqual({ cancel: true });
    await settle();
    expect(wc.loadURL).toHaveBeenCalledTimes(1);
    expect(service.isDowngradeCancel(wc, 'http://legacy.example/home')).toBe(true);
    expect(service.isDowngradeCancel(wc, 'https://legacy.example/')).toBe(false);
  });

  test('a cancelled Back/Forward to an http entry drops that entry, so Back does not land on it again', async () => {
    const wc = fakeWebview();
    const entries = ['https://a.example/', 'http://plain.example/', 'https://b.example/'];
    wc.navigationHistory = {
      getActiveIndex: () => 2,
      getAllEntries: () => entries.map((url) => ({ url, title: '' })),
      removeEntryAtIndex: jest.fn((i) => { entries.splice(i, 1); return true; }),
    };
    send(request({ webContents: wc, resourceType: 'mainFrame', url: 'http://plain.example/' }));
    await settle();
    expect(wc.navigationHistory.removeEntryAtIndex).toHaveBeenCalledWith(1);
    expect(wc.loadURL).toHaveBeenCalledWith('https://plain.example/');
  });

  test('upgradeTarget rewrites an http URL for callers that load it themselves', () => {
    expect(service.upgradeTarget('http://plain.example/a')).toBe('https://plain.example/a');
    expect(service.upgradeTarget('http://localhost:3000/')).toBe('http://localhost:3000/');
    expect(service.upgradeTarget('https://secure.example/')).toBe('https://secure.example/');
    settings['settings.httpsOnly'] = false;
    expect(service.upgradeTarget('http://plain.example/a')).toBe('http://plain.example/a');
  });

  test('a fresh http navigation on another request is upgraded again, not treated as a downgrade', async () => {
    const wc = fakeWebview();
    send(request({ id: 1, webContents: wc, resourceType: 'mainFrame', url: 'http://plain.example/' }));
    send(request({ id: 2, webContents: wc, resourceType: 'mainFrame', url: 'https://plain.example/' }));
    const res = send(request({ id: 3, webContents: wc, resourceType: 'mainFrame', url: 'http://plain.example/' }));
    expect(res).toEqual({ cancel: true });
    expect(service.isUpgradeCancel(wc, 'http://plain.example/')).toBe(true);
  });

  test('navigating somewhere else drops the pending fallback', () => {
    const wc = fakeWebview();
    send(request({ webContents: wc, resourceType: 'mainFrame', url: 'http://plain.example/page' }));
    send(request({ webContents: wc, resourceType: 'mainFrame', url: 'https://secure.example/' }));
    expect(service.httpFallbackFor(wc, 'https://plain.example/page')).toBeNull();
    expect(service.continueOverHttp(wc)).toBe(false);
  });
});

describe('clear cookies on quit', () => {
  // will-quit fires after every window has closed, so no page can set a cookie
  // after the clear.
  function quit() {
    const event = { preventDefault: jest.fn() };
    app.emit('will-quit', event);
    return event;
  }

  test('before-quit (windows still open) does not clear yet', () => {
    settings['settings.clearCookiesOnQuit'] = true;
    const event = { preventDefault: jest.fn() };
    app.emit('before-quit', event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(session.defaultSession.clearStorageData).not.toHaveBeenCalled();
  });

  test('off: quit proceeds and nothing is cleared', () => {
    expect(quit().preventDefault).not.toHaveBeenCalled();
    expect(session.defaultSession.clearStorageData).not.toHaveBeenCalled();
  });

  test('on: quit waits for cookies to clear, then quits once', async () => {
    settings['settings.clearCookiesOnQuit'] = true;
    expect(quit().preventDefault).toHaveBeenCalled();
    expect(quit().preventDefault).toHaveBeenCalled(); // a second Cmd+Q while clearing
    expect(session.defaultSession.clearStorageData).toHaveBeenCalledTimes(1);
    expect(session.defaultSession.clearStorageData).toHaveBeenCalledWith({ storages: ['cookies'] });
    await new Promise((r) => setImmediate(r));
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(quit().preventDefault).not.toHaveBeenCalled(); // the re-issued quit goes through
  });

  test('a clear that fails is logged and still quits', async () => {
    settings['settings.clearCookiesOnQuit'] = true;
    session.defaultSession.clearStorageData.mockRejectedValue(new Error('disk gone'));
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    quit();
    await new Promise((r) => setImmediate(r));
    expect(err).toHaveBeenCalledWith('[privacy] could not clear cookies before quitting:', expect.any(Error));
    expect(app.quit).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  test('a clear that hangs gives up after the timeout and quits', () => {
    jest.useFakeTimers();
    settings['settings.clearCookiesOnQuit'] = true;
    session.defaultSession.clearStorageData.mockReturnValue(new Promise(() => {}));
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    quit();
    jest.advanceTimersByTime(service.CLEAR_ON_QUIT_TIMEOUT_MS);
    return Promise.resolve().then(() => Promise.resolve()).then(() => {
      expect(app.quit).toHaveBeenCalledTimes(1);
      err.mockRestore();
      jest.useRealTimers();
    });
  });
});

// PermissionService tests — uses jest.mock('electron') to inject a fake
// session object so we can capture the registered permission handlers and
// invoke them as Electron would.

let permissionHandler = null;
let checkHandler = null;

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/tmp-mock') },
  session: {
    defaultSession: {
      setPermissionRequestHandler: jest.fn((fn) => { permissionHandler = fn; }),
      setPermissionCheckHandler: jest.fn((fn) => { checkHandler = fn; }),
    },
  },
}));

let svc;

function makeFakeWebContents(url) {
  return { getURL: () => url };
}

beforeEach(() => {
  jest.resetModules();
  permissionHandler = null;
  checkHandler = null;
  svc = require('../../../../main/services/PermissionService');
  svc.removeAllListeners();
  svc._overrides.clear();
  svc._history = [];
  svc._installed = false;
});

describe('PermissionService', () => {
  test('initialize installs request and check handlers on default session', () => {
    svc.initialize(null);
    expect(typeof permissionHandler).toBe('function');
    expect(typeof checkHandler).toBe('function');
  });

  test('decide() returns deny for unknown permissions by default', () => {
    expect(svc.decide('https://example.com', 'made-up-permission')).toBe('deny');
  });

  test('decide() returns allow for fullscreen by default', () => {
    expect(svc.decide('https://example.com', 'fullscreen')).toBe('allow');
  });

  test('clipboard-read asks first, since any page could otherwise read copied passwords', () => {
    expect(svc.decide('https://example.com', 'clipboard-read')).toBe('prompt');
  });

  test('decide() returns prompt for geolocation by default', () => {
    expect(svc.decide('https://example.com', 'geolocation')).toBe('prompt');
  });

  test('decide() returns deny for hardware-access permissions (usb/hid/serial)', () => {
    expect(svc.decide('https://example.com', 'usb')).toBe('deny');
    expect(svc.decide('https://example.com', 'hid')).toBe('deny');
    expect(svc.decide('https://example.com', 'serial')).toBe('deny');
  });

  test('setOverride() takes precedence over default policy', () => {
    expect(svc.decide('https://x.com', 'usb')).toBe('deny');
    svc.setOverride('https://x.com', 'usb', 'allow');
    expect(svc.decide('https://x.com', 'usb')).toBe('allow');
  });

  test('per-origin override only affects that origin', () => {
    svc.setOverride('https://x.com', 'notifications', 'allow');
    expect(svc.decide('https://x.com', 'notifications')).toBe('allow');
    // Default policy for notifications is 'prompt' — per-origin override
    // must not leak to a different origin.
    expect(svc.decide('https://y.com', 'notifications')).toBe('prompt');
  });

  test('notifications default policy is "prompt"', () => {
    expect(svc.decide('https://example.com', 'notifications')).toBe('prompt');
  });

  test('request handler routes "prompt" decisions through the prompt service', async () => {
    const prompter = {
      requestDecision: jest.fn(() => Promise.resolve('allow')),
    };
    svc.initialize(null, { promptService: prompter });
    const calls = [];
    permissionHandler(
      makeFakeWebContents('https://ask.example'),
      'notifications',
      (granted) => calls.push(granted),
      { requestingUrl: 'https://ask.example' }
    );
    // The callback is invoked after the prompt resolves.
    await new Promise((r) => setImmediate(r));
    expect(prompter.requestDecision).toHaveBeenCalledWith('https://ask.example', 'notifications', undefined, { ephemeral: false });
    expect(calls).toEqual([true]);
  });

  test('request handler denies prompt when no prompt service is wired', async () => {
    svc.initialize(null);
    const calls = [];
    permissionHandler(
      makeFakeWebContents('https://ask.example'),
      'notifications',
      (granted) => calls.push(granted),
      { requestingUrl: 'https://ask.example' }
    );
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual([false]);
  });

  test('a view that has not navigated yet falls back quietly to the wildcard origin', () => {
    // getURL() is '' until the first navigation. That is a normal state, so it
    // must not log a warning on every startup permission check.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(svc._originFromDetails(makeFakeWebContents(''), {})).toBe('*');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('a malformed webContents URL still warns before falling back', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(svc._originFromDetails(makeFakeWebContents('not a url'), {})).toBe('*');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('check handler returns false for "prompt" (sync API, no user yet)', () => {
    svc.initialize(null);
    const allow = checkHandler(makeFakeWebContents('https://x.com'), 'notifications', null, {});
    expect(allow).toBe(false);
  });

  test('global wildcard override applies to all origins', () => {
    svc.setOverride('*', 'notifications', 'allow');
    expect(svc.decide('https://anywhere.com', 'notifications')).toBe('allow');
  });

  test('clearOverride() removes the override', () => {
    svc.setOverride('https://x.com', 'usb', 'allow');
    expect(svc.decide('https://x.com', 'usb')).toBe('allow');
    expect(svc.clearOverride('https://x.com', 'usb')).toBe(true);
    expect(svc.decide('https://x.com', 'usb')).toBe('deny');
  });

  test('setOverride() rejects invalid decisions', () => {
    expect(() => svc.setOverride('https://x.com', 'notifications', 'maybe')).toThrow();
  });

  test('permission request handler invokes callback with correct boolean', () => {
    svc.initialize(null);
    const callbacks = [];
    permissionHandler(makeFakeWebContents('https://x.com'), 'fullscreen', (granted) => callbacks.push(granted), {});
    permissionHandler(makeFakeWebContents('https://x.com'), 'usb', (granted) => callbacks.push(granted), {});
    expect(callbacks).toEqual([true, false]);
  });

  test('check handler returns boolean matching decision', () => {
    svc.initialize(null);
    const allow = checkHandler(makeFakeWebContents('https://x.com'), 'fullscreen', null, {});
    const deny = checkHandler(makeFakeWebContents('https://x.com'), 'usb', null, {});
    expect(allow).toBe(true);
    expect(deny).toBe(false);
  });

  test('decisions are recorded to history', () => {
    svc.initialize(null);
    permissionHandler(makeFakeWebContents('https://x.com'), 'fullscreen', () => {}, {});
    const history = svc.getHistory();
    expect(history.length).toBeGreaterThan(0);
    expect(history[history.length - 1].permission).toBe('fullscreen');
    expect(history[history.length - 1].decision).toBe('allow');
  });

  test('history is capped at 100 entries', () => {
    svc.initialize(null);
    for (let i = 0; i < 150; i++) {
      permissionHandler(makeFakeWebContents('https://x.com'), 'fullscreen', () => {}, {});
    }
    expect(svc.getHistory().length).toBe(100);
  });

  test('emits decision events', () => {
    svc.initialize(null);
    const listener = jest.fn();
    svc.on('decision', listener);
    permissionHandler(makeFakeWebContents('https://x.com'), 'fullscreen', () => {}, {});
    expect(listener).toHaveBeenCalled();
  });

  test('emits override-changed events when override is set', () => {
    const listener = jest.fn();
    svc.on('override-changed', listener);
    svc.setOverride('https://x.com', 'usb', 'allow');
    expect(listener).toHaveBeenCalledWith({ origin: 'https://x.com', permission: 'usb', decision: 'allow' });
  });

  test('initialize loads persisted overrides from configService', () => {
    const fakeConfig = {
      get: jest.fn((key, def) => {
        if (key === 'settings.permissions.overrides') return { 'https://x.com|notifications': 'allow' };
        return def;
      }),
      set: jest.fn(),
    };
    svc.initialize(fakeConfig);
    expect(svc.decide('https://x.com', 'notifications')).toBe('allow');
  });

  test('a session-only override applies to session-only lookups and is never persisted or broadcast', () => {
    const setMock = jest.fn();
    const changed = jest.fn();
    svc.initialize({ get: jest.fn(() => null), set: setMock });
    svc.on('override-changed', changed);
    svc.setOverride('https://x.com', 'geolocation', 'deny', { ephemeral: true });
    expect(svc.decide('https://x.com', 'geolocation', { ephemeral: true })).toBe('deny');
    expect(svc.decide('https://x.com', 'geolocation')).toBe('prompt');
    expect(setMock).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    svc.clearSessionOverrides();
    expect(svc.decide('https://x.com', 'geolocation', { ephemeral: true })).toBe('prompt');
  });

  test('a saved override from normal browsing still applies in the private session', () => {
    svc.setOverride('https://x.com', 'geolocation', 'deny');
    expect(svc.decide('https://x.com', 'geolocation', { ephemeral: true })).toBe('deny');
  });

  test('setOverride persists to configService', () => {
    const setMock = jest.fn();
    const fakeConfig = { get: jest.fn(() => null), set: setMock };
    svc.initialize(fakeConfig);
    svc.setOverride('https://x.com', 'usb', 'allow');
    expect(setMock).toHaveBeenCalledWith('settings.permissions.overrides', expect.any(Object));
  });
});

describe('PermissionService external-app links', () => {
  function request(url, prompter) {
    svc.initialize(null, prompter ? { promptService: prompter } : undefined);
    const calls = [];
    permissionHandler(makeFakeWebContents('https://site.example/page'), 'openExternal', (g) => calls.push(g), { externalURL: url });
    return calls;
  }

  test('a mailto link asks per scheme and shows the target', async () => {
    const prompter = { requestDecision: jest.fn(() => Promise.resolve('allow')) };
    const calls = request('mailto:a@b.example', prompter);
    await new Promise((r) => setImmediate(r));
    expect(prompter.requestDecision).toHaveBeenCalledWith('https://site.example', 'openExternal:mailto', 'mailto:a@b.example', { ephemeral: false });
    expect(calls).toEqual([true]);
  });

  test.each(['file:///Applications/Calculator.app', 'ms-msdt:/id PCWDiagnostic', 'search-ms:query=x', 'smb://host/share', 'not a url'])(
    '%s is refused without asking', (url) => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const prompter = { requestDecision: jest.fn(() => Promise.resolve('allow')) };
      expect(request(url, prompter)).toEqual([false]);
      expect(prompter.requestDecision).not.toHaveBeenCalled();
      warn.mockRestore();
    });

  test('a remembered allow for one scheme does not open another', async () => {
    svc.setOverride('https://site.example', 'openExternal:mailto', 'allow');
    const prompter = { requestDecision: jest.fn(() => Promise.resolve('deny')) };
    const calls = request('zoommtg://zoom.us/join?confno=1', prompter);
    await new Promise((r) => setImmediate(r));
    expect(prompter.requestDecision).toHaveBeenCalledWith('https://site.example', 'openExternal:zoommtg', 'zoommtg://zoom.us/join?confno=1', { ephemeral: false });
    expect(calls).toEqual([false]);
  });

  test('a prompt that fails denies the request and logs', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const prompter = { requestDecision: jest.fn(() => { throw new Error('renderer gone'); }) };
    svc.initialize(null, { promptService: prompter });
    const calls = [];
    permissionHandler(makeFakeWebContents('https://x.example'), 'geolocation', (g) => calls.push(g), {});
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual([false]);
    expect(err).toHaveBeenCalledWith('[permissions] prompt failed, denying:', expect.any(Error));
    err.mockRestore();
  });
});

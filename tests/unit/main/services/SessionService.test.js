// SessionService tests — fakes electron.session and verifies private partition setup.

let svc;
let fakePrivateSession;
let fakeSessionModule;

beforeEach(() => {
  jest.resetModules();
  fakePrivateSession = {
    setPermissionRequestHandler: jest.fn(),
    setPermissionCheckHandler: jest.fn(),
    clearStorageData: jest.fn(async () => {}),
    clearCache: jest.fn(async () => {}),
    clearAuthCache: jest.fn(async () => {}),
  };
  fakeSessionModule = {
    fromPartition: jest.fn(() => fakePrivateSession),
  };
  svc = require('../../../../main/services/SessionService');
  svc._setSessionModule(fakeSessionModule);
  // Reset internal state
  svc._installed = false;
  svc._privateSession = null;
});

describe('SessionService', () => {
  test('initialize creates an in-memory session (no persist: prefix, so nothing reaches disk)', () => {
    svc.initialize({});
    expect(fakeSessionModule.fromPartition).toHaveBeenCalledWith('private', { cache: false });
    expect(svc.isInstalled()).toBe(true);
    expect(svc.getPartitionName()).toBe('private');
    expect(svc.getPartitionName().startsWith('persist:')).toBe(false);
  });

  test('initialize is idempotent', () => {
    svc.initialize({});
    svc.initialize({});
    expect(fakeSessionModule.fromPartition).toHaveBeenCalledTimes(1);
  });

  test('the private session applies the default-session permission policy by origin', () => {
    const permissionService = require('../../../../main/services/PermissionService');
    permissionService._overrides.clear();
    permissionService.setOverride('https://x.com', 'geolocation', 'allow');
    svc.initialize({ permissionService });
    const handler = fakePrivateSession.setPermissionRequestHandler.mock.calls[0][0];
    const granted = jest.fn();
    handler({ getURL: () => 'https://x.com/some/page' }, 'geolocation', granted, { requestingUrl: 'https://x.com/some/page' });
    expect(granted).toHaveBeenCalledWith(true);
    const refused = jest.fn();
    handler({ getURL: () => 'https://x.com/' }, 'usb', refused, {});
    expect(refused).toHaveBeenCalledWith(false);
    const checkHandler = fakePrivateSession.setPermissionCheckHandler.mock.calls[0][0];
    expect(checkHandler({ getURL: () => 'https://x.com/' }, 'geolocation', 'https://x.com', {})).toBe(true);
    expect(checkHandler({ getURL: () => 'https://y.com/' }, 'geolocation', 'https://y.com', {})).toBe(false);
  });

  test('a remembered answer in a private tab lasts only for the private session and never reaches config', async () => {
    const permissionService = require('../../../../main/services/PermissionService');
    const promptService = require('../../../../main/services/PermissionPromptService');
    const config = { get: jest.fn(() => null), set: jest.fn() };
    permissionService._installed = true; // keep it off the real defaultSession
    permissionService.initialize(config, { promptService });
    promptService.initialize({ permissionService });
    svc.initialize({ permissionService });
    const prompts = [];
    promptService.on('prompt', (p) => prompts.push(p));
    const request = fakePrivateSession.setPermissionRequestHandler.mock.calls[0][0];
    const check = fakePrivateSession.setPermissionCheckHandler.mock.calls[0][0];
    const flush = () => new Promise((r) => setImmediate(r));

    const granted = jest.fn();
    request({ getURL: () => 'https://maps.example/' }, 'geolocation', granted, { requestingUrl: 'https://maps.example/' });
    await flush();
    expect(prompts).toEqual([expect.objectContaining({ origin: 'https://maps.example', permission: 'geolocation', ephemeral: true })]);
    promptService.resolve(prompts[0].id, 'allow', true);
    await flush();

    expect(granted).toHaveBeenCalledWith(true);
    expect(check({ getURL: () => 'https://maps.example/' }, 'geolocation', 'https://maps.example', {})).toBe(true);
    expect(config.set).not.toHaveBeenCalled();
    expect(permissionService.getOverrides()).toEqual({});
    expect(permissionService.decide('https://maps.example', 'geolocation')).toBe('prompt');

    await svc.clear();
    expect(check({ getURL: () => 'https://maps.example/' }, 'geolocation', 'https://maps.example', {})).toBe(false);
  });

  test('clear() wipes storage, the HTTP cache and saved HTTP auth credentials', async () => {
    svc.initialize({});
    await svc.clear();
    expect(fakePrivateSession.clearStorageData).toHaveBeenCalled();
    expect(fakePrivateSession.clearCache).toHaveBeenCalled();
    expect(fakePrivateSession.clearAuthCache).toHaveBeenCalled();
  });

  describe('a private tab opened while the last private session is being wiped', () => {
    const deferred = () => {
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    };

    test('whenClean waits for the wipe in flight, cache and auth entries included', async () => {
      svc.initialize({});
      const cache = deferred();
      fakePrivateSession.clearCache.mockReturnValueOnce(cache.promise);
      const clearing = svc.clear();
      let ready = false;
      const waiting = svc.whenClean().then(() => { ready = true; });
      await new Promise((r) => setImmediate(r));
      expect(ready).toBe(false);
      cache.resolve();
      await clearing;
      await waiting;
      expect(ready).toBe(true);
      expect(fakePrivateSession.clearAuthCache).toHaveBeenCalledTimes(1);
    });

    test('whenClean resolves at once when no wipe is pending or owed', async () => {
      svc.initialize({});
      await expect(svc.whenClean()).resolves.toBeUndefined();
      expect(fakePrivateSession.clearStorageData).not.toHaveBeenCalled();
    });

    test('a wipe that failed is retried before the next private tab loads', async () => {
      svc.initialize({});
      fakePrivateSession.clearCache.mockRejectedValueOnce(new Error('busy'));
      await expect(svc.clear()).rejects.toThrow('busy');
      await expect(svc.whenClean()).resolves.toBeUndefined();
      expect(fakePrivateSession.clearStorageData).toHaveBeenCalledTimes(2);
      await svc.whenClean();
      expect(fakePrivateSession.clearStorageData).toHaveBeenCalledTimes(2);
    });

    test('a wipe that keeps failing blocks the next private tab', async () => {
      svc.initialize({});
      fakePrivateSession.clearCache.mockRejectedValue(new Error('busy'));
      await expect(svc.clear()).rejects.toThrow('busy');
      await expect(svc.whenClean()).rejects.toThrow('busy');
    });
  });

  test('the private session gets the privacy listeners and untracked-to-disk download handling', () => {
    fakePrivateSession.webRequest = { onBeforeSendHeaders: jest.fn(), onHeadersReceived: jest.fn() };
    const willDownload = {};
    fakePrivateSession.on = jest.fn((event, fn) => { willDownload[event] = fn; });
    const browsingPrivacy = require('../../../../main/services/BrowsingPrivacyService');
    const downloadService = require('../../../../main/services/DownloadService');
    const writeFileSync = jest.fn();
    downloadService._setFs({ existsSync: () => false, readFileSync: () => '', writeFileSync, renameSync: jest.fn(), mkdirSync: jest.fn() });
    downloadService._setFilePath('/mem/downloads.json');

    svc.initialize({ browsingPrivacy, downloadService });

    expect(fakePrivateSession.webRequest.onBeforeSendHeaders).toHaveBeenCalledWith(expect.any(Function));
    expect(fakePrivateSession.webRequest.onHeadersReceived).toHaveBeenCalledWith({ urls: ['<all_urls>'] }, expect.any(Function));
    const done = {};
    const item = {
      getURL: () => 'https://files.example/secret.pdf', getFilename: () => 'secret.pdf', getTotalBytes: () => 1,
      getReceivedBytes: () => 1, getSavePath: () => '/dl/secret.pdf',
      on: jest.fn(), once: jest.fn((event, fn) => { done[event] = fn; }),
    };
    willDownload['will-download']({}, item);
    expect(downloadService.getActive()).toHaveLength(1);
    done.done({}, 'completed');
    expect(downloadService.getHistory()).toEqual([]);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  test('attempts to enable adblocker on private session when service provided', () => {
    const adblockerService = { enableForSession: jest.fn() };
    svc.initialize({ adblockerService });
    expect(adblockerService.enableForSession).toHaveBeenCalledWith(fakePrivateSession);
  });
});

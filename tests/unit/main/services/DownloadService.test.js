// DownloadService tests — fakes electron session.on('will-download').

let svc;

function makeMemFs() {
  const files = new Map();
  return {
    files,
    existsSync: jest.fn((p) => files.has(p) || p === '/tmp-mock'),
    readFileSync: jest.fn((p) => files.get(p) || ''),
    writeFileSync: jest.fn((p, content) => { files.set(p, content); }),
    renameSync: jest.fn((from, to) => { files.set(to, files.get(from)); files.delete(from); }),
    mkdirSync: jest.fn(),
  };
}

function makeFakeSession() {
  const handlers = {};
  return {
    handlers,
    on: jest.fn((event, fn) => { handlers[event] = fn; }),
  };
}

function makeFakeDownloadItem(opts = {}) {
  const listeners = {};
  const item = {
    getURL: () => opts.url || 'https://example.com/file.zip',
    getFilename: () => opts.filename || 'file.zip',
    getTotalBytes: () => opts.totalBytes || 1000,
    getReceivedBytes: () => opts.receivedBytes || 0,
    getSavePath: () => opts.savePath || '/tmp/file.zip',
    on: jest.fn((event, fn) => { listeners[event] = fn; }),
    once: jest.fn((event, fn) => { listeners[event] = fn; }),
    cancel: jest.fn(),
    pause: jest.fn(),
    resume: jest.fn(),
    _trigger: (event, ...args) => listeners[event] && listeners[event](...args),
  };
  return item;
}

beforeEach(() => {
  jest.resetModules();
  svc = require('../../../../main/services/DownloadService');
  svc._setFs(makeMemFs());
  svc._setFilePath('/tmp-mock/downloads.json');
  svc._active = new Map();
  svc._history = [];
  svc._loaded = false;
  svc.removeAllListeners();
});

describe('DownloadService', () => {
  test('attachToSession installs will-download handler once', () => {
    const sess = makeFakeSession();
    svc.attachToSession(sess);
    svc.attachToSession(sess);
    expect(sess.on).toHaveBeenCalledTimes(1);
    expect(sess.on).toHaveBeenCalledWith('will-download', expect.any(Function));
  });

  test('each session gets its own will-download handler', () => {
    const a = makeFakeSession();
    const b = makeFakeSession();
    svc.attachToSession(a);
    svc.attachToSession(b);
    expect(a.on).toHaveBeenCalledTimes(1);
    expect(b.on).toHaveBeenCalledTimes(1);
  });

  test('an ephemeral session\'s downloads are tracked live but never reach the saved history', () => {
    const regular = makeFakeSession();
    const ephemeral = makeFakeSession();
    svc.attachToSession(regular);
    svc.attachToSession(ephemeral, { ephemeral: true });
    const doneListener = jest.fn();
    svc.on('download-done', doneListener);

    const secret = makeFakeDownloadItem({ url: 'https://x.com/secret.zip' });
    ephemeral.handlers['will-download']({}, secret);
    expect(svc.getActive()).toHaveLength(1);
    secret._trigger('done', {}, 'completed');
    expect(doneListener).toHaveBeenCalledTimes(1);
    expect(svc.getHistory()).toEqual([]);
    expect(svc._fs.writeFileSync).not.toHaveBeenCalled();

    const kept = makeFakeDownloadItem({ url: 'https://x.com/kept.zip' });
    regular.handlers['will-download']({}, kept);
    kept._trigger('done', {}, 'completed');
    expect(svc.getHistory().map((d) => d.url)).toEqual(['https://x.com/kept.zip']);
  });

  test('only paths a download finished at count as known, private ones included', () => {
    const regular = makeFakeSession();
    const ephemeral = makeFakeSession();
    svc.attachToSession(regular);
    svc.attachToSession(ephemeral, { ephemeral: true });
    const kept = makeFakeDownloadItem({ savePath: '/dl/kept.zip' });
    const secret = makeFakeDownloadItem({ savePath: '/dl/secret.zip' });
    const running = makeFakeDownloadItem({ savePath: '/dl/running.zip' });
    regular.handlers['will-download']({}, kept);
    ephemeral.handlers['will-download']({}, secret);
    regular.handlers['will-download']({}, running);
    kept._trigger('done', {}, 'completed');
    secret._trigger('done', {}, 'completed');
    expect(svc.isKnownSavePath('/dl/kept.zip')).toBe(true);
    expect(svc.isKnownSavePath('/dl/secret.zip')).toBe(true);
    expect(svc.isKnownSavePath('/dl/running.zip')).toBe(false);
    expect(svc.isKnownSavePath('/etc/passwd')).toBe(false);
    expect(svc.isKnownSavePath('')).toBe(false);
    expect(svc.isKnownSavePath(/** @type {any} */ (null))).toBe(false);
  });

  test('a download saved by an earlier run is known from history', () => {
    svc._fs.files.set('/tmp-mock/downloads.json', JSON.stringify([{ id: 'd1', filename: 'old.pdf', savePath: '/dl/old.pdf', state: 'completed' }]));
    expect(svc.isKnownSavePath('/dl/old.pdf')).toBe(true);
    expect(svc.isKnownSavePath('/dl/other.pdf')).toBe(false);
  });

  test('handles will-download by tracking active and emitting download-started', () => {
    const sess = makeFakeSession();
    svc.attachToSession(sess);
    const startedListener = jest.fn();
    svc.on('download-started', startedListener);
    sess.handlers['will-download']({}, makeFakeDownloadItem({ url: 'https://x.com/a.zip' }));
    expect(svc.getActive().length).toBe(1);
    expect(startedListener).toHaveBeenCalled();
    expect(svc.getActive()[0].url).toBe('https://x.com/a.zip');
  });

  test('done event moves entry from active to history', () => {
    const sess = makeFakeSession();
    svc.attachToSession(sess);
    const doneListener = jest.fn();
    svc.on('download-done', doneListener);
    const item = makeFakeDownloadItem();
    sess.handlers['will-download']({}, item);
    item._trigger('done', {}, 'completed');
    expect(svc.getActive().length).toBe(0);
    expect(svc.getHistory().length).toBe(1);
    expect(svc.getHistory()[0].state).toBe('completed');
    expect(doneListener).toHaveBeenCalled();
  });

  test('cancel/pause/resume forward to download item', () => {
    const sess = makeFakeSession();
    svc.attachToSession(sess);
    const item = makeFakeDownloadItem();
    sess.handlers['will-download']({}, item);
    const id = svc.getActive()[0].id;
    svc.cancel(id);
    svc.pause(id);
    svc.resume(id);
    expect(item.cancel).toHaveBeenCalled();
    expect(item.pause).toHaveBeenCalled();
    expect(item.resume).toHaveBeenCalled();
  });

  test('clearHistory wipes history', () => {
    const sess = makeFakeSession();
    svc.attachToSession(sess);
    const item = makeFakeDownloadItem();
    sess.handlers['will-download']({}, item);
    item._trigger('done', {}, 'completed');
    expect(svc.getHistory().length).toBe(1);
    svc.clearHistory();
    expect(svc.getHistory().length).toBe(0);
  });
});

describe('DownloadService persistence safety', () => {
  test('an unparseable downloads file is moved aside and saving goes through rename', () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    svc._fs.files.set('/tmp-mock/downloads.json', '[{"id":"d1","filename":"tax.pdf');
    svc._loaded = false;
    svc.load();
    svc.clearHistory();
    const corrupt = [...svc._fs.files.keys()].find((k) => k.startsWith('/tmp-mock/downloads.json.corrupt-'));
    expect(svc._fs.files.get(corrupt)).toBe('[{"id":"d1","filename":"tax.pdf');
    expect(svc._fs.renameSync).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp-mock\/downloads\.json\..+\.tmp$/), '/tmp-mock/downloads.json');
    err.mockRestore();
  });
});

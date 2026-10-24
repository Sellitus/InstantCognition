// ModelHubService tests — fake fetch + fake https for HF API + downloads.

const path = require('path');
const fs = require('fs');
const os = require('os');

const mockElectron = { app: { getPath: jest.fn(() => '/unused'), isPackaged: false } };
jest.mock('electron', () => mockElectron);

let svc;
let manager;
let tmpDir;

function makeFakeResponse(jsonBody) {
  return Promise.resolve({ json: () => Promise.resolve(jsonBody) });
}

beforeEach(() => {
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-hub-test-'));
  mockElectron.app.getPath = jest.fn(() => tmpDir);
  jest.doMock('electron', () => mockElectron);
  svc = require('../../../../main/services/ModelHubService');
  manager = require('../../../../main/services/ModelManagerService');
  manager.removeAllListeners();
  manager.setModelsDir(path.join(tmpDir, 'models'));
  manager._registry = null;
  manager._migrated = false;
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

describe('ModelHubService', () => {
  test('search returns normalized models', async () => {
    svc._setFetch(() => makeFakeResponse([
      { modelId: 'TheBloke/llama-2-7b-GGUF', author: 'TheBloke', downloads: 1234, likes: 56, tags: ['gguf'] },
      { modelId: 'bartowski/Qwen2-7B-GGUF', downloads: 999, tags: ['gguf', 'qwen'] },
    ]));
    const results = await svc.search('llama');
    expect(results.length).toBe(2);
    expect(results[0].id).toBe('TheBloke/llama-2-7b-GGUF');
    expect(results[0].author).toBe('TheBloke');
    expect(results[1].author).toBe('bartowski');
  });

  test('search drops invalid entries', async () => {
    svc._setFetch(() => makeFakeResponse([{ noModelId: true }, { modelId: 'a/b' }]));
    const r = await svc.search('x');
    expect(r.length).toBe(1);
    expect(r[0].id).toBe('a/b');
  });

  test('search returns empty when API returns non-array', async () => {
    svc._setFetch(() => makeFakeResponse({ error: 'fail' }));
    const r = await svc.search('x');
    expect(r).toEqual([]);
  });

  test('listGgufFiles filters .gguf entries with download urls', async () => {
    svc._setFetch(() => makeFakeResponse([
      { type: 'file', path: 'README.md', size: 100 },
      { type: 'file', path: 'model-Q4_K_M.gguf', size: 4000000000 },
      { type: 'file', path: 'model-Q8_0.gguf', size: 7000000000 },
      { type: 'directory', path: 'subdir' },
    ]));
    const files = await svc.listGgufFiles('TheBloke/llama-2-7b-GGUF');
    expect(files.length).toBe(2);
    expect(files[0].path).toBe('model-Q4_K_M.gguf');
    expect(files[0].downloadUrl).toContain('huggingface.co/TheBloke/llama-2-7b-GGUF/resolve/main/model-Q4_K_M.gguf');
    expect(files[0].sizeHuman).toMatch(/GB/);
  });

  test('listGgufFiles requires repoId', async () => {
    await expect(svc.listGgufFiles()).rejects.toThrow(/repoId/);
  });

  test('cancelDownload returns false when id unknown', () => {
    expect(svc.cancelDownload('nope')).toBe(false);
  });

  test('getActiveDownloads returns empty when none in progress', () => {
    expect(svc.getActiveDownloads()).toEqual([]);
  });

  test('download registers the file via importModel and emits models-changed', async () => {
    // Stub _streamToFile to write a fake .part file without touching the network.
    svc._streamToFile = jest.fn(async (url, dest) => { fs.writeFileSync(dest, 'fake'); });

    const changed = jest.fn();
    manager.on('models-changed', changed);

    const info = await svc.download({
      repoId: 'TheBloke/test',
      filePath: 'model-Q4_K_M.gguf',
    });

    const expected = path.join(manager.getModelsDir(), 'model-Q4_K_M.gguf');
    expect(fs.existsSync(expected)).toBe(true);
    expect(info).toBeTruthy();
    expect(info.path).toBe(expected);
    expect(manager.listModels().map((m) => m.path)).toContain(expected);
    expect(changed).toHaveBeenCalled();
  });

  test('download requires downloadUrl or repoId+filePath', async () => {
    await expect(svc.download({})).rejects.toThrow(/downloadUrl or repoId\+filePath/);
  });

  test('download rejects when the destination file already exists', async () => {
    const dir = manager.ensureModelsDir();
    const dest = path.join(dir, 'dup.gguf');
    fs.writeFileSync(dest, 'existing');
    await expect(svc.download({ repoId: 'a/b', filePath: 'dup.gguf' }))
      .rejects.toThrow(/Already exists/);
  });

  test('download derives the filename from a bare downloadUrl', async () => {
    svc._streamToFile = jest.fn(async (url, dest) => { fs.writeFileSync(dest, 'x'); });
    const info = await svc.download({ downloadUrl: 'https://h.co/some/path/weights.gguf' });
    const expected = path.join(manager.getModelsDir(), 'weights.gguf');
    expect(info.path).toBe(expected);
    expect(svc._streamToFile.mock.calls[0][0]).toBe('https://h.co/some/path/weights.gguf');
  });

  test('download cleans up and emits download-cancelled when the handle is cancelled mid-stream', async () => {
    svc._streamToFile = jest.fn(async (url, tmp, handle) => {
      fs.writeFileSync(tmp, 'partial');
      handle.cancelled = true;
    });
    const cancelled = jest.fn();
    svc.on('download-cancelled', cancelled);
    const res = await svc.download({ repoId: 'a/b', filePath: 'gone.gguf' });
    expect(res).toBeNull();
    expect(cancelled).toHaveBeenCalled();
    expect(fs.existsSync(path.join(manager.getModelsDir(), 'gone.gguf.part'))).toBe(false);
  });

  test('download emits download-error and rethrows on stream failure', async () => {
    svc._streamToFile = jest.fn(async () => { throw new Error('net down'); });
    const errored = jest.fn();
    svc.on('download-error', errored);
    await expect(svc.download({ repoId: 'a/b', filePath: 'fail.gguf' })).rejects.toThrow(/net down/);
    expect(errored).toHaveBeenCalledWith(expect.objectContaining({ message: 'net down' }));
  });

  test('download falls back to getModelInfo when importModel throws', async () => {
    svc._streamToFile = jest.fn(async (url, dest) => { fs.writeFileSync(dest, 'x'); });
    const origImport = manager.importModel;
    manager.importModel = jest.fn(() => { throw new Error('registry locked'); });
    const fallbackInfo = { path: 'fallback' };
    const origGetInfo = manager.getModelInfo;
    manager.getModelInfo = jest.fn(() => fallbackInfo);
    const changed = jest.fn();
    manager.on('models-changed', changed);

    const info = await svc.download({ repoId: 'a/b', filePath: 'fb.gguf' });
    expect(info).toBe(fallbackInfo);
    expect(changed).toHaveBeenCalled();

    manager.importModel = origImport;
    manager.getModelInfo = origGetInfo;
  });

  test('getActiveDownloads reports an in-flight handle while streaming', async () => {
    let snapshot;
    svc._streamToFile = jest.fn(async (url, dest, handle) => {
      handle.received = 50; handle.total = 100;
      snapshot = svc.getActiveDownloads();
      fs.writeFileSync(dest, 'x');
    });
    await svc.download({ repoId: 'a/b', filePath: 'live.gguf' });
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({ filename: 'live.gguf', received: 50, total: 100 });
    // After completion the handle is removed.
    expect(svc.getActiveDownloads()).toEqual([]);
  });

  test('cancelDownload destroys an active request and marks the handle cancelled', async () => {
    const destroy = jest.fn();
    let captured;
    svc._streamToFile = jest.fn(async (url, dest, handle) => {
      handle.req = { destroy };
      captured = handle;
      // Don't write — leave it "in progress" so cancelDownload sees it.
      const id = svc.getActiveDownloads()[0].id;
      expect(svc.cancelDownload(id)).toBe(true);
      expect(handle.cancelled).toBe(true);
      expect(destroy).toHaveBeenCalled();
    });
    await svc.download({ repoId: 'a/b', filePath: 'cancelme.gguf' });
    expect(captured.cancelled).toBe(true);
  });

  test('_humanSize formats byte ranges and the zero case', () => {
    expect(svc._humanSize(0)).toBe('0 B');
    expect(svc._humanSize(512)).toBe('512 B'); // >=10 -> 0 decimals
    expect(svc._humanSize(8)).toBe('8.0 B');   // <10 -> 1 decimal
    expect(svc._humanSize(2048)).toBe('2.0 KB');
    expect(svc._humanSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(svc._humanSize(20 * 1024 * 1024 * 1024)).toBe('20 GB'); // >=10 -> no decimals
  });

  test('_normalizeModel returns null for entries without a modelId', () => {
    expect(svc._normalizeModel(null)).toBeNull();
    expect(svc._normalizeModel({ noModelId: true })).toBeNull();
  });

  test('_normalizeModel derives author from the id when author is absent', () => {
    const m = svc._normalizeModel({ modelId: 'someone/model-x' });
    expect(m).toMatchObject({ id: 'someone/model-x', author: 'someone', downloads: 0, likes: 0, tags: [] });
  });

  test('listGgufFiles returns [] when the tree response is not an array', async () => {
    svc._setFetch(() => makeFakeResponse({ error: 'nope' }));
    await expect(svc.listGgufFiles('a/b')).resolves.toEqual([]);
  });

  test('search clamps the limit to 100', async () => {
    let calledUrl;
    svc._setFetch((u) => { calledUrl = u; return makeFakeResponse([]); });
    await svc.search('q', { limit: 5000 });
    expect(calledUrl).toContain('limit=100');
  });
});

// _streamToFile + _getJson exercised through a fake https module so the real
// network is never touched. The fake mimics the EventEmitter/stream surface
// the production code uses.
describe('ModelHubService — https streaming', () => {
  const { EventEmitter } = require('events');
  const { Readable } = require('stream');

  // A real Readable so res.pipe(fs.createWriteStream(...)) genuinely streams
  // and the WriteStream 'finish' event fires. resume()/destroy() are spied.
  function fakeRes({ statusCode = 200, headers = {}, chunks = [] } = {}) {
    const res = new Readable({ read() {} });
    res.statusCode = statusCode;
    res.headers = headers;
    res.resume = jest.fn(Readable.prototype.resume.bind(res));
    jest.spyOn(res, 'destroy');
    res._emitData = () => {
      for (const c of chunks) res.push(Buffer.from(c));
      res.push(null);
    };
    return res;
  }

  function fakeHttps(handler, { sync = false } = {}) {
    return {
      get: (url, optsOrCb, maybeCb) => {
        const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
        const req = new EventEmitter();
        req.destroy = jest.fn();
        if (sync) handler(url, cb, req);
        else setImmediate(() => handler(url, cb, req));
        return req;
      },
    };
  }

  test('_getJson over https resolves parsed JSON on 200', async () => {
    svc._setFetch(null);
    svc._setHttps(fakeHttps((url, cb) => {
      const res = fakeRes({ statusCode: 200, chunks: ['{"a":', '1}'] });
      cb(res);
      res._emitData();
    }));
    await expect(svc._getJson('https://x/api')).resolves.toEqual({ a: 1 });
  });

  test('_getJson over https rejects on non-200', async () => {
    svc._setFetch(null);
    svc._setHttps(fakeHttps((url, cb) => { cb(fakeRes({ statusCode: 503 })); }));
    await expect(svc._getJson('https://x/api')).rejects.toThrow(/HTTP 503/);
  });

  test('_getJson over https rejects on malformed JSON', async () => {
    svc._setFetch(null);
    svc._setHttps(fakeHttps((url, cb) => {
      const res = fakeRes({ statusCode: 200, chunks: ['not json'] });
      cb(res);
      res._emitData();
    }));
    await expect(svc._getJson('https://x/api')).rejects.toBeInstanceOf(Error);
  });

  test('_getJson over https rejects on request error', async () => {
    svc._setFetch(null);
    svc._setHttps(fakeHttps((url, cb, req) => { req.emit('error', new Error('socket reset')); }));
    await expect(svc._getJson('https://x/api')).rejects.toThrow(/socket reset/);
  });

  test('_streamToFile follows a redirect then writes the body', async () => {
    let hop = 0;
    const dest = path.join(manager.ensureModelsDir(), 'redir.bin');
    svc._setHttps(fakeHttps((url, cb) => {
      if (hop === 0) {
        hop++;
        cb(fakeRes({ statusCode: 302, headers: { location: 'https://cdn/final' } }));
      } else {
        const res = fakeRes({ statusCode: 200, headers: { 'content-length': '3' }, chunks: ['abc'] });
        cb(res);
        res._emitData();
      }
    }));
    const handle = { id: 'h1', filename: 'redir.bin', received: 0, total: 0, cancelled: false };
    await svc._streamToFile('https://h/start', dest, handle);
    expect(fs.existsSync(dest)).toBe(true);
  });

  test('_streamToFile rejects after exceeding the redirect limit', async () => {
    svc._setHttps(fakeHttps((url, cb) => {
      cb(fakeRes({ statusCode: 301, headers: { location: 'https://loop/again' } }));
    }));
    const handle = { id: 'h2', filename: 'x', received: 0, total: 0, cancelled: false };
    await expect(svc._streamToFile('https://h/start', '/tmp/never', handle))
      .rejects.toThrow(/Too many redirects/);
  });

  test('_streamToFile rejects on a non-200, non-redirect status', async () => {
    svc._setHttps(fakeHttps((url, cb) => { cb(fakeRes({ statusCode: 404 })); }));
    const handle = { id: 'h3', filename: 'x', received: 0, total: 0, cancelled: false };
    await expect(svc._streamToFile('https://h/start', '/tmp/never', handle))
      .rejects.toThrow(/HTTP 404/);
  });

  test('_streamToFile rejects on request error', async () => {
    svc._setHttps(fakeHttps((url, cb, req) => { req.emit('error', new Error('conn lost')); }));
    const handle = { id: 'h4', filename: 'x', received: 0, total: 0, cancelled: false };
    await expect(svc._streamToFile('https://h/start', '/tmp/never', handle))
      .rejects.toThrow(/conn lost/);
  });

  test('_streamToFile destroys the response when a data chunk arrives after cancel', async () => {
    const dest = path.join(manager.ensureModelsDir(), 'cancel.bin');
    let resRef;
    svc._setHttps(fakeHttps((url, cb) => {
      resRef = fakeRes({ statusCode: 200, headers: { 'content-length': '10' } });
      cb(resRef);
      // Synchronously emit a data chunk (listeners are wired by cb()).
      // The handle is already cancelled, so the data handler must
      // res.destroy() + out.destroy() and NOT count the bytes.
      resRef.emit('data', Buffer.from('late-chunk'));
    }, { sync: true }));
    const handle = { id: 'h5', filename: 'cancel.bin', received: 0, total: 0, cancelled: true };
    const p = svc._streamToFile('https://h/start', dest, handle);
    p.catch(() => {}); // promise intentionally never settles on this branch
    expect(resRef.destroy).toHaveBeenCalled();
    expect(handle.received).toBe(0);
  });

  test('cancelDownload returns false for an unknown id', () => {
    expect(svc.cancelDownload('does-not-exist')).toBe(false);
  });
});

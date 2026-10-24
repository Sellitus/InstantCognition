// httpDownload.downloadToFile — streams an HTTPS URL to a file following
// redirects, HTTPS-only. The network (https.get) and the destination file
// (fs.createWriteStream / fs.unlinkSync) are the external boundary and are
// faked; the redirect loop, protocol enforcement, timeout, and error
// propagation under test run for real.

// jest.mock factories are hoisted above imports and may only reference
// `mock`-prefixed names, so the shared fake-network/fake-fs state lives here.
const mockHttps = { script: [], calls: [], options: [] };
const mockFsState = { streams: [], unlinked: [], failCreate: null };

jest.mock('https', () => {
  const { EventEmitter } = require('events');
  return {
    get: jest.fn((url, options, cb) => {
      if (typeof options === 'function') { cb = options; options = undefined; }
      mockHttps.calls.push(url);
      mockHttps.options.push(options);
      const req = new EventEmitter();
      req.setTimeout = jest.fn((ms, onTimeout) => {
        req._timeoutMs = ms;
        req._onTimeout = onTimeout;
      });
      req.destroy = jest.fn((err) => { req.emit('error', err); });
      const step = mockHttps.script.shift();
      // Deliver the response asynchronously so the listeners production
      // attaches after https.get returns (req.on('error'), req.setTimeout)
      // are wired before anything fires.
      process.nextTick(() => {
        if (!step) return;
        if (step.reqError) { req.emit('error', step.reqError); return; }
        if (step.timeout) { if (req._onTimeout) req._onTimeout(); return; }
        const res = new EventEmitter();
        res.statusCode = step.statusCode;
        res.headers = step.headers || {};
        res.resume = jest.fn();
        res.pipe = jest.fn((dest) => {
          for (const chunk of step.body || []) dest._sink.push(chunk);
          dest._ended = true;
          if (dest._autoClose !== false) process.nextTick(() => dest.emit('close'));
          return dest;
        });
        res.setEncoding = jest.fn();
        // Body chunks and 'end' fire after cb so listeners production
        // attaches inside the response callback (res.on('data') for
        // onProgress/getText) are wired before anything emits.
        process.nextTick(() => {
          for (const chunk of step.body || []) res.emit('data', chunk);
          res.emit('end');
        });
        cb(res);
      });
      return req;
    }),
  };
});

jest.mock('fs', () => {
  const { EventEmitter } = require('events');
  return {
    createWriteStream: jest.fn((destPath) => {
      const ws = new EventEmitter();
      ws._sink = [];
      ws._destPath = destPath;
      if (mockFsState.failCreate) {
        ws._autoClose = false; // never resolves: this stream only errors
        mockFsState.streams.push(ws);
        const err = mockFsState.failCreate;
        process.nextTick(() => ws.emit('error', err));
        return ws;
      }
      ws._autoClose = true;
      mockFsState.streams.push(ws);
      return ws;
    }),
    unlinkSync: jest.fn((p) => { mockFsState.unlinked.push(p); }),
  };
});

const https = require('https');
const fs = require('fs');
const { downloadToFile, getText } = require('../../../../main/utils/httpDownload');

function res(statusCode, { headers = {}, body = [] } = {}) {
  return { statusCode, headers, body };
}

beforeEach(() => {
  mockHttps.script = [];
  mockHttps.calls = [];
  mockHttps.options = [];
  mockFsState.streams = [];
  mockFsState.unlinked = [];
  mockFsState.failCreate = null;
  https.get.mockClear();
  fs.createWriteStream.mockClear();
  fs.unlinkSync.mockClear();
});

describe('downloadToFile — success path', () => {
  test('200 streams the body to destPath and resolves with the path', async () => {
    mockHttps.script = [res(200, { body: ['ab', 'cd'] })];
    const out = await downloadToFile('https://host.example/file.bin', '/tmp/out.bin');
    expect(out).toBe('/tmp/out.bin');
    expect(https.get).toHaveBeenCalledTimes(1);
    expect(fs.createWriteStream).toHaveBeenCalledWith('/tmp/out.bin');
    expect(mockFsState.streams[0]._sink.join('')).toBe('abcd');
    // success path must not delete the destination
    expect(mockFsState.unlinked).toEqual([]);
  });
});

describe('downloadToFile — redirects', () => {
  for (const code of [301, 302, 303, 307, 308]) {
    test(`follows a ${code} redirect to the Location URL`, async () => {
      mockHttps.script = [
        res(code, { headers: { location: 'https://cdn.example/final.bin' } }),
        res(200, { body: ['payload'] }),
      ];
      const out = await downloadToFile('https://host.example/start', '/tmp/r.bin');
      expect(out).toBe('/tmp/r.bin');
      expect(mockHttps.calls).toEqual([
        'https://host.example/start',
        'https://cdn.example/final.bin',
      ]);
      expect(mockFsState.streams[0]._sink.join('')).toBe('payload');
    });
  }

  test('resolves a relative Location against the current URL', async () => {
    mockHttps.script = [
      res(302, { headers: { location: '/v2/file.bin' } }),
      res(200, { body: ['x'] }),
    ];
    await downloadToFile('https://host.example/a/b', '/tmp/rel.bin');
    expect(mockHttps.calls[1]).toBe('https://host.example/v2/file.bin');
  });

  test('exceeding the max-redirect cap rejects loudly (does not loop forever)', async () => {
    // maxRedirects:1 → first redirect consumes the budget, the second rejects.
    mockHttps.script = [
      res(302, { headers: { location: 'https://host.example/1' } }),
      res(302, { headers: { location: 'https://host.example/2' } }),
      res(302, { headers: { location: 'https://host.example/3' } }),
    ];
    await expect(
      downloadToFile('https://host.example/start', '/tmp/loop.bin', { maxRedirects: 1 }),
    ).rejects.toThrow(/Too many redirects/);
    expect(fs.createWriteStream).not.toHaveBeenCalled();
  });
});

describe('downloadToFile — protocol enforcement (negative)', () => {
  test('rejects a plain http:// URL without ever calling https.get', async () => {
    await expect(
      downloadToFile('http://host.example/file.bin', '/tmp/x.bin'),
    ).rejects.toThrow(/Only HTTPS downloads are allowed/);
    expect(https.get).not.toHaveBeenCalled();
    expect(fs.createWriteStream).not.toHaveBeenCalled();
  });

  test('rejects an http:// redirect target (HTTPS enforced on each hop)', async () => {
    mockHttps.script = [res(302, { headers: { location: 'http://insecure.example/f' } })];
    await expect(
      downloadToFile('https://host.example/start', '/tmp/x.bin'),
    ).rejects.toThrow(/Only HTTPS downloads are allowed/);
    expect(fs.createWriteStream).not.toHaveBeenCalled();
  });

  test('rejects a malformed URL', async () => {
    await expect(
      downloadToFile('::::not a url::::', '/tmp/x.bin'),
    ).rejects.toThrow(/Invalid download URL/);
    expect(https.get).not.toHaveBeenCalled();
  });

  test('rejects a non-2xx response and drains the body', async () => {
    mockHttps.script = [res(404, {})];
    await expect(
      downloadToFile('https://host.example/missing', '/tmp/x.bin'),
    ).rejects.toThrow(/HTTP 404/);
    expect(fs.createWriteStream).not.toHaveBeenCalled();
  });
});

describe('downloadToFile — failure propagation (fail loud)', () => {
  test('a request timeout rejects with a clear error (not swallowed)', async () => {
    mockHttps.script = [{ timeout: true }];
    await expect(
      downloadToFile('https://host.example/slow', '/tmp/x.bin', { timeoutMs: 50 }),
    ).rejects.toThrow(/Download timed out/);
  });

  test('an upstream request error is propagated, not silently ignored', async () => {
    mockHttps.script = [{ reqError: new Error('ECONNRESET') }];
    await expect(
      downloadToFile('https://host.example/boom', '/tmp/x.bin'),
    ).rejects.toThrow(/ECONNRESET/);
  });

  test('a destination write-stream error rejects and unlinks the partial file', async () => {
    mockFsState.failCreate = new Error('ENOSPC: no space left on device');
    mockHttps.script = [res(200, { body: ['partial'] })];
    await expect(
      downloadToFile('https://host.example/file.bin', '/tmp/full.bin'),
    ).rejects.toThrow(/ENOSPC/);
    // the partial output must be cleaned up, not left behind
    expect(mockFsState.unlinked).toContain('/tmp/full.bin');
  });
});

describe('downloadToFile — headers and progress', () => {
  test('passes custom headers to https.get', async () => {
    mockHttps.script = [res(200, { body: ['x'] })];
    await downloadToFile('https://host.example/f.bin', '/tmp/h.bin', {
      headers: { 'User-Agent': 'test-agent/1' },
    });
    expect(mockHttps.options[0]).toEqual({ headers: { 'User-Agent': 'test-agent/1' } });
  });

  test('fires onProgress with received/total per chunk (total 0 when absent)', async () => {
    mockHttps.script = [
      res(200, { headers: { 'content-length': '4' }, body: ['ab', 'cd'] }),
    ];
    const calls = [];
    await downloadToFile('https://host.example/f.bin', '/tmp/p.bin', {
      onProgress: (received, total, chunkLength) => calls.push([received, total, chunkLength]),
    });
    expect(calls).toEqual([[2, 4, 2], [4, 4, 2]]);
    expect(mockFsState.streams[0]._sink.join('')).toBe('abcd');

    const noTotal = [];
    mockHttps.script = [res(200, { body: ['xy'] })];
    await downloadToFile('https://host.example/g.bin', '/tmp/p2.bin', {
      onProgress: (received, total) => noTotal.push([received, total]),
    });
    expect(noTotal).toEqual([[2, 0]]);
  });
});

describe('getText', () => {
  test('follows a redirect and resolves the buffered utf8 body', async () => {
    mockHttps.script = [
      res(302, { headers: { location: 'https://cdn.example/tag.txt' } }),
      res(200, { body: ['b1234', '-nightly'] }),
    ];
    await expect(getText('https://host.example/latest')).resolves.toBe('b1234-nightly');
    expect(mockHttps.calls).toEqual([
      'https://host.example/latest',
      'https://cdn.example/tag.txt',
    ]);
    expect(mockHttps.options[0]).toEqual({ headers: undefined });
  });

  test('forwards custom headers on every hop', async () => {
    mockHttps.script = [
      res(302, { headers: { location: 'https://cdn.example/tag.txt' } }),
      res(200, { body: ['ok'] }),
    ];
    await getText('https://host.example/latest', { headers: { 'User-Agent': 'x' } });
    expect(mockHttps.options[0]).toEqual({ headers: { 'User-Agent': 'x' } });
    expect(mockHttps.options[1]).toEqual({ headers: { 'User-Agent': 'x' } });
  });

  test('a redirect loop past the cap rejects (does not recurse forever)', async () => {
    mockHttps.script = [
      res(302, { headers: { location: 'https://host.example/1' } }),
      res(302, { headers: { location: 'https://host.example/2' } }),
    ];
    await expect(getText('https://host.example/start', { maxRedirects: 1 }))
      .rejects.toThrow(/Too many redirects/);
  });

  test('a non-2xx response rejects with the status code', async () => {
    mockHttps.script = [res(404, {})];
    await expect(getText('https://host.example/missing')).rejects.toThrow(/HTTP 404/);
  });
});

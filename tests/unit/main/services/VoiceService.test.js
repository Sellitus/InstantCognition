const path = require('path');
const fs = require('fs');
const os = require('os');

// sherpa-onnx{,-node} are native ASR runtimes (external boundary). Mock both
// so tests never load the real native addon (which would SIGABRT on our
// synthetic .onnx fixtures). Each test sets the desired impl; `null` makes
// require() throw MODULE_NOT_FOUND to drive the "runtime missing" path.
let mockSherpaNode = null; // impl object for 'sherpa-onnx-node'
let mockSherpa = null;     // impl object for 'sherpa-onnx'
// The factory returns a stable object whose `OfflineRecognizer` getter
// delegates to the live impl var. When the var is null the require itself
// must throw (module-not-found) so VoiceService takes the fallback path —
// jest does not cache a throwing factory, so it re-runs on the next require.
jest.mock('sherpa-onnx-node', () => {
  if (!mockSherpaNode) { const e = new Error("Cannot find module 'sherpa-onnx-node'"); e.code = 'MODULE_NOT_FOUND'; throw e; }
  return new Proxy({}, { get: (_t, k) => (mockSherpaNode ? mockSherpaNode[k] : undefined) });
}, { virtual: true });
jest.mock('sherpa-onnx', () => {
  if (!mockSherpa) { const e = new Error("Cannot find module 'sherpa-onnx'"); e.code = 'MODULE_NOT_FOUND'; throw e; }
  return new Proxy({}, { get: (_t, k) => (mockSherpa ? mockSherpa[k] : undefined) });
}, { virtual: true });

// electron is an external boundary — VoiceService.defaultModelRoot() probes
// app.getAppPath() for a bundled moonshine dir. Default: no getAppPath so the
// non-electron fallback (return vendor path) is taken; individual tests swap
// mockElectronApp to drive the app-present candidate-probe branch.
let mockElectronApp = null;
jest.mock('electron', () => ({ get app() { return mockElectronApp; } }));

const { VoiceService } = require('../../../../main/services/VoiceService');

beforeEach(() => { mockSherpaNode = null; mockSherpa = null; mockElectronApp = null; });

function fakeCs(initial = {}) {
  let data = { settings: { voice: { ...initial } } };
  return {
    get: (p, fb) => { const ks = p.split('.'); let c = data; for (const k of ks) c = (c && typeof c === 'object') ? c[k] : undefined; return c === undefined ? fb : c; },
    set: () => {},
    _data: data,
  };
}

describe('VoiceService — config', () => {
  test('isEnabled reflects settings.voice.enabled', () => {
    const svc = new VoiceService();
    svc.bindConfig(fakeCs({ enabled: false }));
    expect(svc.isEnabled()).toBe(false);
    const svc2 = new VoiceService();
    svc2.bindConfig(fakeCs({ enabled: true }));
    expect(svc2.isEnabled()).toBe(true);
  });

  test('listProviders includes moonshine variants', () => {
    const svc = new VoiceService();
    svc.bindConfig(fakeCs({}));
    const providers = svc.listProviders();
    expect(providers.map((p) => p.name)).toEqual(expect.arrayContaining(['moonshine-tiny', 'moonshine-base']));
    for (const p of providers) expect(typeof p.label).toBe('string');
  });
});

describe('VoiceService — availability', () => {
  test('isAvailable=false when model files missing (no manifest in vendor)', () => {
    const svc = new VoiceService();
    svc.bindConfig(fakeCs({}));
    // Force a missing-model state by pointing the provider dir at /tmp.
    svc._providerDir = () => path.join(os.tmpdir(), 'nonexistent-moonshine-' + Date.now());
    expect(svc.isAvailable()).toBe(false);
  });

  test('isAvailable=false when disabled', () => {
    const svc = new VoiceService();
    svc.bindConfig(fakeCs({ enabled: false }));
    expect(svc.isAvailable()).toBe(false);
  });
});

describe('VoiceService — transcribe error paths', () => {
  test('rejects too-short audio', async () => {
    const svc = new VoiceService();
    svc.bindConfig(fakeCs({ enabled: true }));
    const tiny = Buffer.alloc(100);
    const r = await svc.transcribe(tiny);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('audio_too_short');
  });

  test('rejects when disabled', async () => {
    const svc = new VoiceService();
    svc.bindConfig(fakeCs({ enabled: false }));
    const buf = Buffer.alloc(8192);
    const r = await svc.transcribe(buf);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('voice_disabled');
  });

  test('returns cancelled and skips decode when signal already aborted', async () => {
    const svc = new VoiceService();
    svc.bindConfig(fakeCs({ enabled: true }));
    let decoded = false;
    svc._loadModel = async () => ({
      createStream: () => ({ acceptWaveform() {}, free() {} }),
      decode() { decoded = true; },
      getResult: () => ({ text: 'x' }),
    });
    const buf = Buffer.alloc(8192);
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await svc.transcribe(buf, { signal: ctrl.signal });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('cancelled');
    expect(decoded).toBe(false);
  });

  test('rejects with unavailable when model not present', async () => {
    const svc = new VoiceService();
    svc.bindConfig(fakeCs({ enabled: true }));
    svc._providerDir = () => path.join(os.tmpdir(), 'nonexistent-moonshine-' + Date.now());
    const buf = Buffer.alloc(8192);
    const r = await svc.transcribe(buf);
    expect(r.ok).toBe(false);
    expect(['model_not_bundled', 'native_runtime_missing', 'native_runtime_incompatible', 'init_failed', 'unavailable']).toContain(r.error);
  });
});

describe('VoiceService — warmUp', () => {
  test('returns false when model missing', async () => {
    const svc = new VoiceService();
    svc.bindConfig(fakeCs({ enabled: true }));
    svc._providerDir = () => path.join(os.tmpdir(), 'nonexistent-moonshine-' + Date.now());
    const r = await svc.warmUp();
    expect(r.ok).toBe(false);
    expect(typeof r.reason).toBe('string');
  });
});

describe('VoiceService — config + provider selection', () => {
  test('isEnabled returns true when no config service is bound', () => {
    const svc = new VoiceService();
    expect(svc.isEnabled()).toBe(true);
  });

  test('bindConfig honors a recognized provider override', () => {
    const svc = new VoiceService();
    svc.bindConfig(fakeCs({ provider: 'moonshine-base' }));
    expect(svc._provider).toBe('moonshine-base');
  });

  test('bindConfig ignores an unrecognized provider', () => {
    const svc = new VoiceService();
    svc.bindConfig(fakeCs({ provider: 'whisper-xxl' }));
    expect(svc._provider).toBe('moonshine-tiny');
  });

  test('unavailableReason is null before any failed load', () => {
    const svc = new VoiceService();
    expect(svc.unavailableReason()).toBeNull();
  });
});

// Builds a complete model dir (all required files non-empty) so
// _modelFilesExist passes and we can exercise _loadModel branches.
function makeModelDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-voice-'));
  for (const f of ['preprocess.onnx', 'encode.int8.onnx', 'uncached_decode.int8.onnx', 'cached_decode.int8.onnx', 'tokens.txt']) {
    fs.writeFileSync(path.join(dir, f), 'x');
  }
  return dir;
}

describe('VoiceService — _modelFilesExist', () => {
  test('false when a required file is zero-length (partial download)', () => {
    const svc = new VoiceService();
    svc.bindConfig(fakeCs({}));
    const dir = makeModelDir();
    fs.writeFileSync(path.join(dir, 'tokens.txt'), ''); // truncate one file
    svc._providerDir = () => dir;
    expect(svc._modelFilesExist()).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('true when every required file exists and is non-empty', () => {
    const svc = new VoiceService();
    svc.bindConfig(fakeCs({}));
    const dir = makeModelDir();
    svc._providerDir = () => dir;
    expect(svc._modelFilesExist()).toBe(true);
    expect(svc.isAvailable()).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('VoiceService — _loadModel native runtime branches', () => {
  let dir;
  beforeEach(() => { dir = makeModelDir(); });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    // Drop the cached virtual sherpa modules so the next test's impl swap
    // (including back to "missing") is honored on a fresh require.
    jest.resetModules();
  });

  test('sets native_runtime_missing when neither sherpa package is present', async () => {
    mockSherpaNode = null; mockSherpa = null;
    const svc = new VoiceService();
    svc.bindConfig(fakeCs({ enabled: true }));
    svc._providerDir = () => dir;
    const model = await svc._loadModel();
    expect(model).toBeNull();
    expect(svc.unavailableReason()).toBe('native_runtime_missing');
    // Subsequent calls short-circuit via the _unavailable flag.
    expect(await svc._loadModel()).toBeNull();
  });

  test('sets native_runtime_incompatible when sherpa lacks OfflineRecognizer', async () => {
    mockSherpaNode = { notARecognizer: true };
    const svc = new VoiceService();
    svc.bindConfig(fakeCs({ enabled: true }));
    svc._providerDir = () => dir;
    const model = await svc._loadModel();
    expect(model).toBeNull();
    expect(svc.unavailableReason()).toBe('native_runtime_incompatible');
  });

  test('constructs the recognizer when sherpa is available and transcribes PCM16', async () => {
    const decode = jest.fn();
    const createStream = jest.fn(() => ({ acceptWaveform: jest.fn(), free: jest.fn() }));
    const getResult = jest.fn(() => ({ text: '  hello world  ' }));
    mockSherpaNode = {
      OfflineRecognizer: jest.fn(function OfflineRecognizer() {
        this.createStream = createStream;
        this.decode = decode;
        this.getResult = getResult;
      }),
    };
    const svc = new VoiceService();
    svc.bindConfig(fakeCs({ enabled: true }));
    svc._providerDir = () => dir;

    const model = await svc._loadModel();
    expect(model).toBeTruthy();

    // 2KB of PCM16 silence -> Float32 conversion path + trimmed result.
    const buf = Buffer.alloc(2048);
    const r = await svc.transcribe(buf, { sampleRate: 16000 });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('hello world');
    expect(typeof r.ms).toBe('number');
    expect(createStream).toHaveBeenCalled();
    expect(decode).toHaveBeenCalled();

    // warmUp now reports ok with the cached model.
    const w = await svc.warmUp();
    expect(w.ok).toBe(true);
  });

  test('transcribe surfaces an error when the recognizer throws', async () => {
    mockSherpaNode = {
      OfflineRecognizer: jest.fn(function OfflineRecognizer() {
        this.createStream = () => { throw new Error('decode blew up'); };
        this.decode = jest.fn();
        this.getResult = jest.fn();
      }),
    };
    const svc = new VoiceService();
    svc.bindConfig(fakeCs({ enabled: true }));
    svc._providerDir = () => dir;
    const r = await svc.transcribe(Buffer.alloc(2048));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/decode blew up/);
  });

  test('_loadModel returns the cached model on the second call without reloading', async () => {
    const ctor = jest.fn(function OfflineRecognizer() {
      this.createStream = jest.fn();
      this.decode = jest.fn();
      this.getResult = jest.fn();
    });
    mockSherpaNode = { OfflineRecognizer: ctor };
    const svc = new VoiceService();
    svc.bindConfig(fakeCs({ enabled: true }));
    svc._providerDir = () => dir;
    const a = await svc._loadModel();
    const b = await svc._loadModel();
    expect(a).toBe(b);
    expect(ctor).toHaveBeenCalledTimes(1);
  });

  test('falls back to sherpa-onnx when sherpa-onnx-node is absent', async () => {
    mockSherpaNode = null;
    mockSherpa = {
      OfflineRecognizer: jest.fn(function OfflineRecognizer() {
        this.createStream = jest.fn(() => ({ acceptWaveform: jest.fn() }));
        this.decode = jest.fn();
        this.getResult = jest.fn(() => ({ transcript: 'fallback text' }));
      }),
    };
    const svc = new VoiceService();
    svc.bindConfig(fakeCs({ enabled: true }));
    svc._providerDir = () => dir;
    const r = await svc.transcribe(Buffer.alloc(2048));
    expect(r.ok).toBe(true);
    expect(r.text).toBe('fallback text');
  });

  test('_loadModel outer catch sets _unavailable when the recognizer ctor throws', async () => {
    mockSherpaNode = {
      OfflineRecognizer: jest.fn(function OfflineRecognizer() {
        throw new Error('native init segfault');
      }),
    };
    const svc = new VoiceService();
    svc.bindConfig(fakeCs({ enabled: true }));
    svc._providerDir = () => dir;
    const model = await svc._loadModel();
    expect(model).toBeNull();
    expect(svc.unavailableReason()).toBe('native init segfault');
    expect(svc.isAvailable()).toBe(false); // _unavailable now latched
  });

  test('_loadModel outer catch falls back to "init_failed" for a message-less throw', async () => {
    mockSherpaNode = {
      OfflineRecognizer: jest.fn(function OfflineRecognizer() {
        const e = new Error(); e.message = ''; throw e;
      }),
    };
    const svc = new VoiceService();
    svc.bindConfig(fakeCs({ enabled: true }));
    svc._providerDir = () => dir;
    expect(await svc._loadModel()).toBeNull();
    expect(svc.unavailableReason()).toBe('init_failed');
  });
});

describe('VoiceService — defaultModelRoot (electron app probe)', () => {
  // Exercises the real _providerDir -> defaultModelRoot path (NOT the stubbed
  // _providerDir used elsewhere) so the app-present candidate-probe loop runs.
  test('with electron app present, the candidate-probe loop returns the app-path candidate when it is the only one that exists', () => {
    // Build a self-contained app dir whose <appPath>/vendor/moonshine exists.
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-voice-app-'));
    fs.mkdirSync(path.join(appDir, 'vendor', 'moonshine', 'tiny-en'), { recursive: true });
    mockElectronApp = { getAppPath: () => appDir };
    const svc = new VoiceService();
    svc.bindConfig(fakeCs({}));
    // Force defaultModelRoot to skip the relative-CWD candidates by running
    // from a CWD that has no vendor/moonshine, then restore.
    const origCwd = process.cwd();
    const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-voice-cwd-'));
    process.chdir(emptyCwd);
    try {
      const providerDir = svc._providerDir();
      expect(providerDir).toBe(path.join(appDir, 'vendor', 'moonshine', 'tiny-en'));
    } finally {
      process.chdir(origCwd);
      fs.rmSync(appDir, { recursive: true, force: true });
      fs.rmSync(emptyCwd, { recursive: true, force: true });
    }
  });

  test('with electron app present but NO candidate existing, falls through to the vendor return', () => {
    mockElectronApp = { getAppPath: () => path.join(os.tmpdir(), 'ic-no-such-app-' + Date.now()) };
    const svc = new VoiceService();
    svc.bindConfig(fakeCs({}));
    const origCwd = process.cwd();
    const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-voice-cwd2-'));
    process.chdir(emptyCwd);
    try {
      const providerDir = svc._providerDir();
      // No candidate matched -> the final `return path.join(__dirname,..vendor/moonshine)`.
      expect(providerDir).toMatch(/vendor[\\/]moonshine[\\/]tiny-en$/);
      expect(path.isAbsolute(providerDir)).toBe(true);
    } finally {
      process.chdir(origCwd);
      fs.rmSync(emptyCwd, { recursive: true, force: true });
    }
  });

  test('falls back to the vendor path when electron app lacks getAppPath', () => {
    mockElectronApp = {}; // truthy app, but no getAppPath -> non-electron fallback
    const svc = new VoiceService();
    svc.bindConfig(fakeCs({ provider: 'moonshine-base' }));
    const providerDir = svc._providerDir();
    expect(providerDir).toMatch(/vendor[\\/]moonshine[\\/]base-en$/);
  });
});

// lifecycleHooks — orphan detection, interceptor wrappers, log dir resolution.
// The only external boundary mocked is `electron` (for logBaseDir's app path).

const { EventEmitter } = require('events');

const mockElectron = { app: { getPath: jest.fn(() => '/userdata') } };
jest.mock('electron', () => mockElectron);

const ledgerModule = require('../../../../main/agent/ledger');
const { attachOrphanListener, wrapInterceptors, logBaseDir } = require('../../../../main/agent/lifecycleHooks');

function fakeService(overrides = {}) {
  const svc = new EventEmitter();
  return Object.assign(svc, {
    _running: true,
    _paused: false,
    _resumePromise: null,
    _resumeResolver: null,
    _task: { description: 'demo' },
    _ledgerState: null,
    ...overrides,
  });
}

describe('attachOrphanListener', () => {
  test('no-ops when wc is missing or lacks once()', () => {
    expect(() => attachOrphanListener({ wc: null, service: fakeService() })).not.toThrow();
    expect(() => attachOrphanListener({ wc: {}, service: fakeService() })).not.toThrow();
  });

  test('destroyed event while not running emits nothing', () => {
    const wc = new EventEmitter();
    wc.once = wc.once.bind(wc);
    const svc = fakeService({ _running: false });
    const orphaned = jest.fn();
    svc.on('task-orphaned', orphaned);
    attachOrphanListener({ wc, service: svc });
    wc.emit('destroyed');
    expect(orphaned).not.toHaveBeenCalled();
  });

  test('destroyed while running pauses the service and emits task-orphaned', () => {
    const wc = new EventEmitter();
    const svc = fakeService({ _toolCtx: { defaultWebContents: wc } });
    const orphaned = jest.fn();
    svc.on('task-orphaned', orphaned);
    attachOrphanListener({ wc, service: svc });
    wc.emit('destroyed');
    expect(svc._paused).toBe(true);
    expect(svc._resumePromise).toBeInstanceOf(Promise);
    expect(typeof svc._resumeResolver).toBe('function');
    expect(orphaned).toHaveBeenCalledWith({ task: { description: 'demo' } });
  });

  test('does not re-create the resume promise if already paused', () => {
    const wc = new EventEmitter();
    const existing = Promise.resolve();
    const svc = fakeService({ _paused: true, _resumePromise: existing, _toolCtx: { defaultWebContents: wc } });
    attachOrphanListener({ wc, service: svc });
    wc.emit('destroyed');
    expect(svc._resumePromise).toBe(existing);
  });

  test('a tab that is no longer the run\'s default tab does not pause it', () => {
    const stale = new EventEmitter();
    const svc = fakeService({ _toolCtx: { defaultWebContents: new EventEmitter() } });
    const orphaned = jest.fn();
    svc.on('task-orphaned', orphaned);
    attachOrphanListener({ wc: stale, service: svc });
    stale.emit('destroyed');
    expect(svc._paused).toBe(false);
    expect(orphaned).not.toHaveBeenCalled();
  });

  test('the returned detach function removes the listener', () => {
    const wc = new EventEmitter();
    const detach = attachOrphanListener({ wc, service: fakeService({ _toolCtx: { defaultWebContents: wc } }) });
    expect(wc.listenerCount('destroyed')).toBe(1);
    detach();
    expect(wc.listenerCount('destroyed')).toBe(0);
  });
});

describe('wrapInterceptors', () => {
  function baseHooks() {
    return {
      beforeStep: jest.fn(async () => {}),
      onStep: jest.fn(async () => {}),
    };
  }

  test('beforeStep appends a rendered ledger line when the ledger has content', async () => {
    const svc = fakeService();
    svc._ledgerState = ledgerModule.patch(ledgerModule.init({ task: 't' }), {
      progress: 'making progress', facts_known_add: ['fact 1'],
    });
    const base = baseHooks();
    const innerBeforeStep = base.beforeStep; // wrapInterceptors reassigns base.beforeStep
    const wrapped = wrapInterceptors({ base, service: svc });
    const ctx = { messages: [] };
    await wrapped.beforeStep(ctx);
    expect(innerBeforeStep).toHaveBeenCalledWith(ctx);
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].role).toBe('user');
    expect(ctx.messages[0].content).toContain('[ledger]');
  });

  test('beforeStep adds nothing when the ledger is empty', async () => {
    const svc = fakeService({ _ledgerState: ledgerModule.init({ task: 't' }) });
    const base = baseHooks();
    const wrapped = wrapInterceptors({ base, service: svc });
    const ctx = { messages: [] };
    await wrapped.beforeStep(ctx);
    expect(ctx.messages).toHaveLength(0);
  });

  test('beforeStep adds nothing when there is no ledger state', async () => {
    const svc = fakeService({ _ledgerState: null });
    const wrapped = wrapInterceptors({ base: baseHooks(), service: svc });
    const ctx = { messages: [] };
    await wrapped.beforeStep(ctx);
    expect(ctx.messages).toHaveLength(0);
  });

  test('onStep emits a throughput event when tokens and latency are positive', async () => {
    const svc = fakeService();
    const tp = jest.fn();
    svc.on('throughput', tp);
    const wrapped = wrapInterceptors({ base: baseHooks(), service: svc });
    await wrapped.onStep({ step: 3, tokens: 100, latencyMs: 2000 });
    expect(tp).toHaveBeenCalledWith({
      step: 3, tokensThisTurn: 100, elapsedMs: 2000, tokPerSec: 50,
    });
  });

  test('onStep emits nothing when tokens or latency are zero/absent', async () => {
    const svc = fakeService();
    const tp = jest.fn();
    svc.on('throughput', tp);
    const wrapped = wrapInterceptors({ base: baseHooks(), service: svc });
    await wrapped.onStep({ step: 1, tokens: 0, latencyMs: 1000 });
    await wrapped.onStep({ step: 2 });
    expect(tp).not.toHaveBeenCalled();
  });
});

describe('logBaseDir', () => {
  test('uses the electron userData path when available', () => {
    mockElectron.app.getPath = jest.fn(() => '/userdata');
    const dir = logBaseDir();
    expect(dir).toContain('/userdata');
    expect(dir).toMatch(/agent-runs$/);
  });

  test('falls back to the OS tmpdir when app.getPath is unavailable', () => {
    const saved = mockElectron.app;
    mockElectron.app = {}; // no getPath
    const dir = logBaseDir();
    expect(dir).toMatch(/instantcognition-agent-runs$/);
    mockElectron.app = saved;
  });
});

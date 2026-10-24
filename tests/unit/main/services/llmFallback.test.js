const { startWithFallback, recoverFromMlxStreamCrash } = require('../../../../main/services/llmFallback');

// Minimal fake LLMService-shaped object. The two functions under test read and
// mutate a well-defined subset of fields (_loadVerified, _fallbackChain,
// _backend, _modelType, _lastStartOpts, _restartCount, _intentionalStop) and
// call a handful of methods (_spawnAndWait, _appendLog, emit, stop, start).
function makeSvc(overrides = {}) {
  return {
    _loadVerified: false,
    _fallbackChain: [],
    _backend: 'llamaCpp',
    _modelType: null,
    _lastStartOpts: {},
    _restartCount: 0,
    _intentionalStop: false,
    _spawnAndWait: jest.fn(),
    _appendLog: jest.fn(),
    emit: jest.fn(),
    stop: jest.fn(),
    start: jest.fn(),
    ...overrides,
  };
}

describe('llmFallback', () => {
  describe('startWithFallback', () => {
    test('returns the status when the primary backend spawns cleanly', async () => {
      const svc = makeSvc({ _spawnAndWait: jest.fn().mockResolvedValue({ ok: true, port: 8080 }) });
      const status = await startWithFallback(svc, { modelPath: '/m' });
      expect(status).toEqual({ ok: true, port: 8080 });
      expect(svc._loadVerified).toBe(false); // not flipped by this helper on success
    });

    test('throws when spawn fails AND the chain is empty', async () => {
      const svc = makeSvc({ _spawnAndWait: jest.fn().mockRejectedValue(new Error('boom')) });
      await expect(startWithFallback(svc, {})).rejects.toThrow('boom');
      // it did not fall over
      expect(svc.emit).not.toHaveBeenCalled();
    });

    test('throws when health-check passed then crashed (mid-session crash leaves fallback alone)', async () => {
      // Real LLMService flips _loadVerified=true once the health probe succeeds.
      // A crash AFTER that point is a mid-session crash — fallback is for
      // load-time failures only, so the chain must be left untouched.
      const svc = makeSvc({
        _spawnAndWait: jest.fn().mockImplementation(async () => {
          svc._loadVerified = true; // health check passed…
          throw new Error('mid crash'); // …then crashed
        }),
        _fallbackChain: [{ backend: 'omlx', opts: {} }],
      });
      await expect(startWithFallback(svc, {})).rejects.toThrow('mid crash');
      expect(svc._fallbackChain).toHaveLength(1);
      expect(svc.emit).not.toHaveBeenCalled();
    });

    test('falls over to the next backend on a load-time failure', async () => {
      const svc = makeSvc({
        _backend: 'mlxOpenAi',
        _spawnAndWait: jest.fn()
          .mockRejectedValueOnce(new Error('load fail'))
          .mockResolvedValueOnce({ ok: true, port: 8081 }),
        _fallbackChain: [{ backend: 'llamaCpp', opts: { modelPath: '/gguf' } }],
      });
      const status = await startWithFallback(svc, { modelPath: '/mlx' });
      expect(status).toEqual({ ok: true, port: 8081 });
      expect(svc._backend).toBe('llamaCpp');
      expect(svc._fallbackChain).toHaveLength(0);
      expect(svc._restartCount).toBe(0);
      expect(svc._intentionalStop).toBe(false); // reset for the fallback proc
      // logs the fallback + emits the fallback event
      expect(svc._appendLog).toHaveBeenCalledWith('warn', expect.stringMatching(/Falling back.*llamaCpp/));
      expect(svc.emit).toHaveBeenCalledWith('fallback', expect.objectContaining({ from: 'mlxOpenAi', to: 'llamaCpp' }));
    });

    test('derives modelType from the backend (isMlxBackend) when opts omits it', async () => {
      const svc = makeSvc({
        _spawnAndWait: jest.fn()
          .mockRejectedValueOnce(new Error('fail'))
          .mockResolvedValueOnce({ ok: true }),
        _fallbackChain: [{ backend: 'omlx', opts: {} }],
      });
      await startWithFallback(svc, {});
      // omlx is an MLX backend → modelType defaults to 'lm'
      expect(svc._modelType).toBe('lm');
      expect(svc._lastStartOpts).toEqual({});
    });

    test('opts.modelType wins over the backend-derived default', async () => {
      const svc = makeSvc({
        _spawnAndWait: jest.fn()
          .mockRejectedValueOnce(new Error('fail'))
          .mockResolvedValueOnce({ ok: true }),
        _fallbackChain: [{ backend: 'llamaCpp', opts: { modelType: 'chat' } }],
      });
      await startWithFallback(svc, {});
      expect(svc._modelType).toBe('chat');
    });

    test('exhausts the chain and throws when every backend fails', async () => {
      const svc = makeSvc({
        _spawnAndWait: jest.fn()
          .mockRejectedValueOnce(new Error('a fail'))
          .mockRejectedValueOnce(new Error('b fail'))
          .mockRejectedValue(new Error('c fail')),
        _fallbackChain: [
          { backend: 'omlx', opts: {} },
          { backend: 'llamaCpp', opts: {} },
        ],
      });
      await expect(startWithFallback(svc, {})).rejects.toThrow('c fail');
      expect(svc._fallbackChain).toHaveLength(0);
    });
  });

  describe('recoverFromMlxStreamCrash', () => {
    test('returns null on a non-MLX backend (no recovery applies)', async () => {
      const svc = makeSvc({ _backend: 'llamaCpp', _lastStartOpts: {} });
      expect(await recoverFromMlxStreamCrash(svc)).toBeNull();
      expect(svc.stop).not.toHaveBeenCalled();
    });

    test('returns null when there is no prior start opts to retry from', async () => {
      const svc = makeSvc({ _backend: 'mlxOpenAi', _lastStartOpts: null });
      expect(await recoverFromMlxStreamCrash(svc)).toBeNull();
    });

    test('multimodal crash: restarts with --model-type lm and emits auto-recovered-text-only', async () => {
      const svc = makeSvc({
        _backend: 'mlxOpenAi',
        _modelType: 'vlm',
        _lastStartOpts: { modelPath: '/m' },
        start: jest.fn().mockResolvedValue({ ok: true, port: 9000 }),
      });
      const status = await recoverFromMlxStreamCrash(svc);
      expect(status).toEqual({ ok: true, port: 9000 });
      expect(svc.stop).toHaveBeenCalledWith({ silent: true });
      expect(svc.start).toHaveBeenCalledWith(expect.objectContaining({ modelType: 'lm', forceTextOnly: true }));
      expect(svc.emit).toHaveBeenCalledWith('auto-recovered-text-only', { reason: 'mlx_stream_crash' });
    });

    // oMLX has no --model-type switch, so a crash on a multimodal oMLX model
    // goes straight to the other runtime instead of a text-only restart.
    test('multimodal oMLX crash skips the text-only restart and falls over to mlxOpenAi', async () => {
      const svc = makeSvc({
        _backend: 'omlx',
        _modelType: 'multimodal',
        _lastStartOpts: { modelPath: '/m' },
        _fallbackChain: [{ backend: 'mlxOpenAi', opts: { modelPath: '/m' } }],
        start: jest.fn().mockResolvedValue({ ok: true }),
      });
      const status = await recoverFromMlxStreamCrash(svc);
      expect(status).toEqual({ ok: true });
      expect(svc.start).toHaveBeenCalledTimes(1);
      expect(svc.start).toHaveBeenCalledWith(expect.objectContaining({ modelPath: '/m', modelType: 'lm', forceTextOnly: true, fallbackChain: [] }));
      expect(svc.emit).not.toHaveBeenCalledWith('auto-recovered-text-only', expect.anything());
      expect(svc.emit).toHaveBeenCalledWith('auto-recovered-alt-mlx', expect.objectContaining({ from: 'omlx', to: 'mlxOpenAi' }));
    });

    test('lm-mode crash: falls over to an alternate MLX backend in the chain', async () => {
      const svc = makeSvc({
        _backend: 'mlxOpenAi',
        _modelType: 'lm',
        _lastStartOpts: { modelPath: '/m' },
        _fallbackChain: [{ backend: 'omlx', opts: { modelPath: '/m2' } }],
        start: jest.fn().mockResolvedValue({ ok: true }),
      });
      const status = await recoverFromMlxStreamCrash(svc);
      expect(status).toEqual({ ok: true });
      expect(svc.start).toHaveBeenCalledWith(expect.objectContaining({
        modelType: 'lm',
        forceTextOnly: true,
        fallbackChain: [],
      }));
      expect(svc.emit).toHaveBeenCalledWith('auto-recovered-alt-mlx', expect.objectContaining({
        from: 'mlxOpenAi', to: 'omlx',
      }));
    });

    test('lm-mode crash with a non-MLX fallback returns null (no cross-family recovery)', async () => {
      const svc = makeSvc({
        _backend: 'mlxOpenAi',
        _modelType: 'lm',
        _lastStartOpts: { modelPath: '/m' },
        _fallbackChain: [{ backend: 'llamaCpp', opts: {} }],
      });
      expect(await recoverFromMlxStreamCrash(svc)).toBeNull();
    });

    test('lm-mode crash with empty chain returns null', async () => {
      const svc = makeSvc({
        _backend: 'omlx',
        _modelType: 'lm',
        _lastStartOpts: { modelPath: '/m' },
        _fallbackChain: [],
      });
      expect(await recoverFromMlxStreamCrash(svc)).toBeNull();
    });
  });
});

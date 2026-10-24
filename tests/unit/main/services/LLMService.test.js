const { EventEmitter } = require('events');

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/mock'), isPackaged: false },
}));

jest.mock('http', () => ({
  get: jest.fn((opts, cb) => {
    const req = new (require('events').EventEmitter)();
    req.destroy = jest.fn();
    setImmediate(() => {
      cb({ statusCode: 200, resume: jest.fn() });
    });
    return req;
  }),
}));

let svc;

function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  return proc;
}

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  svc = require('../../../../main/services/LLMService');
  svc.removeAllListeners();
  svc.on('error', () => {}); // restore the floor listener (removeAllListeners cleared it)
  svc._proc = null;
  svc._status = 'stopped';
  svc._logs = [];
  svc._restartCount = 0;
  svc._lastError = null;
  svc._intentionalStop = false;
  svc._remote = null;
  svc._fallbackChain = [];
  svc._loadVerified = false;
  svc._originalBackend = null;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('LLMService', () => {
  test('initial status is stopped', () => {
    expect(svc.getStatus().status).toBe('stopped');
  });

  test('getEndpoint returns null when not running', () => {
    expect(svc.getEndpoint()).toBeNull();
  });

  test('setRemoteEndpoint switches to running with endpoint', () => {
    svc.setRemoteEndpoint('https://example.com', 'sk-test');
    expect(svc.getStatus().status).toBe('running');
    expect(svc.getEndpoint()).toBe('https://example.com');
    expect(svc.getStatus().isRemote).toBe(true);
  });

  test('clearRemoteEndpoint reverts to stopped', () => {
    svc.setRemoteEndpoint('https://example.com');
    svc.clearRemoteEndpoint();
    expect(svc.getStatus().status).toBe('stopped');
    expect(svc.getEndpoint()).toBeNull();
  });

  describe('dual state — remote configured AND local engine running', () => {
    // Reachable from pure UI flow: Use Remote, switch mode to Local, Start. Nothing in llm:start clears the persisted remote config, so both states coexist (item B).

    beforeEach(() => {
      svc.setRemoteEndpoint('https://api.example.com/v1/', 'sk-test', 'big-model'); // trailing /v1 as stored pre-normalization in older configs; also forces _backend='remote' which a real start() would overwrite next, but we short-circuit that here to isolate the state under test
      svc._proc = makeFakeProc();
      svc._port = 8421;
      svc._host = '127.0.0.1';
      svc._modelPath = '/models/local.gguf';
      svc._backend = 'llamaCpp'; // what start() would set once it actually runs the local engine, overwriting whatever remote left behind
      svc._status = 'running';
    });

    test('getEndpoint returns the live local proc URL, not the shadowing remote endpoint', () => {
      expect(svc.getEndpoint()).toBe('http://127.0.0.1:8421'); // returning _remote.endpoint here would silently route all chat to a paid API while UI shows "local engine running" — that is exactly what this pins against regressing
    });

    test('clearRemoteEndpoint on a live local proc leaves the endpoint and running status untouched', () => {
      svc.clearRemoteEndpoint(); // must not tear down or report stopped just because _remote was cleared while a real process is alive — callers would read that as "engine died" when nothing did
      expect(svc.getEndpoint()).toBe('http://127.0.0.1:8421');
    });

    test("setRemoteEndpoint on a live local proc keeps running status but does not flip endpoint resolution to remote", () => {
      // The user re-activating Remote in Settings while the local engine still runs is one click away from this; until they explicitly stop+switch, chat traffic must stay put rather than jump endpoints mid-session.
      svc.setRemoteEndpoint('https://api.example.com', 'sk-test2');
      expect(svc.getStatus().status).toBe('running'); // status was already running for the local proc — a second "start" signal here would desync every listener that treats it as a transition edge, not merely re-asserting current state
      expect(svc.getEndpoint()).toBe('http://127.0.0.1:8421'); // same reason getEndpoint above; consistency across both surfaces is what makes the pair safe to rely on independently
    });

    test("clearRemoteEndpoint with NO live local proc still reverts endpoint and 'running' status from remote", () => {
      svc._proc = null;
      expect(svc.getStatus().status).toBe('running'); // pre-clear: only the remote was providing "active" state, so it read running even though nothing is actually executing locally — that's correct for a pure-remote setup and must survive this refactor unchanged (pure-remote behavior is untouched by item B)
      svc.clearRemoteEndpoint();
      expect(svc.getEndpoint()).toBeNull();
    });
  });

  test('start rejects without binaryPath', async () => {
    await expect(svc.start({})).rejects.toThrow(/binaryPath/);
  });

  test('start rejects without modelPath', async () => {
    await expect(svc.start({ binaryPath: '/x' })).rejects.toThrow(/modelPath/);
  });

  test('start rejects without port', async () => {
    await expect(svc.start({ binaryPath: '/x', modelPath: '/m' })).rejects.toThrow(/port/);
  });

  test('start spawns child and waits for healthy', async () => {
    const fakeProc = makeFakeProc();
    svc._setSpawn(jest.fn(() => fakeProc));
    svc._setHttpGet(jest.fn(() => Promise.resolve(true)));

    const startPromise = svc.start({
      binaryPath: '/usr/bin/llama-server',
      modelPath: '/models/test.gguf',
      port: 8421,
      contextSize: 2048,
      threads: 4,
      gpuLayers: 0,
    });

    // Let async health check resolve
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(1100);
    await Promise.resolve();

    const status = await startPromise;
    expect(status.status).toBe('running');
    expect(status.model).toBe('/models/test.gguf');
  });

  test('logs are appended via _appendLog and ring-buffered', () => {
    for (let i = 0; i < 250; i++) {
      svc._appendLog('info', 'line ' + i);
    }
    expect(svc.getLogs().length).toBeLessThanOrEqual(200);
  });

  test('status-change event fires when status updates', () => {
    const listener = jest.fn();
    svc.on('status-change', listener);
    svc._setStatus('starting');
    svc._setStatus('running');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test('status-change does not fire when status unchanged', () => {
    svc._setStatus('starting');
    const listener = jest.fn();
    svc.on('status-change', listener);
    svc._setStatus('starting');
    expect(listener).not.toHaveBeenCalled();
  });

  test('stop with no proc still sets stopped', async () => {
    await svc.stop();
    expect(svc.getStatus().status).toBe('stopped');
  });

  describe('visibility pause/resume', () => {
    async function bootRunning() {
      const fakeProc = makeFakeProc();
      svc._setSpawn(jest.fn(() => fakeProc));
      svc._setHttpGet(jest.fn(() => Promise.resolve(true)));
      const startPromise = svc.start({
        binaryPath: '/usr/bin/llama-server',
        modelPath: '/models/test.gguf',
        port: 8421,
        contextSize: 2048,
        threads: 4,
        gpuLayers: 0,
      });
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(1100);
      await Promise.resolve();
      await startPromise;
      return fakeProc;
    }

    test('pauseForVisibility snapshots opts and stops the proc', async () => {
      const fakeProc = await bootRunning();
      svc.pauseForVisibility();
      // stop is fire-and-forget (await internally); let it resolve.
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((r) => setImmediate(r));
      expect(svc._pauseSnapshot).toBeTruthy();
      expect(svc._pauseSnapshot.opts.binaryPath).toBe('/usr/bin/llama-server');
      expect(svc._proc).toBeNull();
      expect(fakeProc.kill).toHaveBeenCalled();
    });

    test('resumeFromVisibility restarts with snapshot opts', async () => {
      await bootRunning();
      svc.pauseForVisibility();
      await new Promise((r) => setImmediate(r));

      // Replace spawn fn so resume actually launches a new proc.
      const newProc = makeFakeProc();
      svc._setSpawn(jest.fn(() => newProc));
      svc._setHttpGet(jest.fn(() => Promise.resolve(true)));

      await svc.resumeFromVisibility();
      expect(svc._pauseSnapshot).toBeNull();
      expect(svc.getStatus().status).toBe('running');
    });

    test('explicit user stop voids a pending resume', async () => {
      await bootRunning();
      svc.pauseForVisibility();
      await new Promise((r) => setImmediate(r));

      const newProc = makeFakeProc();
      const spawnSpy = jest.fn(() => newProc);
      svc._setSpawn(spawnSpy);
      svc._setHttpGet(jest.fn(() => Promise.resolve(true)));

      // User pressed Stop while hidden.
      await svc.stop({ silent: false });
      await svc.resumeFromVisibility();
      // No new spawn should have happened — the snapshot was wiped by stop().
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    // The killed proc's SIGTERM exit must NOT flip the parked engine into 'error': pause sets status to 'stopped' before killing, so if LLMManager's spawn-time handler still fires for that same child (it does unless park detaches its listeners), it sees wasRunning=false + non-zero signal and falls through to _setStatus('error') — a normal hide-while-running would then read as an engine failure until resume.
    test("parked engine stays 'stopped' after the proc actually exits via SIGTERM (no false error state)", async () => {
      const fakeProc = await bootRunning();
      expect(svc.getStatus().status).toBe('running'); // pre-park sanity: this is what makes a flip to 'error' observable rather than an accidental no-op either way
      svc.pauseForVisibility();
      expect(svc._proc).toBeNull(); // park already detached the handle from manager state — but the OS-level child (and its listeners) are still alive until it actually dies, and THAT is what this test drives next; without a real 'exit' emission here, a buggy detach that simply never listens again would pass vacuously
      fakeProc.emit('exit', null, 'SIGTERM'); // matches how llama-server/mlx_lm.server actually die on SIGTERM — code=null + signal='SIGTERM', not an artificial non-zero exit code

      expect(svc.getStatus().status).toBe('stopped'); // the whole point: park is a deferral ("paused while hidden"), never a failure. If this reads 'error' after just a normal hide, any UI or logic that branches on lastError/status will treat a parked engine as broken for however long it stays hidden — and resumeFromVisibility doesn't consult _status at all before restarting (llmVisibility.js), so the only thing keeping users from seeing spurious error toasts is this staying 'stopped'.
      expect(svc._pauseSnapshot).toBeTruthy(); // park's job is to preserve restart state; a false-error path must not also lose that — if both fail together, resume would silently do nothing and the user loses their running engine with no indication why.
    });

    test('pauseForVisibility is a no-op when not running', () => {
      expect(svc._proc).toBeNull();
      svc.pauseForVisibility();
      expect(svc._pauseSnapshot).toBeNull(); // nothing to park means nothing recorded — a stray snapshot here would make resumeFromVisibility restart an engine the user never asked for, out of nowhere.
    });
  });


  test('start refuses if already running', async () => {
    svc._proc = makeFakeProc();
    await expect(svc.start({ binaryPath: '/x', modelPath: '/m', port: 1234 })).rejects.toThrow(/already running/);
  });

  test('mlxOpenAi start rejects without pythonPath', async () => {
    await expect(svc.start({ backend: 'mlxOpenAi', modelPath: '/m', port: 1234 })).rejects.toThrow(/pythonPath/);
  });

  test('omlx start rejects without pythonPath', async () => {
    await expect(svc.start({ backend: 'omlx', modelPath: '/m', port: 1234 })).rejects.toThrow(/pythonPath required/);
  });

  test('the removed mlxLm backend is rejected as unsupported', async () => {
    await expect(svc.start({ backend: 'mlxLm', pythonPath: '/p', modelPath: '/m', port: 1234 })).rejects.toThrow('unsupported backend: mlxLm');
  });

  test('vllm start rejects without pythonPath (isPythonBackend gate)', async () => {
    // vLLM launches as `python -m vllm...`; a missing pythonPath would build a
    // malformed command. The isPythonBackend guard fails loud at validation.
    await expect(svc.start({ backend: 'vllm', modelPath: '/m', port: 1234 })).rejects.toThrow(/pythonPath/);
  });

  test('vllm start with pythonPath reaches spawn and becomes healthy', async () => {
    const fakeProc = makeFakeProc();
    svc._setSpawn(jest.fn(() => fakeProc));
    svc._setHttpGet(jest.fn(() => Promise.resolve(true)));
    const startPromise = svc.start({ backend: 'vllm', pythonPath: '/usr/bin/python3', modelPath: '/m/llama3', port: 8000 });
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(1100);
    await Promise.resolve();
    const status = await startPromise;
    expect(status.status).toBe('running');
    expect(status.backend).toBe('vllm');
  });

  test('mlxOpenAi start runs mlx-openai-server through the resolved interpreter', async () => {
    const fakeProc = makeFakeProc();
    const spawnFn = jest.fn(() => fakeProc);
    svc._setSpawn(spawnFn);
    svc._setHttpGet(jest.fn(() => Promise.resolve(true)));

    const startPromise = svc.start({
      backend: 'mlxOpenAi',
      pythonPath: '/usr/bin/python3',
      modelPath: 'mlx-community/Llama-3-8B',
      port: 8421,
    });

    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(1100);
    await Promise.resolve();

    const status = await startPromise;
    expect(status.status).toBe('running');
    expect(status.backend).toBe('mlxOpenAi');
    expect(status.originalBackend).toBe('mlxOpenAi');
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnFn.mock.calls[0];
    expect(cmd).toBe('/usr/bin/python3');
    expect(args.slice(0, 4)).toEqual(['-I', '-c', 'import sys; from app.cli import cli; sys.exit(cli())', 'launch']);
    expect(args).toContain('--model-path');
    expect(args).toContain('mlx-community/Llama-3-8B');
    expect(args).toContain('--model-type');
    expect(args).toContain('lm');
    expect(args).toContain('--no-log-file');
  });

  test('omlx start pins the model, spawns omlx serve, polls /health and loads the model', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsvc-omlx-'));
    try {
      const fakeProc = makeFakeProc();
      const spawnFn = jest.fn(() => fakeProc);
      const httpGet = jest.fn(() => Promise.resolve(true));
      const httpPost = jest.fn(() => Promise.resolve({ status: 200, body: '' }));
      svc._setSpawn(spawnFn);
      svc._setHttpGet(httpGet);
      svc._setHttpPost(httpPost);

      const status = await svc.start({
        backend: 'omlx',
        pythonPath: '/venv/bin/python3',
        modelPath: '/models/Qwen3-8B-4bit/',
        basePath,
        port: 8421,
      });

      expect(status.status).toBe('running');
      expect(status.backend).toBe('omlx');
      expect(status.apiModel).toBe('Qwen3-8B-4bit');
      const [cmd, args] = spawnFn.mock.calls[0];
      expect(cmd).toBe('/venv/bin/python3');
      expect(args.slice(0, 4)).toEqual(['-I', '-m', 'omlx.cli', 'serve']);
      expect(args).toEqual(expect.arrayContaining(['--model-dir', '/models/Qwen3-8B-4bit/', '--base-path', basePath, '--port', '8421']));
      expect(httpGet).toHaveBeenCalledWith('http://127.0.0.1:8421/health');
      expect(httpPost).toHaveBeenCalledWith(expect.objectContaining({ port: 8421, path: '/v1/models/Qwen3-8B-4bit/load' }));
      const settings = JSON.parse(fs.readFileSync(path.join(basePath, 'model_settings.json'), 'utf8'));
      expect(settings.models['Qwen3-8B-4bit']).toEqual(expect.objectContaining({ is_pinned: true, is_default: true }));
    } finally {
      fs.rmSync(basePath, { recursive: true, force: true });
    }
  });

  test('an oMLX model that fails to load fails the start instead of reporting running', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsvc-omlx-'));
    try {
      const fakeProc = makeFakeProc();
      fakeProc.kill = jest.fn(() => setImmediate(() => fakeProc.emit('exit', null, 'SIGTERM')));
      svc._setSpawn(jest.fn(() => fakeProc));
      svc._setHttpGet(jest.fn(() => Promise.resolve(true)));
      svc._setHttpPost(jest.fn(() => Promise.resolve({ status: 507, body: 'needs 40 GB' })));

      await expect(svc.start({ backend: 'omlx', pythonPath: '/venv/bin/python3', modelPath: '/models/Big', basePath, port: 8421 }))
        .rejects.toThrow(/oMLX does not have enough memory to load Big\. needs 40 GB/);
      expect(svc.getStatus().status).toBe('error');
    } finally {
      fs.rmSync(basePath, { recursive: true, force: true });
    }
  });

  test('start rejects unsupported backend', async () => {
    await expect(svc.start({ backend: 'bogus', modelPath: '/m', port: 1234 })).rejects.toThrow(/unsupported/);
  });

  test('start rejects legacy umbrella "mlx" backend (must use mlxOpenAi/omlx)', async () => {
    // The mergeStartOpts layer normalizes legacy 'mlx' before reaching the
    // service, so by the time start() runs the id should always be specific.
    await expect(svc.start({ backend: 'mlx', pythonPath: '/p', modelPath: '/m', port: 1234 })).rejects.toThrow(/unsupported/);
  });

  test('fallback chain swaps backends on pre-health failure', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsvc-omlx-'));
    const procA = makeFakeProc();
    const procB = makeFakeProc();
    const spawnFn = jest.fn();
    spawnFn.mockImplementationOnce(() => {
      // Schedule procA to die on the next microtask — before the first
      // health check completes — so _waitForHealthy throws.
      Promise.resolve().then(() => procA.emit('exit', 1, null));
      return procA;
    });
    spawnFn.mockImplementationOnce(() => procB);
    svc._setSpawn(spawnFn);
    let attempts = 0;
    // procA: health says 'not yet'. procB: health says ready.
    svc._setHttpGet(jest.fn(() => Promise.resolve(attempts++ > 0)));
    svc._setHttpPost(jest.fn(() => Promise.resolve({ status: 200, body: '' })));

    const fallbackEvents = [];
    svc.on('fallback', (e) => fallbackEvents.push(e));

    try {
      const startPromise = svc.start({
        backend: 'mlxOpenAi',
        pythonPath: '/usr/bin/python3',
        modelPath: 'm',
        port: 8421,
        fallbackChain: [{ backend: 'omlx', opts: { backend: 'omlx', pythonPath: '/omlx/bin/python3', modelPath: 'm', basePath, port: 8421 } }],
      });

      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
        jest.advanceTimersByTime(1100);
      }

      const status = await startPromise;
      expect(status.backend).toBe('omlx');
      expect(status.originalBackend).toBe('mlxOpenAi');
      expect(spawnFn).toHaveBeenCalledTimes(2);
      expect(spawnFn.mock.calls[1][0]).toBe('/omlx/bin/python3');
      expect(fallbackEvents).toHaveLength(1);
      expect(fallbackEvents[0].from).toBe('mlxOpenAi');
      expect(fallbackEvents[0].to).toBe('omlx');
    } finally {
      fs.rmSync(basePath, { recursive: true, force: true });
    }
  });

  // Regression: _spawnAndWait's health-failure stop used to run un-awaited, so
  // a fallback B spawned while A's stop was still in its SIGKILL grace would
  // get its _proc slot nulled by the late-resuming stop — orphaning B.
  test('fallback proc survives the failed backend settling late (kill grace race)', async () => {
    const procA = makeFakeProc(); // never emits 'exit', never healthy
    const procB = makeFakeProc();
    const spawnFn = jest.fn();
    spawnFn.mockImplementationOnce(() => procA);
    spawnFn.mockImplementationOnce(() => procB);
    svc._setSpawn(spawnFn);
    // A never healthy; B ready on its first poll.
    svc._setHttpGet(jest.fn(() => Promise.resolve(svc._proc === procB)));

    const startPromise = svc.start({
      backend: 'llamaCpp',
      binaryPath: '/bin/llama-server',
      modelPath: 'm',
      port: 8421,
      fallbackChain: [{ backend: 'llamaCpp', opts: { backend: 'llamaCpp', binaryPath: '/bin/llama-server-b', modelPath: 'm', port: 8421 } }],
    });

    // Advance past A's 60s health timeout and the 3s SIGKILL grace; each
    // timer step needs several microtask turns for the poll/stop chains.
    for (let i = 0; i < 70; i++) {
      for (let j = 0; j < 10; j++) await Promise.resolve();
      jest.advanceTimersByTime(1100);
    }

    const status = await startPromise;
    expect(status.status).toBe('running');
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(svc._proc).toBe(procB); // the late stop of A must not clear B

    // procB never emits 'exit', so stop() needs its 3s kill grace advanced.
    const stopPromise = svc.stop();
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 10; j++) await Promise.resolve();
      jest.advanceTimersByTime(1100);
    }
    await stopPromise;
    expect(procB.kill).toHaveBeenCalled();
    expect(svc._proc).toBeNull();
  });

  // restartAsTextOnly is the auto-recovery hook called by LLMClientService when
  // a chat request returns the MLX "Stream(gpu, N) in current thread" error.
  // It has two stages: (1) multimodal → text-only; (2) if text-only also
  // crashes, swap to the alternate MLX runtime via the fallback chain.
  describe('restartAsTextOnly', () => {
    test('returns null when not running an MLX backend', async () => {
      svc._backend = 'llamaCpp';
      svc._lastStartOpts = { backend: 'llamaCpp' };
      svc._modelType = 'multimodal';
      expect(await svc.restartAsTextOnly()).toBeNull();
    });

    test('returns null with no _lastStartOpts (nothing to restart)', async () => {
      svc._backend = 'mlxOpenAi';
      svc._lastStartOpts = null;
      svc._modelType = 'multimodal';
      expect(await svc.restartAsTextOnly()).toBeNull();
    });

    test('first stage: multimodal → restarts with --model-type lm + forceTextOnly', async () => {
      svc._backend = 'mlxOpenAi';
      svc._modelType = 'multimodal';
      svc._lastStartOpts = { backend: 'mlxOpenAi', pythonPath: '/p', modelPath: '/m', port: 8421 };
      svc._fallbackChain = [];
      svc.stop = jest.fn().mockResolvedValue();
      svc.start = jest.fn().mockResolvedValue({ status: 'running' });
      const events = [];
      svc.on('auto-recovered-text-only', (e) => events.push(e));

      const result = await svc.restartAsTextOnly();

      expect(svc.stop).toHaveBeenCalledWith({ silent: true });
      expect(svc.start).toHaveBeenCalledTimes(1);
      const startedWith = svc.start.mock.calls[0][0];
      expect(startedWith.modelType).toBe('lm');
      expect(startedWith.forceTextOnly).toBe(true);
      expect(startedWith.modelPath).toBe('/m');
      expect(events).toHaveLength(1);
      expect(result).toEqual({ status: 'running' });
    });

    test('second stage: lm-mode crash → swaps to alternate MLX runtime from fallback chain', async () => {
      svc._backend = 'mlxOpenAi';
      svc._modelType = 'lm';
      svc._lastStartOpts = { backend: 'mlxOpenAi', pythonPath: '/p', modelPath: '/m', port: 8421 };
      svc._fallbackChain = [{
        backend: 'omlx',
        opts: { backend: 'omlx', pythonPath: '/p', modelPath: '/m', port: 8421, modelType: 'multimodal' },
      }];
      svc.stop = jest.fn().mockResolvedValue();
      svc.start = jest.fn().mockResolvedValue({ status: 'running', backend: 'omlx' });
      const events = [];
      svc.on('auto-recovered-alt-mlx', (e) => events.push(e));

      const result = await svc.restartAsTextOnly();

      expect(svc.stop).toHaveBeenCalledWith({ silent: true });
      const startedWith = svc.start.mock.calls[0][0];
      expect(startedWith.backend).toBe('omlx');
      // Alt runtime is forced into text-only too — same threading-bug class.
      expect(startedWith.modelType).toBe('lm');
      expect(startedWith.forceTextOnly).toBe(true);
      // No further fallback to prevent infinite escalation.
      expect(startedWith.fallbackChain).toEqual([]);
      expect(events).toHaveLength(1);
      expect(events[0].from).toBe('mlxOpenAi');
      expect(events[0].to).toBe('omlx');
      expect(result.backend).toBe('omlx');
    });

    test('second stage: returns null when fallback chain is empty', async () => {
      svc._backend = 'mlxOpenAi';
      svc._modelType = 'lm';
      svc._lastStartOpts = { backend: 'mlxOpenAi', pythonPath: '/p', modelPath: '/m', port: 8421 };
      svc._fallbackChain = [];
      svc.stop = jest.fn().mockResolvedValue();
      svc.start = jest.fn().mockResolvedValue({ status: 'running' });

      expect(await svc.restartAsTextOnly()).toBeNull();
      expect(svc.stop).not.toHaveBeenCalled();
      expect(svc.start).not.toHaveBeenCalled();
    });

    test('second stage: returns null when fallback target is not an MLX backend', async () => {
      svc._backend = 'mlxOpenAi';
      svc._modelType = 'lm';
      svc._lastStartOpts = { backend: 'mlxOpenAi', pythonPath: '/p', modelPath: '/m', port: 8421 };
      svc._fallbackChain = [{ backend: 'llamaCpp', opts: {} }];
      svc.stop = jest.fn().mockResolvedValue();
      svc.start = jest.fn().mockResolvedValue({ status: 'running' });

      expect(await svc.restartAsTextOnly()).toBeNull();
      expect(svc.start).not.toHaveBeenCalled();
    });
  });

  test('mid-session crash does NOT trigger fallback chain (only same-args restart)', async () => {
    const proc = makeFakeProc();
    const spawnFn = jest.fn(() => proc);
    svc._setSpawn(spawnFn);
    svc._setHttpGet(jest.fn(() => Promise.resolve(true)));

    const fallbackEvents = [];
    svc.on('fallback', (e) => fallbackEvents.push(e));

    const startPromise = svc.start({
      backend: 'mlxOpenAi',
      pythonPath: '/usr/bin/python3',
      modelPath: 'm',
      port: 8421,
      fallbackChain: [{ backend: 'omlx', opts: { backend: 'omlx', pythonPath: '/usr/bin/python3', modelPath: 'm', port: 8421 } }],
    });
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(1100);
    await Promise.resolve();
    await startPromise;

    // Now the running process dies — _loadVerified is true, so no fallback.
    proc.emit('exit', 1, null);
    expect(fallbackEvents).toHaveLength(0);
  });
});

describe('LLMService reload', () => {
  const tick = () => new Promise((r) => setImmediate(r));
  const opts = { backend: 'llamaCpp', binaryPath: '/engines/b2/llama-server', modelPath: '/models/a.gguf', port: 8421 };

  // A process that exits as soon as it is killed, like a server honouring SIGTERM.
  function dyingProc() {
    const proc = makeFakeProc();
    proc.kill = jest.fn(() => setImmediate(() => proc.emit('exit', null, 'SIGTERM')));
    return proc;
  }

  // The reloaded server stays in its health wait until the test lets it pass.
  function gatedHealth() {
    let pass;
    const gate = new Promise((r) => { pass = r; });
    let first = true;
    svc._setHttpGet(jest.fn(() => {
      if (!first) return Promise.resolve(true);
      first = false;
      return gate;
    }));
    return () => pass(true);
  }

  beforeEach(() => {
    svc._proc = dyingProc();
    svc._status = 'running';
    svc._lastStartOpts = { ...opts, binaryPath: '/bundled/llama-server' };
  });

  test('a start pressed while a reload loads waits for it and keeps the reloaded server', async () => {
    const spawn = jest.fn(() => dyingProc());
    svc._setSpawn(spawn);
    const pass = gatedHealth();

    const reload = svc.reload({ ...opts });
    await tick();
    await tick();
    expect(spawn).toHaveBeenCalledTimes(1);
    const manual = svc.start({ ...opts });
    pass();

    await expect(reload).resolves.toMatchObject({ status: 'running' });
    await expect(manual).resolves.toMatchObject({ status: 'running', model: '/models/a.gguf' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test('a start for another model during a reload replaces the reloaded server', async () => {
    const spawn = jest.fn(() => dyingProc());
    svc._setSpawn(spawn);
    const pass = gatedHealth();

    const reload = svc.reload({ ...opts });
    await tick();
    await tick();
    const manual = svc.start({ ...opts, modelPath: '/models/b.gguf' });
    pass();
    await reload;

    await expect(manual).resolves.toMatchObject({ status: 'running', model: '/models/b.gguf' });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(svc._lastStartOpts.modelPath).toBe('/models/b.gguf');
  });

  test('a second reload while one is in progress is refused', async () => {
    svc._setSpawn(jest.fn(() => dyingProc()));
    const pass = gatedHealth();

    const reload = svc.reload({ ...opts });
    await expect(svc.reload({ ...opts })).rejects.toThrow(/already reloading/);
    await tick();
    await tick();
    pass();
    await reload;
  });

  test('a start outside a reload still refuses a running server', async () => {
    await expect(svc.start({ ...opts })).rejects.toThrow(/already running/);
  });
});

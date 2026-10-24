// EngineUpdateService — the daily llama.cpp / MLX runtime check and the
// user-triggered install. Network and disk are mocked at the engineFetch seam,
// so these exercise the policy: what counts as newer, what gets sent to the
// renderer, and what the install refuses to do.

jest.mock('../../../../main/services/llm/engineFetch', () => ({
  getJson: jest.fn(),
  fetchText: jest.fn(),
  downloadVerified: jest.fn(),
  run: jest.fn(),
  extractArchive: jest.fn(),
  findFile: jest.fn(),
  copyDirContents: jest.fn(),
}));

jest.mock('../../../../main/services/EngineDiscoveryService', () => ({
  detectLlamaCpp: jest.fn(),
  detectMlx: jest.fn(),
  clearCache: jest.fn(),
  getBundledMlxPython: jest.fn(() => null),
  findPythonInterpreter: jest.fn(async () => null),
  isDiscoveredPath: jest.fn(() => false),
  resolveBackendPath: jest.fn(async () => null),
}));

jest.mock('../../../../main/services/llm/enginePaths', () => ({
  managedRoot: jest.fn(() => '/tmp/engines'),
  managedLlamaRoot: jest.fn(() => '/tmp/engines/llama-server'),
  managedLlamaDirs: jest.fn(() => []),
  managedMlxVenv: jest.fn(() => '/tmp/engines/mlx-venv'),
  venvPython: jest.fn((d) => `${d}/bin/python3`),
  managedMlxPython: jest.fn(() => null),
}));

const fetcher = require('../../../../main/services/llm/engineFetch');
const discovery = require('../../../../main/services/EngineDiscoveryService');
const service = require('../../../../main/services/EngineUpdateService');

const LATEST_RELEASE = {
  tag_name: 'v0.4.0',
  assets: [{ name: 'nightly-tag.txt', browser_download_url: 'https://example.test/nightly-tag.txt' }],
};

function makeWindow() {
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
}

// In-memory stand-in for ConfigService's dotted get/set.
function makeConfig(settings = {}) {
  const config = { settings };
  const walk = (keyPath) => keyPath.split('.');
  return {
    config,
    get: (keyPath, fallback) => {
      let cur = config;
      for (const part of walk(keyPath)) {
        if (cur === null || typeof cur !== 'object') return fallback;
        cur = cur[part];
      }
      return cur === undefined ? fallback : cur;
    },
    set: (keyPath, value) => {
      const parts = walk(keyPath);
      let cur = config;
      for (const part of parts.slice(0, -1)) {
        if (cur[part] == null || typeof cur[part] !== 'object') cur[part] = {};
        cur = cur[part];
      }
      cur[parts[parts.length - 1]] = value;
    },
  };
}

function makeLlm(status, lastStartOpts = null) {
  return {
    _lastStartOpts: lastStartOpts,
    getStatus: jest.fn(() => status),
    reload: jest.fn(async () => ({ status: 'running' })),
  };
}

function mlxNotSupported() {
  discovery.detectMlx.mockResolvedValue({ available: false, pythonPath: null, reason: 'MLX requires Apple silicon' });
}

describe('EngineUpdateService', () => {
  let win;
  const hostPlatform = process.platform;

  // The runtimes offered depend on the host (MLX on macOS, vLLM on Linux and
  // Windows), and these cases exercise the macOS set, so they run as macOS
  // on every CI runner. A case about another platform pins its own.
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    jest.clearAllMocks();
    win = makeWindow();
    service._window = win;
    service._configService = null;
    service._busy = false;
    service._latest = { llamaCpp: null, mlx: null };
    service._lastEngines = null;
    service._deps = {};
    fetcher.getJson.mockImplementation(async (url) => {
      if (url.endsWith('/releases/latest')) return LATEST_RELEASE;
      throw new Error(`unexpected GET ${url}`);
    });
    fetcher.fetchText.mockResolvedValue('b10831\n');
  });

  afterEach(() => {
    service.stop();
    Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true });
  });

  describe('check', () => {
    test('resolves the build tag through nightly-tag.txt and records a newer build without prompting', async () => {
      // releases/latest is a versioned release with no binaries — reading its
      // tag_name directly would compare 'v0.4.0' against a build number.
      discovery.detectLlamaCpp.mockResolvedValue({ available: true, path: '/bundled/llama-server', version: 'version: 8772 (bafae2765)' });
      mlxNotSupported();

      const engines = await service.check({ background: true });

      expect(fetcher.fetchText).toHaveBeenCalledWith('https://example.test/nightly-tag.txt');
      const llama = engines.find((e) => e.engine === 'llamaCpp');
      expect(llama.latest).toBe('b10831');
      expect(llama.updateAvailable).toBe(true);
      // Only the startup check or a send may surface it.
      expect(win.sent).toHaveLength(0);
    });

    test('installs nothing on its own — a found update is only reported', async () => {
      discovery.detectLlamaCpp.mockResolvedValue({ available: true, path: '/bundled/llama-server', version: 'version: 8772' });
      mlxNotSupported();

      await service.check({ background: true });

      expect(fetcher.downloadVerified).not.toHaveBeenCalled();
      expect(fetcher.run).not.toHaveBeenCalled();
    });

    test('a background check stays silent when everything is current', async () => {
      discovery.detectLlamaCpp.mockResolvedValue({ available: true, path: '/bundled/llama-server', version: 'version: 10831' });
      mlxNotSupported();

      await service.check({ background: true });

      expect(win.sent).toHaveLength(0);
    });

    test('a manual check always answers, current or not', async () => {
      discovery.detectLlamaCpp.mockResolvedValue({ available: true, path: '/bundled/llama-server', version: 'version: 10831' });
      mlxNotSupported();

      await service.check({ background: false });

      expect(win.sent.map((s) => s.payload.status)).toEqual(['checking', 'up-to-date']);
    });

    test('one runtime failing does not hide the other', async () => {
      discovery.detectLlamaCpp.mockResolvedValue({ available: true, path: '/b/llama-server', version: 'version: 8772' });
      discovery.detectMlx.mockRejectedValue(new Error('probe exploded'));
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const engines = await service.check({ background: false });

      expect(engines.find((e) => e.engine === 'llamaCpp').updateAvailable).toBe(true);
      expect(engines.find((e) => e.engine === 'mlx')).toMatchObject({ ok: false, error: 'probe exploded' });
      warnSpy.mockRestore();
    });

    test('compares MLX packages against PyPI', async () => {
      discovery.detectLlamaCpp.mockResolvedValue({ available: false, path: null, version: null });
      discovery.detectMlx.mockResolvedValue({
        available: true,
        pythonPath: '/py',
        packages: { 'mlx-lm': '0.31.3', 'mlx-openai-server': '1.8.1' },
      });
      fetcher.getJson.mockImplementation(async (url) => {
        if (url.endsWith('/releases/latest')) return LATEST_RELEASE;
        if (url.includes('mlx-lm')) return { info: { version: '0.31.10' } };
        if (url.includes('mlx-openai-server')) return { info: { version: '1.8.1' } };
        throw new Error(`unexpected GET ${url}`);
      });

      const engines = await service.check({ background: true });

      const mlx = engines.find((e) => e.engine === 'mlx');
      expect(mlx.updateAvailable).toBe(true);
      expect(mlx.packages).toEqual([
        { package: 'mlx-lm', current: '0.31.3', latest: '0.31.10' },
        { package: 'mlx-openai-server', current: '1.8.1', latest: '1.8.1' },
      ]);
    });
  });

  describe('update prompt', () => {
    const stoppedStatus = { status: 'stopped', backend: null, isRemote: false };

    beforeEach(() => {
      discovery.detectLlamaCpp.mockResolvedValue({ available: true, path: '/bundled/llama-server', version: 'version: 8772' });
      mlxNotSupported();
    });

    test('the startup check offers the selected local engine update once per version', async () => {
      const cfg = makeConfig({ llm: { mode: 'local', activeBackend: 'llamaCpp' } });
      service._configService = cfg;
      service._deps = { llmService: makeLlm(stoppedStatus) };

      await service.check({ background: true, startup: true });
      await service.check({ background: true, startup: true });

      const prompts = win.sent.filter((s) => s.payload.status === 'available');
      expect(prompts).toHaveLength(1);
      expect(prompts[0].payload.engines.map((e) => e.engine)).toEqual(['llamaCpp']);
      expect(prompts[0].payload.liveEngine).toBeNull();
      expect(cfg.get('settings.llm.engineUpdatePrompted.llamaCpp')).toBe('b10831');
    });

    test('the startup check stays silent when the selected endpoint is remote', async () => {
      service._configService = makeConfig({ llm: { mode: 'remote', activeBackend: 'remote' } });
      service._deps = { llmService: makeLlm({ status: 'running', backend: 'remote', isRemote: true }) };

      await service.check({ background: true, startup: true });

      expect(win.sent).toHaveLength(0);
    });

    test('the first send after a check offers the running engine update, the second does not', async () => {
      service._configService = makeConfig({ llm: { mode: 'local', activeBackend: 'llamaCpp' } });
      service._deps = { llmService: makeLlm({ status: 'running', backend: 'llamaCpp', isRemote: false }, { backend: 'llamaCpp', modelPath: '/m.gguf' }) };
      await service.check({ background: true });
      expect(win.sent).toHaveLength(0);

      expect(service.offerSelected()).toBe(true);
      expect(service.offerSelected()).toBe(false);

      expect(win.sent).toHaveLength(1);
      expect(win.sent[0].payload).toMatchObject({ status: 'available', liveEngine: 'llamaCpp' });
    });

    test('an update for a runtime the selected engine does not use is not offered', async () => {
      service._configService = makeConfig({ llm: { mode: 'local', activeBackend: 'mlxOpenAi' } });
      service._deps = { llmService: makeLlm({ status: 'running', backend: 'mlxOpenAi', isRemote: false }) };
      await service.check({ background: true });

      expect(service.offerSelected()).toBe(false);
      expect(win.sent).toHaveLength(0);
    });

    test('a newer version than the one already offered is offered again', async () => {
      const cfg = makeConfig({ llm: { mode: 'local', activeBackend: 'llamaCpp', engineUpdatePrompted: { llamaCpp: 'b10000', mlx: null } } });
      service._configService = cfg;
      service._deps = { llmService: makeLlm(stoppedStatus) };
      await service.check({ background: true });

      expect(service.offerSelected()).toBe(true);
      expect(cfg.get('settings.llm.engineUpdatePrompted.llamaCpp')).toBe('b10831');
    });

    test('an offer the window could not show is offered again on the next send', async () => {
      const cfg = makeConfig({ llm: { mode: 'local', activeBackend: 'llamaCpp' } });
      service._configService = cfg;
      service._deps = { llmService: makeLlm(stoppedStatus) };
      await service.check({ background: true });
      const shown = service._window;
      service._window = null;

      expect(service.offerSelected()).toBe(false);
      expect(cfg.get('settings.llm.engineUpdatePrompted.llamaCpp', null)).toBeNull();
      service._window = shown;
      expect(service.offerSelected()).toBe(true);
    });

    test('nothing is offered before any check has run', () => {
      service._configService = makeConfig({ llm: { mode: 'local', activeBackend: 'llamaCpp' } });
      service._deps = { llmService: makeLlm(stoppedStatus) };

      expect(service.offerSelected()).toBe(false);
    });

    test('a manual check names the live engine so the toast can offer a restart', async () => {
      service._deps = { llmService: makeLlm({ status: 'running', backend: 'llamaCpp', isRemote: false }, { backend: 'llamaCpp', modelPath: '/m.gguf' }) };

      await service.check({ background: false });

      expect(win.sent.pop().payload).toMatchObject({ status: 'available', liveEngine: 'llamaCpp' });
    });

    test('an engine on a hand-set runtime is not offered a restart', async () => {
      service._deps = { llmService: makeLlm({ status: 'running', backend: 'llamaCpp', isRemote: false }, { backend: 'llamaCpp', binaryPath: '/Users/me/llama-server', modelPath: '/m.gguf' }) };

      await service.check({ background: false });

      expect(win.sent.pop().payload).toMatchObject({ status: 'available', liveEngine: null });
    });

    test('an update the user saw in a manual check is not offered again on the next send', async () => {
      const cfg = makeConfig({ llm: { mode: 'local', activeBackend: 'llamaCpp' } });
      service._configService = cfg;
      service._deps = { llmService: makeLlm(stoppedStatus) };

      await service.check({ background: false });

      expect(cfg.get('settings.llm.engineUpdatePrompted.llamaCpp')).toBe('b10831');
      expect(service.offerSelected()).toBe(false);
    });
  });

  describe('install and restart (MLX)', () => {
    const runningMlx = { status: 'running', backend: 'mlxOpenAi', isRemote: false };
    const startOpts = { backend: 'mlxOpenAi', pythonPath: '/bundled/py', modelPath: '/models/qwen', port: 8421 };

    beforeEach(() => {
      const enginePaths = require('../../../../main/services/llm/enginePaths');
      enginePaths.managedMlxPython.mockReturnValue('/tmp/engines/mlx-venv/bin/python3');
      fetcher.run.mockResolvedValue({ stdout: '', stderr: '' });
      discovery.detectMlx.mockResolvedValue({ available: true, pythonPath: '/tmp/engines/mlx-venv/bin/python3', packages: { 'mlx-lm': '0.32.0', 'mlx-openai-server': '1.9.0' } });
      discovery.resolveBackendPath.mockResolvedValue('/tmp/engines/mlx-venv/bin/python3');
      discovery.isDiscoveredPath.mockImplementation((_engine, p) => p === '/bundled/py' || p === '/tmp/engines/mlx-venv/bin/python3');
    });

    afterEach(() => {
      require('../../../../main/services/llm/enginePaths').managedMlxPython.mockReturnValue(null);
      discovery.isDiscoveredPath.mockImplementation(() => false);
      discovery.resolveBackendPath.mockResolvedValue(null);
      fetcher.run.mockReset();
    });

    test('releases the cached interpreter detection produced and keeps one set by hand', async () => {
      const cfg = makeConfig({ llm: { mlxOpenAi: { pythonPath: '/bundled/py' }, mlxLm: { pythonPath: '/custom/py' } } });
      service._configService = cfg;

      const res = await service.install('mlx');

      expect(res.ok).toBe(true);
      expect(cfg.get('settings.llm.mlxOpenAi.pythonPath')).toBeNull();
      expect(cfg.get('settings.llm.mlxLm.pythonPath')).toBe('/custom/py');
    });

    test('Update + Restart reloads the same model on the new runtime', async () => {
      const llm = makeLlm(runningMlx, { ...startOpts });
      service._configService = makeConfig({ llm: { mlxOpenAi: { pythonPath: '/bundled/py' } } });
      service._deps = { llmService: llm, chatStream: { isBusy: () => false } };

      await service.install('mlx', { restart: true });

      expect(llm.reload).toHaveBeenCalledWith(expect.objectContaining({ modelPath: '/models/qwen', pythonPath: '/tmp/engines/mlx-venv/bin/python3' }));
      const statuses = win.sent.map((s) => s.payload.status);
      expect(statuses.slice(-2)).toEqual(['installed', 'restarted']);
      expect(win.sent.find((s) => s.payload.status === 'installed').payload.pendingRestart).toBe(true);
    });

    test('plain Update leaves the running engine alone but its next restart loads the new runtime', async () => {
      const llm = makeLlm(runningMlx, { ...startOpts });
      service._deps = { llmService: llm, chatStream: { isBusy: () => false } };

      await service.install('mlx');

      expect(llm.reload).not.toHaveBeenCalled();
      expect(llm._lastStartOpts.pythonPath).toBe('/tmp/engines/mlx-venv/bin/python3');
      expect(win.sent.pop().payload).toMatchObject({ status: 'installed', pendingRestart: false });
    });

    test('an installed update is not offered again on the next send', async () => {
      service._configService = makeConfig({ llm: { mode: 'local', activeBackend: 'mlxOpenAi' } });
      service._deps = { llmService: makeLlm(runningMlx, { ...startOpts }), chatStream: { isBusy: () => false } };
      service._lastEngines = [{ engine: 'mlx', ok: true, updateAvailable: true, latest: 'mlx-lm 0.33.0', current: 'mlx-lm 0.32.0' }];

      await service.install('mlx');

      expect(service.offerSelected()).toBe(false);
    });

    test('Update + Restart waits for a memory capture still using the engine', async () => {
      jest.useFakeTimers();
      const llm = makeLlm(runningMlx, { ...startOpts });
      let capturing = true;
      service._deps = { llmService: llm, chatStream: { isBusy: () => false }, userMemory: { isCapturing: () => capturing } };

      const p = service.install('mlx', { restart: true });
      await jest.advanceTimersByTimeAsync(3000);
      expect(llm.reload).not.toHaveBeenCalled();
      capturing = false;
      await jest.advanceTimersByTimeAsync(1000);
      await p;
      jest.useRealTimers();

      expect(llm.reload).toHaveBeenCalledTimes(1);
      expect(win.sent.pop().payload).toMatchObject({ status: 'restarted', engine: 'mlx' });
    });

    test('a failed restart is reported to the user while the install still counts', async () => {
      const llm = makeLlm(runningMlx, { ...startOpts });
      llm.reload.mockRejectedValue(new Error('model failed to load'));
      service._deps = { llmService: llm, chatStream: { isBusy: () => false } };

      const res = await service.install('mlx', { restart: true });

      expect(res.ok).toBe(true);
      expect(win.sent.pop().payload).toMatchObject({ ok: false, status: 'error', phase: 'restart', engine: 'mlx', error: 'model failed to load' });
    });
  });

  describe('install', () => {
    beforeEach(() => {
      service._latest.llamaCpp = 'b10831';
      fetcher.getJson.mockImplementation(async (url) => {
        if (url.endsWith('/releases/tags/b10831')) {
          return { tag_name: 'b10831', assets: [{ name: 'llama-b10831-bin-linux-x64.zip', browser_download_url: 'https://example.test/a.zip', size: 1 }] };
        }
        throw new Error(`unexpected GET ${url}`);
      });
    });

    test('refuses an asset GitHub published no checksum for', async () => {
      // Pin the host so the linux-x64 fixture asset is the one picked.
      const { platform, arch } = process;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });

      const res = await service.install('llamaCpp');

      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      Object.defineProperty(process, 'arch', { value: arch, configurable: true });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/no checksum/i);
      expect(fetcher.downloadVerified).not.toHaveBeenCalled();
      expect(win.sent.pop().payload).toMatchObject({ ok: false, status: 'error', engine: 'llamaCpp' });
    });

    test('reports the platform having no prebuilt binary instead of installing the wrong one', async () => {
      fetcher.getJson.mockImplementation(async () => ({ tag_name: 'b10831', assets: [{ name: 'llama-b10831-bin-win-cpu-x64.zip', digest: 'sha256:abc' }] }));
      const platform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

      const res = await service.install('llamaCpp');

      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/no prebuilt binary/i);
    });

    test('a second install is refused while one is running', async () => {
      service._busy = true;

      const res = await service.install('llamaCpp');

      expect(res).toEqual({ ok: false, error: 'An engine install is already running.' });
      expect(fetcher.getJson).not.toHaveBeenCalled();
    });
  });

  describe('initialize', () => {
    test('schedules no check when the setting is off', () => {
      const configService = { get: jest.fn((path, fallback) => (path === 'settings.llm.engineAutoCheck' ? false : fallback)) };

      service.initialize(win, configService);

      expect(service._timer).toBeNull();
    });

    test('schedules the first check without holding the process open', () => {
      const configService = { get: jest.fn((_path, fallback) => fallback) };

      service.initialize(win, configService);

      expect(service._timer).not.toBeNull();
      service.stop();
      expect(service._timer).toBeNull();
    });
  });
});

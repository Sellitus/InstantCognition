// backendRuntime — per-backend launch opts, spawn shape, health target,
// post-health step and stop escalation. Boundaries: the filesystem (a temp
// dir), Electron's userData path, wsl.exe (wsl module calls), HTTP (the
// injectable `post`), and process signals (a mock child process).

const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../../../../main/services/llm/wsl', () => {
  const actual = jest.requireActual('../../../../../main/services/llm/wsl');
  return { ...actual, execInDistro: jest.fn(), terminateDistro: jest.fn() };
});

const { app } = require('electron');
const wsl = require('../../../../../main/services/llm/wsl');
const rt = require('../../../../../main/services/llm/backendRuntime');

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
function setPlatform(p) { Object.defineProperty(process, 'platform', { value: p, configurable: true }); }

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-rt-test-')); });
afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  fs.rmSync(tmp, { recursive: true, force: true });
  jest.restoreAllMocks();
  jest.resetAllMocks();
  jest.useRealTimers();
});

function modelDir(name, config) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  if (config) fs.writeFileSync(path.join(dir, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return dir;
}

describe('prepareLaunch: omlx', () => {
  test('writes model settings under the given base path and names the folder as model id', () => {
    const model = modelDir('Llama-3.2-1B');
    const base = path.join(tmp, 'home');
    const { opts, apiModel } = rt.prepareLaunch('omlx', { modelPath: model, basePath: base, contextLength: 4096 });
    expect(apiModel).toBe('Llama-3.2-1B');
    expect(opts.basePath).toBe(base);
    const doc = JSON.parse(fs.readFileSync(path.join(base, 'model_settings.json'), 'utf8'));
    expect(doc.models['Llama-3.2-1B']).toEqual({ is_pinned: true, is_default: true, max_context_window: 4096 });
  });

  test('defaults the base path to the managed oMLX home under userData', () => {
    jest.spyOn(app, 'getPath').mockReturnValue(tmp);
    const { opts } = rt.prepareLaunch('omlx', { modelPath: modelDir('M') });
    expect(opts.basePath).toBe(path.join(tmp, 'engines', 'omlx-home'));
    expect(fs.existsSync(path.join(opts.basePath, 'model_settings.json'))).toBe(true);
  });

  test('throws when no engines directory is available', () => {
    jest.spyOn(app, 'getPath').mockReturnValue('');
    expect(() => rt.prepareLaunch('omlx', { modelPath: modelDir('M') })).toThrow(/No writable engines directory/);
  });
});

describe('prepareLaunch: vllm', () => {
  beforeEach(() => setPlatform('linux'));

  test('a Hub repo id is kept as model and served name; its parser comes from the name', () => {
    const { opts, apiModel } = rt.prepareLaunch('vllm', { modelPath: 'Qwen/Qwen3-8B', toolParser: 'auto' });
    expect(opts.modelPath).toBe('Qwen/Qwen3-8B');
    expect(opts.servedModelName).toBe('Qwen/Qwen3-8B');
    expect(apiModel).toBe('Qwen/Qwen3-8B');
    expect(opts.toolCallParser).toBe('hermes');
  });

  test('a local folder is served under its basename with the parser from config.json model_type', () => {
    const dir = modelDir('my-finetune', { model_type: 'qwen3' });
    const { opts, apiModel } = rt.prepareLaunch('vllm', { modelPath: `${dir}/`, toolParser: 'auto' });
    expect(apiModel).toBe('my-finetune');
    expect(opts.toolCallParser).toBe('hermes');
    expect(opts.modelPath).toBe(`${dir}/`);
  });

  test("toolParser 'none' resolves no parser", () => {
    const dir = modelDir('qwen', { model_type: 'qwen3' });
    expect(rt.prepareLaunch('vllm', { modelPath: dir, toolParser: 'none' }).opts.toolCallParser).toBeNull();
  });

  test('an unknown model family resolves no parser', () => {
    const dir = modelDir('weird', { model_type: 'unknownarch' });
    expect(rt.prepareLaunch('vllm', { modelPath: dir, toolParser: 'auto' }).opts.toolCallParser).toBeNull();
  });

  test('an unreadable config.json is an error, not a silent default', () => {
    const dir = modelDir('broken', '{not json');
    expect(() => rt.prepareLaunch('vllm', { modelPath: dir, toolParser: 'auto' })).toThrow(/Could not read/);
  });

  test('on Windows a local path is translated to the WSL view; a repo id is not', () => {
    setPlatform('win32');
    const { opts, apiModel } = rt.prepareLaunch('vllm', { modelPath: 'C:\\models\\Mistral-7B', toolParser: 'none' });
    expect(opts.modelPath).toBe('/mnt/c/models/Mistral-7B');
    // The served name comes from the Windows path (path.basename is host-native).
    expect(apiModel).toBe(opts.servedModelName);
    expect(apiModel).toBe(path.basename('C:\\models\\Mistral-7B'));
    expect(rt.prepareLaunch('vllm', { modelPath: 'org/name', toolParser: 'none' }).opts.modelPath).toBe('org/name');
  });
});

test('prepareLaunch passes other backends through untouched', () => {
  const opts = { modelPath: '/m.gguf', port: 1 };
  const res = rt.prepareLaunch('llamaCpp', opts);
  expect(res).toEqual({ opts, apiModel: null });
});

describe('spawnSpec', () => {
  test('vllm on Windows runs inside the app distro through wsl.exe', () => {
    setPlatform('win32');
    const spec = rt.spawnSpec('vllm', '/opt/v/bin/vllm', ['serve', 'x']);
    expect(spec.command).toBe('wsl.exe');
    expect(spec.args).toEqual(['-d', 'InstantCognition', '-u', 'root', '--exec', '/opt/v/bin/vllm', 'serve', 'x']);
    expect(spec.options.windowsHide).toBe(true);
    expect(spec.options.env.WSL_UTF8).toBe('1');
  });

  test('vllm on Linux gets its own process group', () => {
    setPlatform('linux');
    const spec = rt.spawnSpec('vllm', '/v/bin/vllm', ['serve']);
    expect(spec).toEqual({ command: '/v/bin/vllm', args: ['serve'], options: { stdio: ['ignore', 'pipe', 'pipe'], detached: true } });
  });

  test('other backends spawn plainly', () => {
    setPlatform('linux');
    const spec = rt.spawnSpec('omlx', '/py', ['-m']);
    expect(spec.options).toEqual({ stdio: ['ignore', 'pipe', 'pipe'] });
  });
});

test('healthSpec reads the schema and falls back to /v1/models within 60 s', () => {
  expect(rt.healthSpec('vllm')).toEqual({ path: '/health', timeoutMs: 1800000 });
  expect(rt.healthSpec('omlx')).toEqual({ path: '/health', timeoutMs: 180000 });
  expect(rt.healthSpec('llamaCpp')).toEqual({ path: '/v1/models', timeoutMs: 60000 });
});

describe('afterHealthy', () => {
  const target = { host: '127.0.0.1', port: 9000, apiModel: 'Llama 3' };

  test('oMLX: loads the model by its URL-encoded id; 2xx passes', async () => {
    const post = jest.fn().mockResolvedValue({ status: 200, body: '' });
    await rt.afterHealthy('omlx', target, post);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ host: '127.0.0.1', port: 9000, path: '/v1/models/Llama%203/load' }));
  });

  test('oMLX: 507 is reported as out of memory', async () => {
    const post = jest.fn().mockResolvedValue({ status: 507, body: 'need 40GB ' });
    await expect(rt.afterHealthy('omlx', target, post)).rejects.toThrow('oMLX does not have enough memory to load Llama 3. need 40GB');
  });

  test('oMLX: any other non-2xx fails with the status', async () => {
    const post = jest.fn().mockResolvedValue({ status: 404, body: 'no model' });
    await expect(rt.afterHealthy('omlx', target, post)).rejects.toThrow('oMLX could not load Llama 3 (HTTP 404). no model');
  });

  test('other backends, or oMLX without a model id, make no request', async () => {
    const post = jest.fn();
    await rt.afterHealthy('vllm', target, post);
    await rt.afterHealthy('omlx', { ...target, apiModel: null }, post);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('stopProcess', () => {
  function mockProc({ exitOn = 'SIGTERM', pid = 4321 } = {}) {
    const proc = new EventEmitter();
    proc.pid = pid;
    proc.kill = jest.fn((sig) => { if (sig === exitOn) setImmediate(() => proc.emit('exit', 0)); return true; });
    return proc;
  }

  test('a process that exits on SIGTERM is not SIGKILLed', async () => {
    setPlatform('darwin');
    const proc = mockProc();
    await expect(rt.stopProcess('llamaCpp', proc)).resolves.toEqual([]);
    expect(proc.kill.mock.calls).toEqual([['SIGTERM']]);
  });

  test('a process that ignores SIGTERM is SIGKILLed after the grace period', async () => {
    jest.useFakeTimers();
    setPlatform('darwin');
    const proc = mockProc({ exitOn: 'never' });
    const done = rt.stopProcess('omlx', proc);
    await jest.advanceTimersByTimeAsync(rt.DEFAULT_KILL_GRACE_MS - 1);
    expect(proc.kill.mock.calls).toEqual([['SIGTERM']]);
    await jest.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toEqual([]);
    expect(proc.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  });

  test('ESRCH (already gone) is not a failure; other signal errors are returned', async () => {
    jest.useFakeTimers();
    setPlatform('darwin');
    const proc = mockProc({ exitOn: 'never' });
    proc.kill.mockImplementation((sig) => {
      if (sig === 'SIGTERM') throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    });
    const done = rt.stopProcess('llamaCpp', proc);
    await jest.advanceTimersByTimeAsync(rt.DEFAULT_KILL_GRACE_MS);
    await expect(done).resolves.toEqual(['SIGKILL to llamaCpp failed: not permitted']);
  });

  test('vllm on Linux signals the whole process group with the longer grace', async () => {
    jest.useFakeTimers();
    setPlatform('linux');
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const proc = mockProc({ exitOn: 'never', pid: 777 });
    const done = rt.stopProcess('vllm', proc);
    await jest.advanceTimersByTimeAsync(rt.DEFAULT_KILL_GRACE_MS);
    expect(kill.mock.calls).toEqual([[-777, 'SIGTERM']]);
    await jest.advanceTimersByTimeAsync(rt.VLLM_KILL_GRACE_MS - rt.DEFAULT_KILL_GRACE_MS);
    await done;
    expect(kill.mock.calls).toEqual([[-777, 'SIGTERM'], [-777, 'SIGKILL']]);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  test('vllm on Windows: pkill inside the distro, then terminate the distro', async () => {
    jest.useFakeTimers();
    setPlatform('win32');
    wsl.execInDistro.mockResolvedValue({ stdout: '', stderr: '' });
    wsl.terminateDistro.mockResolvedValue({ stdout: '', stderr: '' });
    const proc = mockProc({ exitOn: 'never' });
    const done = rt.stopProcess('vllm', proc);
    await jest.advanceTimersByTimeAsync(rt.VLLM_KILL_GRACE_MS);
    await done;
    expect(wsl.execInDistro).toHaveBeenCalledWith(['/usr/bin/pkill', '-TERM', '-f', 'vllm serve'], expect.any(Object));
    expect(wsl.terminateDistro).toHaveBeenCalledTimes(1);
    expect(proc.kill.mock.calls).toEqual([['SIGKILL']]);
  });
});

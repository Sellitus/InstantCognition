// engineUpdateHandlers — IPC for the runtime update check and install.
// Electron and the service are mocked so each handler runs directly.

const mockOnHandlers = new Map();
const mockInvokeHandlers = new Map();
const mockAppHandlers = new Map();

jest.mock('electron', () => ({
  ipcMain: {
    on: jest.fn((channel, fn) => { mockOnHandlers.set(channel, fn); }),
    handle: jest.fn((channel, fn) => { mockInvokeHandlers.set(channel, fn); }),
  },
  app: { on: jest.fn((event, fn) => { mockAppHandlers.set(event, fn); }) },
}));

jest.mock('../../../../main/services/ChatStreamService', () => ({ isBusy: jest.fn(() => false) }));
jest.mock('../../../../main/services/UserMemoryService', () => ({ isCapturing: jest.fn(() => false) }));

jest.mock('../../../../main/services/EngineUpdateService', () => ({
  initialize: jest.fn(),
  stop: jest.fn(),
  check: jest.fn(),
  offerSelected: jest.fn(),
  install: jest.fn(async () => ({ ok: true, version: 'b10831' })),
}));

const engineUpdateService = require('../../../../main/services/EngineUpdateService');
const chatStream = require('../../../../main/services/ChatStreamService');
const userMemory = require('../../../../main/services/UserMemoryService');

function loadHandlers(services = {}) {
  mockOnHandlers.clear();
  mockInvokeHandlers.clear();
  mockAppHandlers.clear();
  const win = { isDestroyed: () => false };
  jest.isolateModules(() => {
    require('../../../../main/ipc/engineUpdateHandlers').register(win, services);
  });
  return win;
}

describe('engineUpdateHandlers', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('starts the background check with the config, engine status and the engine users a restart waits on', () => {
    const configService = { get: jest.fn() };
    const llmService = { getStatus: jest.fn() };
    const win = loadHandlers({ configService, llmService });
    expect(engineUpdateService.initialize).toHaveBeenCalledWith(win, configService, { llmService, chatStream, userMemory });
  });

  test('a user send asks the service to offer the selected engine update', () => {
    loadHandlers({});
    mockOnHandlers.get('engine-updater:user-send')();
    expect(engineUpdateService.offerSelected).toHaveBeenCalledTimes(1);
  });

  test('the manual check is not a background check, so it always answers', () => {
    loadHandlers({});
    mockOnHandlers.get('engine-updater:check-now')();
    expect(engineUpdateService.check).toHaveBeenCalledWith({ background: false });
  });

  test('installs the requested engine', async () => {
    loadHandlers({});
    await expect(mockInvokeHandlers.get('engine-updater:install')({}, 'mlx')).resolves.toEqual({ ok: true, version: 'b10831' });
    expect(engineUpdateService.install).toHaveBeenCalledWith('mlx', { restart: false });
  });

  test('passes a restart request through, and only a literal true counts', async () => {
    loadHandlers({});
    await mockInvokeHandlers.get('engine-updater:install')({}, 'llamaCpp', { restart: true });
    await mockInvokeHandlers.get('engine-updater:install')({}, 'llamaCpp', { restart: 'yes' });
    expect(engineUpdateService.install.mock.calls).toEqual([['llamaCpp', { restart: true }], ['llamaCpp', { restart: false }]]);
  });

  test('rejects an engine id the service does not know', async () => {
    loadHandlers({});
    const res = await mockInvokeHandlers.get('engine-updater:install')({}, 'llamaCpp; rm -rf /');
    expect(res.ok).toBe(false);
    expect(engineUpdateService.install).not.toHaveBeenCalled();
  });

  test('stops the timer on quit so a pending check cannot outlive the app', () => {
    loadHandlers({});
    mockAppHandlers.get('before-quit')();
    expect(engineUpdateService.stop).toHaveBeenCalled();
  });
});

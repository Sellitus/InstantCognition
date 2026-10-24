// updaterHandlers — the Settings "Check now" channel and the restart-to-install
// action, plus the UpdateService startup wiring that registering performs.

const mockOn = new Map();
const mockHandle = new Map();
const mockAppOn = jest.fn();

jest.mock('electron', () => ({
  ipcMain: {
    on: jest.fn((ch, fn) => { mockOn.set(ch, fn); }),
    handle: jest.fn((ch, fn) => { mockHandle.set(ch, fn); }),
  },
  app: { getVersion: () => '4.0.0', on: (...a) => mockAppOn(...a) },
}));

const mockService = {
  initialize: jest.fn(),
  check: jest.fn(),
  installNow: jest.fn(() => ({ ok: true })),
  supported: jest.fn(() => true),
  nudge: jest.fn(() => ({ level: 'none', version: null })),
  stop: jest.fn(),
};
jest.mock('../../../../main/services/UpdateService', () => mockService);

const { register } = require('../../../../main/ipc/updaterHandlers');

beforeEach(() => {
  mockOn.clear();
  mockHandle.clear();
  mockAppOn.mockClear();
  Object.values(mockService).forEach((fn) => fn.mockClear());
  mockService.installNow.mockReturnValue({ ok: true });
  mockService.supported.mockReturnValue(true);
  mockService.nudge.mockReturnValue({ level: 'none', version: null });
});

describe('updaterHandlers', () => {
  test('registering hands the window and config to UpdateService', () => {
    const win = { id: 1 };
    const configService = { get: jest.fn() };
    register(/** @type {any} */ (win), /** @type {any} */ ({ configService }));
    expect(mockService.initialize).toHaveBeenCalledWith(win, configService);
  });

  test('updater:check-now runs a manual check, which reports every step', () => {
    register(/** @type {any} */ ({}), /** @type {any} */ ({}));
    mockOn.get('updater:check-now')({});
    expect(mockService.check).toHaveBeenCalledWith({ manual: true });
  });

  test('updater:install reports the failure instead of swallowing it', async () => {
    mockService.installNow.mockReturnValue({ ok: false, error: 'Install failed.' });
    register(/** @type {any} */ ({}), /** @type {any} */ ({}));
    await expect(mockHandle.get('updater:install')()).toEqual({ ok: false, error: 'Install failed.' });
  });

  test('updater:status tells the renderer whether this build can self-update', async () => {
    mockService.supported.mockReturnValue(false);
    register(/** @type {any} */ ({}), /** @type {any} */ ({}));
    expect(await mockHandle.get('updater:status')()).toEqual({
      ok: true, supported: false, currentVersion: '4.0.0', nudge: { level: 'none', version: null },
    });
  });

  test('updater:status carries the restart nudge so the toolbar can hydrate on load', async () => {
    mockService.nudge.mockReturnValue({ level: 'elevated', version: '4.2.0' });
    register(/** @type {any} */ ({}), /** @type {any} */ ({}));
    expect((await mockHandle.get('updater:status')()).nudge).toEqual({ level: 'elevated', version: '4.2.0' });
  });

  test('quitting cancels the pending check', () => {
    register(/** @type {any} */ ({}), /** @type {any} */ ({}));
    const [event, fn] = mockAppOn.mock.calls[0];
    expect(event).toBe('before-quit');
    fn();
    expect(mockService.stop).toHaveBeenCalled();
  });
});

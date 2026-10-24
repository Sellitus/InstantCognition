// UpdateService — background update checks on top of electron-updater.
//
// electron-updater itself is a boundary: it is replaced with a fake emitter so
// the branch that matters (can this build replace itself, and what does the
// renderer hear when it cannot) is exercised without a real update feed.

const { EventEmitter } = require('events');

jest.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '4.0.0' },
}));

const mockCheckForUpdates = jest.fn();
jest.mock('../../../../updater', () => ({
  checkForUpdates: (...a) => mockCheckForUpdates(...a),
  compareVersions: jest.requireActual('../../../../updater').compareVersions,
}));

const { UpdateService, nudgeLevel } = require('../../../../main/services/UpdateService');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function fakeWindow() {
  return { isDestroyed: () => false, webContents: { send: jest.fn() } };
}

function fakeConfig(settings = {}) {
  return {
    get: jest.fn((path, fallback) => {
      const key = String(path).replace(/^settings\./, '');
      return key in settings ? settings[key] : fallback;
    }),
    set: jest.fn((path, value) => { settings[String(path).replace(/^settings\./, '')] = value; }),
  };
}

/** An electron-updater stand-in: same event surface, no network. */
function fakeUpdater() {
  const u = /** @type {any} */ (new EventEmitter());
  u.checkForUpdates = jest.fn(() => Promise.resolve());
  u.quitAndInstall = jest.fn();
  return u;
}

/** The real electron-updater emits 'error' and rejects for the same failure. */
function failWith(updater, err, once = false) {
  const impl = () => { updater.emit('error', err); return Promise.reject(err); };
  if (once) updater.checkForUpdates.mockImplementationOnce(impl);
  else updater.checkForUpdates.mockImplementation(impl);
}

function makeService({ settings = {}, env = {}, packaged = true, platform = 'darwin', updater = null, now = null } = {}) {
  const svc = new UpdateService();
  const win = fakeWindow();
  svc._setEnv(env);
  svc._setPackaged(() => packaged);
  svc._setPlatform(() => platform);
  if (updater) svc._setLoader(() => updater);
  if (now) svc._setNow(now);
  svc.initialize(win, fakeConfig(settings));
  return { svc, win, settings };
}

const sentOn = (win, channel) => win.webContents.send.mock.calls.filter((c) => c[0] === channel).map((c) => c[1]);

beforeEach(() => {
  jest.useFakeTimers();
  mockCheckForUpdates.mockReset();
  mockCheckForUpdates.mockResolvedValue({ ok: true, status: 'up-to-date', currentVersion: '4.0.0' });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('UpdateService.supported', () => {
  test('a packaged macOS build can replace itself', () => {
    const { svc } = makeService();
    expect(svc.supported()).toBe(true);
  });

  test('a dev run cannot — there is no update feed behind it', () => {
    const { svc } = makeService({ packaged: false });
    expect(svc.supported()).toBe(false);
  });

  test('a Windows portable exe cannot — it is not installed anywhere', () => {
    const { svc } = makeService({ platform: 'win32', env: { PORTABLE_EXECUTABLE_FILE: 'C:\\IC.exe' } });
    expect(svc.supported()).toBe(false);
  });

  test('Linux only self-updates from an AppImage', () => {
    expect(makeService({ platform: 'linux', env: {} }).svc.supported()).toBe(false);
    expect(makeService({ platform: 'linux', env: { APPIMAGE: '/tmp/IC.AppImage' } }).svc.supported()).toBe(true);
  });
});

describe('UpdateService startup check', () => {
  test('schedules a check when automatic updates are on', async () => {
    const updater = fakeUpdater();
    const { svc } = makeService({ updater });
    jest.runOnlyPendingTimers();
    await Promise.resolve();
    expect(updater.checkForUpdates).toHaveBeenCalled();
    svc.stop();
  });

  test('schedules nothing when the user turned automatic updates off', () => {
    const updater = fakeUpdater();
    makeService({ settings: { autoUpdate: false }, updater });
    jest.runOnlyPendingTimers();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(mockCheckForUpdates).not.toHaveBeenCalled();
  });

  test('stop() cancels a pending check so a closing app makes no network call', () => {
    const updater = fakeUpdater();
    const { svc } = makeService({ updater });
    svc.stop();
    jest.runOnlyPendingTimers();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });
});

describe('UpdateService.check', () => {
  test('reports progress and readiness to the renderer', async () => {
    const updater = fakeUpdater();
    const { svc, win } = makeService({ updater });
    await svc.check();
    updater.emit('update-available', { version: '4.1.0' });
    updater.emit('download-progress', { percent: 42.6 });
    updater.emit('update-downloaded', { version: '4.1.0' });
    const sent = win.webContents.send.mock.calls.map((c) => c[1]);
    expect(sent).toEqual([
      { ok: true, status: 'downloading', version: '4.1.0', percent: 0, manual: false },
      { ok: true, status: 'downloading', percent: 43, manual: false },
      { ok: true, status: 'downloaded', version: '4.1.0', manual: false },
    ]);
  });

  test('a background check starting mid manual check does not silence the manual answer', async () => {
    const updater = fakeUpdater();
    const { svc, win } = makeService({ updater });
    await svc.check({ manual: true });
    updater.emit('update-available', { version: '4.1.0' });
    await svc.check();
    updater.emit('update-downloaded', { version: '4.1.0' });
    expect(sentOn(win, 'updater:result').map((m) => [m.status, m.manual])).toEqual([
      ['downloading', true],
      ['downloaded', true],
    ]);
  });

  test('a manual check tags its results so the renderer reports each step', async () => {
    const updater = fakeUpdater();
    const { svc, win } = makeService({ updater });
    await svc.check({ manual: true });
    updater.emit('update-not-available');
    expect(sentOn(win, 'updater:result')).toEqual([{ ok: true, status: 'up-to-date', currentVersion: '4.0.0', manual: true }]);
    await svc.check();
    updater.emit('update-not-available');
    expect(sentOn(win, 'updater:result')[1].manual).toBe(false);
  });

  test('a build that cannot self-update shows no toast in the background, only a pill that links the release at once', async () => {
    mockCheckForUpdates.mockResolvedValue({ ok: true, status: 'update-available', version: '4.1.0', url: 'https://example.com/r' });
    const { svc, win, settings } = makeService({ platform: 'win32', env: { PORTABLE_EXECUTABLE_FILE: 'C:\\IC.exe' }, now: () => 5000 });
    await svc.check();
    await svc.check();
    expect(sentOn(win, 'updater:result').filter((m) => m.status === 'update-available')).toEqual([]);
    expect(settings.pendingUpdate).toEqual({ version: '4.1.0', since: 5000, url: 'https://example.com/r' });
    expect(sentOn(win, 'updater:nudge')).toEqual([{ level: 'recommended', version: '4.1.0', url: 'https://example.com/r' }]);

    await svc.check({ manual: true });
    expect(sentOn(win, 'updater:result').filter((m) => m.status === 'update-available')).toEqual([
      expect.objectContaining({ version: '4.1.0', manualDownload: true, manual: true }),
    ]);
  });

  test('a newer release replaces the linked one and keeps the original wait', async () => {
    let now = 5000;
    mockCheckForUpdates.mockResolvedValue({ ok: true, status: 'update-available', version: '4.1.0', url: 'https://example.com/r' });
    const { svc, win, settings } = makeService({ packaged: false, now: () => now });
    await svc.check();
    now = 5000 + 8 * DAY;
    mockCheckForUpdates.mockResolvedValue({ ok: true, status: 'update-available', version: '4.2.0', url: 'https://example.com/r2' });
    await svc.check();
    expect(settings.pendingUpdate).toEqual({ version: '4.2.0', since: 5000, url: 'https://example.com/r2' });
    expect(sentOn(win, 'updater:nudge').pop()).toEqual({ level: 'elevated', version: '4.2.0', url: 'https://example.com/r2' });
  });

  test('the beta channel allows pre-releases', async () => {
    const updater = fakeUpdater();
    const { svc } = makeService({ settings: { updateChannel: 'beta' }, updater });
    await svc.check();
    expect(updater.allowPrerelease).toBe(true);
  });

  test('a failed feed on a self-updating build stays silent and links the release only if it is still failing days later', async () => {
    let now = 0;
    const updater = fakeUpdater();
    failWith(updater, new Error('feed 404'));
    mockCheckForUpdates.mockResolvedValue({ ok: true, status: 'update-available', version: '4.1.0', url: 'https://example.com/r' });
    const { svc, win, settings } = makeService({ updater, now: () => now });
    await svc.check();
    expect(mockCheckForUpdates).toHaveBeenCalledWith({ channel: 'stable', currentVersion: '4.0.0' });
    expect(mockCheckForUpdates).toHaveBeenCalledTimes(1);
    expect(sentOn(win, 'updater:result')).toEqual([]);
    expect(sentOn(win, 'updater:nudge')).toEqual([]);
    expect(settings.pendingUpdate).toEqual({ version: '4.1.0', since: 0, url: 'https://example.com/r' });

    now = 3 * DAY;
    jest.advanceTimersByTime(HOUR);
    await Promise.resolve();
    expect(mockCheckForUpdates).toHaveBeenCalledTimes(2);
    expect(sentOn(win, 'updater:nudge')).toEqual([{ level: 'recommended', version: '4.1.0', url: 'https://example.com/r' }]);
    svc.stop();
  });

  test('a feed that recovers replaces the linked release with the download', async () => {
    const updater = fakeUpdater();
    failWith(updater, new Error('feed 404'), true);
    mockCheckForUpdates.mockResolvedValue({ ok: true, status: 'update-available', version: '4.1.0', url: 'https://example.com/r' });
    const { svc, settings } = makeService({ updater, now: () => 7000 });
    await svc.check();
    await svc.check();
    updater.emit('update-downloaded', { version: '4.1.0' });
    expect(settings.pendingUpdate).toEqual({ version: '4.1.0', since: 7000 });
    expect(svc.nudge().url).toBeNull();
  });

  test('a transient failure followed by an up-to-date answer leaves nothing behind', async () => {
    const updater = fakeUpdater();
    failWith(updater, new Error('ETIMEDOUT'), true);
    mockCheckForUpdates.mockResolvedValueOnce({ ok: true, status: 'update-available', version: '4.1.0', url: 'https://example.com/r' });
    const { svc, win, settings } = makeService({ updater, now: () => 0 });
    await svc.check();
    await svc.check();
    updater.emit('update-not-available');
    expect(settings.pendingUpdate).toBeNull();
    expect(sentOn(win, 'updater:nudge')).toEqual([]);
  });

  test('a failure the updater reports twice — emitted and thrown — falls back once', async () => {
    const updater = fakeUpdater();
    failWith(updater, new Error('feed 404'));
    mockCheckForUpdates.mockResolvedValue({ ok: true, status: 'update-available', version: '4.1.0', url: 'https://example.com/r' });
    const { svc, win } = makeService({ updater });
    await svc.check({ manual: true });
    expect(mockCheckForUpdates).toHaveBeenCalledTimes(1);
    expect(sentOn(win, 'updater:result')).toEqual([
      { ok: true, status: 'update-available', version: '4.1.0', url: 'https://example.com/r', manualDownload: true, manual: true },
    ]);
  });

  test('macOS rejecting the update signature switches this run to the release page', async () => {
    const updater = fakeUpdater();
    mockCheckForUpdates.mockResolvedValue({ ok: true, status: 'update-available', version: '4.1.0', url: 'https://example.com/r' });
    const { svc, win } = makeService({ updater, platform: 'darwin', now: () => 0 });
    await svc.check();
    updater.emit('error', new Error('Code signature at URL file:///tmp/IC.app/ did not pass validation: code object is not signed at all'));
    await Promise.resolve();
    await Promise.resolve();

    expect(svc.supported()).toBe(false);
    expect(sentOn(win, 'updater:nudge')).toEqual([{ level: 'recommended', version: '4.1.0', url: 'https://example.com/r' }]);
    await svc.check();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  test('the same words from a non-macOS updater do not disable self-update', async () => {
    const updater = fakeUpdater();
    const { svc } = makeService({ updater, platform: 'win32', now: () => 0 });
    await svc.check();
    updater.emit('error', new Error('code signature mismatch'));
    await Promise.resolve();
    expect(svc.supported()).toBe(true);
  });

  // A release published without its latest-*.yml feed makes electron-updater
  // 404. The user must not see that 404 when GitHub already answered the
  // question.
  test('an electron-updater 404 does not mask an up-to-date answer from GitHub', async () => {
    const updater = fakeUpdater();
    failWith(updater, new Error('Cannot find latest-mac.yml in the latest release artifacts'));
    mockCheckForUpdates.mockResolvedValue({ ok: true, status: 'up-to-date', currentVersion: '4.0.0' });
    const { svc, win } = makeService({ updater });
    await svc.check();
    expect(mockCheckForUpdates).toHaveBeenCalledTimes(1);
    expect(sentOn(win, 'updater:result')).toHaveLength(1);
    const sent = win.webContents.send.mock.calls.map((c) => c[1]);
    expect(sent[sent.length - 1]).toMatchObject({ ok: true, status: 'up-to-date', currentVersion: '4.0.0' });
    expect(sent.some((p) => p && p.ok === false)).toBe(false);
  });

  test('both paths failing surfaces a visible error', async () => {
    const updater = fakeUpdater();
    failWith(updater, new Error('feed 404'));
    mockCheckForUpdates.mockRejectedValue(new Error('GitHub responded 503.'));
    const { svc, win } = makeService({ updater });
    await svc.check();
    await Promise.resolve();
    const sent = win.webContents.send.mock.calls.map((c) => c[1]);
    expect(mockCheckForUpdates).toHaveBeenCalledTimes(1);
    expect(sent.filter(m => m.ok === false)).toHaveLength(1);
    expect(sent.find(m => m.ok === false)).toMatchObject({ ok: false, error: 'feed 404' });
  });
});

describe('nudgeLevel', () => {
  const at = 1_000_000_000_000;
  test('stays quiet for the first three days', () => {
    expect(nudgeLevel(null, at)).toBe('none');
    expect(nudgeLevel({ version: '4.1.0', since: at }, at + 2.9 * DAY)).toBe('none');
  });
  test('recommends a restart from day three and insists from day seven', () => {
    expect(nudgeLevel({ version: '4.1.0', since: at }, at + 3 * DAY)).toBe('recommended');
    expect(nudgeLevel({ version: '4.1.0', since: at }, at + 6.9 * DAY)).toBe('recommended');
    expect(nudgeLevel({ version: '4.1.0', since: at }, at + 7 * DAY)).toBe('elevated');
  });
  test('a malformed record never nudges', () => {
    expect(nudgeLevel(/** @type {any} */ ({ version: '4.1.0' }), at)).toBe('none');
  });
});

describe('UpdateService pending update and restart nudge', () => {
  test('a download records its version and time; later downloads keep the first time until one installs', async () => {
    let t = 1000;
    const updater = fakeUpdater();
    const { svc, settings } = makeService({ updater, now: () => t });
    await svc.check();
    updater.emit('update-downloaded', { version: '4.1.0' });
    expect(settings.pendingUpdate).toEqual({ version: '4.1.0', since: 1000 });
    t = 5000;
    updater.emit('update-downloaded', { version: '4.1.0' });
    expect(settings.pendingUpdate).toEqual({ version: '4.1.0', since: 1000 });
    updater.emit('update-downloaded', { version: '4.2.0' });
    expect(settings.pendingUpdate).toEqual({ version: '4.2.0', since: 1000 });
  });

  test('with automatic updates off, a manual download still grows into a nudge', async () => {
    let now = 0;
    const updater = fakeUpdater();
    const { svc, win } = makeService({ updater, now: () => now, settings: { autoUpdate: false } });
    await svc.check({ manual: true });
    updater.emit('update-downloaded', { version: '4.1.0' });
    now = 3 * DAY;
    jest.advanceTimersByTime(HOUR);
    expect(sentOn(win, 'updater:nudge')).toEqual([{ level: 'recommended', version: '4.1.0', url: null }]);
    // The tick never turns into background checks the user switched off.
    now = 4 * DAY;
    jest.advanceTimersByTime(HOUR * 24);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    svc.stop();
  });

  test('startup clears the record once the running version has it installed', () => {
    const installed = makeService({ settings: { pendingUpdate: { version: '4.0.0', since: 1 } } });
    expect(installed.settings.pendingUpdate).toBeNull();
    const waiting = makeService({ settings: { pendingUpdate: { version: '4.1.0', since: 1 } } });
    expect(waiting.settings.pendingUpdate).toEqual({ version: '4.1.0', since: 1 });
  });

  test('an update downloaded days ago nudges as soon as this run has it in hand', async () => {
    const now = 100 * DAY;
    const updater = fakeUpdater();
    const { svc, win } = makeService({
      updater, now: () => now, settings: { pendingUpdate: { version: '4.1.0', since: now - 4 * DAY } },
    });
    // Before this run downloads it there is nothing installNow can apply.
    expect(svc.nudge()).toEqual({ level: 'none', version: null, url: null });
    await svc.check();
    updater.emit('update-downloaded', { version: '4.1.0' });
    expect(sentOn(win, 'updater:nudge')).toEqual([{ level: 'recommended', version: '4.1.0', url: null }]);
  });

  test('the hourly tick raises the nudge as the wait crosses each threshold, once per level', async () => {
    let now = 10 * DAY;
    const updater = fakeUpdater();
    const { svc, win } = makeService({ updater, now: () => now });
    jest.advanceTimersByTime(15000);
    await Promise.resolve();
    updater.emit('update-downloaded', { version: '4.1.0' });
    expect(sentOn(win, 'updater:nudge')).toEqual([]);

    now += 3 * DAY;
    jest.advanceTimersByTime(HOUR);
    now += HOUR;
    jest.advanceTimersByTime(HOUR);
    expect(sentOn(win, 'updater:nudge')).toEqual([{ level: 'recommended', version: '4.1.0', url: null }]);

    now += 4 * DAY;
    jest.advanceTimersByTime(HOUR);
    expect(sentOn(win, 'updater:nudge')).toEqual([
      { level: 'recommended', version: '4.1.0', url: null },
      { level: 'elevated', version: '4.1.0', url: null },
    ]);
    svc.stop();
  });
});

describe('UpdateService periodic re-check', () => {
  test('checks again once six hours have passed, not on every hourly tick', async () => {
    let now = 0;
    const updater = fakeUpdater();
    const { svc } = makeService({ updater, now: () => now });
    jest.advanceTimersByTime(15000);
    await Promise.resolve();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);

    for (let h = 1; h <= 5; h++) { now = h * HOUR; jest.advanceTimersByTime(HOUR); }
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    now = 6 * HOUR;
    jest.advanceTimersByTime(HOUR);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    svc.stop();
  });

  test('stop() ends the re-check loop', async () => {
    let now = 0;
    const updater = fakeUpdater();
    const { svc } = makeService({ updater, now: () => now });
    jest.advanceTimersByTime(15000);
    svc.stop();
    now = 12 * HOUR;
    jest.advanceTimersByTime(12 * HOUR);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });
});

describe('UpdateService.installNow', () => {
  test('refuses when nothing has been downloaded', () => {
    const { svc } = makeService({ packaged: false });
    expect(svc.installNow()).toEqual({ ok: false, error: 'No update has been downloaded.' });
  });

  test('quits into the installer once an update is in hand', async () => {
    const updater = fakeUpdater();
    const { svc } = makeService({ updater });
    await svc.check();
    expect(svc.installNow()).toEqual({ ok: true });
    expect(updater.quitAndInstall).toHaveBeenCalled();
  });
});

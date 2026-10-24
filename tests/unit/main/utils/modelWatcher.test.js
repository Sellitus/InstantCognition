// modelWatcher tests — verify that triggering a rescan calls the manager's
// scanDirs (with modelsDir as combined) and listModels for prune, and that
// the fs.watch wiring (debounce, .part filter, stop) behaves.
//
// fs is the external boundary: existsSync + watch are faked so no real
// filesystem watcher is created.

const mockFsWatchHandles = [];
let mockFsExists;
jest.mock('fs', () => ({
  existsSync: (p) => mockFsExists(p),
  watch: (dir, opts, cb) => {
    const handle = { dir, opts, cb, closed: false, close: jest.fn(function close() { this.closed = true; }) };
    mockFsWatchHandles.push(handle);
    return handle;
  },
}));

const { createModelWatcher } = require('../../../../main/utils/modelWatcher');

beforeEach(() => {
  mockFsWatchHandles.length = 0;
  mockFsExists = jest.fn(() => true);
});

function makeFakeManager() {
  return {
    getModelsDir: jest.fn(() => '/tmp/models-dir'),
    scanDirs: jest.fn(),
    listModels: jest.fn(),
  };
}

describe('modelWatcher', () => {
  test('_triggerRescanForTest scans modelsDir then listModels for prune', () => {
    const mgr = makeFakeManager();
    const w = createModelWatcher(mgr);
    w.start({ combined: null, mlx: null, gguf: null });
    w._triggerRescanForTest();
    expect(mgr.scanDirs).toHaveBeenCalledWith({ combined: '/tmp/models-dir' });
    expect(mgr.listModels).toHaveBeenCalled();
    w.stop();
  });

  test('_triggerRescanForTest also scans user-configured roots when set', () => {
    const mgr = makeFakeManager();
    const w = createModelWatcher(mgr);
    w.start({ combined: null, mlx: '/m', gguf: '/g' });
    w._triggerRescanForTest();
    expect(mgr.scanDirs).toHaveBeenCalledTimes(2);
    expect(mgr.scanDirs).toHaveBeenNthCalledWith(1, { combined: '/tmp/models-dir' });
    expect(mgr.scanDirs).toHaveBeenNthCalledWith(2, { combined: null, mlx: '/m', gguf: '/g' });
    w.stop();
  });

  test('rescan is best-effort and swallows manager errors', () => {
    const mgr = makeFakeManager();
    mgr.scanDirs = jest.fn(() => { throw new Error('boom'); });
    const w = createModelWatcher(mgr);
    w.start();
    expect(() => w._triggerRescanForTest()).not.toThrow();
  });

  test('start attaches an fs.watch on the models dir plus each configured root', () => {
    const mgr = makeFakeManager();
    const w = createModelWatcher(mgr);
    w.start({ combined: '/c', mlx: '/m', gguf: null });
    const dirs = mockFsWatchHandles.map((h) => h.dir).sort();
    expect(dirs).toEqual(['/c', '/m', '/tmp/models-dir'].sort());
    w.stop();
  });

  test('start skips directories that do not exist', () => {
    const mgr = makeFakeManager();
    mockFsExists = jest.fn((p) => p === '/tmp/models-dir'); // only models dir exists
    const w = createModelWatcher(mgr);
    w.start({ combined: '/missing', mlx: null, gguf: null });
    expect(mockFsWatchHandles.map((h) => h.dir)).toEqual(['/tmp/models-dir']);
    w.stop();
  });

  test('a watch event debounces into a single scheduled rescan', () => {
    jest.useFakeTimers();
    const mgr = makeFakeManager();
    const w = createModelWatcher(mgr, { debounceMs: 100 });
    w.start();
    const cb = mockFsWatchHandles[0].cb;
    cb('rename', 'new-model.gguf');
    cb('change', 'new-model.gguf'); // resets the debounce timer
    expect(mgr.scanDirs).not.toHaveBeenCalled();
    jest.advanceTimersByTime(100);
    expect(mgr.scanDirs).toHaveBeenCalledWith({ combined: '/tmp/models-dir' });
    w.stop();
    jest.useRealTimers();
  });

  test('in-flight .part download files are ignored (no rescan scheduled)', () => {
    jest.useFakeTimers();
    const mgr = makeFakeManager();
    const w = createModelWatcher(mgr, { debounceMs: 50 });
    w.start();
    mockFsWatchHandles[0].cb('rename', 'model.gguf.part');
    jest.advanceTimersByTime(50);
    expect(mgr.scanDirs).not.toHaveBeenCalled();
    w.stop();
    jest.useRealTimers();
  });

  test('a null filename still schedules a rescan', () => {
    jest.useFakeTimers();
    const mgr = makeFakeManager();
    const w = createModelWatcher(mgr, { debounceMs: 10 });
    w.start();
    mockFsWatchHandles[0].cb('rename', null);
    jest.advanceTimersByTime(10);
    expect(mgr.scanDirs).toHaveBeenCalled();
    w.stop();
    jest.useRealTimers();
  });

  test('stop closes every watcher and clears a pending debounce timer', () => {
    jest.useFakeTimers();
    const mgr = makeFakeManager();
    const w = createModelWatcher(mgr, { debounceMs: 100 });
    w.start({ combined: '/c', mlx: null, gguf: null });
    mockFsWatchHandles[0].cb('change', 'x.gguf'); // arm the debounce timer
    const handles = [...mockFsWatchHandles];
    w.stop();
    for (const h of handles) expect(h.closed).toBe(true);
    // Pending timer was cleared -> no rescan fires after stop.
    jest.advanceTimersByTime(500);
    expect(mgr.scanDirs).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  test('stop tolerates a watcher whose close() throws', () => {
    const mgr = makeFakeManager();
    const w = createModelWatcher(mgr);
    w.start();
    mockFsWatchHandles[0].close = () => { throw new Error('close failed'); };
    expect(() => w.stop()).not.toThrow();
  });

  test('start restarts cleanly (stop old watchers, attach new ones)', () => {
    const mgr = makeFakeManager();
    const w = createModelWatcher(mgr);
    w.start();
    const first = mockFsWatchHandles[0];
    w.start({ combined: '/c', mlx: null, gguf: null });
    expect(first.closed).toBe(true);
    expect(mockFsWatchHandles.length).toBeGreaterThan(1);
    w.stop();
  });
});

// browserDataHandlers wires History/Bookmark/Download services to ipcMain.
// ipcMain + SemanticIndexService are external boundaries (mocked); the
// captured handlers are invoked to assert they delegate with the correct
// argument shapes — the renderer sends { limit } / { query } objects.

const invokeHandlers = {};

jest.mock('electron', () => ({
  ipcMain: {
    handle: jest.fn((ch, fn) => { invokeHandlers[ch] = fn; }),
  },
}));

jest.mock('../../../../main/services/SemanticIndexService', () => ({
  search: jest.fn(() => []),
  reindex: jest.fn(() => ({ ok: true })),
}));

const contentIndex = require('../../../../main/services/ContentIndexService');

const browserDataHandlers = require('../../../../main/ipc/browserDataHandlers');

let pruneSpy;

describe('browserDataHandlers.register', () => {
  beforeEach(() => {
    Object.keys(invokeHandlers).forEach((k) => delete invokeHandlers[k]);
    // The history-mutation handlers call contentIndex.prune to keep
    // semantic_content.json bounded; intercept it so tests never touch the
    // real store on disk.
    pruneSpy = jest.spyOn(contentIndex, 'prune').mockReturnValue(0);
  });
  afterEach(() => { pruneSpy.mockRestore(); });

  test('no history handlers without a historyService', () => {
    browserDataHandlers.register({}, {});
    expect(invokeHandlers['history:recent']).toBeUndefined();
  });

  test("'history:recent' unwraps the { limit } object the renderer sends", () => {
    const historyService = { getRecent: jest.fn(() => []) };
    browserDataHandlers.register({}, { historyService });
    invokeHandlers['history:recent']({}, { limit: 200 });
    // Pre-fix the handler passed the whole object through, so getRecent
    // received { limit: 200 } instead of the number 200.
    expect(historyService.getRecent).toHaveBeenCalledWith(200);
  });

  test("'history:recent' falls back to 50 when no limit is given", () => {
    const historyService = { getRecent: jest.fn(() => []) };
    browserDataHandlers.register({}, { historyService });
    invokeHandlers['history:recent']({}, {});
    expect(historyService.getRecent).toHaveBeenCalledWith(50);
  });

  test("'history:add' delegates the navigation entry to addEntry", () => {
    const historyService = { getRecent: jest.fn(), addEntry: jest.fn() };
    browserDataHandlers.register({}, { historyService });
    const entry = { url: 'https://example.com', title: 'Example', spaceId: 'custom1' };
    invokeHandlers['history:add']({}, entry);
    expect(historyService.addEntry).toHaveBeenCalledWith(entry);
  });

  test("'history:search' forwards the query and the options object", () => {
    const historyService = { getRecent: jest.fn(), search: jest.fn(() => []) };
    browserDataHandlers.register({}, { historyService });
    invokeHandlers['history:search']({}, { query: 'cats', limit: 200 });
    expect(historyService.search).toHaveBeenCalledWith('cats', { query: 'cats', limit: 200 });
  });

  test("'browsing:capture-content' delegates url+text to contentIndex.capture", () => {
    const captureSpy = jest.spyOn(contentIndex, 'capture').mockReturnValue(true);
    browserDataHandlers.register({}, {});
    const res = invokeHandlers['browsing:capture-content']({}, { url: 'https://example.com/p', text: 'body text' });
    expect(captureSpy).toHaveBeenCalledWith('https://example.com/p', 'body text');
    expect(res).toEqual({ ok: true, captured: true });
    captureSpy.mockRestore();
  });

  test("'browsing:capture-content' reports captured:false when the store is unchanged", () => {
    const captureSpy = jest.spyOn(contentIndex, 'capture').mockReturnValue(false);
    browserDataHandlers.register({}, {});
    const res = invokeHandlers['browsing:capture-content']({}, { url: 'https://example.com/p', text: 'same' });
    expect(res).toEqual({ ok: true, captured: false });
    captureSpy.mockRestore();
  });

  test("'bookmarks:search' unwraps the { query } object the renderer sends", () => {
    const bookmarkService = { search: jest.fn(() => []) };
    browserDataHandlers.register({}, { bookmarkService });
    invokeHandlers['bookmarks:search']({}, { query: 'github' });
    // Pre-fix the whole { query } object was passed through, so BookmarkService
    // stringified it to '[object object]' and matched nothing.
    expect(bookmarkService.search).toHaveBeenCalledWith('github');
  });

  test("'bookmarks:toggle' adds a page that is not bookmarked yet", () => {
    const bookmarkService = {
      findByUrl: jest.fn(() => null),
      add: jest.fn(() => ({ id: 'bm_1' })),
      remove: jest.fn(),
    };
    browserDataHandlers.register({}, { bookmarkService });
    const res = invokeHandlers['bookmarks:toggle']({}, { url: 'https://example.com', title: 'Example' });
    expect(bookmarkService.add).toHaveBeenCalledWith({ url: 'https://example.com', title: 'Example' });
    expect(bookmarkService.remove).not.toHaveBeenCalled();
    expect(res).toEqual({ added: true, url: 'https://example.com', id: 'bm_1' });
  });

  test("'bookmarks:toggle' removes an existing bookmark instead of duplicating it", () => {
    const bookmarkService = {
      findByUrl: jest.fn(() => ({ id: 'bm_1', url: 'https://example.com' })),
      add: jest.fn(),
      remove: jest.fn(() => true),
    };
    browserDataHandlers.register({}, { bookmarkService });
    const res = invokeHandlers['bookmarks:toggle']({}, { url: 'https://example.com', title: 'Example' });
    expect(bookmarkService.remove).toHaveBeenCalledWith('bm_1');
    expect(bookmarkService.add).not.toHaveBeenCalled();
    expect(res).toEqual({ added: false, url: 'https://example.com' });
  });

  test("'bookmarks:remove' passes the id straight through", () => {
    const bookmarkService = { remove: jest.fn(() => true) };
    browserDataHandlers.register({}, { bookmarkService });
    expect(invokeHandlers['bookmarks:remove']({}, 'bm_9')).toBe(true);
    expect(bookmarkService.remove).toHaveBeenCalledWith('bm_9');
  });

  test("history mutations prune the content index to the live URL set", () => {
    const historyService = {
      getRecent: jest.fn(() => [{ url: 'https://live.com/a' }]),
      addEntry: jest.fn(),
      deleteEntry: jest.fn(() => true),
      clearAll: jest.fn(),
    };
    const bookmarkService = {
      getTree: jest.fn(() => ({ type: 'folder', children: [{ type: 'bookmark', url: 'https://bm.com/x' }] })),
    };
    browserDataHandlers.register({}, { historyService, bookmarkService });

    pruneSpy.mockClear();
    invokeHandlers['history:add']({}, { url: 'https://live.com/a', title: 'A' });
    expect(pruneSpy).toHaveBeenCalledWith(['https://live.com/a', 'https://bm.com/x']);

    pruneSpy.mockClear();
    invokeHandlers['history:clear']({});
    expect(historyService.clearAll).toHaveBeenCalled();
    expect(pruneSpy).toHaveBeenCalledWith(['https://live.com/a', 'https://bm.com/x']);
  });

  test('history:add still works when the content index has nothing to prune', () => {
    const historyService = { getRecent: jest.fn(() => []), addEntry: jest.fn() };
    browserDataHandlers.register({}, { historyService });
    pruneSpy.mockClear();
    const res = invokeHandlers['history:add']({}, { url: 'https://x.com' });
    expect(historyService.addEntry).toHaveBeenCalledWith({ url: 'https://x.com' });
    expect(res).toBeUndefined(); // addEntry returns undefined; handler must not add fields
    // No bookmarkService and empty history mock → prunes with an empty live set
    // (the real HistoryService would list the new entry via getRecent).
    expect(pruneSpy).toHaveBeenCalledWith([]);
  });
});

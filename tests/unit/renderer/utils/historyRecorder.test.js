const { attachHistoryRecorder } = require('../../../../renderer/utils/historyRecorder');

function makeWebview({ id = 'custom2', url = '', title = '', partition = null } = {}) {
  const wv = new EventTarget();
  wv.id = id;
  wv.getAttribute = (name) => (name === 'partition' ? partition : null);
  wv.isConnected = true;
  wv._url = url;
  wv._title = title;
  wv.getURL = () => wv._url;
  wv.getTitle = () => wv._title;
  wv.fire = (type, props) => {
    const ev = new Event(type);
    Object.assign(ev, props);
    wv.dispatchEvent(ev);
  };
  return wv;
}

function navigate(wv, type, url, extra = {}) {
  wv._url = url;
  wv.fire(type, { url, ...extra });
}

let invoke;
beforeEach(() => {
  jest.useFakeTimers();
  invoke = jest.fn(() => Promise.resolve({}));
});
afterEach(() => { jest.useRealTimers(); });

describe('attachHistoryRecorder', () => {
  test('records an SPA in-page navigation with the title set after the URL changed', () => {
    const wv = makeWebview();
    attachHistoryRecorder(wv, { invoke });
    navigate(wv, 'did-navigate-in-page', 'https://claude.ai/chat/abc', { isMainFrame: true });
    wv._title = 'Debugging history';
    jest.advanceTimersByTime(1500);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('history:add', {
      url: 'https://claude.ai/chat/abc', title: 'Debugging history', spaceId: 'custom2',
    });
  });

  test('records full-page loads from did-navigate', () => {
    const wv = makeWebview({ title: 'Example' });
    attachHistoryRecorder(wv, { invoke });
    navigate(wv, 'did-navigate', 'https://example.com/');
    jest.advanceTimersByTime(1500);
    expect(invoke).toHaveBeenCalledWith('history:add', expect.objectContaining({ url: 'https://example.com/' }));
  });

  test('never records a private pane', () => {
    const wv = makeWebview({ title: 'Secret', partition: 'private' });
    attachHistoryRecorder(wv, { invoke });
    navigate(wv, 'did-navigate', 'https://example.com/private');
    jest.advanceTimersByTime(5000);
    expect(invoke).not.toHaveBeenCalled();
  });

  test('ignores sub-frame in-page navigations', () => {
    const wv = makeWebview();
    attachHistoryRecorder(wv, { invoke });
    wv.fire('did-navigate-in-page', { url: 'https://ads.example/frame#x', isMainFrame: false });
    jest.advanceTimersByTime(5000);
    expect(invoke).not.toHaveBeenCalled();
  });

  test('ignores non-web schemes', () => {
    const wv = makeWebview();
    attachHistoryRecorder(wv, { invoke });
    navigate(wv, 'did-navigate', 'about:blank');
    navigate(wv, 'did-navigate', 'file:///etc/passwd');
    jest.advanceTimersByTime(5000);
    expect(invoke).not.toHaveBeenCalled();
  });

  test('rapid route changes commit only the URL the user settled on', () => {
    const wv = makeWebview({ title: 'T' });
    attachHistoryRecorder(wv, { invoke });
    navigate(wv, 'did-navigate-in-page', 'https://app.example/a', { isMainFrame: true });
    jest.advanceTimersByTime(500);
    navigate(wv, 'did-navigate-in-page', 'https://app.example/b', { isMainFrame: true });
    jest.advanceTimersByTime(1500);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][1].url).toBe('https://app.example/b');
  });

  test('a reload of the committed URL is not recorded again', () => {
    const wv = makeWebview({ title: 'T' });
    attachHistoryRecorder(wv, { invoke });
    navigate(wv, 'did-navigate', 'https://example.com/');
    jest.advanceTimersByTime(1500);
    navigate(wv, 'did-navigate', 'https://example.com/');
    jest.advanceTimersByTime(1500);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test('a later title change for the committed URL is re-sent', () => {
    const wv = makeWebview({ title: '' });
    attachHistoryRecorder(wv, { invoke });
    navigate(wv, 'did-navigate', 'https://example.com/');
    jest.advanceTimersByTime(1500);
    wv._title = 'Example Domain';
    wv.fire('page-title-updated', { title: 'Example Domain' });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][1]).toEqual({ url: 'https://example.com/', title: 'Example Domain', spaceId: 'custom2' });
  });

  test('drops a pending visit when the pane is closed before commit', () => {
    const wv = makeWebview({ title: 'T' });
    attachHistoryRecorder(wv, { invoke });
    navigate(wv, 'did-navigate', 'https://example.com/');
    wv.isConnected = false;
    jest.advanceTimersByTime(1500);
    expect(invoke).not.toHaveBeenCalled();
  });

  test('onCommit receives each committed URL', () => {
    const wv = makeWebview({ title: 'T' });
    const onCommit = jest.fn();
    attachHistoryRecorder(wv, { invoke, onCommit });
    navigate(wv, 'did-navigate', 'https://example.com/');
    jest.advanceTimersByTime(1500);
    expect(onCommit).toHaveBeenCalledWith('https://example.com/');
  });

  test('logs a failed history:add instead of throwing', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    invoke = jest.fn(() => Promise.reject(new Error('ipc down')));
    const wv = makeWebview({ title: 'T' });
    attachHistoryRecorder(wv, { invoke });
    navigate(wv, 'did-navigate', 'https://example.com/');
    jest.advanceTimersByTime(1500);
    await Promise.resolve();
    await Promise.resolve();
    expect(err).toHaveBeenCalledWith('[historyRecorder] history:add failed:', 'ipc down');
    err.mockRestore();
  });
});

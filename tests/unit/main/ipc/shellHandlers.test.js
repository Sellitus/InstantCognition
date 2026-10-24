// shellHandlers — clipboard and OS-shell channels for the sandboxed shell.
// Only web/mailto URLs reach the OS, and only files a download wrote open.

jest.mock('electron', () => {
  const handlers = {};
  return {
    ipcMain: {
      on: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      handle: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      _handlers: handlers,
    },
    clipboard: { writeText: jest.fn() },
    shell: { openExternal: jest.fn(() => Promise.resolve()), openPath: jest.fn(() => Promise.resolve('')), showItemInFolder: jest.fn() },
  };
});

const { ipcMain, clipboard, shell } = require('electron');
const { register } = require('../../../../main/ipc/shellHandlers');

const DOWNLOADED = '/Users/me/Downloads/report.pdf';
const downloadService = { isKnownSavePath: jest.fn((p) => p === DOWNLOADED) };
const h = (ch) => ipcMain._handlers[ch];
const syncCall = (ch, arg) => { const event = { returnValue: undefined }; h(ch)(event, arg); return event.returnValue; };

beforeEach(() => {
  jest.clearAllMocks();
  register(null, { downloadService });
});

describe('clipboard:write-text', () => {
  test('writes the text and reports ok synchronously', () => {
    expect(syncCall('clipboard:write-text', 'copied')).toEqual({ ok: true });
    expect(clipboard.writeText).toHaveBeenCalledWith('copied');
  });

  test('a non-string is refused without touching the clipboard', () => {
    expect(syncCall('clipboard:write-text', { x: 1 })).toEqual({ ok: false, error: expect.stringContaining('string') });
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  test('a clipboard failure is reported, not swallowed', () => {
    clipboard.writeText.mockImplementationOnce(() => { throw new Error('pasteboard busy'); });
    expect(syncCall('clipboard:write-text', 'x')).toEqual({ ok: false, error: 'pasteboard busy' });
  });
});

describe('shell:open-external', () => {
  test.each(['https://example.com/a', 'http://localhost:3000/', 'mailto:me@example.com'])('opens %s', async (url) => {
    await h('shell:open-external')({}, url);
    expect(shell.openExternal).toHaveBeenCalledWith(url);
  });

  test.each(['file:///etc/passwd', 'smb://host/share', 'ms-msdt:/id', 'javascript:alert(1)', '', null])('refuses %p', async (url) => {
    await expect(h('shell:open-external')({}, url)).rejects.toThrow(/http, https and mailto/);
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});

describe('shell:open-path and shell:show-item-in-folder', () => {
  test('a finished download opens and reveals', async () => {
    await expect(h('shell:open-path')({}, DOWNLOADED)).resolves.toBe('');
    expect(shell.openPath).toHaveBeenCalledWith(DOWNLOADED);
    expect(syncCall('shell:show-item-in-folder', DOWNLOADED)).toEqual({ ok: true });
    expect(shell.showItemInFolder).toHaveBeenCalledWith(DOWNLOADED);
  });

  test.each(['/Applications/Calculator.app', '/etc/passwd', '', undefined])('any other path %p is refused', async (p) => {
    await expect(h('shell:open-path')({}, p)).resolves.toBe('that file is not a finished download');
    expect(syncCall('shell:show-item-in-folder', p)).toEqual({ ok: false, error: 'that file is not a finished download' });
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  test('a reveal failure is reported to the shell', () => {
    shell.showItemInFolder.mockImplementationOnce(() => { throw new Error('Finder unavailable'); });
    expect(syncCall('shell:show-item-in-folder', DOWNLOADED)).toEqual({ ok: false, error: 'Finder unavailable' });
  });
});

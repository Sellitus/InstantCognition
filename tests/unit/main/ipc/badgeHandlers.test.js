jest.mock('electron', () => {
  const handlers = {};
  return {
    ipcMain: {
      on: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      handle: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      _handlers: handlers,
    },
  };
});

const { ipcMain } = require('electron');
const { register } = require('../../../../main/ipc/badgeHandlers');

describe('badgeHandlers', () => {
  let badgeService;

  beforeEach(() => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    ipcMain.on.mockImplementation((c, h) => { ipcMain._handlers[c] = h; });
    ipcMain.handle.mockImplementation((c, h) => { ipcMain._handlers[c] = h; });

    badgeService = {
      setForOrigin: jest.fn(),
      clearForOrigin: jest.fn(),
      total: jest.fn(() => 7),
    };
    register({}, { badgeService });
  });

  test('no-ops when badgeService missing', () => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    register({}, {});
    expect(Object.keys(ipcMain._handlers)).toHaveLength(0);
  });

  test('no-ops when services arg omitted', () => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    register({});
    expect(Object.keys(ipcMain._handlers)).toHaveLength(0);
  });

  describe('badge:set', () => {
    test('uses explicit string origin from payload', () => {
      ipcMain._handlers['badge:set']({ sender: {} }, { origin: 'https://x.com', count: 3 });
      expect(badgeService.setForOrigin).toHaveBeenCalledWith('https://x.com', 3);
    });

    test('derives origin from sender URL when no payload origin', () => {
      ipcMain._handlers['badge:set']({ sender: { getURL: () => 'https://site.com/path' } }, { count: 2 });
      expect(badgeService.setForOrigin).toHaveBeenCalledWith('https://site.com', 2);
    });

    test('falls back to "*" when no sender URL', () => {
      ipcMain._handlers['badge:set']({ sender: {} }, { count: 1 });
      expect(badgeService.setForOrigin).toHaveBeenCalledWith('*', 1);
    });

    test('defaults payload to {} when omitted', () => {
      ipcMain._handlers['badge:set']({ sender: {} });
      expect(badgeService.setForOrigin).toHaveBeenCalledWith('*', undefined);
    });

    test('errors (e.g. invalid URL) are caught and logged', () => {
      expect(() => ipcMain._handlers['badge:set']({ sender: { getURL: () => 'not a url' } }, {})).not.toThrow();
    });
  });

  describe('badge:clear', () => {
    test('uses explicit string origin', () => {
      ipcMain._handlers['badge:clear']({ sender: {} }, { origin: 'https://x.com' });
      expect(badgeService.clearForOrigin).toHaveBeenCalledWith('https://x.com');
    });

    test('derives origin from sender URL', () => {
      ipcMain._handlers['badge:clear']({ sender: { getURL: () => 'https://site.com/p' } }, {});
      expect(badgeService.clearForOrigin).toHaveBeenCalledWith('https://site.com');
    });

    test('falls back to "*" with no sender URL', () => {
      ipcMain._handlers['badge:clear']({ sender: {} }, {});
      expect(badgeService.clearForOrigin).toHaveBeenCalledWith('*');
    });

    test('defaults payload to {} when omitted', () => {
      ipcMain._handlers['badge:clear']({ sender: {} });
      expect(badgeService.clearForOrigin).toHaveBeenCalledWith('*');
    });

    test('errors are caught and logged', () => {
      expect(() => ipcMain._handlers['badge:clear']({ sender: { getURL: () => 'bad url' } }, {})).not.toThrow();
    });
  });
});

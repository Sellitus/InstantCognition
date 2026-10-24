jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/mock-userdata') },
}));
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));
const path = require('path');
const fs = require('fs');
const electron = require('electron');

// Re-pull the module after the mocks are registered. The module reads
// app.getPath at call time (inside registryPath), not at require time, so a
// single require is fine across tests that mutate mock return values.
const { load, save, registryPath } = require('../../../../main/services/modelRegistry');

describe('modelRegistry', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('registryPath', () => {
    test('lives under userData/model_registry.json', () => {
      expect(registryPath()).toBe(path.join('/mock-userdata', 'model_registry.json'));
    });

    test('falls back to cwd when app.getPath throws', () => {
      electron.app.getPath.mockImplementation(() => { throw new Error('no electron'); });
      expect(registryPath()).toBe(path.join(process.cwd(), 'model_registry.json'));
      electron.app.getPath.mockReturnValue('/mock-userdata');
    });
  });

  describe('load', () => {
    test('returns the paths array from a valid registry file', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ paths: ['/a', '/b'] }));
      expect(load()).toEqual(['/a', '/b']);
    });

    test('filters non-string entries out of the paths array', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ paths: ['/a', 7, null, '/b'] }));
      expect(load()).toEqual(['/a', '/b']);
    });

    test('returns [] when the file does not exist', () => {
      fs.existsSync.mockReturnValue(false);
      expect(load()).toEqual([]);
    });

    test('returns [] when the file has no paths array', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ other: 'shape' }));
      expect(load()).toEqual([]);
    });

    test('returns [] on malformed JSON (best-effort read)', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('{ not json');
      expect(load()).toEqual([]);
    });

    test('returns [] when readFileSync throws', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => { throw new Error('EACCES'); });
      expect(load()).toEqual([]);
    });
  });

  describe('save', () => {
    test('writes paths array under the paths key, mkdir-ing the parent first', () => {
      save(['/x', '/y']);
      expect(fs.mkdirSync).toHaveBeenCalledWith(path.dirname(registryPath()), { recursive: true });
      const written = fs.writeFileSync.mock.calls[0][1];
      expect(JSON.parse(written)).toEqual({ paths: ['/x', '/y'] });
    });

    test('does not throw when the write fails (best-effort cache file)', () => {
      fs.mkdirSync.mockImplementation(() => { throw new Error('EROFS'); });
      expect(() => save(['/x'])).not.toThrow();
    });
  });
});

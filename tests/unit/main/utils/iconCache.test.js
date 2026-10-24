// iconCache — persists notification icons to <userData>/notification-icons.
// electron is the external boundary (app.getPath); fs is real against a tmpdir.

const fs = require('fs');
const os = require('os');
const path = require('path');

let userDataDir;
const mockElectron = { app: { getPath: jest.fn(() => userDataDir) } };
jest.mock('electron', () => mockElectron);

const iconCache = require('../../../../main/utils/iconCache');

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-iconcache-'));
  mockElectron.app.getPath = jest.fn(() => userDataDir);
});
afterEach(() => {
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
});

// A tiny 1x1 PNG, base64-encoded.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('storeDataUrl', () => {
  test('returns null for non-data-URL inputs', () => {
    expect(iconCache.storeDataUrl(null)).toBeNull();
    expect(iconCache.storeDataUrl(123)).toBeNull();
    expect(iconCache.storeDataUrl('https://example.com/icon.png')).toBeNull();
  });

  test('returns null for a malformed data: URL', () => {
    expect(iconCache.storeDataUrl('data:garbage-without-comma')).toBeNull();
  });

  test('writes a base64 PNG and returns its on-disk path with the right extension', () => {
    const out = iconCache.storeDataUrl(`data:image/png;base64,${PNG_B64}`);
    expect(out).toMatch(/notification-icons[\\/][0-9a-f]{40}\.png$/);
    expect(fs.existsSync(out)).toBe(true);
  });

  test('decodes URL-encoded (non-base64) payloads as utf8', () => {
    const out = iconCache.storeDataUrl('data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E');
    expect(out).toMatch(/\.svg$/);
    expect(fs.readFileSync(out, 'utf8')).toBe('<svg></svg>');
  });

  test('maps unknown mime types to a .bin extension', () => {
    const out = iconCache.storeDataUrl('data:application/octet-stream;base64,QUJD');
    expect(out).toMatch(/\.bin$/);
  });

  test('returns null for an empty payload', () => {
    expect(iconCache.storeDataUrl('data:image/png;base64,')).toBeNull();
  });

  test('returns null when the payload exceeds MAX_BYTES', () => {
    const big = Buffer.alloc(iconCache.MAX_BYTES + 1).toString('base64');
    expect(iconCache.storeDataUrl(`data:image/png;base64,${big}`)).toBeNull();
  });

  test('returns null when base64 decoding throws', () => {
    // Buffer.from(...,'base64') tolerates junk, so force the utf8/decodeURIComponent
    // branch with a malformed percent-escape that decodeURIComponent rejects.
    expect(iconCache.storeDataUrl('data:image/png,%E0%A4%A')).toBeNull();
  });

  test('is content-addressed: the same bytes resolve to the same file', () => {
    const a = iconCache.storeDataUrl(`data:image/png;base64,${PNG_B64}`);
    const b = iconCache.storeDataUrl(`data:image/png;base64,${PNG_B64}`);
    expect(a).toBe(b);
  });

  test('returns null when the cache directory cannot be created (mkdir fails)', () => {
    // Point userData at a regular file so mkdirSync('<file>/notification-icons')
    // throws ENOTDIR and getCacheDir's catch returns null.
    const filePath = path.join(userDataDir, 'not-a-dir');
    fs.writeFileSync(filePath, 'x');
    mockElectron.app.getPath = jest.fn(() => filePath);
    expect(iconCache.storeDataUrl(`data:image/png;base64,${PNG_B64}`)).toBeNull();
  });
});

describe('getCacheDir', () => {
  test('creates and returns the notification-icons directory', () => {
    const dir = iconCache.getCacheDir();
    expect(dir).toBe(path.join(userDataDir, 'notification-icons'));
    expect(fs.existsSync(dir)).toBe(true);
  });

  test('returns null when app.getPath is unavailable', () => {
    mockElectron.app.getPath = undefined;
    expect(iconCache.getCacheDir()).toBeNull();
  });
});

describe('gc', () => {
  test('removes files not referenced by any record and keeps referenced ones', () => {
    const keep = iconCache.storeDataUrl(`data:image/png;base64,${PNG_B64}`);
    const dir = iconCache.getCacheDir();
    const orphan = path.join(dir, 'orphan.png');
    fs.writeFileSync(orphan, 'stale');

    iconCache.gc([{ iconPath: keep }, { foo: 'no-icon' }, null]);

    expect(fs.existsSync(keep)).toBe(true);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  test('is a no-op when the cache dir is unavailable', () => {
    mockElectron.app.getPath = undefined;
    expect(() => iconCache.gc([])).not.toThrow();
  });

  test('treats undefined records as keeping nothing', () => {
    const dir = iconCache.getCacheDir();
    const f = path.join(dir, 'x.png');
    fs.writeFileSync(f, 'x');
    iconCache.gc(undefined);
    expect(fs.existsSync(f)).toBe(false);
  });
});

describe('clearAll', () => {
  test('deletes every file in the cache directory', () => {
    const dir = iconCache.getCacheDir();
    fs.writeFileSync(path.join(dir, 'a.png'), '1');
    fs.writeFileSync(path.join(dir, 'b.png'), '2');
    iconCache.clearAll();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('is a no-op when the cache dir is unavailable', () => {
    mockElectron.app.getPath = undefined;
    expect(() => iconCache.clearAll()).not.toThrow();
  });
});

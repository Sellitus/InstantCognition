const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic, readJsonOrQuarantine } = require('../../../shared/atomicWrite');

let dir;
let errSpy;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-atomic-'));
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  test('writes the data and leaves no temp file', () => {
    const file = path.join(dir, 'nested', 'store.json');
    writeFileAtomic(fs, file, '[1,2]');
    expect(fs.readFileSync(file, 'utf8')).toBe('[1,2]');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['store.json']);
  });

  test('each write uses its own temp path, so two writers never share one', () => {
    const file = path.join(dir, 'store.json');
    const temps = [];
    const recording = { ...fs, writeFileSync: (p, d) => { temps.push(p); fs.writeFileSync(p, d); } };
    writeFileAtomic(recording, file, '1');
    writeFileAtomic(recording, file, '2');
    expect(temps).toHaveLength(2);
    expect(new Set(temps).size).toBe(2);
    for (const t of temps) {
      expect(path.dirname(t)).toBe(dir);
      expect(t).not.toBe(`${file}.tmp`);
    }
  });

  test('a failed rename removes the temp file and rethrows', () => {
    const file = path.join(dir, 'store.json');
    fs.writeFileSync(file, '["keep"]');
    const noRename = { ...fs, renameSync: () => { const e = new Error('EXDEV: cross-device link'); throw e; } };
    expect(() => writeFileAtomic(noRename, file, '["new"]')).toThrow('EXDEV');
    expect(fs.readdirSync(dir)).toEqual(['store.json']);
    expect(fs.readFileSync(file, 'utf8')).toBe('["keep"]');
  });

  test('a failed write leaves the previous file content intact', () => {
    const file = path.join(dir, 'store.json');
    fs.writeFileSync(file, '["keep"]');
    const failing = {
      ...fs,
      existsSync: fs.existsSync,
      mkdirSync: fs.mkdirSync,
      renameSync: fs.renameSync,
      writeFileSync: (p) => {
        fs.writeFileSync(p, '["tr'); // partial bytes, then the disk fills
        const err = new Error('ENOSPC: no space left on device');
        throw err;
      },
    };
    expect(() => writeFileAtomic(failing, file, '["new"]')).toThrow('ENOSPC');
    expect(fs.readFileSync(file, 'utf8')).toBe('["keep"]');
    expect(fs.readdirSync(dir)).toEqual(['store.json']);
  });
});

describe('readJsonOrQuarantine', () => {
  test('a missing file yields undefined without quarantine', () => {
    expect(readJsonOrQuarantine(fs, path.join(dir, 'none.json'), 'T')).toEqual({ value: undefined });
  });

  test('parses a valid file', () => {
    const file = path.join(dir, 'ok.json');
    fs.writeFileSync(file, '{"a":1}');
    expect(readJsonOrQuarantine(fs, file, 'T')).toEqual({ value: { a: 1 } });
  });

  test('moves a truncated file aside so a later save cannot overwrite it', () => {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, '[{"id":"b1","url":"https://x');
    const res = readJsonOrQuarantine(fs, file, 'T');
    expect(res.value).toBeUndefined();
    expect(res.quarantined).toMatch(/bad\.json\.corrupt-\d+$/);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(res.quarantined, 'utf8')).toBe('[{"id":"b1","url":"https://x');
  });

  test.each(['EBUSY', 'EACCES', 'EMFILE', 'EIO'])('a %s read error blocks saving and leaves the valid file in place', (code) => {
    const file = path.join(dir, 'ok.json');
    fs.writeFileSync(file, '{"a":1}');
    const rename = jest.fn();
    const busy = { ...fs, renameSync: rename, readFileSync: () => { const e = /** @type {any} */ (new Error(`${code}: read failed`)); e.code = code; throw e; } };
    expect(readJsonOrQuarantine(busy, file, 'T')).toEqual({ value: undefined, blocked: true });
    expect(rename).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual(['ok.json']);
    expect(errSpy).toHaveBeenCalled();
  });

  test('a file that vanishes between the existence check and the read is treated as missing', () => {
    const file = path.join(dir, 'gone.json');
    const racing = { ...fs, existsSync: () => true };
    expect(readJsonOrQuarantine(racing, file, 'T')).toEqual({ value: undefined });
  });

  test('reports blocked when the corrupt file cannot be moved', () => {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, '{oops');
    const noRename = { ...fs, existsSync: fs.existsSync, readFileSync: fs.readFileSync, renameSync: () => { throw new Error('EPERM'); } };
    const res = readJsonOrQuarantine(noRename, file, 'T');
    expect(res).toEqual({ value: undefined, blocked: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('{oops');
  });
});

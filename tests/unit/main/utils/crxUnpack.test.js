// crxUnpack — stripCrxHeader is pure header parsing; unpackArchive is the
// .crx/.zip → unpacked-dir pipeline. extract-zip and fs/os are the external
// boundary and are faked; the header-strip + temp-staging + zip-slip
// propagation under test run for real.
//
// stripCrxHeader: a wrong magic constant or offset would return the wrong
// bytes, so these assert the exact embedded-ZIP slice for CRX2/CRX3 and that
// plain ZIPs pass through untouched.

// jest.mock factories are hoisted; only `mock`-prefixed names may cross in.
const mockExtract = { calls: [], impl: null };
const mockFsRec = {
  files: new Map(), // path -> contents (whatever was written)
  mkdirs: [],
  unlinked: [],
};

jest.mock('extract-zip', () => jest.fn(async (zipPath, opts) => {
  mockExtract.calls.push({ zipPath, dir: opts && opts.dir });
  if (mockExtract.impl) return mockExtract.impl(zipPath, opts);
  return undefined;
}));

jest.mock('fs', () => {
  const realPath = require('path');
  return {
    mkdirSync: jest.fn((d) => { mockFsRec.mkdirs.push(d); }),
    readFileSync: jest.fn((p) => {
      if (mockFsRec.files.has(p)) return mockFsRec.files.get(p);
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    }),
    writeFileSync: jest.fn((p, data) => { mockFsRec.files.set(realPath.resolve(p), data); }),
    unlinkSync: jest.fn((p) => {
      mockFsRec.unlinked.push(realPath.resolve(p));
      mockFsRec.files.delete(realPath.resolve(p));
    }),
  };
});

jest.mock('os', () => ({ tmpdir: jest.fn(() => '/fake-tmp') }));

const path = require('path');
const extract = require('extract-zip');
const fs = require('fs');
const os = require('os');
const { stripCrxHeader, unpackArchive } = require('../../../../main/utils/crxUnpack');

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

const ZIP = Buffer.from('PK\x03\x04-pretend-zip-body');

describe('stripCrxHeader', () => {
  test('returns a plain ZIP buffer unchanged (no CRX magic)', () => {
    expect(stripCrxHeader(ZIP)).toBe(ZIP);
  });

  test('strips a CRX3 header and returns exactly the embedded ZIP', () => {
    const header = Buffer.from('crx3-protobuf-header');
    const crx = Buffer.concat([Buffer.from('Cr24'), u32(3), u32(header.length), header, ZIP]);
    expect(stripCrxHeader(crx).equals(ZIP)).toBe(true);
  });

  test('strips a CRX2 header (pubkey + signature) and returns the ZIP', () => {
    const pubKey = Buffer.alloc(11, 1);
    const sig = Buffer.alloc(7, 2);
    const crx = Buffer.concat([
      Buffer.from('Cr24'), u32(2), u32(pubKey.length), u32(sig.length), pubKey, sig, ZIP,
    ]);
    expect(stripCrxHeader(crx).equals(ZIP)).toBe(true);
  });

  test('throws on an unsupported CRX version', () => {
    const crx = Buffer.concat([Buffer.from('Cr24'), u32(4), u32(0), ZIP]);
    expect(() => stripCrxHeader(crx)).toThrow(/Unsupported CRX version/);
  });

  test('throws on a too-small buffer', () => {
    expect(() => stripCrxHeader(Buffer.alloc(8))).toThrow(/too small/);
  });

  test('throws when the declared header runs past the buffer', () => {
    const crx = Buffer.concat([Buffer.from('Cr24'), u32(3), u32(0xffffff), Buffer.alloc(4)]);
    expect(() => stripCrxHeader(crx)).toThrow(/Corrupt CRX header/);
  });
});

describe('unpackArchive', () => {
  beforeEach(() => {
    mockExtract.calls = [];
    mockExtract.impl = null;
    mockFsRec.files = new Map();
    mockFsRec.mkdirs = [];
    mockFsRec.unlinked = [];
    extract.mockClear();
    fs.mkdirSync.mockClear();
    fs.readFileSync.mockClear();
    fs.writeFileSync.mockClear();
    fs.unlinkSync.mockClear();
    os.tmpdir.mockClear();
  });

  test('a plain .zip is extracted in place (no temp staging) into the dest dir', async () => {
    const src = '/downloads/ext.zip';
    mockFsRec.files.set(src, ZIP); // plain ZIP: no CRX magic
    // Model a successful extract that drops manifest.json into dir.
    mockExtract.impl = (_zip, opts) => {
      mockFsRec.files.set(path.join(opts.dir, 'manifest.json'), '{}');
    };

    const out = await unpackArchive(src, '/dest/unpacked');

    const absDest = path.resolve('/dest/unpacked');
    expect(out).toBe(absDest);
    expect(fs.mkdirSync).toHaveBeenCalledWith(absDest, { recursive: true });
    // plain ZIP extracted from the source itself — no temp .zip written
    expect(extract).toHaveBeenCalledTimes(1);
    expect(mockExtract.calls[0]).toEqual({ zipPath: path.resolve(src), dir: absDest });
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  test('a .crx has its header stripped, the inner ZIP staged to tmp, then extracted and cleaned up', async () => {
    const header = Buffer.from('crx3-header');
    const crx = Buffer.concat([Buffer.from('Cr24'), u32(3), u32(header.length), header, ZIP]);
    const src = '/downloads/ext.crx';
    mockFsRec.files.set(src, crx);
    let stagedZipBytes = null;
    mockExtract.impl = (zipPath) => {
      stagedZipBytes = mockFsRec.files.get(path.resolve(zipPath));
    };

    const out = await unpackArchive(src, '/dest/crx-unpacked');

    const absDest = path.resolve('/dest/crx-unpacked');
    expect(out).toBe(absDest);
    // the inner ZIP (header stripped) was staged under the faked tmpdir
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const tmpZipPath = fs.writeFileSync.mock.calls[0][0];
    expect(tmpZipPath.startsWith('/fake-tmp/')).toBe(true);
    expect(tmpZipPath.endsWith('.zip')).toBe(true);
    // the bytes handed to extract-zip are exactly the embedded ZIP
    expect(Buffer.isBuffer(stagedZipBytes) && stagedZipBytes.equals(ZIP)).toBe(true);
    // extract was driven from the temp zip, not the .crx
    expect(mockExtract.calls[0].zipPath).toBe(path.resolve(tmpZipPath));
    expect(mockExtract.calls[0].dir).toBe(absDest);
    // temp zip is cleaned up afterward (finally block)
    expect(mockFsRec.unlinked).toContain(path.resolve(tmpZipPath));
  });

  test('the temp zip is still cleaned up when extraction of a .crx fails', async () => {
    const header = Buffer.from('h');
    const crx = Buffer.concat([Buffer.from('Cr24'), u32(3), u32(header.length), header, ZIP]);
    mockFsRec.files.set('/downloads/bad.crx', crx);
    mockExtract.impl = () => { throw new Error('corrupt central directory'); };

    await expect(unpackArchive('/downloads/bad.crx', '/dest/x')).rejects.toThrow(/corrupt central directory/);

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const tmpZipPath = path.resolve(fs.writeFileSync.mock.calls[0][0]);
    // even on the failure path the staged temp zip must be removed
    expect(mockFsRec.unlinked).toContain(tmpZipPath);
  });

  test('SECURITY: a zip-slip / path-traversal entry is rejected and nothing is written outside the dest dir', async () => {
    const src = '/downloads/evil.zip';
    mockFsRec.files.set(src, ZIP); // plain ZIP path (no temp staging)
    const absDest = path.resolve('/dest/safe-area');

    // Model extract-zip's real zip-slip guard: an entry whose joined,
    // normalized path escapes opts.dir throws "Out of bound path" and
    // writes NOTHING (extract-zip rejects before extracting the entry).
    const maliciousEntries = ['ok.txt', '../../../etc/evil-implant'];
    mockExtract.impl = (_zip, opts) => {
      for (const name of maliciousEntries) {
        const target = path.join(opts.dir, name);
        const rel = path.relative(opts.dir, target);
        if (rel.split(path.sep).includes('..')) {
          throw new Error(
            `Out of bound path "${target}" found while processing file ${name}`,
          );
        }
        mockFsRec.files.set(target, 'entry');
      }
    };

    await expect(unpackArchive(src, '/dest/safe-area')).rejects.toThrow(/Out of bound path/);

    // Hard security assertion: no file was written anywhere outside absDest.
    const outside = [...mockFsRec.files.keys()].filter(
      (p) => p !== src && !p.startsWith(absDest + path.sep) && p !== absDest,
    );
    expect(outside).toEqual([]);
    // Specifically, the traversal target was never created.
    expect(mockFsRec.files.has(path.resolve('/etc/evil-implant'))).toBe(false);
  });

  test('SECURITY: a zip-slip entry inside a .crx is rejected and the staged temp zip is cleaned up (no outside write)', async () => {
    const header = Buffer.from('h');
    const crx = Buffer.concat([Buffer.from('Cr24'), u32(3), u32(header.length), header, ZIP]);
    mockFsRec.files.set('/downloads/evil.crx', crx);
    const absDest = path.resolve('/dest/crx-safe');

    mockExtract.impl = (_zip, opts) => {
      const name = '../../escape.sh';
      const target = path.join(opts.dir, name);
      const rel = path.relative(opts.dir, target);
      if (rel.split(path.sep).includes('..')) {
        throw new Error(`Out of bound path "${target}" found while processing file ${name}`);
      }
      mockFsRec.files.set(target, 'should-not-happen');
    };

    await expect(unpackArchive('/downloads/evil.crx', '/dest/crx-safe')).rejects.toThrow(/Out of bound path/);

    // temp zip staged then removed despite the rejection
    const tmpZipPath = path.resolve(fs.writeFileSync.mock.calls[0][0]);
    expect(mockFsRec.unlinked).toContain(tmpZipPath);
    // nothing extracted outside the dest dir
    const escaped = [...mockFsRec.files.keys()].filter(
      (p) => !p.startsWith(absDest + path.sep) && p !== absDest
        && p !== '/downloads/evil.crx' && p !== tmpZipPath,
    );
    expect(escaped).toEqual([]);
  });
});

// engineFetch — the network and unpacking layer for runtime updates. These
// cover the parts that run without a network: the HTTPS-only guard that keeps
// an executable from arriving over plaintext, and the on-disk helpers.

const fs = require('fs');
const os = require('os');
const path = require('path');

const fetcher = require('../../../../main/services/llm/engineFetch');

describe('transport guards', () => {
  test('refuses a plaintext URL rather than fetching an executable over http', async () => {
    await expect(fetcher.fetchText('http://example.test/nightly-tag.txt')).rejects.toThrow(/HTTPS/);
    await expect(fetcher.downloadVerified('http://example.test/a.zip', '/tmp/nope.zip')).rejects.toThrow(/HTTPS/);
  });

  test('refuses a malformed URL', async () => {
    await expect(fetcher.fetchText('not a url')).rejects.toThrow(/Invalid URL/);
    await expect(fetcher.downloadVerified('not a url', '/tmp/nope.zip')).rejects.toThrow(/Invalid download URL/);
  });

  test('a failing command reports the tail of its output, not just an exit code', async () => {
    await expect(fetcher.run(process.execPath, ['-e', 'console.error("boom detail"); process.exit(3)']))
      .rejects.toThrow(/boom detail/);
  });
});

describe('disk helpers', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-fetch-test-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  test('findFile locates a binary nested inside an extracted archive', () => {
    const nested = path.join(tmp, 'build', 'bin');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'llama-server'), '#!/bin/sh\n');

    expect(fetcher.findFile(tmp, 'llama-server')).toBe(path.join(nested, 'llama-server'));
    expect(fetcher.findFile(tmp, 'llama-server.exe')).toBeNull();
  });

  test('copyDirContents copies the whole tree and keeps files executable', () => {
    const src = path.join(tmp, 'src');
    fs.mkdirSync(path.join(src, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(src, 'llama-server'), 'bin');
    // The shared libraries beside the binary must stay loadable, so the exec
    // bit is applied to everything copied, not only the binary.
    fs.writeFileSync(path.join(src, 'lib', 'libggml.so'), 'lib');

    const dest = path.join(tmp, 'dest');
    fetcher.copyDirContents(src, dest);

    expect(fs.readFileSync(path.join(dest, 'llama-server'), 'utf8')).toBe('bin');
    expect(fs.statSync(path.join(dest, 'lib', 'libggml.so')).mode & 0o111).toBeTruthy();
  });
});
// win32 has no unzip; pin the tar/PowerShell zip routing at the mocked execFile boundary.
describe('extractArchive zip routing', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const dirs = [];
  const setup = async (platform, failures = {}) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    const log = []; jest.resetModules();
    jest.doMock('child_process', () => ({ execFile: (file, args, opts, cb) => {
      log.push({ file, args }); cb(failures[file] || null);
    } }));
    const { extractArchive } = require('../../../../main/services/llm/engineFetch');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-zip-')); dirs.push(dir);
    return { extractArchive, log, zip: path.join(dir, 'llama.zip'), outDir: path.join(dir, 'out') };
  };
  afterAll(() => { dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })); Object.defineProperty(process, 'platform', realPlatform); });
  test('win32 zip goes through tar, never unzip', async () => {
    const t = await setup('win32');
    await t.extractArchive(t.zip, t.outDir);
    expect(t.log).toEqual([{ file: 'tar', args: ['-xf', t.zip, '-C', t.outDir] }]);
  });
  test('win32 falls back to PowerShell when tar is missing', async () => {
    const t = await setup('win32', { tar: new Error('no tar') });
    await t.extractArchive(t.zip, t.outDir);
    expect(t.log.map((s) => s.file)).toEqual(['tar', 'powershell.exe']);
    expect(t.log[1].args).toEqual(['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${t.zip}' -DestinationPath '${t.outDir}' -Force`]);
    const b = await setup('win32', { tar: new Error('t1'), 'powershell.exe': new Error('p1') });
    await expect(b.extractArchive(b.zip, b.outDir)).rejects.toThrow(/t1.*p1/);
  });
  test('darwin keeps unzip for zips', async () => {
    const t = await setup('darwin');
    await t.extractArchive(t.zip, t.outDir);
    expect(t.log).toEqual([{ file: 'unzip', args: ['-q', '-o', t.zip, '-d', t.outDir] }]);
  });
});

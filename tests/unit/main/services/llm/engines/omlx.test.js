// engines/omlx — the oMLX updater adapter. Boundaries: engineFetch (GitHub
// API, wheel download, processes), Electron's userData path (a temp dir) and
// the discovery singleton's probe results.

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../../../../../main/services/llm/engineFetch', () => ({
  getJson: jest.fn(), run: jest.fn(), downloadVerified: jest.fn(),
}));

const { app } = require('electron');
const fetcher = require('../../../../../../main/services/llm/engineFetch');
const discovery = require('../../../../../../main/services/EngineDiscoveryService');
const { bundledOmlxPythonCandidates } = require('../../../../../../main/services/llm/omlxDiscovery');
const omlx = require('../../../../../../main/services/llm/engines/omlx');

const realArch = Object.getOwnPropertyDescriptor(process, 'arch');
const wheel = (tag, extra = {}) => ({
  name: `omlx-0.8.0-${tag}-${tag}-macosx_15_0_universal2.whl`,
  browser_download_url: `https://example.test/${tag}.whl`,
  digest: `sha256:${'c'.repeat(64)}`,
  ...extra,
});
const RELEASES = [
  { tag_name: 'v0.9.0rc1', prerelease: false, assets: [] },
  { tag_name: 'v0.8.0', prerelease: false, assets: [wheel('cp311'), wheel('cp312')] },
  { tag_name: 'v0.7.0', prerelease: false, assets: [] },
];

let tmp; let sent;
function venvPython() { return path.join(tmp, 'engines', 'omlx-venv', 'bin', 'python3'); }
function makeManagedVenv() { fs.mkdirSync(path.dirname(venvPython()), { recursive: true }); fs.writeFileSync(venvPython(), ''); }
/** run(): answers the python-tag probe with `tag`, everything else succeeds. */
function runAnswers({ tag = '311', gitFails = false } = {}) {
  fetcher.run.mockImplementation(async (file, args) => {
    if (gitFails && (file === 'xcode-select' || file === 'git')) throw new Error('xcrun: error: invalid active developer path');
    if (args[0] === '-c') return { stdout: `${tag}\n`, stderr: '' };
    return { stdout: '', stderr: '' };
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omlx-adapter-test-'));
  sent = [];
  Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
  jest.spyOn(app, 'getPath').mockReturnValue(tmp);
  jest.spyOn(discovery, 'clearCache').mockImplementation(() => {});
});
afterEach(() => {
  Object.defineProperty(process, 'arch', realArch);
  fs.rmSync(tmp, { recursive: true, force: true });
  jest.restoreAllMocks();
  jest.resetAllMocks();
});

describe('check', () => {
  test('a Mac that cannot run oMLX reports unavailable without asking GitHub', async () => {
    jest.spyOn(discovery, 'detectOmlx').mockResolvedValue({ available: false, pythonPath: null, reason: 'Apple Silicon required' });
    const row = await omlx.check({ latest: {} });
    expect(row).toMatchObject({ engine: 'omlx', current: 'unavailable', updateAvailable: false, reason: 'Apple Silicon required' });
    expect(fetcher.getJson).not.toHaveBeenCalled();
  });

  test('not installed: offers the newest stable release, ignoring rc tags', async () => {
    jest.spyOn(discovery, 'detectOmlx').mockResolvedValue({ available: false, pythonPath: null, reason: 'oMLX not installed' });
    fetcher.getJson.mockResolvedValue(RELEASES);
    const ctx = { latest: {} };
    const row = await omlx.check(ctx);
    expect(row).toMatchObject({ current: 'not installed', latest: '0.8.0', updateAvailable: true });
    expect(ctx.latest.omlx.tag_name).toBe('v0.8.0');
  });

  test('installed at latest: no update; older: update', async () => {
    fetcher.getJson.mockResolvedValue(RELEASES);
    const detect = jest.spyOn(discovery, 'detectOmlx').mockResolvedValue({ available: true, pythonPath: '/p', version: '0.8.0' });
    expect((await omlx.check({ latest: {} })).updateAvailable).toBe(false);
    detect.mockResolvedValue({ available: true, pythonPath: '/p', version: '0.7.0' });
    expect(await omlx.check({ latest: {} })).toMatchObject({ current: '0.7.0', updateAvailable: true });
  });

  test('no stable release is an error', async () => {
    jest.spyOn(discovery, 'detectOmlx').mockResolvedValue({ available: false, pythonPath: null, reason: 'oMLX not installed' });
    fetcher.getJson.mockResolvedValue([{ tag_name: 'v1.0.0-dev', prerelease: false }]);
    await expect(omlx.check({ latest: {} })).rejects.toThrow('No stable oMLX release was found.');
  });
});

describe('install', () => {
  const ctx = () => ({ latest: { omlx: RELEASES[1] }, send: (p) => sent.push(p) });

  test('downloads the wheel for the venv python, verified, and pip-installs it', async () => {
    makeManagedVenv();
    runAnswers({ tag: '312' });
    fetcher.downloadVerified.mockResolvedValue(undefined);
    jest.spyOn(discovery, 'detectOmlx').mockResolvedValue({ available: true, pythonPath: venvPython(), version: '0.8.0' });

    await expect(omlx.install(ctx())).resolves.toBe('0.8.0');

    const [url, dest, opts] = fetcher.downloadVerified.mock.calls[0];
    expect(url).toBe('https://example.test/cp312.whl');
    expect(path.basename(dest)).toBe(wheel('cp312').name);
    expect(opts.digest).toBe(`sha256:${'c'.repeat(64)}`);
    const pip = fetcher.run.mock.calls.find(([, a]) => a.includes('pip'));
    expect(pip[0]).toBe(venvPython());
    expect(pip[1]).toEqual(['-m', 'pip', 'install', '--no-cache-dir', '--upgrade', dest]);
    expect(discovery.clearCache).toHaveBeenCalled();
    expect(sent.some((p) => p.status === 'downloading')).toBe(true);
  });

  test('missing git stops with the Command Line Tools instruction', async () => {
    runAnswers({ gitFails: true });
    await expect(omlx.install(ctx())).rejects.toThrow(/xcode-select --install/);
    expect(fetcher.downloadVerified).not.toHaveBeenCalled();
  });

  test('no wheel for the interpreter version', async () => {
    makeManagedVenv();
    runAnswers({ tag: '313' });
    await expect(omlx.install(ctx())).rejects.toThrow('oMLX 0.8.0 has no wheel for Python 3.13.');
  });

  test('a wheel without a published checksum is refused', async () => {
    makeManagedVenv();
    runAnswers({ tag: '311' });
    const release = { ...RELEASES[1], assets: [wheel('cp311', { digest: null })] };
    await expect(omlx.install({ latest: { omlx: release }, send: () => {} })).rejects.toThrow(/published no checksum/);
    expect(fetcher.downloadVerified).not.toHaveBeenCalled();
  });

  test('an install that does not then report the new version fails', async () => {
    makeManagedVenv();
    runAnswers();
    fetcher.downloadVerified.mockResolvedValue(undefined);
    jest.spyOn(discovery, 'detectOmlx').mockResolvedValue({ available: true, pythonPath: venvPython(), version: '0.7.0' });
    await expect(omlx.install(ctx())).rejects.toThrow('oMLX 0.8.0 was installed but does not run: reports 0.7.0');
  });

  test('without a managed venv, creates one from the bundled interpreter with system site packages', async () => {
    const bundled = bundledOmlxPythonCandidates().find((p) => fs.existsSync(p));
    jest.spyOn(discovery, 'findPythonInterpreter').mockResolvedValue('/sys/python3');
    runAnswers({ tag: '311' });
    fetcher.downloadVerified.mockResolvedValue(undefined);
    jest.spyOn(discovery, 'detectOmlx').mockResolvedValue({ available: true, pythonPath: venvPython(), version: '0.8.0' });
    await omlx.install(ctx());
    const venv = fetcher.run.mock.calls.find(([, a]) => a.includes('venv'));
    expect(venv[0]).toBe(bundled || '/sys/python3');
    expect(venv[1]).toEqual(['-m', 'venv', '--system-site-packages', path.join(tmp, 'engines', 'omlx-venv')]);
  });

  test('a base interpreter outside 3.11–3.13 is refused', async () => {
    const realExists = fs.existsSync;
    const bundled = bundledOmlxPythonCandidates();
    jest.spyOn(fs, 'existsSync').mockImplementation((p) => (bundled.includes(p) ? false : realExists(p)));
    jest.spyOn(discovery, 'findPythonInterpreter').mockResolvedValue('/sys/python3');
    runAnswers({ tag: '310' });
    await expect(omlx.install(ctx())).rejects.toThrow('oMLX needs Python 3.11–3.13; the available interpreter (/sys/python3) is 3.10.');
  });

  test('refuses Intel Macs', async () => {
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
    await expect(omlx.install(ctx())).rejects.toThrow('oMLX requires Apple Silicon.');
  });
});

test('supported only on macOS', () => {
  expect(omlx.supported('darwin')).toBe(true);
  expect(omlx.supported('linux')).toBe(false);
});

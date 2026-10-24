// wsl — path translation, wsl.exe output parsing and the setup-state
// derivation behind vLLM on Windows. wsl.exe / sc.exe / reg.exe are mocked at
// the engineFetch.run boundary.

jest.mock('../../../../../main/services/llm/engineFetch', () => ({ run: jest.fn() }));

const fetcher = require('../../../../../main/services/llm/engineFetch');
const wsl = require('../../../../../main/services/llm/wsl');

afterEach(() => { jest.resetAllMocks(); });

describe('toWslPath', () => {
  test('maps a drive path under /mnt with a lower-case drive letter', () => {
    expect(wsl.toWslPath('C:\\Models\\Qwen3-8B')).toBe('/mnt/c/Models/Qwen3-8B');
    expect(wsl.toWslPath('d:/m/x/')).toBe('/mnt/d/m/x');
    expect(wsl.toWslPath('E:\\')).toBe('/mnt/e');
  });

  test('passes POSIX paths through unchanged', () => {
    expect(wsl.toWslPath('/root/models/a')).toBe('/root/models/a');
  });

  test('maps the app distro UNC path (both host names) to the distro root', () => {
    expect(wsl.toWslPath('\\\\wsl$\\InstantCognition\\root\\m')).toBe('/root/m');
    expect(wsl.toWslPath('\\\\wsl.localhost\\instantcognition\\opt\\x')).toBe('/opt/x');
  });

  test('rejects another distro, network shares and empty input', () => {
    expect(() => wsl.toWslPath('\\\\wsl$\\Ubuntu\\home\\m')).toThrow(/WSL distro "Ubuntu"/);
    expect(() => wsl.toWslPath('\\\\server\\share\\m')).toThrow(/network path/);
    expect(() => wsl.toWslPath('')).toThrow(/No path/);
  });
});

describe('output parsing', () => {
  test('cleanOutput strips UTF-16 NULs and a BOM', () => {
    expect(wsl.cleanOutput('\uFEFFU\u0000b\u0000u\u0000')).toBe('Ubu');
    expect(wsl.cleanOutput(null)).toBe('');
  });

  test('parseDistroList drops NULs, CRs and blank lines', () => {
    const utf16ish = 'U\u0000b\u0000u\u0000n\u0000t\u0000u\u0000\r\u0000\n\u0000\r\n  \r\nInstantCognition\r\n';
    expect(wsl.parseDistroList(utf16ish)).toEqual(['Ubuntu', 'InstantCognition']);
    expect(wsl.parseDistroList('')).toEqual([]);
  });
});

describe('deriveWslState', () => {
  const base = { wslRuns: true, installPending: false, vmcomputeMissing: false, distros: [] };

  test('a pending install means reboot-required even when wsl does not run', () => {
    expect(wsl.deriveWslState({ ...base, wslRuns: false, installPending: true })).toBe('reboot-required');
  });
  test('wsl-missing when the WSL package does not answer', () => {
    expect(wsl.deriveWslState({ ...base, wslRuns: false })).toBe('wsl-missing');
  });
  test('reboot-required when the vmcompute service is absent', () => {
    expect(wsl.deriveWslState({ ...base, vmcomputeMissing: true, distros: ['InstantCognition'] })).toBe('reboot-required');
  });
  test('distro-missing when only other distros exist', () => {
    expect(wsl.deriveWslState({ ...base, distros: ['Ubuntu'] })).toBe('distro-missing');
  });
  test('ready when the app distro is registered (case-insensitive)', () => {
    expect(wsl.deriveWslState({ ...base, distros: ['Ubuntu', 'instantcognition'] })).toBe('ready');
  });
});

describe('wsl.exe calls', () => {
  test('execInDistro runs argv as root in the app distro with WSL_UTF8 set', async () => {
    fetcher.run.mockResolvedValueOnce({ stdout: 'o\u0000k\u0000', stderr: '' });
    const res = await wsl.execInDistro(['/usr/bin/true'], { timeoutMs: 5 });
    expect(res.stdout).toBe('ok');
    const [file, args, opts] = fetcher.run.mock.calls[0];
    expect(file).toBe('wsl.exe');
    expect(args).toEqual(['-d', 'InstantCognition', '-u', 'root', '--exec', '/usr/bin/true']);
    expect(opts.timeoutMs).toBe(5);
    expect(opts.env.WSL_UTF8).toBe('1');
  });

  test('runWsl rethrows with NULs removed from the message', async () => {
    fetcher.run.mockRejectedValueOnce(new Error('b\u0000a\u0000d\u0000'));
    await expect(wsl.runWsl(['-l'])).rejects.toThrow(/^bad$/);
  });

  test('listDistros treats "no installed distributions" as an empty list', async () => {
    fetcher.run.mockRejectedValueOnce(new Error('Windows Subsystem for Linux has no installed distributions.'));
    await expect(wsl.listDistros()).resolves.toEqual([]);
  });

  test('listDistros rethrows any other failure', async () => {
    fetcher.run.mockRejectedValueOnce(new Error('access denied'));
    await expect(wsl.listDistros()).rejects.toThrow('access denied');
  });

  test('wslState: registered distro on a running WSL is ready', async () => {
    fetcher.run.mockImplementation(async (file, args) => {
      if (file === 'reg.exe') throw new Error('not found');
      if (file === 'sc.exe') return { stdout: 'RUNNING', stderr: '' };
      if (args[0] === '--version') return { stdout: 'WSL version: 2', stderr: '' };
      return { stdout: 'InstantCognition\r\n', stderr: '' };
    });
    await expect(wsl.wslState()).resolves.toBe('ready');
  });

  test('wslState: sc.exe 1060 (service missing) means reboot-required', async () => {
    fetcher.run.mockImplementation(async (file) => {
      if (file === 'reg.exe') throw new Error('not found');
      if (file === 'sc.exe') throw new Error('[SC] OpenService FAILED 1060');
      return { stdout: '', stderr: '' };
    });
    await expect(wsl.wslState()).resolves.toBe('reboot-required');
  });

  test('wslState: wsl --version failing means wsl-missing and lists nothing', async () => {
    fetcher.run.mockImplementation(async (file) => {
      if (file === 'sc.exe') return { stdout: '', stderr: '' };
      throw new Error('fail');
    });
    await expect(wsl.wslState()).resolves.toBe('wsl-missing');
    expect(fetcher.run.mock.calls.some(([, args]) => args.includes('-l'))).toBe(false);
  });

  test('terminateDistro terminates the app distro', async () => {
    fetcher.run.mockResolvedValueOnce({ stdout: '', stderr: '' });
    await wsl.terminateDistro();
    expect(fetcher.run.mock.calls[0][1]).toEqual(['--terminate', 'InstantCognition']);
  });
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const shellTools = require('../../../../../main/agent/tools/shellTools');

const { argvError, buildEnv, resolveWinCommand } = shellTools;
const shellRun = shellTools.find((t) => t.name === 'shell.run');
const POSIX = process.platform !== 'win32';
const posixTest = POSIX ? test : test.skip;

let base, root, outside, settings;
const run = (args, invCtx) => shellRun.handler(args, { agentSettings: settings }, invCtx || {});

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code !== 'ESRCH'; }
}

async function waitGone(pid, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !alive(pid);
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-shell-')));
  root = path.join(base, 'root');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.mkdirSync(outside);
  settings = {
    workspace: { roots: [root] },
    shell: { enabled: true, defaultTimeoutMs: 10000, maxTimeoutMs: 20000, maxOutputBytes: 65536, envAllow: ['PATH', 'HOME'] },
  };
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  fs.rmSync(base, { recursive: true, force: true });
});

describe('argv handling', () => {
  posixTest('["echo", "$(whoami)"] prints the literal text: no shell expansion', async () => {
    const r = await run({ argv: ['echo', '$(whoami)', '*', '`id`'] });
    expect(r).toMatchObject({ ok: true, exitCode: 0 });
    expect(r.stdout).toBe('$(whoami) * `id`\n');
  });

  test('a string argv is rejected before anything is spawned', async () => {
    expect(await run({ argv: 'echo hi' })).toEqual({ ok: false, error: 'argv_must_be_array' });
  });

  test.each([
    [[], 'argv_empty'],
    [[''], 'argv_empty'],
    [['echo', 3], 'argv_element_not_string'],
    [['echo', 'a\u0000b'], 'argv_nul_byte'],
  ])('argvError(%p) = %s', (argv, code) => {
    expect(argvError(argv)).toBe(code);
  });

  test('a missing program is a spawn error, not an exception', async () => {
    const r = await run({ argv: ['ic-no-such-program-xyz'] });
    expect(r).toMatchObject({ ok: false, error: 'spawn_failed' });
  });

  test('stdin is passed through and a non-zero exit is ok:false', async () => {
    const r = await run({ argv: [process.execPath, '-e', 'process.stdin.pipe(process.stdout); process.stdin.on("end",()=>process.exit(3))'], stdin: 'piped' });
    expect(r).toMatchObject({ ok: false, exitCode: 3, stdout: 'piped' });
  });
});

describe('cwd confinement', () => {
  test('cwd outside the root is rejected', async () => {
    expect(await run({ argv: ['pwd'], cwd: '../outside' })).toEqual({ ok: false, error: 'path_outside_workspace' });
    expect(await run({ argv: ['pwd'], cwd: outside })).toEqual({ ok: false, error: 'path_outside_workspace' });
  });

  posixTest('cwd through a symlink escaping the root is rejected', async () => {
    fs.symlinkSync(outside, path.join(root, 'link'), 'dir');
    expect(await run({ argv: ['pwd'], cwd: 'link' })).toEqual({ ok: false, error: 'path_outside_workspace' });
  });

  test('cwd defaults to the root and accepts a subdirectory', async () => {
    const r = await run({ argv: [process.execPath, '-e', 'process.stdout.write(process.cwd())'], cwd: 'sub' });
    expect(fs.realpathSync(r.stdout)).toBe(path.join(root, 'sub'));
  });

  test('shell disabled in settings refuses to run', async () => {
    settings.shell.enabled = false;
    expect(await run({ argv: ['echo', 'x'] })).toEqual({ ok: false, error: 'shell_disabled' });
  });
});

describe('environment', () => {
  test('OPENAI_API_KEY is scrubbed even when listed in envAllow', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-should-not-leak';
    settings.shell.envAllow = ['PATH', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'DB_PASSWORD'];
    const r = await run({ argv: [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.env))'] });
    const env = JSON.parse(r.stdout);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(r.stdout).not.toContain('sk-test-should-not-leak');
    expect(env.PATH).toBe(process.env.PATH);
  });

  test('variables not in envAllow are not inherited', () => {
    expect(buildEnv(['PATH'], { PATH: '/bin', HOME: '/h', AWS_SECRET_ACCESS_KEY: 's' })).toEqual({ PATH: '/bin' });
    expect(buildEnv(['session_token', 'PASSWD', 'LANG'], { session_token: 't', PASSWD: 'p', LANG: 'C' })).toEqual({ LANG: 'C' });
  });
});

describe('timeout and abort', () => {
  posixTest('timeout kills the whole process group, background children included', async () => {
    const r = await run({ argv: ['sh', '-c', 'sleep 30 & echo $!; wait'], timeoutMs: 400 });
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.signal).toBe('SIGKILL');
    const grandchild = Number(r.stdout.trim());
    expect(grandchild).toBeGreaterThan(0);
    expect(await waitGone(grandchild, 2000)).toBe(true);
  }, 5000);

  posixTest('a background process left running after a normal exit is killed too', async () => {
    const r = await run({ argv: ['sh', '-c', 'sleep 30 > /dev/null 2>&1 & echo $!'] });
    expect(r).toMatchObject({ ok: true, exitCode: 0 });
    expect(await waitGone(Number(r.stdout.trim()), 2000)).toBe(true);
  }, 5000);

  test('timeoutMs is clamped to settings.shell.maxTimeoutMs', async () => {
    settings.shell.maxTimeoutMs = 300;
    const started = Date.now();
    const r = await run({ argv: [process.execPath, '-e', 'setTimeout(()=>{}, 30000)'], timeoutMs: 60000 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
  }, 5000);

  test('an abort signal stops the command', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await run({ argv: [process.execPath, '-e', 'setTimeout(()=>{}, 30000)'] }, { signal: ac.signal });
    expect(r).toMatchObject({ ok: false, aborted: true, timedOut: false });
  }, 5000);
});

describe('output cap', () => {
  test('stdout keeps the tail and flags truncation', async () => {
    settings.shell.maxOutputBytes = 1000;
    const r = await run({ argv: [process.execPath, '-e', 'process.stdout.write("a".repeat(5000) + "END")'] });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBe(1000);
    expect(r.stdout.endsWith('END')).toBe(true);
  });
});

describe('Windows', () => {
  const winBase = {
    SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', PATHEXT: '.COM;.EXE;.BAT;.CMD',
    windir: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u', APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', TEMP: 'C:\\T', TMP: 'C:\\T',
  };

  test('buildEnv adds the variables Windows programs need to start, matching names case-insensitively', () => {
    const source = { ...winBase, Path: 'C:\\bin', NPM_TOKEN: 'x', OTHER: 'o' };
    expect(buildEnv(['PATH', 'NPM_TOKEN'], source, 'win32')).toEqual({ PATH: 'C:\\bin', ...winBase, windir: undefined, WINDIR: 'C:\\Windows' });
  });

  test('buildEnv on POSIX adds nothing beyond envAllow', () => {
    expect(buildEnv(['PATH'], { ...winBase, PATH: '/bin', Path: 'x' }, 'linux')).toEqual({ PATH: '/bin' });
  });

  test('buildEnv never copies a secret-looking name even from the Windows base list', () => {
    expect(Object.keys(buildEnv([], { ...winBase, APPDATA_TOKEN: 't' }, 'win32'))).not.toContain('APPDATA_TOKEN');
  });

  describe('resolveWinCommand', () => {
    const files = new Set([
      'C:\\work\\tool.exe',
      'C:\\node\\node.exe', 'C:\\node\\npm.cmd', 'C:\\node\\npm',
      'C:\\scripts\\build.bat',
      'C:\\both\\git.cmd', 'C:\\later\\git.exe',
    ]);
    // NTFS lookups are case-insensitive.
    const lower = new Set([...files].map((f) => f.toLowerCase()));
    const isFile = (p) => lower.has(p.toLowerCase());
    const resolve = (argv0, pathEnv) => resolveWinCommand(argv0, 'C:\\work', pathEnv, isFile);

    test('finds .exe in cwd before PATH and on PATH', () => {
      expect(resolve('tool', 'C:\\node')).toEqual({ resolved: 'C:\\work\\tool.exe' });
      expect(resolve('node', 'C:\\nope;C:\\node\\')).toEqual({ resolved: 'C:\\node\\node.exe' });
      expect(resolve('NODE.EXE', 'C:\\node')).toEqual({ resolved: 'C:\\node\\NODE.EXE' });
      expect(resolve('node', '"C:\\node"')).toEqual({ resolved: 'C:\\node\\node.exe' });
    });

    test('a name that resolves only to .cmd/.bat is refused with the script path', () => {
      expect(resolve('npm', 'C:\\node')).toMatchObject({ error: 'shell_cmd_script_unsupported', resolved: 'C:\\node\\npm.cmd' });
      expect(resolve('build', 'C:\\scripts')).toMatchObject({ error: 'shell_cmd_script_unsupported', resolved: 'C:\\scripts\\build.bat' });
    });

    test('an earlier PATH .cmd does not shadow a later .exe (libuv only launches .com/.exe)', () => {
      expect(resolve('git', 'C:\\both;C:\\later')).toEqual({ resolved: 'C:\\later\\git.exe' });
    });

    test('an explicit .cmd/.bat argv[0] is refused even when absent', () => {
      expect(resolve('C:\\x\\run.CMD', '')).toMatchObject({ error: 'shell_cmd_script_unsupported' });
      expect(resolve('setup.bat', '')).toMatchObject({ error: 'shell_cmd_script_unsupported' });
    });

    test('a path with a directory is not searched on PATH', () => {
      expect(resolve('.\\npm', 'C:\\node')).toEqual({ resolved: null });
      expect(resolve('C:\\node\\node', '')).toEqual({ resolved: 'C:\\node\\node.exe' });
    });

    test('an unknown program resolves to nothing so spawn reports it', () => {
      expect(resolve('nothing', 'C:\\node')).toEqual({ resolved: null });
    });
  });

  test('shell.run refuses a batch script on win32 before spawning', async () => {
    const r = await shellRun.handler({ argv: ['build.bat', 'x'] }, { agentSettings: settings, platform: 'win32' }, {});
    expect(r).toMatchObject({ ok: false, error: 'shell_cmd_script_unsupported' });
    expect(r.hint).toMatch(/cmd\.exe/);
  });

  posixTest('the same argv on POSIX is spawned, not refused', async () => {
    const r = await run({ argv: ['build.bat', 'x'] });
    expect(r).toMatchObject({ ok: false, error: 'spawn_failed' });
  });
});

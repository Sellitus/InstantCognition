// shellTools — shell.run: one command as an argv array, no shell.
//
// spawn(argv[0], argv.slice(1), { shell:false }) so `$(…)`, globs, pipes and
// quotes in arguments reach the program literally. The cwd must resolve
// inside a workspace root, but this is NOT a sandbox: the command can still
// touch absolute paths, which is why exec always needs approval outside Bypass
// or an explicit allow rule. The environment is built only from
// settings.llm.agent.shell.envAllow minus credential-looking names. The child
// leads its own process group (POSIX), so timeout, abort, and the end of the
// run kill every process it started; on Windows `taskkill /T` kills the tree.
//
// Windows: the env also carries the base variables programs need to start
// (SystemRoot, TEMP, …). libuv launches only .com/.exe, so a name that
// resolves to a .cmd/.bat (npm, npx, yarn) is refused up front with
// shell_cmd_script_unsupported: running one needs cmd.exe, which re-parses
// the arguments, and shell:true is never used.

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { resolveInside, resolveRoot, errCode } = require('../workspace/pathGuard');
const { settingsFor } = require('../workspace/agentSettings');

const IS_WIN = process.platform === 'win32';
const SECRET_NAME_RE = /KEY|TOKEN|SECRET|PASS/i;
const HARD_MAX_TIMEOUT_MS = 600000;
const MAX_ARGV = 1000;
const MAX_ARG_LEN = 131072;
const CLOSE_GRACE_MS = 500;
const WIN_BASE_ENV = ['SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'];
const WIN_EXEC_EXTS = ['.com', '.exe'];
const WIN_SCRIPT_EXTS = ['.cmd', '.bat'];
const NOT_FOUND_CODES = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'EINVAL']);
const CMD_SCRIPT_HINT = 'Batch scripts (.cmd/.bat) need cmd.exe, which re-parses arguments, so shell.run will not start them. '
  + 'Run the program the script wraps instead, e.g. ["node", "<npm folder>\\node_modules\\npm\\bin\\npm-cli.js", "test"], '
  + 'or use ["cmd.exe", "/d", "/s", "/c", "…"] only when a shell is truly needed.';

/** @returns {string|null} error code, or null when argv is acceptable */
function argvError(argv) {
  if (!Array.isArray(argv)) return 'argv_must_be_array';
  if (!argv.length) return 'argv_empty';
  if (argv.length > MAX_ARGV) return 'argv_too_long';
  for (const a of argv) {
    if (typeof a !== 'string') return 'argv_element_not_string';
    if (a.includes('\0')) return 'argv_nul_byte';
    if (a.length > MAX_ARG_LEN) return 'argv_element_too_long';
  }
  if (!argv[0]) return 'argv_empty';
  return null;
}

/**
 * @param {string[]} envAllow
 * @param {Record<string, string|undefined>} source
 * @param {string} [platform]
 */
function buildEnv(envAllow, source, platform = process.platform) {
  const win = platform === 'win32';
  // Windows variable names are case-insensitive (Path vs PATH).
  const fold = (n) => (win ? n.toUpperCase() : n);
  /** @type {Map<string, string>} */
  const byName = new Map();
  for (const k of Object.keys(source)) if (!byName.has(fold(k))) byName.set(fold(k), k);
  /** @type {Record<string, string>} */
  const env = {};
  const seen = new Set();
  for (const name of win ? [...envAllow, ...WIN_BASE_ENV] : envAllow) {
    if (typeof name !== 'string' || !name || SECRET_NAME_RE.test(name) || seen.has(fold(name))) continue;
    seen.add(fold(name));
    const k = byName.get(fold(name));
    const v = k === undefined ? undefined : source[k];
    if (typeof v === 'string') env[name] = v;
  }
  return env;
}

function statIsFile(p) {
  try { return fs.statSync(p).isFile(); } catch (err) {
    if (NOT_FOUND_CODES.has(errCode(err))) return false;
    throw err;
  }
}

/**
 * Mirrors libuv's Windows program search (cwd, then each PATH entry; a name
 * with an extension is tried as is, then with .com and .exe appended) to find
 * what spawn would run, and also notes the .cmd/.bat it cannot run.
 * @param {string} argv0
 * @param {string} cwd
 * @param {string|undefined} pathEnv
 * @param {(p: string) => boolean} [isFile]
 * @returns {{ resolved: string|null, error?: string }}
 */
function resolveWinCommand(argv0, cwd, pathEnv, isFile = statIsFile) {
  const w = path.win32;
  const ext = w.extname(argv0).toLowerCase();
  if (WIN_SCRIPT_EXTS.includes(ext)) return { error: 'shell_cmd_script_unsupported', resolved: argv0 };
  const hasDir = /[\\/:]/.test(argv0);
  const dirs = hasDir ? [cwd] : [cwd, ...String(pathEnv || '').split(';').map((d) => d.replace(/^"(.*)"$/, '$1')).filter(Boolean)];
  let script = null;
  for (const dir of dirs) {
    const abs = w.resolve(cwd, dir, argv0);
    const tries = (ext ? [abs] : []).concat(WIN_EXEC_EXTS.map((e) => abs + e));
    const hit = tries.find((p) => isFile(p));
    if (hit) return { resolved: hit };
    if (!script) script = WIN_SCRIPT_EXTS.map((e) => abs + e).find((p) => isFile(p)) || null;
  }
  return script ? { error: 'shell_cmd_script_unsupported', resolved: script } : { resolved: null };
}

// Tail buffer: keeps the last `cap` bytes.
function tailBuffer(cap) {
  let parts = [];
  let len = 0;
  let dropped = false;
  return {
    push(chunk) {
      parts.push(chunk); len += chunk.length;
      if (len > cap * 2) { const b = Buffer.concat(parts); parts = [b.subarray(b.length - cap)]; len = cap; dropped = true; }
    },
    text() {
      const b = Buffer.concat(parts);
      if (b.length > cap) dropped = true;
      return b.subarray(Math.max(0, b.length - cap)).toString('utf8');
    },
    get truncated() { return dropped || len > cap; },
  };
}

/** Kill the child's whole process group (POSIX) or process tree (Windows). */
function killTree(child, onError) {
  const pid = child.pid;
  if (!pid) return;
  if (IS_WIN) {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], (err) => {
      if (err && onError) onError(err);
    });
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); }
  catch (err) {
    if (errCode(err) !== 'ESRCH' && onError) onError(err);
  }
}

function run({ argv, cwd, env, timeoutMs, stdin, maxOutputBytes, signal }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const out = tailBuffer(maxOutputBytes);
    const errBuf = tailBuffer(maxOutputBytes);
    const notes = [];
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, detached: !IS_WIN, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, error: 'spawn_failed', detail: (err instanceof Error && err.message) || String(err) });
      return;
    }
    let settled = false, timedOut = false, wasAborted = false, exitCode = null, exitSignal = null, graceTimer = null;
    const recordKillError = (err) => notes.push(`kill failed: ${(err instanceof Error && err.message) || String(err)}`);
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(graceTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      // Background processes the command left behind die with it.
      killTree(child, recordKillError);
      const ok = !timedOut && !wasAborted && exitCode === 0;
      const truncated = out.truncated || errBuf.truncated;
      const res = { ok, exitCode, signal: exitSignal, stdout: out.text(), stderr: errBuf.text(), truncated, durationMs: Date.now() - started, timedOut, aborted: wasAborted, ...extra };
      if (notes.length) res.notes = notes;
      resolve(res);
    };
    const onAbort = () => { wasAborted = true; killTree(child, recordKillError); };
    const timer = setTimeout(() => { timedOut = true; killTree(child, recordKillError); }, timeoutMs);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => errBuf.push(c));
    child.on('error', (err) => {
      const detail = (err instanceof Error && err.message) || String(err);
      if (exitCode === null && exitSignal === null) finish({ ok: false, error: 'spawn_failed', detail });
      else notes.push(`child error: ${detail}`);
    });
    child.on('exit', (code, sig) => {
      exitCode = code; exitSignal = sig;
      // A grandchild holding stdout open would otherwise delay 'close' forever.
      graceTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(); }, CLOSE_GRACE_MS);
    });
    child.on('close', () => finish());
    // EPIPE when the program exits without reading stdin is expected; keep it visible.
    child.stdin.on('error', (err) => notes.push(`stdin: ${(err instanceof Error && err.message) || String(err)}`));
    if (typeof stdin === 'string' && stdin) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

const shellRun = {
  name: 'shell.run',
  description: 'Run ONE program in the workspace. argv is an array: ["git","status"], ["npm","test"]. No shell: pipes, redirects, globs and $(…) are passed literally; wrap in ["sh","-c","…"] only when a shell is truly needed. On Windows .cmd/.bat scripts (npm, npx) cannot be started: run their program, e.g. ["node","…\\npm-cli.js",…]. cwd is relative to the workspace root. Returns {exitCode,signal,stdout,stderr,truncated,durationMs}; output is tail-capped.',
  timeoutMs: HARD_MAX_TIMEOUT_MS + 5000,
  sideEffect: true,
  targetSpaceKey: '__shell__',
  parameters: {
    type: 'object',
    properties: {
      argv: { type: 'array', items: { type: 'string' }, description: 'Program and arguments, one element each.' },
      cwd: { type: 'string', description: 'Working directory relative to the workspace root (default ".").' },
      timeoutMs: { type: 'number', description: 'Kill the command after this many ms (default and max from settings).' },
      stdin: { type: 'string', description: 'Text written to the program\'s stdin.' },
      root: { type: 'string', description: 'Workspace root by path or folder name. Default: the first root.' },
    },
    required: ['argv'],
  },
  handler: async (args, toolCtx, invCtx) => {
    const a = args || {};
    const settings = settingsFor(toolCtx);
    // toolCtx.platform lets tests exercise the Windows path on any OS.
    const platform = (toolCtx && typeof toolCtx.platform === 'string' && toolCtx.platform) || process.platform;
    if (!settings.shell.enabled) return { ok: false, error: 'shell_disabled' };
    const bad = argvError(a.argv);
    if (bad) return { ok: false, error: bad };
    if (a.stdin !== undefined && typeof a.stdin !== 'string') return { ok: false, error: 'stdin_must_be_string' };
    if (typeof a.stdin === 'string' && Buffer.byteLength(a.stdin, 'utf8') > settings.workspace.maxWriteBytes) return { ok: false, error: 'stdin_too_large' };
    let cwd;
    try {
      const root = resolveRoot(settings.workspace.roots, a.root);
      cwd = resolveInside(root, a.cwd === undefined ? '.' : a.cwd).abs;
    } catch (err) {
      return { ok: false, error: (err instanceof Error && err.message) || String(err) };
    }
    const env = buildEnv(settings.shell.envAllow, process.env, platform);
    if (platform === 'win32') {
      const found = resolveWinCommand(a.argv[0], cwd, env.PATH !== undefined ? env.PATH : process.env.PATH);
      if (found.error) return { ok: false, error: found.error, resolved: found.resolved, hint: CMD_SCRIPT_HINT };
    }
    const maxT = Math.min(settings.shell.maxTimeoutMs, HARD_MAX_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(a.timeoutMs) && a.timeoutMs > 0 ? Math.min(Math.floor(a.timeoutMs), maxT) : Math.min(settings.shell.defaultTimeoutMs, maxT);
    return run({
      argv: a.argv, cwd, timeoutMs, stdin: a.stdin,
      env,
      maxOutputBytes: settings.shell.maxOutputBytes,
      signal: invCtx && invCtx.signal,
    });
  },
};

module.exports = [shellRun];
module.exports.argvError = argvError;
module.exports.buildEnv = buildEnv;
module.exports.resolveWinCommand = resolveWinCommand;

// pathGuard — confines agent file access to a configured workspace root.
//
// resolveInside(root, rel, {forWrite}) returns { root, abs, rel } where `abs`
// is the target with every EXISTING component resolved through realpath, and
// throws Error('<code>') when the target is not provably inside the root:
//   invalid_path            non-string, empty, NUL byte, Windows ADS/odd names
//   workspace_root_missing  the root itself does not resolve
//   path_outside_workspace  lexical or symlink escape
//   path_unresolvable       a dangling symlink or a symlink loop sits on the
//                           path, or a directory on it cannot be searched
//   symlink_target          forWrite and the final component is a symlink
// Symlinks inside the root that stay inside the root are allowed for reads.
// The check is time-of-check: callers that write re-verify the parent right
// before the rename (see fsTools).
//
// compileGlob(glob, opts) turns an untrusted glob (from the model or the
// renderer) into a batch matcher whose regex runs in a vm with a timeout:
// picomatch compiles `*a*a*a…b` to nested lazy quantifiers that backtrack
// polynomially, and a match in the main process would freeze the app.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const picomatch = require('picomatch');

const IS_WIN = process.platform === 'win32';

function err(code) { return new Error(code); }

/** Node error code of a caught value, or '' when it carries none. */
function errCode(e) {
  return e && typeof e === 'object' && 'code' in e ? String(/** @type {{ code: unknown }} */ (e).code) : '';
}
const MISSING = new Set(['ENOENT', 'ENOTDIR']);
const UNRESOLVABLE = new Set(['ELOOP', 'EACCES', 'EPERM']);
// Errors on one entry of a directory walk (vanished, unreadable, swapped for
// a file or a link loop) that skip that entry instead of failing the walk.
const WALK_SKIP_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ELOOP']);
const MAX_GLOB_LEN = 256;
const MAX_GLOB_STARS_PER_SEGMENT = 6;

function realpath(p) { return fs.realpathSync.native(p); }

function isInside(realRoot, p) {
  return p === realRoot || p.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep);
}

function lstatOrNull(p) {
  try { return fs.lstatSync(p); }
  catch (e) {
    if (MISSING.has(errCode(e))) return null;
    throw e;
  }
}

// Realpath of the nearest existing ancestor plus the not-yet-existing tail.
function resolveExisting(abs) {
  const tail = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpath(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (e) {
      if (UNRESOLVABLE.has(errCode(e))) throw err('path_unresolvable');
      if (!MISSING.has(errCode(e))) throw e;
      // realpath failed but the entry exists: a symlink whose target is gone.
      // Following it later (mkdir/write) could land anywhere.
      if (lstatOrNull(cur)) throw err('path_unresolvable');
      const parent = path.dirname(cur);
      if (parent === cur) throw err('path_unresolvable');
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function checkRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw err('invalid_path');
  if (IS_WIN) {
    // Alternate data streams (`a.txt:s`) and trailing dots/spaces alias other
    // names and would slip past protectedGlobs.
    const noDrive = rel.replace(/^[A-Za-z]:/, '');
    if (noDrive.includes(':')) throw err('invalid_path');
    if (rel.split(/[\\/]/).some((seg) => seg !== '.' && seg !== '..' && /[. ]$/.test(seg))) throw err('invalid_path');
  }
}

/**
 * @param {string} root an absolute workspace root
 * @param {string} rel path relative to the root (absolute paths inside it are accepted)
 * @param {{ forWrite?: boolean }} [opts]
 * @returns {{ root: string, abs: string, rel: string }}
 */
function resolveInside(root, rel, opts) {
  checkRel(rel);
  if (typeof root !== 'string' || !root || root.includes('\0') || !path.isAbsolute(root)) throw err('workspace_root_missing');
  let realRoot;
  try { realRoot = realpath(root); }
  catch (e) {
    if (MISSING.has(errCode(e))) throw err('workspace_root_missing');
    throw e;
  }
  const lexical = path.resolve(realRoot, rel);
  if (!isInside(realRoot, lexical)) throw err('path_outside_workspace');
  const abs = resolveExisting(lexical);
  if (!isInside(realRoot, abs)) throw err('path_outside_workspace');
  if (opts && opts.forWrite) {
    // `abs` is already resolved; the requested name itself must not be a link.
    const st = lstatOrNull(lexical);
    if (st && st.isSymbolicLink()) throw err('symlink_target');
  }
  const relOut = path.relative(realRoot, abs).split(path.sep).join('/') || '.';
  return { root: realRoot, abs, rel: relOut };
}

/** True when the workspace-relative POSIX path matches a protected glob. */
function isProtected(rel, protectedGlobs) {
  if (typeof rel !== 'string' || !Array.isArray(protectedGlobs) || !protectedGlobs.length) return false;
  const globs = protectedGlobs.filter((g) => typeof g === 'string' && g);
  if (!globs.length) return false;
  // nocase: on case-insensitive volumes `.ENV` and `.env` are the same file.
  return picomatch(globs, { dot: true, nocase: true, nonegate: true })(rel);
}

const GLOB_SCRIPT = new vm.Script(
  '(function(){var re=new RegExp(src,flags);var out=[];'
  + 'for(var i=0;i<paths.length;i++)out.push(re.test(paths[i]));return out;})()',
);

/**
 * Compile an untrusted glob. Throws invalid_glob or glob_too_complex; the
 * returned matcher throws glob_timeout when a batch outlives timeoutMs.
 * Negation (`!x`) is always literal.
 * @param {string} glob
 * @param {{ dot?: boolean, nocase?: boolean }} [opts]
 * @returns {(paths: string[], timeoutMs: number) => boolean[]}
 */
function compileGlob(glob, opts) {
  if (typeof glob !== 'string' || !glob || glob.includes('\0')) throw err('invalid_glob');
  if (glob.length > MAX_GLOB_LEN) throw err('glob_too_complex');
  if (glob.split('/').some((seg) => seg.split('*').length - 1 > MAX_GLOB_STARS_PER_SEGMENT)) throw err('glob_too_complex');
  const re = picomatch.makeRe(glob, { dot: !!(opts && opts.dot), nocase: !!(opts && opts.nocase), nonegate: true });
  const sandbox = vm.createContext({ src: re.source, flags: re.flags, paths: [] });
  return (paths, timeoutMs) => {
    sandbox.paths = paths;
    try { return Array.from(GLOB_SCRIPT.runInContext(sandbox, { timeout: Math.max(1, Math.floor(timeoutMs)) })); }
    catch (e) {
      if (errCode(e) === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw err('glob_timeout');
      throw e;
    }
    finally { sandbox.paths = []; }
  };
}

/**
 * Pick a configured root by index, by exact path, or by basename; the first
 * root when no selector is given.
 * @param {string[]} roots
 * @param {unknown} [selector]
 */
function resolveRoot(roots, selector) {
  const list = Array.isArray(roots) ? roots.filter((r) => typeof r === 'string' && r) : [];
  if (!list.length) throw err('no_workspace_root');
  if (selector === undefined || selector === null || selector === '') return list[0];
  if (typeof selector === 'number') {
    if (Number.isInteger(selector) && selector >= 0 && selector < list.length) return list[selector];
    throw err('unknown_workspace_root');
  }
  if (typeof selector === 'string') {
    const hit = list.find((r) => r === selector) || list.find((r) => path.basename(r) === selector);
    if (hit) return hit;
  }
  throw err('unknown_workspace_root');
}

/** Re-check, immediately before a write lands, that `dir` still resolves inside the root. */
function assertDirInside(realRoot, dir) {
  const real = realpath(dir);
  if (!isInside(realRoot, real)) throw err('path_outside_workspace');
  return real;
}

module.exports = { resolveInside, isProtected, resolveRoot, assertDirInside, isInside, errCode, compileGlob, WALK_SKIP_CODES };

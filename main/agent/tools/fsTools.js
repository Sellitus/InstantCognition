// fsTools — workspace-scoped file tools: fs.list, fs.read, fs.search,
// fs.write, fs.edit, fs.diff.
//
// Every path goes through pathGuard against a root from
// settings.llm.agent.workspace.roots (args.root picks one by index, path or
// basename; default the first). Symlinks are never followed while walking.
// Writes land as temp file + rename in the target's directory, after the
// parent is re-verified inside the root and toolCtx.checkpoints.beforeMutate
// (when the host provides one) has snapshotted the target; afterMutate(dest,
// content) then records what landed. fs.write/fs.edit
// expose previewMutation(args, toolCtx) → { path, diff } for approval cards.
// Regex search runs in a vm context with a per-file timeout, and globs go
// through pathGuard.compileGlob (complexity cap + vm timeout): a pathological
// pattern must not freeze the main process. Walks skip an entry that vanishes
// or cannot be read mid-walk and report how many in `skipped`; only the
// starting directory failing fails the call.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { createTwoFilesPatch } = require('diff');
const { resolveInside, resolveRoot, assertDirInside, errCode, compileGlob, WALK_SKIP_CODES } = require('../workspace/pathGuard');
const { settingsFor } = require('../workspace/agentSettings');

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const SNIFF_BYTES = 8192;
const CHUNK = 65536;
const MAX_REGEX_LEN = 200;
const REGEX_FILE_TIMEOUT_MS = 250;
const SEARCH_BUDGET_MS = 25000;
const MAX_WALK_ENTRIES = 20000;
const MAX_LINE_PREVIEW = 300;
const DIFF_OPTS = { context: 3, timeout: 500 };

class ToolError extends Error {
  constructor(code, extra) { super(code); this.extra = extra || {}; }
}
const fail = (code, extra) => { throw new ToolError(code, extra); };

function wrap(fn) {
  return async (args, toolCtx, invCtx) => {
    try { return await fn(args || {}, toolCtx || {}, invCtx || {}); }
    catch (err) {
      if (err instanceof ToolError) return { ok: false, error: err.message, ...err.extra };
      if (errCode(err) === 'ENOENT') return { ok: false, error: 'file_not_found' };
      return { ok: false, error: (err instanceof Error && err.message) || String(err) };
    }
  };
}

function clampInt(v, min, max, dflt) {
  if (!Number.isFinite(v)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

function aborted(invCtx) { return !!(invCtx && invCtx.signal && invCtx.signal.aborted); }

function workspace(args, toolCtx) {
  const settings = settingsFor(toolCtx);
  return { settings, root: resolveRoot(settings.workspace.roots, args.root) };
}

/** Count a per-entry walk error as skipped; anything else propagates. */
function skipEntry(err, counter) {
  if (!WALK_SKIP_CODES.has(errCode(err))) throw err;
  counter.skipped += 1;
}

const byName = (a, b) => a.name.localeCompare(b.name);

function isBinary(buf) { return buf.subarray(0, SNIFF_BYTES).includes(0); }

function diffOf(rel, before, after) {
  const patch = createTwoFilesPatch(`a/${rel}`, `b/${rel}`, before, after, '', '', DIFF_OPTS);
  return typeof patch === 'string' ? patch : null;
}

// Pure text edit. old_string must occur exactly once unless replace_all.
function applyEdit(text, args) {
  const oldS = args.old_string;
  const newS = args.new_string;
  if (typeof oldS !== 'string' || !oldS) fail('old_string_required');
  if (typeof newS !== 'string') fail('new_string_required');
  if (oldS === newS) fail('edit_noop');
  let count = 0;
  for (let i = text.indexOf(oldS); i !== -1; i = text.indexOf(oldS, i + oldS.length)) count += 1;
  if (!count) fail('edit_no_match');
  if (count > 1 && !args.replace_all) fail('edit_not_unique', { occurrences: count });
  // split/join and slice: String.replace would expand `$&`-style patterns in new_string.
  if (args.replace_all) return { content: text.split(oldS).join(newS), replacements: count };
  const at = text.indexOf(oldS);
  return { content: text.slice(0, at) + newS + text.slice(at + oldS.length), replacements: 1 };
}

function decodeUtf8Strict(buf) {
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) fail('not_utf8');
  return text;
}

// Mutations are serialized so two edits of one file in a parallel batch
// cannot interleave their read-modify-write.
let writeChain = Promise.resolve();
function withWriteLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

async function lstatOrNull(p) {
  try { return await fsp.lstat(p); }
  catch (err) { if (errCode(err) === 'ENOENT') return null; throw err; }
}

async function atomicWrite(target, content, toolCtx) {
  const dir = path.dirname(target.abs);
  await fsp.mkdir(dir, { recursive: true });
  const realDir = assertDirInside(target.root, dir);
  const dest = path.join(realDir, path.basename(target.abs));
  const st = await lstatOrNull(dest);
  if (st && st.isSymbolicLink()) fail('symlink_target');
  if (st && !st.isFile()) fail(st.isDirectory() ? 'is_directory' : 'not_a_regular_file');
  if (toolCtx.checkpoints && typeof toolCtx.checkpoints.beforeMutate === 'function') await toolCtx.checkpoints.beforeMutate(dest);
  const tmp = path.join(realDir, `.${path.basename(dest)}.ic-${crypto.randomBytes(6).toString('hex')}.tmp`);
  // 'wx' = O_CREAT|O_EXCL: never follows or reuses an existing entry.
  const fh = await fsp.open(tmp, 'wx', st ? st.mode & 0o777 : 0o666);
  try {
    try { await fh.writeFile(content, 'utf8'); } finally { await fh.close(); }
    await fsp.rename(tmp, dest);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch((rmErr) => {
      if (err instanceof Error) err.message += `; temp cleanup failed: ${rmErr && rmErr.message}`;
    });
    throw err;
  }
  if (toolCtx.checkpoints && typeof toolCtx.checkpoints.afterMutate === 'function') await toolCtx.checkpoints.afterMutate(dest, content);
  return { created: !st };
}

async function readRegularFile(abs, maxBytes) {
  const st = await fsp.stat(abs);
  if (st.isDirectory()) fail('is_directory');
  if (!st.isFile()) fail('not_a_regular_file');
  if (st.size > maxBytes) fail('file_too_large', { size: st.size, maxBytes });
  const buf = await fsp.readFile(abs);
  if (isBinary(buf)) fail('binary_file');
  return buf;
}

const fsList = {
  name: 'fs.list',
  description: 'List files and directories in the workspace. Paths are relative to the workspace root. Symlinks are reported, never followed; .git and node_modules are listed but not descended.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory relative to the workspace root (default ".").' },
      depth: { type: 'number', description: 'Levels to descend, 1-3 (default 1).' },
      limit: { type: 'number', description: 'Max entries, 1-1000 (default 200).' },
      root: { type: 'string', description: 'Workspace root by path or folder name. Default: the first root.' },
    },
    required: [],
  },
  handler: wrap(async (args, toolCtx, invCtx) => {
    const { root } = workspace(args, toolCtx);
    const t = resolveInside(root, args.path === undefined ? '.' : args.path);
    if (!(await fsp.stat(t.abs)).isDirectory()) fail('not_a_directory');
    const depth = clampInt(args.depth, 1, 3, 1);
    const limit = clampInt(args.limit, 1, 1000, 200);
    const entries = [];
    const counter = { skipped: 0 };
    let truncated = false;
    const walk = async (absDir, relDir, level) => {
      let dirents;
      try { dirents = (await fsp.readdir(absDir, { withFileTypes: true })).sort(byName); }
      catch (err) { if (level === 1) throw err; skipEntry(err, counter); return; }
      for (const d of dirents) {
        if (entries.length >= limit || aborted(invCtx)) { truncated = true; return; }
        const rel = relDir === '.' ? d.name : `${relDir}/${d.name}`;
        const type = d.isSymbolicLink() ? 'symlink' : d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other';
        const entry = { path: rel, type };
        if (type === 'file') {
          try { entry.size = (await fsp.lstat(path.join(absDir, d.name))).size; }
          catch (err) { skipEntry(err, counter); continue; }
        }
        entries.push(entry);
        if (type === 'dir' && level < depth && !SKIP_DIRS.has(d.name)) await walk(path.join(absDir, d.name), rel, level + 1);
      }
    };
    await walk(t.abs, t.rel, 1);
    return { ok: true, root: t.root, path: t.rel, entries, truncated, skipped: counter.skipped };
  }),
};

const fsRead = {
  name: 'fs.read',
  description: 'Read a UTF-8 text file from the workspace by line range. Returns {content,startLine,endLine,hasMore}. Binary files are refused.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace root.' },
      offset: { type: 'number', description: '1-based first line to return (default 1).' },
      limit: { type: 'number', description: 'Max lines to return (default 2000).' },
      root: { type: 'string', description: 'Workspace root by path or folder name. Default: the first root.' },
    },
    required: ['path'],
  },
  handler: wrap(async (args, toolCtx) => {
    const { settings, root } = workspace(args, toolCtx);
    const t = resolveInside(root, args.path);
    const st = await fsp.stat(t.abs);
    if (st.isDirectory()) fail('is_directory');
    if (!st.isFile()) fail('not_a_regular_file');
    const offset = clampInt(args.offset, 1, Number.MAX_SAFE_INTEGER, 1);
    const limit = clampInt(args.limit, 1, 100000, 2000);
    const cap = settings.workspace.maxReadBytes;
    const fh = await fsp.open(t.abs, 'r');
    try {
      const head = Buffer.alloc(Math.min(SNIFF_BYTES, st.size));
      if (head.length) await fh.read(head, 0, head.length, 0);
      if (isBinary(head)) fail('binary_file');
      // Chunked line scan: memory stays bounded by `cap` even for a single
      // multi-megabyte line.
      const buf = Buffer.alloc(CHUNK);
      const out = [];
      let pos = 0, lineNo = 1, cur = [], curLen = 0, outBytes = 0, stopped = false, truncated = false, unread = 0;
      const emit = () => {
        out.push(Buffer.concat(cur).toString('utf8'));
        outBytes += curLen + 1;
        if (out.length >= limit) stopped = true;
        if (outBytes >= cap) { stopped = true; truncated = true; }
      };
      while (!stopped) {
        const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
        if (!bytesRead) break;
        pos += bytesRead;
        const chunk = buf.subarray(0, bytesRead);
        let start = 0;
        while (!stopped) {
          const nl = chunk.indexOf(10, start);
          const end = nl === -1 ? chunk.length : nl;
          if (lineNo >= offset) {
            const take = Math.min(end - start, Math.max(0, cap - curLen));
            if (take > 0) { cur.push(Buffer.from(chunk.subarray(start, start + take))); curLen += take; }
            if (take < end - start) truncated = true;
          }
          if (nl === -1) break;
          if (lineNo >= offset) emit();
          cur = []; curLen = 0; lineNo += 1; start = nl + 1;
          unread = chunk.length - start;
        }
      }
      if (!stopped && curLen > 0 && lineNo >= offset) { unread = 0; emit(); }
      const hasMore = stopped && (unread > 0 || pos < st.size);
      return { ok: true, path: t.rel, content: out.join('\n'), startLine: offset, endLine: offset + out.length - 1, totalBytes: st.size, truncated, hasMore };
    } finally {
      await fh.close();
    }
  }),
};

const REGEX_SCRIPT = new vm.Script(
  '(function(){var re=new RegExp(src,flags);var lines=text.split("\\n");var hits=[];'
  + 'for(var i=0;i<lines.length&&hits.length<cap;i++){if(re.test(lines[i]))hits.push(i);}return hits;})()',
);

function lineMatcher(args) {
  const pattern = args.pattern;
  if (pattern === undefined) return null;
  if (typeof pattern !== 'string' || !pattern) fail('empty_pattern');
  const ignoreCase = !!args.ignoreCase;
  if (!args.regex) {
    const needle = ignoreCase ? pattern.toLowerCase() : pattern;
    return (text, cap) => {
      const hits = [];
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && hits.length < cap; i++) {
        if ((ignoreCase ? lines[i].toLowerCase() : lines[i]).includes(needle)) hits.push(i);
      }
      return hits;
    };
  }
  if (pattern.length > MAX_REGEX_LEN) fail('regex_too_long', { max: MAX_REGEX_LEN });
  const flags = ignoreCase ? 'i' : '';
  try { new RegExp(pattern, flags); } catch (err) { fail('invalid_regex', { detail: (err instanceof Error && err.message) || String(err) }); }
  const sandbox = vm.createContext({ src: pattern, flags, text: '', cap: 0 });
  return (text, cap, timeoutMs) => {
    sandbox.text = text; sandbox.cap = cap;
    try { return Array.from(REGEX_SCRIPT.runInContext(sandbox, { timeout: Math.max(1, timeoutMs) })); }
    catch (err) {
      if (errCode(err) === 'ERR_SCRIPT_EXECUTION_TIMEOUT') fail('regex_timeout');
      throw err;
    }
  };
}

const fsSearch = {
  name: 'fs.search',
  description: 'Find workspace files by glob and/or search their contents. pattern is a literal substring unless regex:true (max 200 chars). Skips .git, node_modules, binary and oversize files. Returns [{path,line,text}] for content matches, [{path}] for glob-only.',
  timeoutMs: SEARCH_BUDGET_MS + 5000,
  parameters: {
    type: 'object',
    properties: {
      glob: { type: 'string', description: 'Path glob relative to `path`, e.g. "src/**/*.js".' },
      pattern: { type: 'string', description: 'Text to find in file contents.' },
      regex: { type: 'boolean', description: 'Treat pattern as a JavaScript regular expression.' },
      ignoreCase: { type: 'boolean', description: 'Case-insensitive content match.' },
      path: { type: 'string', description: 'Directory to search under (default ".").' },
      maxResults: { type: 'number', description: 'Max results, 1-500 (default 100).' },
      root: { type: 'string', description: 'Workspace root by path or folder name. Default: the first root.' },
    },
    required: [],
  },
  handler: wrap(async (args, toolCtx, invCtx) => {
    const { settings, root } = workspace(args, toolCtx);
    const base = resolveInside(root, args.path === undefined ? '.' : args.path);
    if (args.glob !== undefined && (typeof args.glob !== 'string' || !args.glob)) fail('invalid_glob');
    const globMatch = args.glob ? compileGlob(args.glob, { dot: true }) : null;
    const match = lineMatcher(args);
    if (!globMatch && !match) fail('glob_or_pattern_required');
    const maxResults = clampInt(args.maxResults, 1, 500, 100);
    const deadline = Date.now() + SEARCH_BUDGET_MS;
    const budgetLeft = () => Math.min(REGEX_FILE_TIMEOUT_MS, deadline - Date.now());
    const results = [];
    const counter = { skipped: 0 };
    let scanned = 0, visited = 0, truncated = false;
    const stack = [base.abs];
    while (stack.length && !truncated) {
      const dir = stack.pop();
      let dirents;
      try { dirents = (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) => b.name.localeCompare(a.name)); }
      catch (err) { if (dir === base.abs) throw err; skipEntry(err, counter); continue; }
      const files = [];
      for (const d of dirents) {
        if (++visited > MAX_WALK_ENTRIES || Date.now() > deadline || aborted(invCtx)) { truncated = true; break; }
        const abs = path.join(dir, d.name);
        if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) stack.push(abs); continue; }
        if (d.isFile()) files.push(abs);
      }
      // One vm call per directory: a per-file call would pay the watchdog setup 20000 times.
      const keep = globMatch ? globMatch(files.map((abs) => path.relative(base.abs, abs).split(path.sep).join('/')), budgetLeft()) : null;
      for (let i = 0; i < files.length; i++) {
        if (results.length >= maxResults || Date.now() > deadline || aborted(invCtx)) { truncated = true; break; }
        if (keep && !keep[i]) continue;
        const abs = files[i];
        const rel = path.relative(base.root, abs).split(path.sep).join('/');
        if (!match) { results.push({ path: rel }); continue; }
        let buf;
        try {
          const st = await fsp.lstat(abs);
          if (st.size > settings.workspace.maxReadBytes) continue;
          buf = await fsp.readFile(abs);
        } catch (err) { skipEntry(err, counter); continue; }
        if (isBinary(buf)) continue;
        scanned += 1;
        const text = buf.toString('utf8');
        const hits = match(text, maxResults - results.length, budgetLeft());
        if (!hits.length) continue;
        const lines = text.split('\n');
        for (const h of hits) results.push({ path: rel, line: h + 1, text: lines[h].slice(0, MAX_LINE_PREVIEW) });
      }
    }
    return { ok: true, results, filesScanned: scanned, truncated, skipped: counter.skipped };
  }),
};

function previewFor(name) {
  return (args, toolCtx) => {
    const a = args || {};
    let rel = typeof a.path === 'string' ? a.path : '';
    try {
      const { settings, root } = workspace(a, toolCtx || {});
      const t = resolveInside(root, a.path, { forWrite: true });
      rel = t.rel;
      const cap = name === 'fs.write' ? settings.workspace.maxReadBytes : settings.workspace.maxWriteBytes;
      let before = '';
      const st = fs.existsSync(t.abs) ? fs.statSync(t.abs) : null;
      if (st) {
        if (!st.isFile()) fail(st.isDirectory() ? 'is_directory' : 'not_a_regular_file');
        if (st.size > cap) fail('file_too_large');
        const buf = fs.readFileSync(t.abs);
        if (isBinary(buf)) fail('binary_file');
        before = decodeUtf8Strict(buf);
      } else if (name === 'fs.edit') fail('file_not_found');
      const after = name === 'fs.write' ? String(a.content == null ? '' : a.content) : applyEdit(before, a).content;
      const diff = diffOf(t.rel, before, after);
      return diff === null ? { path: rel, diff: null, error: 'diff_too_large' } : { path: rel, diff };
    } catch (err) {
      return { path: rel, diff: null, error: (err instanceof Error && err.message) || String(err) };
    }
  };
}

const fsWrite = {
  name: 'fs.write',
  description: 'Create or overwrite a workspace file with the given UTF-8 content (atomic). Parent directories are created inside the workspace. Prefer fs.edit for changing part of an existing file.',
  sideEffect: true,
  targetSpaceKey: 'path',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace root.' },
      content: { type: 'string', description: 'Full new file content.' },
      root: { type: 'string', description: 'Workspace root by path or folder name. Default: the first root.' },
    },
    required: ['path', 'content'],
  },
  previewMutation: previewFor('fs.write'),
  handler: wrap((args, toolCtx) => withWriteLock(async () => {
    const { settings, root } = workspace(args, toolCtx);
    if (typeof args.content !== 'string') fail('content_must_be_string');
    const bytes = Buffer.byteLength(args.content, 'utf8');
    if (bytes > settings.workspace.maxWriteBytes) fail('content_too_large', { maxWriteBytes: settings.workspace.maxWriteBytes });
    const t = resolveInside(root, args.path, { forWrite: true });
    if (t.abs === t.root) fail('is_directory');
    const { created } = await atomicWrite(t, args.content, toolCtx);
    return { ok: true, path: t.rel, bytes, created };
  })),
};

const fsEdit = {
  name: 'fs.edit',
  description: 'Replace old_string with new_string in a workspace file. old_string must match exactly once unless replace_all is true. Read the file first so old_string is exact, including whitespace.',
  sideEffect: true,
  targetSpaceKey: 'path',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace root.' },
      old_string: { type: 'string', description: 'Exact text to replace.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
      root: { type: 'string', description: 'Workspace root by path or folder name. Default: the first root.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  previewMutation: previewFor('fs.edit'),
  handler: wrap((args, toolCtx) => withWriteLock(async () => {
    const { settings, root } = workspace(args, toolCtx);
    const t = resolveInside(root, args.path, { forWrite: true });
    const text = decodeUtf8Strict(await readRegularFile(t.abs, settings.workspace.maxWriteBytes));
    const { content, replacements } = applyEdit(text, args);
    if (Buffer.byteLength(content, 'utf8') > settings.workspace.maxWriteBytes) fail('content_too_large', { maxWriteBytes: settings.workspace.maxWriteBytes });
    await atomicWrite(t, content, toolCtx);
    return { ok: true, path: t.rel, replacements };
  })),
};

const fsDiff = {
  name: 'fs.diff',
  description: 'Show a unified diff between a workspace file and proposed content, without writing. A missing file diffs as empty.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace root.' },
      against: { type: 'string', description: 'What to compare against; only "content" is supported.' },
      content: { type: 'string', description: 'Proposed content.' },
      root: { type: 'string', description: 'Workspace root by path or folder name. Default: the first root.' },
    },
    required: ['path', 'content'],
  },
  handler: wrap(async (args, toolCtx) => {
    if (args.against !== undefined && args.against !== 'content') fail('unsupported_against');
    const { settings, root } = workspace(args, toolCtx);
    const t = resolveInside(root, args.path);
    const st = await lstatOrNull(t.abs);
    const before = st ? decodeUtf8Strict(await readRegularFile(t.abs, settings.workspace.maxReadBytes)) : '';
    const diff = diffOf(t.rel, before, args.content);
    if (diff === null) fail('diff_too_large');
    return { ok: true, path: t.rel, diff, identical: before === args.content };
  }),
};

module.exports = [fsList, fsRead, fsSearch, fsWrite, fsEdit, fsDiff];
module.exports.applyEdit = applyEdit;

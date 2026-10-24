// instructions — user-authored standing instructions for the agent.
//
// loadInstructions({ agentSettings, workspaceRoot, userDataDir }) reads
//   1. the global file: settings.llm.agent.instructions.globalFile when set
//      (an absolute path the user chose), else {userData}/instructions.md —
//      the file instructions:get-global / set-global edit;
//   2. each of instructions.workspaceFiles (AGENTS.md, INSTRUCTIONS.md) at
//      the session's workspace root, resolved through pathGuard.resolveInside
//      so a symlink (or `..`) pointing outside the root is never read.
// Everything shares one instructions.maxBytes budget; a file that does not fit
// is cut at the budget and marked truncated. A missing file is simply absent.
// A file that escapes the root, is not a regular file (directory, FIFO,
// device), sits in a symlink loop or is unreadable is skipped and reported in
// `skipped`; any other read error propagates.
//
// formatInstructionsBlock(result) renders the system-prompt section.

const fs = require('fs');
const path = require('path');
const { resolveInside, errCode } = require('./pathGuard');
const { DEFAULT_LLM_SETTINGS } = require('../../../shared/llmDefaults');

const D = DEFAULT_LLM_SETTINGS.agent.instructions;
const MAX_WORKSPACE_FILES = 8;
const GUARD_SKIPS = new Set(['path_outside_workspace', 'path_unresolvable', 'invalid_path', 'workspace_root_missing']);

function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

/** @param {any} agentSettings settings.llm.agent as stored */
function normalizeInstructions(agentSettings) {
  const ins = obj(obj(agentSettings).instructions);
  const files = Array.isArray(ins.workspaceFiles) ? ins.workspaceFiles : D.workspaceFiles;
  return {
    enabled: typeof ins.enabled === 'boolean' ? ins.enabled : D.enabled,
    globalFile: typeof ins.globalFile === 'string' ? ins.globalFile.trim() : '',
    workspaceFiles: files.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim()).slice(0, MAX_WORKSPACE_FILES),
    maxBytes: Number.isFinite(ins.maxBytes) && ins.maxBytes > 0 ? Math.floor(ins.maxBytes) : D.maxBytes,
  };
}

/** Global instructions path: the configured file, else {userData}/instructions.md. */
function globalInstructionsPath(globalFile, userDataDir) {
  if (globalFile) {
    if (!path.isAbsolute(globalFile) || globalFile.includes('\0')) throw new Error('instructions_global_file_not_absolute');
    return globalFile;
  }
  return userDataDir ? path.join(userDataDir, 'instructions.md') : null;
}

// `abs` of a workspace file is already realpath-resolved; O_NOFOLLOW closes
// the window where it is swapped for a symlink after that check. O_NONBLOCK
// keeps an open of a FIFO swapped in after the stat from blocking main; the
// fstat below then refuses it.
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);
const NOFOLLOW = fs.constants.O_NOFOLLOW ? OPEN_FLAGS | fs.constants.O_NOFOLLOW : null;
const UNREADABLE = { ELOOP: 'path_unresolvable', EACCES: 'permission_denied', EPERM: 'permission_denied' };

// Reads at most `budget` bytes of a regular file. null when it does not exist.
// Only a regular file is ever opened: open() on a FIFO blocks until a writer
// appears, which would hang every turn start.
function readCapped(abs, budget, noFollow) {
  let fd;
  try {
    const pre = noFollow ? fs.lstatSync(abs) : fs.statSync(abs);
    if (noFollow && pre.isSymbolicLink()) return { skipped: 'symlink_target' };
    if (!pre.isFile()) return { skipped: 'not_a_regular_file' };
    fd = fs.openSync(abs, noFollow && NOFOLLOW !== null ? NOFOLLOW : OPEN_FLAGS);
  } catch (err) {
    const code = errCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    if (noFollow && code === 'ELOOP') return { skipped: 'symlink_target' };
    if (Object.prototype.hasOwnProperty.call(UNREADABLE, code)) return { skipped: UNREADABLE[code] };
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { skipped: 'not_a_regular_file' };
    const want = Math.min(st.size, budget);
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = fs.readSync(fd, buf, got, want - got, got);
      if (!n) break;
      got += n;
    }
    // A cut inside a multi-byte character decodes to U+FFFD; drop it.
    const text = buf.subarray(0, got).toString('utf8').replace(/\uFFFD+$/, '');
    return { text, bytes: got, truncated: st.size > got };
  } finally { fs.closeSync(fd); }
}

/**
 * @param {{ agentSettings?: any, workspaceRoot?: string|null, userDataDir?: string|null }} opts
 * @returns {{ enabled: boolean, maxBytes: number, sources: Array<{ kind: 'global'|'workspace', name: string, path: string, text: string, bytes: number, truncated: boolean }>, skipped: Array<{ name: string, reason: string }> }}
 */
function loadInstructions(opts) {
  const o = opts || {};
  const cfg = normalizeInstructions(o.agentSettings);
  /** @type {Array<{ kind: 'global'|'workspace', name: string, path: string, text: string, bytes: number, truncated: boolean }>} */
  const sources = [];
  /** @type {Array<{ name: string, reason: string }>} */
  const skipped = [];
  if (!cfg.enabled) return { enabled: false, maxBytes: cfg.maxBytes, sources, skipped };
  let budget = cfg.maxBytes;
  const take = (kind, name, abs) => {
    if (budget <= 0) { skipped.push({ name, reason: 'budget_exhausted' }); return; }
    const r = readCapped(abs, budget, kind === 'workspace');
    if (!r) return;
    if ('skipped' in r) { skipped.push({ name, reason: String(r.skipped) }); return; }
    if (!r.text.trim()) return;
    budget -= r.bytes;
    sources.push({ kind, name, path: abs, text: r.text, bytes: r.bytes, truncated: r.truncated });
  };

  const globalPath = globalInstructionsPath(cfg.globalFile, o.userDataDir || null);
  if (globalPath) take('global', path.basename(globalPath), globalPath);

  if (o.workspaceRoot) {
    for (const name of cfg.workspaceFiles) {
      let target;
      try { target = resolveInside(o.workspaceRoot, name); }
      catch (err) {
        const code = err instanceof Error ? err.message : '';
        if (GUARD_SKIPS.has(code)) { skipped.push({ name, reason: code }); continue; }
        throw err;
      }
      take('workspace', target.rel, target.abs);
    }
  }
  return { enabled: true, maxBytes: cfg.maxBytes, sources, skipped };
}

/** System-prompt section for loaded instructions; '' when there are none. */
function formatInstructionsBlock(result) {
  const sources = result && Array.isArray(result.sources) ? result.sources : [];
  if (!sources.length) return '';
  const parts = sources.map((s) => {
    const label = s.kind === 'global' ? 'Global instructions' : `Workspace instructions (${s.name})`;
    return `### ${label}\n${s.text.trim()}${s.truncated ? '\n[truncated at the instructions size limit]' : ''}`;
  });
  return `User instructions — follow these unless the task says otherwise:\n\n${parts.join('\n\n')}`;
}

/** Global-file read for the settings editor: same refusals as a turn start. */
function readInstructionsFile(abs, budget) { return readCapped(abs, budget, false); }

module.exports = { loadInstructions, formatInstructionsBlock, normalizeInstructions, globalInstructionsPath, readInstructionsFile };

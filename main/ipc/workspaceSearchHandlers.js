// workspace:search-files {query, root?} — file-name search over the agent's
// workspace roots for the composer's @ palette. Walks breadth-first from each
// realpath'd root, never follows symlinks, skips .git, node_modules, protected
// files and (counted) unreadable subdirectories, and caps walk and results.
// A query with glob characters is a pathGuard.compileGlob glob on the
// root-relative path, else a case-insensitive substring. A failing root lands
// in rootErrors while the others are still searched.
const { ipcMain } = require('electron');
const fsp = require('fs').promises;
const path = require('path');
const { resolveInside, resolveRoot, isProtected, compileGlob, errCode, WALK_SKIP_CODES } = require('../agent/workspace/pathGuard');
const { readAgentSettings } = require('../agent/workspace/agentSettings');

const MAX_QUERY = 200;
const MAX_RESULTS = 50;
const MAX_WALK_ENTRIES = 20000;
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const GLOB_CHARS = /[*?[\]{}]/;
const GLOB_TIMEOUT_MS = 250;
const msg = (err) => (err instanceof Error && err.message) || String(err);

/** @returns {(rels: string[]) => boolean[]} */
function matcherFor(query) {
  if (!query) return (rels) => rels.map(() => true);
  const glob = GLOB_CHARS.test(query) ? compileGlob(query, { nocase: true, dot: true }) : null;
  if (glob) return (rels) => glob(rels, GLOB_TIMEOUT_MS);
  const q = query.toLowerCase();
  return (rels) => rels.map((rel) => rel.toLowerCase().includes(q));
}

// Basename hits before path-only hits, then shallower/shorter paths.
function rank(query, rel) {
  const base = path.posix.basename(rel).toLowerCase();
  const q = query.toLowerCase();
  const tier = !q ? 0 : base.startsWith(q) ? 0 : base.includes(q) ? 1 : 2;
  return tier * 100000 + rel.length;
}

async function searchRoot(root, match, settings, budget) {
  const realRoot = resolveInside(root, '.').root;
  const hits = [];
  const queue = [realRoot];
  while (queue.length && budget.left > 0) {
    const dir = /** @type {string} */ (queue.shift());
    let dirents;
    try { dirents = (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); }
    catch (err) { if (dir === realRoot || !WALK_SKIP_CODES.has(errCode(err))) throw err; budget.skipped += 1; continue; }
    const files = [];
    for (const d of dirents) {
      if (--budget.left < 0) { budget.truncated = true; break; }
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) queue.push(abs); continue; }
      if (!d.isFile()) continue;
      const rel = path.relative(realRoot, abs).split(path.sep).join('/');
      if (!isProtected(rel, settings.workspace.protectedGlobs)) files.push({ root: realRoot, rootName: path.basename(realRoot), path: rel, name: d.name });
    }
    const keep = match(files.map((f) => f.path));
    files.forEach((f, i) => { if (keep[i]) hits.push(f); });
  }
  if (queue.length) budget.truncated = true;
  return hits;
}

/**
 * @param {{ query?: unknown, root?: unknown }} arg
 * @param {{ get: (k: string, d?: any) => any }} configService
 */
async function searchFiles(arg, configService) {
  const query = arg.query === undefined || arg.query === null ? '' : arg.query;
  if (typeof query !== 'string' || query.length > MAX_QUERY || query.includes('\0')) return { ok: false, error: 'invalid_query' };
  if (arg.root !== undefined && typeof arg.root !== 'string') return { ok: false, error: 'invalid_root' };
  const settings = readAgentSettings(configService);
  if (!settings.workspace.roots.length) return { ok: true, results: [], truncated: false, roots: 0, skipped: 0, rootErrors: [] };
  const roots = arg.root ? [resolveRoot(settings.workspace.roots, arg.root)] : settings.workspace.roots;
  const budget = { left: MAX_WALK_ENTRIES, truncated: false, skipped: 0 };
  const q = query.trim();
  const match = matcherFor(q);
  const hits = [];
  const rootErrors = [];
  // glob_timeout is the query's fault and would fail every root alike.
  for (const root of roots) {
    try { hits.push(...await searchRoot(root, match, settings, budget)); }
    catch (err) { if (msg(err) === 'glob_timeout') throw err; rootErrors.push({ root, error: msg(err) }); }
  }
  if (rootErrors.length === roots.length) return { ok: false, error: rootErrors[0].error, rootErrors };
  hits.sort((a, b) => rank(q, a.path) - rank(q, b.path));
  return { ok: true, results: hits.slice(0, MAX_RESULTS), truncated: budget.truncated || hits.length > MAX_RESULTS, roots: roots.length, skipped: budget.skipped, rootErrors };
}

function register(_mainWindow, services) {
  const { configService } = services || {};
  if (!configService) return;
  ipcMain.handle('workspace:search-files', async (_e, arg) => {
    try { return await searchFiles(arg && typeof arg === 'object' && !Array.isArray(arg) ? arg : {}, configService); }
    catch (err) { return { ok: false, error: msg(err) }; }
  });
}

module.exports = { register, searchFiles };

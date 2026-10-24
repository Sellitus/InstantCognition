// Recursive scanner for MLX model directories and GGUF files.
//
// Given one or more root directories, walk them depth-first and collect:
//   - MLX model directories (contain config.json + tokenizer + weights)
//   - GGUF model files (first shard only when a shard set is present)
//
// Skips hidden directories, node_modules, and symlinks. Gracefully ignores
// unreadable entries. Stops descending into a directory once it is recognized
// as an MLX model (no useful model content nested deeper anyway).

const fs = require('fs');
const path = require('path');
const { parseShard } = require('./modelDetection');

const TOKENIZER_NAMES = ['tokenizer.json', 'tokenizer.model', 'tokenizer_config.json'];
const WEIGHT_RE = /\.(safetensors|npz)$/i;
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.DS_Store']);
const MAX_DEPTH = 8;

function isMlxDir(d) {
  try {
    if (!fs.existsSync(path.join(d, 'config.json'))) return false;
    if (!TOKENIZER_NAMES.some((n) => fs.existsSync(path.join(d, n)))) return false;
    return fs.readdirSync(d).some((f) => WEIGHT_RE.test(f));
  } catch (_) { return false; }
}

// Walk `root` up to MAX_DEPTH and push found models into `out`.
// `want`: { gguf: bool, mlx: bool }
function walk(root, want, out, depth) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (_) { return; /* unreadable */ }

  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIR_NAMES.has(e.name)) continue;
    if (e.isSymbolicLink && e.isSymbolicLink()) continue;
    const full = path.join(root, e.name);

    if (e.isDirectory && e.isDirectory()) {
      if (want.mlx && isMlxDir(full)) { out.mlx.push(full); continue; }
      walk(full, want, out, depth + 1);
    } else if (e.isFile && e.isFile() && want.gguf && e.name.toLowerCase().endsWith('.gguf')) {
      const shard = parseShard(e.name);
      if (shard && shard.index !== 1) continue;
      out.gguf.push(full);
    }
  }
}

// Run a scan with a set of roots per type. Returns {mlx: string[], gguf: string[]}.
// Duplicates across roots are removed.
function scan({ mlxRoots, ggufRoots }) {
  const out = { mlx: [], gguf: [] };
  for (const root of mlxRoots || []) {
    if (root && fs.existsSync(root)) walk(root, { mlx: true, gguf: false }, out, 0);
  }
  for (const root of ggufRoots || []) {
    if (root && fs.existsSync(root)) walk(root, { mlx: false, gguf: true }, out, 0);
  }
  out.mlx = Array.from(new Set(out.mlx));
  out.gguf = Array.from(new Set(out.gguf));
  return out;
}

// Resolve the effective roots from a {mlx, gguf, combined} config object:
//   - mlxRoots  = [mlx, combined].filter(existent)
//   - ggufRoots = [gguf, combined].filter(existent)
// Passing a null/empty value for `combined` means only the type-specific dir
// (if any) is used. Order within the result is stable for deterministic output.
function resolveRoots(dirs) {
  const d = dirs || {};
  const mlxRoots = [];
  const ggufRoots = [];
  if (d.mlx) mlxRoots.push(d.mlx);
  if (d.gguf) ggufRoots.push(d.gguf);
  if (d.combined) { mlxRoots.push(d.combined); ggufRoots.push(d.combined); }
  return { mlxRoots, ggufRoots };
}

module.exports = { scan, resolveRoots, isMlxDir };

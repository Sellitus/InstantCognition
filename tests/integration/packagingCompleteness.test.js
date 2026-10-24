/**
 * packagingCompleteness.test.js — every file the app requires at runtime has to
 * be inside package.json `build.files`.
 *
 * WHY THIS TEST EXISTS
 * `build.files` is a whitelist: anything not listed is dropped from the asar.
 * `shared/` was missing from it, so every electron-builder artifact started and
 * then died on `Cannot find module '../../shared/configDefaults'`. Nothing in
 * the unit suite could see that — the source tree has the file, only the
 * package does not.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const BUILD_FILES = require('../../package.json').build.files;

const ENTRY_FILES = ['main.js', 'preload.js', 'renderer.js'];
const SOURCE_DIRS = ['main', 'renderer', 'shared'];

/** Every .js file under dir, recursively. */
function collectJs(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJs(full, acc);
    else if (entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

/** Relative require targets in a file, resolved to repo-relative paths. */
function relativeRequires(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  const re = /require\(\s*['"](\.[^'"]*)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const resolved = path.resolve(path.dirname(file), m[1]);
    out.push(path.relative(REPO_ROOT, resolved));
  }
  return out;
}

/**
 * The first path segment is what `build.files` entries grant: an entry is
 * either a bare filename, a directory ("shared/") or a glob ("main/**\/*").
 */
function isCovered(relPath) {
  const segment = relPath.split(path.sep)[0];
  return BUILD_FILES.some((pattern) => {
    if (pattern.startsWith('!')) return false;
    // A require of a root module drops the extension ('../../updater'), while
    // build.files names the file ('updater.js').
    if (pattern === relPath || pattern === relPath + '.js' || pattern === segment) return true;
    return pattern.startsWith(segment + '/');
  });
}

describe('packaged app completeness', () => {
  const files = [
    ...ENTRY_FILES.map((f) => path.join(REPO_ROOT, f)),
    ...SOURCE_DIRS.flatMap((d) => collectJs(path.join(REPO_ROOT, d))),
  ];

  test('every runtime source directory is listed in build.files', () => {
    const uncovered = new Set();
    for (const file of files) {
      for (const target of relativeRequires(file)) {
        // Requires that climb out of the repo, or land in node_modules, are
        // not this whitelist's business.
        if (target.startsWith('..') || target.startsWith('node_modules')) continue;
        if (!isCovered(target)) uncovered.add(target.split(path.sep)[0]);
      }
    }
    expect([...uncovered].sort()).toEqual([]);
  });

  test('the entry points themselves are listed', () => {
    for (const entry of ENTRY_FILES) {
      expect(BUILD_FILES).toContain(entry);
    }
  });

  test('every script the app pages load is packaged', () => {
    for (const page of ['index.html', 'launcher.html']) {
      const html = fs.readFileSync(path.join(REPO_ROOT, page), 'utf8');
      const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
      expect(srcs.length).toBeGreaterThan(0);
      for (const src of srcs) expect(BUILD_FILES).toContain(src);
    }
  });

  test('config.json is never packaged', () => {
    // It holds API keys in plaintext; a build machine's copy would ship inside
    // every public binary.
    expect(BUILD_FILES).not.toContain('config.json');
  });
});

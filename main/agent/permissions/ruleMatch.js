// ruleMatch — `tool[:spec]` permission rules (pure).
//
// Tool part: a glob over the DOT-separated tool name, matched segment by
// segment. `*` and `?` never cross a dot; a whole `**` segment spans zero or
// more segments. So `mcp.github.*` matches `mcp.github.create_issue`, `mcp.*`
// does not (use `mcp.**`), and `fs.{read,list}` works (braces must not hold
// dots). `!` is literal everywhere: negated rules are not supported.
//
// Spec part (after the first `:`), interpreted by the CALL's tool:
//   shell.run  whitespace-separated tokens, each a glob over ONE argv element
//              (`*` inside a token may span `/`). Never matched against a
//              joined command string.
//                strict (allow rules): tokens align with argv from argv[0];
//                  lengths must be equal unless the last token is a lone `*`,
//                  which absorbs zero or more trailing args. `git status`
//                  matches exactly ['git','status']; `git *` matches
//                  ['git'] and ['git','push','--force'].
//                lenient (deny/ask rules): over-approximates so wrappers do
//                  not dodge a deny: every rule is a prefix match, tried at
//                  every argv offset, also over argv re-split on whitespace
//                  and on shell separators/substitutions with quotes removed
//                  (`sh -c "x;sudo y"`, `$(sudo y)`, `s""udo`), with the first
//                  token also matched against the element's basename
//                  (`/usr/bin/sudo`) and, on darwin/win32 where command
//                  lookup ignores case, case-insensitively (`SUDO`).
//   fs.*       a workspace-relative POSIX path glob (dot files included);
//              lenient matching is case-insensitive. Any rule whose tool glob
//              can reach an fs tool must use a relative spec, or a deny would
//              parse yet never match.
//   browser.*  a hostname glob (case-insensitive) against args.url, else the
//              current page url. Lenient matching also covers subdomains of a
//              literal host.
// A rule whose spec cannot apply to the call (no argv/path/host) never matches.

const path = require('path');
const picomatch = require('picomatch');
const { knownNames } = require('./toolCatalog');

const MAX_RULE_LEN = 512;
const MAX_TOOL_SEGMENTS = 16;
const MAX_SPEC_TOKENS = 64;
const TOOL_PART_RE = /^[A-Za-z0-9_\-*?{}[\],!@+.]+$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const GLOB_CHARS_RE = /[*?[\]{}()!+@\\]/;

const SEG_OPTS = { bash: true, dot: true, nonegate: true };
const ARGV_OPTS = { bash: true, dot: true, nonegate: true };
const NOCASE_PLATFORMS = new Set(['darwin', 'win32']);
const SHELL_SPLIT_RE = /[\s;&|$()`'"<>]+/;
const SHELL_QUOTE_RE = /["'\\]/g;
const FS_TOOL_NAMES = knownNames().filter((n) => n.startsWith('fs.'));

/** @param {string} toolName */
function specKind(toolName) {
  if (toolName === 'shell.run') return 'argv';
  if (toolName.startsWith('fs.')) return 'path';
  if (toolName.startsWith('browser.')) return 'host';
  return null;
}

function fail(why) { return new Error(`invalid_rule:${why}`); }

/**
 * Parse and compile a rule. Throws Error('invalid_rule:<why>') on bad syntax.
 * @param {unknown} input
 */
function parse(input) {
  if (typeof input !== 'string') throw fail('not_a_string');
  const raw = input.trim();
  if (!raw) throw fail('empty');
  if (raw.length > MAX_RULE_LEN) throw fail('too_long');
  if (CONTROL_RE.test(raw)) throw fail('control_char');
  const idx = raw.indexOf(':');
  const tool = idx < 0 ? raw : raw.slice(0, idx);
  const spec = idx < 0 ? null : raw.slice(idx + 1).trim();
  if (!tool || !TOOL_PART_RE.test(tool)) throw fail('tool_part');
  const toolSegs = tool.split('.');
  if (toolSegs.length > MAX_TOOL_SEGMENTS || toolSegs.some((s) => !s)) throw fail('tool_part');
  if (spec !== null && !spec) throw fail('empty_spec');
  if (spec !== null && !GLOB_CHARS_RE.test(tool) && !specKind(tool)) throw fail('spec_not_supported');

  const segMatchers = toolSegs.map((s) => (s === '**' ? null : picomatch(s, SEG_OPTS)));
  const rule = { raw: spec === null ? tool : `${tool}:${spec}`, tool, spec, toolSegs, segMatchers, tokens: null, argv: null, argv0Nocase: null, path: null, pathLenient: null, host: null };
  if (spec !== null) {
    const tokens = spec.split(/\s+/);
    if (tokens.length > MAX_SPEC_TOKENS) throw fail('spec_too_long');
    rule.tokens = tokens;
    rule.argv = tokens.map((t) => picomatch(t, ARGV_OPTS));
    rule.argv0Nocase = picomatch(tokens[0], { ...ARGV_OPTS, nocase: true });
    if (!spec.startsWith('/') && !spec.includes('\\') && !spec.split('/').includes('..')) {
      rule.path = picomatch(spec, { dot: true, nonegate: true });
      rule.pathLenient = picomatch(spec, { dot: true, nonegate: true, nocase: true });
    }
    rule.host = picomatch(spec, { nocase: true, nonegate: true });
    const kind = GLOB_CHARS_RE.test(tool) ? null : specKind(tool);
    if (!rule.path && (kind === 'path' || FS_TOOL_NAMES.some((n) => matchToolName(rule, n)))) throw fail('path_spec_must_be_relative');
  }
  return Object.freeze(rule);
}

/** @param {string} line @returns {{ ok: true, rule: any } | { ok: false, error: string }} */
function tryParse(line) {
  try { return { ok: true, rule: parse(line) }; }
  catch (err) { return { ok: false, error: (err instanceof Error && err.message) || 'invalid_rule' }; }
}

/** Compile a rule list; invalid entries are reported, never dropped silently. */
function compileList(list) {
  const rules = [];
  const invalid = [];
  for (const line of Array.isArray(list) ? list : []) {
    const r = tryParse(line);
    if (r.ok === false) invalid.push({ rule: String(line), error: r.error });
    else rules.push(r.rule);
  }
  return { rules, invalid };
}

function matchSegs(rule, nameSegs, i, j) {
  if (i === rule.toolSegs.length) return j === nameSegs.length;
  if (rule.toolSegs[i] === '**') {
    for (let k = j; k <= nameSegs.length; k++) if (matchSegs(rule, nameSegs, i + 1, k)) return true;
    return false;
  }
  if (j === nameSegs.length) return false;
  return rule.segMatchers[i](nameSegs[j]) && matchSegs(rule, nameSegs, i + 1, j + 1);
}

function matchToolName(rule, name) {
  if (typeof name !== 'string' || !name) return false;
  return matchSegs(rule, name.split('.'), 0, 0);
}

function baseName(s) {
  return path.win32.basename(path.posix.basename(s)).replace(/\.exe$/i, '');
}

// Token i of the rule against seq[start + i]; `last * absorbs the rest` and
// `prefix` (lenient) both allow trailing elements.
function matchTokensAt(rule, seq, start, { prefix, basenameFirst, nocaseFirst }) {
  const toks = rule.tokens;
  const trailingStar = toks.length > 1 && toks[toks.length - 1] === '*';
  const need = trailingStar ? toks.length - 1 : toks.length;
  const avail = seq.length - start;
  if (avail < need) return false;
  if (!prefix && !trailingStar && avail !== need) return false;
  for (let i = 0; i < need; i++) {
    const el = seq[start + i];
    if (rule.argv[i](el)) continue;
    if (i === 0 && basenameFirst && rule.argv[i](baseName(el))) continue;
    if (i === 0 && nocaseFirst && (rule.argv0Nocase(el) || rule.argv0Nocase(baseName(el)))) continue;
    return false;
  }
  return true;
}

function splitAll(argv, re) { return argv.flatMap((a) => a.split(re).filter(Boolean)); }

function matchArgv(rule, argv, lenient, platform) {
  if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== 'string')) return false;
  if (rule.tokens.length === 1 && rule.tokens[0] === '*') return true;
  if (!lenient) return matchTokensAt(rule, argv, 0, { prefix: false, basenameFirst: false, nocaseFirst: false });
  const opts = { prefix: true, basenameFirst: true, nocaseFirst: NOCASE_PLATFORMS.has(platform) };
  const seqs = [
    argv,
    splitAll(argv, /\s+/),
    splitAll(argv, SHELL_SPLIT_RE),
    splitAll(argv.map((a) => a.replace(SHELL_QUOTE_RE, '')), SHELL_SPLIT_RE),
  ];
  for (const seq of seqs) {
    for (let s = 0; s < seq.length; s++) {
      if (matchTokensAt(rule, seq, s, opts)) return true;
    }
  }
  return false;
}

function matchHost(rule, host, lenient) {
  if (!host) return false;
  if (rule.host(host)) return true;
  if (!lenient || GLOB_CHARS_RE.test(rule.spec)) return false;
  const lit = rule.spec.toLowerCase().replace(/^\.+/, '');
  return !!lit && (host === lit || host.endsWith(`.${lit}`));
}

/**
 * @param {any} rule parsed rule
 * @param {string} name tool name of the call
 * @param {{ argv?: string[]|null, path?: string|null, host?: string }} facts
 * @param {{ lenient?: boolean, platform?: string }} [opts] platform defaults to process.platform
 */
function matches(rule, name, facts, opts) {
  if (!matchToolName(rule, name)) return false;
  if (rule.spec === null) return true;
  const lenient = !!(opts && opts.lenient);
  const f = facts || {};
  const kind = specKind(name);
  if (kind === 'argv') return matchArgv(rule, f.argv, lenient, (opts && opts.platform) || process.platform);
  if (kind === 'path') {
    if (typeof f.path !== 'string' || !rule.path) return false;
    return lenient ? rule.pathLenient(f.path) : rule.path(f.path);
  }
  if (kind === 'host') return matchHost(rule, typeof f.host === 'string' ? f.host.toLowerCase() : '', lenient);
  return false;
}

/** First rule in `rules` matching the call, or null. */
function firstMatch(rules, name, facts, opts) {
  for (const r of rules || []) if (matches(r, name, facts, opts)) return r;
  return null;
}

/**
 * Whether a path rule could match `base` or a path below it, ignoring case.
 * Over-approximates: true unless the glob's literal prefix or its fixed depth
 * (no `**` or braces) rules the whole subtree out.
 * @param {any} rule parsed rule @param {string} base workspace-relative dir
 */
function pathReachesUnder(rule, base) {
  if (rule.spec === null) return true;
  if (!rule.path || typeof base !== 'string') return false;
  if (base === '.' || base === '') return true;
  const b = base.toLowerCase();
  const g = picomatch.scan(rule.spec).base.toLowerCase();
  if (g && g !== b && !g.startsWith(`${b}/`) && !b.startsWith(`${g}/`)) return false;
  if (rule.spec.includes('**') || rule.spec.includes('{')) return true;
  return rule.spec.split('/').length > b.split('/').length;
}

/** Hostname used for browser.* specs: args.url wins, else the page url. */
function hostFor(args, pageUrl) {
  for (const u of [args && args.url, pageUrl]) {
    if (typeof u !== 'string' || !u) continue;
    try {
      const parsed = new URL(u);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.hostname.toLowerCase().replace(/\.+$/, '');
    } catch (_) { continue; } // an unparseable url carries no host; try the next source
  }
  return '';
}

function plain(tok) { return typeof tok === 'string' && tok.length > 0 && !/\s/.test(tok) && !GLOB_CHARS_RE.test(tok) && !tok.includes(':'); }

/**
 * Narrowest rule that would have allowed this call, or null when none can be
 * expressed. Shell rules are only ever the exact, fully plain argv: a
 * `head *` rule would also allow `python3 -c <anything>` or `rm -rf <anything>`.
 * MCP and host-less browser calls get the exact tool name or nothing.
 */
function suggest(name, facts) {
  const rule = suggestRaw(name, facts);
  return rule && tryParse(rule).ok ? rule : null;
}

function suggestRaw(name, facts) {
  if (typeof name !== 'string' || !name) return null;
  const segs = name.split('.');
  if (segs.some((s) => !plain(s))) return null;
  const f = facts || {};
  const kind = specKind(name);
  if (kind === 'argv') {
    const argv = Array.isArray(f.argv) ? f.argv : [];
    return argv.length && argv.every(plain) ? `${name}:${argv.join(' ')}` : null;
  }
  if (kind === 'path') {
    if (typeof f.path !== 'string' || !f.path || f.path === '.') return null;
    if (f.path.split('/').some((s) => !plain(s))) return null;
    const dir = path.posix.dirname(f.path);
    return dir === '.' ? `${name}:${f.path}` : `${name}:${dir}/**`;
  }
  if (kind === 'host') return f.host && plain(f.host) ? `${name}:${f.host}` : null;
  return name;
}

module.exports = { parse, tryParse, compileList, matches, firstMatch, matchToolName, hostFor, suggest, specKind, pathReachesUnder };

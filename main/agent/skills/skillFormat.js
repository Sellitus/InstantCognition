// skillFormat — parse and serialize SKILL.md (YAML frontmatter + markdown body).
//
// Accepts the Claude Code / Codex skill layout. Frontmatter fields:
//   name           required, ^[a-z0-9-]{1,64}$ (it is also the directory name)
//   description    required, what the skill does and when to use it
//   allowed-tools  optional, comma/space separated string or a YAML list
//   when, triggers optional auto-trigger hints (triggers: phrases)
// Any other key is kept verbatim in `extra` so a round trip never loses it.
//
// allowed-tools entries written for Claude Code (Read, Bash(git:*), …) are
// mapped to this app's `tool[:spec]` rule strings (ruleMatch syntax); this
// app's own names pass through. An entry that cannot be mapped becomes a
// warning and grants nothing. The rule list only ever narrows the tools the
// model is offered; permission decisions stay with the permission engine.

const YAML = require('yaml');
const ruleMatch = require('../permissions/ruleMatch');
const { classify } = require('../permissions/toolCatalog');

const NAME_RE = /^[a-z0-9-]{1,64}$/;
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_DESCRIPTION = 1024;
const MAX_TRIGGERS = 32;
const KNOWN_KEYS = new Set(['name', 'description', 'allowed-tools', 'when', 'triggers']);
const YAML_OPTS = { schema: 'core', uniqueKeys: true, maxAliasCount: 50, prettyErrors: false };

const CLAUDE_TOOL_MAP = Object.freeze({
  Read: ['fs.read'],
  Write: ['fs.write'],
  Edit: ['fs.edit'],
  MultiEdit: ['fs.edit'],
  Glob: ['fs.search'],
  Grep: ['fs.search'],
  LS: ['fs.list'],
  Bash: ['shell.run'],
  WebSearch: ['browser.web_search'],
  WebFetch: ['browser.open_tab', 'browser.read_tab'],
  TodoWrite: ['agent.todo_write'],
  Task: ['agent.spawn_subagent'],
});
const PATH_SPEC_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS']);

/** Split an allowed-tools string on commas/whitespace outside parentheses. */
function splitToolList(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(text)) {
    if (ch === '(') depth += 1;
    if (ch === ')' && depth > 0) depth -= 1;
    if (depth === 0 && (ch === ',' || /\s/.test(ch))) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Claude Code spec → this app's rule spec, or null when it has no faithful equivalent.
function translateSpec(tool, spec) {
  if (tool === 'Bash') {
    const prefix = /^([\s\S]*?):\*$/.exec(spec);
    const tokens = (prefix ? prefix[1] : spec).trim();
    if (!tokens) return null;
    return prefix ? `${tokens} *` : tokens;
  }
  if (PATH_SPEC_TOOLS.has(tool)) {
    const rel = spec.replace(/^\.\//, '');
    if (!rel || rel.startsWith('/') || rel.startsWith('~') || rel.includes('\\')) return null;
    return rel;
  }
  if (tool === 'WebFetch') {
    const domain = /^domain:([A-Za-z0-9.*-]+)$/.exec(spec);
    return domain ? domain[1] : null;
  }
  return null;
}

function validRules(candidates) {
  const rules = [];
  for (const c of candidates) {
    const r = ruleMatch.tryParse(c);
    if (r.ok === false) return null;
    rules.push(r.rule.raw);
  }
  return rules;
}

/** Map one allowed-tools entry → { rules: string[], warning?: string }. */
function mapToolEntry(entry) {
  const s = String(entry).trim();
  if (!s) return { rules: [] };
  const unmapped = { rules: [], warning: `allowed-tools: "${s}" has no equivalent here and was ignored` };
  const mcp = /^mcp__([A-Za-z0-9_-]+?)(?:__([A-Za-z0-9_-]+))?$/.exec(s);
  if (mcp) {
    const rules = validRules([`mcp.${mcp[1]}.${mcp[2] || '*'}`]);
    return rules ? { rules } : unmapped;
  }
  const claude = /^([A-Za-z]+)(?:\(([\s\S]*)\))?$/.exec(s);
  if (claude && Object.prototype.hasOwnProperty.call(CLAUDE_TOOL_MAP, claude[1])) {
    const targets = CLAUDE_TOOL_MAP[claude[1]];
    const spec = claude[2] === undefined ? '' : claude[2].trim();
    if (!spec || spec === '*') return { rules: targets.slice() };
    const ours = translateSpec(claude[1], spec);
    const rules = ours ? validRules(targets.map((t) => `${t}:${ours}`)) : null;
    return rules ? { rules } : unmapped;
  }
  if (s.includes('.')) {
    const r = ruleMatch.tryParse(s);
    if (r.ok === false) return unmapped;
    const isGlob = /[*?{[]/.test(r.rule.tool);
    if (!isGlob && classify(r.rule.tool).cls === 'unknown') return unmapped;
    return { rules: [r.rule.raw] };
  }
  return unmapped;
}

/** @returns {{ raw: string[]|null, rules: string[]|null, warnings: string[] }} */
function mapAllowedTools(value) {
  if (value === undefined || value === null) return { raw: null, rules: null, warnings: [] };
  const warnings = [];
  let raw;
  if (Array.isArray(value)) {
    raw = [];
    for (const v of value) {
      if (typeof v === 'string') raw.push(...splitToolList(v));
      else warnings.push(`allowed-tools: non-text entry ${JSON.stringify(v)} was ignored`);
    }
  } else if (typeof value === 'string') raw = splitToolList(value);
  else return { raw: [], rules: [], warnings: ['allowed-tools must be a list or a comma-separated string; no tools are allowed'] };
  const rules = [];
  for (const entry of raw) {
    const m = mapToolEntry(entry);
    if (m.warning) warnings.push(m.warning);
    for (const r of m.rules) if (!rules.includes(r)) rules.push(r);
  }
  return { raw, rules, warnings };
}

/**
 * Predicate over tool names for a mapped rule list, or null when the skill
 * does not restrict tools. Meta tools (agent.done, agent.ask_user, …) always
 * stay so a narrowed run can still finish or ask the user.
 * @param {string[]|null|undefined} rules
 */
function toolNamePredicate(rules) {
  if (!Array.isArray(rules)) return null;
  const compiled = ruleMatch.compileList(rules).rules;
  return (name) => classify(name).cls === 'meta' || compiled.some((r) => ruleMatch.matchToolName(r, name));
}

function readTriggers(value, warnings) {
  if (value === undefined || value === null) return [];
  const list = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : null;
  if (!list) { warnings.push('triggers must be a list of phrases; ignored'); return []; }
  const out = list.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim());
  if (out.length !== list.length) warnings.push('triggers: non-text entries were ignored');
  return out.slice(0, MAX_TRIGGERS);
}

function splitFrontmatter(text) {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) return null;
  const end = src.indexOf('\n---', 3);
  if (end < 0) return null;
  const after = src.slice(end + 4);
  if (after && !after.startsWith('\n')) return null;
  return { yaml: src.slice(4, end + 1), body: after.replace(/^\n/, '') };
}

/**
 * @param {unknown} text SKILL.md contents
 * @returns {{ ok: true, skill: any, warnings: string[] } | { ok: false, error: string }}
 */
function parseSkill(text) {
  if (typeof text !== 'string') return { ok: false, error: 'not_text' };
  if (Buffer.byteLength(text, 'utf8') > MAX_SKILL_BYTES) return { ok: false, error: 'too_large' };
  if (text.includes('\u0000')) return { ok: false, error: 'binary_content' };
  const parts = splitFrontmatter(text);
  if (!parts) return { ok: false, error: 'missing_frontmatter' };
  let fm;
  try { fm = YAML.parse(parts.yaml, YAML_OPTS); }
  catch (err) { return { ok: false, error: `frontmatter_yaml: ${(err instanceof Error && err.message.split('\n')[0]) || 'parse failed'}` }; }
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) return { ok: false, error: 'frontmatter_not_mapping' };
  if (typeof fm.name !== 'string' || !NAME_RE.test(fm.name)) return { ok: false, error: 'invalid_name' };
  if (typeof fm.description !== 'string' || !fm.description.trim()) return { ok: false, error: 'missing_description' };
  if (fm.description.length > MAX_DESCRIPTION) return { ok: false, error: 'description_too_long' };
  const tools = mapAllowedTools(fm['allowed-tools']);
  const warnings = tools.warnings.slice();
  if (fm.when !== undefined && typeof fm.when !== 'string') warnings.push('when must be text; ignored');
  const extra = {};
  for (const [k, v] of Object.entries(fm)) if (!KNOWN_KEYS.has(k)) extra[k] = v;
  return {
    ok: true,
    warnings,
    skill: {
      name: fm.name,
      description: fm.description.trim(),
      allowedTools: tools.raw,
      tools: tools.rules,
      when: typeof fm.when === 'string' ? fm.when.trim() : '',
      triggers: readTriggers(fm.triggers, warnings),
      body: parts.body.trim(),
      extra,
    },
  };
}

/**
 * Serialize { name, description, body, allowedTools?, when?, triggers?, extra? }.
 * Throws on an invalid name or description so a bad skill is never written.
 */
function serializeSkill(skill) {
  const s = skill || {};
  if (typeof s.name !== 'string' || !NAME_RE.test(s.name)) throw new Error('invalid_name');
  if (typeof s.description !== 'string' || !s.description.trim()) throw new Error('missing_description');
  const fm = { name: s.name, description: s.description.trim() };
  if (Array.isArray(s.allowedTools)) fm['allowed-tools'] = s.allowedTools.join(', ');
  if (typeof s.when === 'string' && s.when.trim()) fm.when = s.when.trim();
  if (Array.isArray(s.triggers) && s.triggers.length) fm.triggers = s.triggers.slice();
  for (const [k, v] of Object.entries(s.extra || {})) if (!KNOWN_KEYS.has(k)) fm[k] = v;
  const body = typeof s.body === 'string' ? s.body.trim() : '';
  const out = `---\n${YAML.stringify(fm, { lineWidth: 0 })}---\n\n${body}\n`;
  if (Buffer.byteLength(out, 'utf8') > MAX_SKILL_BYTES) throw new Error('too_large');
  return out;
}

/** Lowercase slug that satisfies NAME_RE, or '' when nothing usable remains. */
function slugifyName(raw) {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '');
}

module.exports = {
  NAME_RE, MAX_SKILL_BYTES, CLAUDE_TOOL_MAP,
  parseSkill, serializeSkill, mapAllowedTools, mapToolEntry, splitToolList, toolNamePredicate, slugifyName,
};

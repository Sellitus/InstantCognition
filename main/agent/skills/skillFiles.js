// skillFiles — filesystem side of the skill store: {baseDir}/<name>/SKILL.md
// plus any resource files that came with an imported skill.
//
// Every write lands in a hidden staging path first and is renamed into place,
// so a crash or a failed copy never leaves a half-written skill behind. Copies
// from another tool's skill folder skip nested symlinks (a link could point at
// ~/.ssh) and stop at a file-count and byte cap.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseSkill, serializeSkill, slugifyName, NAME_RE, MAX_SKILL_BYTES } = require('./skillFormat');

const SKILL_FILE = 'SKILL.md';
const MAX_COPY_FILES = 200;
const MAX_COPY_BYTES = 10 * 1024 * 1024;
const LEGACY_SUFFIX = '.skill.json';
const MIGRATED_SUFFIX = '.migrated';

const stagingPath = (baseDir) => path.join(baseDir, `.staging-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);

/**
 * Read and parse <dir>/SKILL.md.
 * @param {string} dir
 * @returns {{ ok: true, skill: any, warnings: string[] } | { ok: false, error: string }}
 */
function readSkillDir(dir) {
  const file = path.join(dir, SKILL_FILE);
  const st = fs.statSync(file);
  if (st.size > MAX_SKILL_BYTES) return { ok: false, error: 'too_large' };
  return parseSkill(fs.readFileSync(file, 'utf8'));
}

/** Move a fully written staging dir to baseDir/<name>; 'exists' unless overwrite. */
function commitStaged(baseDir, staged, name, overwrite) {
  const dest = path.join(baseDir, name);
  if (fs.existsSync(dest)) {
    if (!overwrite) { fs.rmSync(staged, { recursive: true, force: true }); return { ok: false, error: 'exists' }; }
    const old = stagingPath(baseDir);
    fs.renameSync(dest, old);
    fs.renameSync(staged, dest);
    fs.rmSync(old, { recursive: true, force: true });
  } else fs.renameSync(staged, dest);
  return { ok: true, dir: dest };
}

/** Serialize and write one skill; the existing dir's resource files are kept on overwrite. */
function writeSkill(baseDir, skill, { overwrite = false } = {}) {
  const markdown = serializeSkill(skill);
  const dest = path.join(baseDir, skill.name);
  if (overwrite && fs.existsSync(dest)) {
    const tmp = path.join(dest, `.${SKILL_FILE}.${crypto.randomBytes(6).toString('hex')}`);
    fs.writeFileSync(tmp, markdown, { flag: 'wx' });
    fs.renameSync(tmp, path.join(dest, SKILL_FILE));
    return { ok: true, dir: dest };
  }
  const staged = stagingPath(baseDir);
  fs.mkdirSync(staged);
  fs.writeFileSync(path.join(staged, SKILL_FILE), markdown);
  return commitStaged(baseDir, staged, skill.name, overwrite);
}

function copyTree(src, dest, budget, warnings, rel) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${ent.name}` : ent.name;
    const from = path.join(src, ent.name);
    if (ent.isSymbolicLink()) { warnings.push(`Skipped symbolic link ${relPath}`); continue; }
    if (ent.isDirectory()) { copyTree(from, path.join(dest, ent.name), budget, warnings, relPath); continue; }
    if (!ent.isFile()) { warnings.push(`Skipped special file ${relPath}`); continue; }
    budget.files += 1;
    budget.bytes += fs.statSync(from).size;
    if (budget.files > MAX_COPY_FILES) throw new Error('too_many_files');
    if (budget.bytes > MAX_COPY_BYTES) throw new Error('too_large');
    fs.copyFileSync(from, path.join(dest, ent.name), fs.constants.COPYFILE_EXCL);
  }
}

/**
 * Copy an external skill folder (Claude Code / Codex layout) into baseDir.
 * @returns {{ ok: boolean, name?: string, error?: string, warnings: string[] }}
 */
function importSkillDir(baseDir, srcDir, { overwrite = false } = {}) {
  const parsed = readSkillDir(srcDir);
  if (parsed.ok === false) return { ok: false, error: parsed.error, warnings: [] };
  const warnings = parsed.warnings.slice();
  const staged = stagingPath(baseDir);
  try { copyTree(srcDir, staged, { files: 0, bytes: 0 }, warnings, ''); }
  catch (err) {
    fs.rmSync(staged, { recursive: true, force: true });
    throw err;
  }
  const res = commitStaged(baseDir, staged, parsed.skill.name, overwrite);
  return { ...res, name: parsed.skill.name, warnings };
}

/** Legacy *.skill.json → skill fields. Throws when nothing usable remains. */
function legacyToSkill(raw, fileName) {
  if (!raw || typeof raw !== 'object') throw new Error('not_an_object');
  const name = slugifyName(raw.name || fileName.slice(0, -LEGACY_SUFFIX.length));
  const task = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (!NAME_RE.test(name) || !task) throw new Error('missing_name_or_description');
  const body = [task];
  if (typeof raw.startUrl === 'string' && raw.startUrl) body.push(`Start at ${raw.startUrl}.`);
  if (typeof raw.systemPromptAppend === 'string' && raw.systemPromptAppend.trim()) body.push(raw.systemPromptAppend.trim());
  if (Array.isArray(raw.inputs) && raw.inputs.length) {
    body.push(['Inputs (ask the user for any that are missing):', ...raw.inputs
      .filter((i) => i && typeof i.name === 'string')
      .map((i) => `- ${i.name}${i.description ? `: ${i.description}` : ''}${i.required ? ' (required)' : ''}`)].join('\n'));
  }
  const extra = {};
  if (typeof raw.qualityMode === 'string') extra['quality-mode'] = raw.qualityMode;
  if (raw.qualityOverride && typeof raw.qualityOverride === 'object') extra['quality-override'] = raw.qualityOverride;
  return {
    name,
    description: task.split('\n')[0].slice(0, 1024),
    body: body.join('\n\n'),
    allowedTools: Array.isArray(raw.toolsAllowlist) ? raw.toolsAllowlist.filter((t) => typeof t === 'string') : undefined,
    extra,
  };
}

/**
 * Convert every {baseDir}/*.skill.json once. A converted file is renamed to
 * *.skill.json.migrated, so a second run finds nothing to do. A file that
 * fails stays in place and is reported every run until the user fixes it.
 */
function migrateLegacy(baseDir) {
  const result = { migrated: [], errors: [] };
  for (const f of fs.readdirSync(baseDir).filter((x) => x.endsWith(LEGACY_SUFFIX))) {
    const file = path.join(baseDir, f);
    try {
      const skill = legacyToSkill(JSON.parse(fs.readFileSync(file, 'utf8')), f);
      const w = writeSkill(baseDir, skill);
      if (w.ok === false && w.error !== 'exists') throw new Error(w.error);
      fs.renameSync(file, file + MIGRATED_SUFFIX);
      result.migrated.push({ file: f, name: skill.name, existed: w.ok === false });
    } catch (err) {
      result.errors.push({ file: f, error: (err instanceof Error && err.message) || String(err) });
    }
  }
  return result;
}

module.exports = { SKILL_FILE, MAX_COPY_FILES, readSkillDir, writeSkill, importSkillDir, migrateLegacy, legacyToSkill };

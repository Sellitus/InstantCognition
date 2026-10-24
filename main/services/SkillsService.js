// SkillsService — the user's skills: {userData}/skills/<name>/SKILL.md folders
// in the Claude Code / Codex format (see main/agent/skills/skillFormat.js).
//
// Sources: written here (settings page, "Create skill from this chat"),
// installed from an https URL, or copy-imported on request from
// ~/.claude/skills and ~/.codex/skills (never automatically). Legacy
// *.skill.json files are converted once on first use.
//
// allowed-tools only NARROWS the tools offered to the model while a skill is
// active (toolFilterFor). It never grants permission: every call still goes
// through the permission engine like any other.
//
// Per-skill enabled state lives in {baseDir}/.state.json so an imported
// SKILL.md stays byte-identical to its source.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { NAME_RE, parseSkill, toolNamePredicate } = require('../agent/skills/skillFormat');
const { readSkillDir, writeSkill, importSkillDir, migrateLegacy } = require('../agent/skills/skillFiles');
const { matchSkills, readSkillSettings } = require('../agent/skills/skillMatcher');
const { fetchSkillFromUrl } = require('../agent/skills/skillInstall');
const { draftSkill } = require('../agent/skills/skillDraft');
const { errMsg } = require('../../shared/errMsg');
const { isMode, resolveMode, withOverride, tightenOverride } = require('./QualityModeService');

const STATE_FILE = '.state.json';
const IMPORT_SOURCES = Object.freeze({ claude: ['.claude', 'skills'], codex: ['.codex', 'skills'] });

function summarize(skill, enabled, warnings) {
  return {
    name: skill.name, description: skill.description, when: skill.when, triggers: skill.triggers,
    allowedTools: skill.allowedTools, tools: skill.tools, warnings, enabled,
  };
}

class SkillsService {
  constructor() {
    this._baseDir = null;
    this._homeDir = null;
    this._agentService = null;
    this._configService = null;
    this._llm = null;
    this._qualityMode = null;
    this._migration = null;
  }

  /**
   * @param {{ agentService?: any, configService?: any, llm?: any, baseDir?: string, homeDir?: string, qualityMode?: any }} deps
   */
  bind({ agentService, configService, llm, baseDir, homeDir, qualityMode } = {}) {
    this._agentService = agentService || null;
    this._qualityMode = qualityMode || null;
    this._configService = configService || null;
    this._llm = llm || null;
    this._homeDir = homeDir || os.homedir();
    this._baseDir = baseDir || path.join(require('electron').app.getPath('userData'), 'skills');
    this._migration = null;
  }

  // SKILL.md quality keys are untrusted (skills install from URLs): a known
  // quality-mode contributes only the parts of that mode stricter than the
  // user's active one, then quality-override tightens the result further.
  _qualityOverride(extra) {
    const qm = this._qualityMode || require('./QualityModeService');
    const active = qm.resolve();
    const mode = extra && isMode(extra['quality-mode']) ? resolveMode(extra['quality-mode']) : null;
    const fromMode = mode ? tightenOverride(active, mode) : {};
    const fromOverride = tightenOverride(withOverride(active, fromMode), extra ? extra['quality-override'] : null);
    const out = { ...fromMode, ...fromOverride };
    if (fromMode.budget || fromOverride.budget) out.budget = { ...fromMode.budget, ...fromOverride.budget };
    return Object.keys(out).length ? out : null;
  }

  _config() {
    return this._configService || require('./ConfigService');
  }

  // Creates the store and runs the one-time legacy migration; errors reach the caller.
  _ready() {
    if (!this._baseDir) throw new Error('skills_not_bound');
    if (!this._migration) {
      fs.mkdirSync(this._baseDir, { recursive: true });
      this._migration = migrateLegacy(this._baseDir);
    }
    return this._baseDir;
  }

  _readState() {
    const file = path.join(this._ready(), STATE_FILE);
    if (!fs.existsSync(file)) return { disabled: [] };
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { disabled: Array.isArray(raw && raw.disabled) ? raw.disabled.filter((n) => typeof n === 'string') : [] };
  }

  _writeState(state) {
    const file = path.join(this._ready(), STATE_FILE);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  }

  /** Every installed skill plus folders that failed to parse (never hidden). */
  list() {
    const base = this._ready();
    const disabled = new Set(this._readState().disabled);
    const skills = [];
    const errors = [];
    for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      let parsed;
      try { parsed = readSkillDir(path.join(base, ent.name)); }
      catch (err) { errors.push({ dir: ent.name, error: errMsg(err) }); continue; }
      if (parsed.ok === false) errors.push({ dir: ent.name, error: parsed.error });
      else if (parsed.skill.name !== ent.name) errors.push({ dir: ent.name, error: `name_mismatch:${parsed.skill.name}` });
      else skills.push(summarize(parsed.skill, !disabled.has(ent.name), parsed.warnings));
    }
    skills.sort((a, b) => a.name.localeCompare(b.name));
    const migration = /** @type {{ migrated: any[], errors: any[] }} */ (this._migration);
    return { ok: true, skills, errors, migration: { migrated: migration.migrated, errors: migration.errors } };
  }

  get(name) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) return { ok: false, error: 'invalid_name' };
    const dir = path.join(this._ready(), name);
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) return { ok: false, error: 'not_found' };
    const parsed = readSkillDir(dir);
    if (parsed.ok === false) return { ok: false, error: parsed.error };
    const enabled = !this._readState().disabled.includes(name);
    return { ok: true, skill: { ...summarize(parsed.skill, enabled, parsed.warnings), body: parsed.skill.body, extra: parsed.skill.extra } };
  }

  /**
   * Save from raw SKILL.md text ({ markdown }) or fields ({ name, description, body, allowedTools?, when?, triggers? }).
   * @param {any} input
   * @param {{ overwrite?: boolean }} [opts]
   */
  save(input, { overwrite = false } = {}) {
    if (!input || typeof input !== 'object') return { ok: false, error: 'invalid_skill' };
    let skill;
    if (typeof input.markdown === 'string') {
      const parsed = parseSkill(input.markdown);
      if (parsed.ok === false) return parsed;
      skill = parsed.skill;
    } else skill = input;
    if (typeof skill.name !== 'string' || !NAME_RE.test(skill.name)) return { ok: false, error: 'invalid_name' };
    try {
      const res = writeSkill(this._ready(), skill, { overwrite });
      if (res.ok === false) return res;
    } catch (err) { return { ok: false, error: errMsg(err) }; }
    return this.get(skill.name);
  }

  delete(name) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) return { ok: false, error: 'invalid_name' };
    const dir = path.join(this._ready(), name);
    if (!fs.existsSync(dir)) return { ok: false, error: 'not_found' };
    fs.rmSync(dir, { recursive: true, force: true });
    const state = this._readState();
    if (state.disabled.includes(name)) this._writeState({ disabled: state.disabled.filter((n) => n !== name) });
    return { ok: true };
  }

  setEnabled(name, enabled) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) return { ok: false, error: 'invalid_name' };
    if (!fs.existsSync(path.join(this._ready(), name))) return { ok: false, error: 'not_found' };
    const disabled = this._readState().disabled.filter((n) => n !== name);
    if (!enabled) disabled.push(name);
    this._writeState({ disabled });
    return { ok: true, name, enabled: !!enabled };
  }

  /**
   * Copy-import every skill folder under ~/.claude/skills or ~/.codex/skills.
   * @param {'claude'|'codex'} source
   */
  importFrom(source, { overwrite = false } = {}) {
    if (!Object.prototype.hasOwnProperty.call(IMPORT_SOURCES, source)) return { ok: false, error: 'invalid_source' };
    const base = this._ready();
    const srcRoot = path.join(/** @type {string} */ (this._homeDir), ...IMPORT_SOURCES[source]);
    if (!fs.existsSync(srcRoot)) return { ok: true, source, dir: srcRoot, sourceMissing: true, results: [] };
    const results = [];
    for (const ent of fs.readdirSync(srcRoot, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      const entry = path.join(srcRoot, ent.name);
      try {
        // A top-level symlink is the user's own choice of skill folder; nested ones are skipped in the copy.
        if (!fs.statSync(entry).isDirectory()) continue;
        if (!fs.existsSync(path.join(entry, 'SKILL.md'))) { results.push({ dir: ent.name, ok: false, status: 'error', error: 'missing_skill_md', warnings: [] }); continue; }
        const res = importSkillDir(base, fs.realpathSync(entry), { overwrite });
        const status = res.ok ? 'imported' : res.error === 'exists' ? 'exists' : 'error';
        results.push({ dir: ent.name, name: res.name, ok: !!res.ok, status, error: res.ok ? undefined : res.error, warnings: res.warnings });
      } catch (err) {
        results.push({ dir: ent.name, ok: false, status: 'error', error: errMsg(err), warnings: [] });
      }
    }
    return { ok: true, source, dir: srcRoot, results };
  }

  /** @param {string} url @param {{ overwrite?: boolean, get?: any }} [opts] */
  async installFromUrl(url, opts = {}) {
    const fetched = await fetchSkillFromUrl(url, { get: opts.get });
    if (fetched.ok === false) return fetched;
    const saved = this.save({ markdown: fetched.markdown }, { overwrite: opts.overwrite === true });
    if (saved.ok === false) return saved;
    return { ...saved, url: fetched.url, warnings: fetched.warnings };
  }

  /** Draft (not save) a skill from a conversation transcript. */
  async draftFromTranscript(messages, opts = {}) {
    const llm = this._llm || require('./LLMClientService');
    return draftSkill(llm, messages, opts);
  }

  /** Enabled skills ranked for auto-trigger; [] when autoTrigger is off. */
  match(text) {
    const settings = readSkillSettings(this._config());
    if (!settings.autoTrigger) return [];
    return matchSkills(text, this.list().skills.filter((s) => s.enabled), { threshold: settings.matchThreshold });
  }

  /**
   * Narrowing predicate for a skill's mapped allowed-tools, or null when the
   * skill does not restrict tools. Combine it with any existing filter by AND;
   * it never adds a tool and never answers a permission question.
   * @param {{ tools?: string[]|null }} skill
   */
  toolFilterFor(skill) {
    return toolNamePredicate(skill && skill.tools);
  }

  /** Activate a skill for the model (agent.use_skill). */
  use(name) {
    const res = this.get(name);
    if (res.ok === false) return res;
    if (!res.skill.enabled) return { ok: false, error: 'skill_disabled' };
    return res;
  }

  /**
   * Start an agent task that follows a skill. `allowedTools` carries the
   * skill's mapped rule list so the host can narrow the run's tools. With a
   * sessionId the run is a turn in that session: its user message reads
   * `/<name> <task>` and the skill body goes to the turn's system-side
   * instructions; without one the whole skill prompt is the task.
   * @param {{ name: string, task?: string, webContentsId?: number, sessionId?: string }} args
   */
  async run({ name, task, webContentsId, sessionId }) {
    const res = this.use(name);
    if (res.ok === false) return res;
    if (!this._agentService) return { ok: false, error: 'agent_unavailable' };
    const s = res.skill;
    const taskText = typeof task === 'string' ? task.trim() : '';
    const follow = [`Follow the "${s.name}" skill.`, s.body].filter(Boolean).join('\n\n');
    const qualitySkillOverride = this._qualityOverride(s.extra);
    const common = { webContentsId, qualitySkillOverride, allowedTools: s.tools };
    if (sessionId) {
      return this._agentService.startTask({ ...common, sessionId, description: taskText ? `/${s.name} ${taskText}` : `/${s.name}`, instructions: follow });
    }
    return this._agentService.startTask({ ...common, description: [follow, taskText ? `Task: ${taskText}` : ''].filter(Boolean).join('\n\n') });
  }
}

const instance = new SkillsService();
module.exports = instance;
module.exports.SkillsService = SkillsService;
module.exports.IMPORT_SOURCES = IMPORT_SOURCES;

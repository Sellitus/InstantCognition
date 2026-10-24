// QualityModeService — resolves Efficient / Balanced / Ultra into a single
// config object threaded through AgentRuntime, tool handlers, approval gate,
// action log, and budget enforcement. One knob, no feature-flag sprawl.
//
// Modes (see plan §3):
//   efficient — AX-only observations, single-sample, local drafts, tight budget.
//   balanced  — default. Resample on low confidence, remote verifies destructive.
//   ultra     — best-of-N, world-model lookahead, full vision every turn, judges.

const MODES = {
  efficient: {
    name: 'efficient',
    observation: { mode: 'ax', diffAfterFirst: true, screenshot: 'off' },
    sampling: { bestOf: 1, resampleOnLowConfidence: false, confidenceThreshold: 0 },
    reflection: { after: 'failure' }, // 'failure' | 'plan' | 'every'
    draftVerify: { drafts: 'local', verify: 'on_destructive' },
    shadowFork: { policy: 'off' }, // 'off' | 'destructive' | 'every_decision'
    judges: { policy: 'payment_auth' }, // 'payment_auth' | 'destructive' | 'all_mutating'
    worldModel: false,
    vision: 'off',
    macros: { strategy: 'use_first' },
    // maxTokens is cumulative spend, and every step re-sends the whole
    // conversation, so the ceiling scales as maxSteps × typical prompt size
    // (~10k). A budget sized like a context window ends the run mid-task.
    budget: { maxSteps: 12, maxTokens: 150000, maxSeconds: 600, maxNavigations: 10 },
  },
  balanced: {
    name: 'balanced',
    observation: { mode: 'ax', diffAfterFirst: false, screenshot: 'auto' },
    sampling: { bestOf: 1, resampleOnLowConfidence: true, confidenceThreshold: 0.35 },
    reflection: { after: 'failure_or_plan_end' },
    draftVerify: { drafts: 'local', verify: 'on_destructive' },
    shadowFork: { policy: 'destructive' },
    judges: { policy: 'destructive' },
    worldModel: false,
    vision: 'auto',
    macros: { strategy: 'use_first_verify' },
    budget: { maxSteps: 30, maxTokens: 500000, maxSeconds: 1800, maxNavigations: 25 },
  },
  ultra: {
    name: 'ultra',
    observation: { mode: 'ax_dom_vision', diffAfterFirst: false, screenshot: 'every_turn' },
    sampling: { bestOf: 5, resampleOnLowConfidence: true, confidenceThreshold: 0.6 },
    reflection: { after: 'every' },
    draftVerify: { drafts: 'remote', verify: 'every_step' },
    shadowFork: { policy: 'every_decision' },
    judges: { policy: 'all_mutating' },
    worldModel: true,
    vision: 'forced',
    macros: { strategy: 'rederive' },
    // maxTokens=0 means "no ceiling"; maxSteps capped to avoid runaway loops.
    budget: { maxSteps: 100, maxTokens: 0, maxSeconds: 7200, maxNavigations: 100 },
  },
};

function isMode(name) { return typeof name === 'string' && Object.prototype.hasOwnProperty.call(MODES, name); }

function resolveMode(name) {
  if (isMode(name)) return deepClone(MODES[name]);
  return deepClone(MODES.balanced);
}

// Merge a partial override (e.g. per-Skill adjustment) on top of a mode.
// The mode's own fields layer over its named preset, so overrides already
// applied to it (config, skill, persona) survive; sub-objects shallow-merge.
function withOverride(mode, override) {
  const base = { ...resolveMode(mode && mode.name ? mode.name : 'balanced'), ...deepClone(mode || {}) };
  const o = override || {};
  const out = { ...base };
  for (const k of Object.keys(o)) {
    if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) {
      out[k] = { ...base[k], ...o[k] };
    } else {
      out[k] = o[k];
    }
  }
  return out;
}

function listModes() { return Object.keys(MODES); }

// Ordered weakest to strictest. A policy missing from its ladder is not tighter.
const POLICY_LADDERS = {
  judges: ['payment_auth', 'destructive', 'all_mutating'],
  shadowFork: ['off', 'destructive', 'every_decision'],
  draftVerify: ['on_destructive', 'every_step'],
};
const POLICY_FIELD = { judges: 'policy', shadowFork: 'policy', draftVerify: 'verify' };

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// Filter an untrusted override (a SKILL.md from disk or an install URL) down to
// the parts that only make `base` stricter: lower budget ceilings and stricter
// safety policies. Everything else is dropped, so a skill can never spend more
// or skip a judge/verify step the user's mode would have run.
function tightenOverride(base, override) {
  const out = {};
  if (!isPlainObject(override)) return out;
  if (isPlainObject(override.budget) && isPlainObject(base.budget)) {
    const budget = {};
    for (const [k, v] of Object.entries(override.budget)) {
      const cur = base.budget[k];
      if (typeof cur !== 'number' || typeof v !== 'number' || !Number.isFinite(v)) continue;
      const n = Math.floor(v);
      // A base of 0 means uncapped, so any positive ceiling tightens it.
      if (n >= 1 && (cur === 0 || n < cur)) budget[k] = n;
    }
    if (Object.keys(budget).length) out.budget = budget;
  }
  for (const [key, ladder] of Object.entries(POLICY_LADDERS)) {
    const field = POLICY_FIELD[key];
    const want = isPlainObject(override[key]) ? override[key][field] : undefined;
    const cur = isPlainObject(base[key]) ? ladder.indexOf(base[key][field]) : -1;
    if (ladder.indexOf(want) > cur && cur >= 0) out[key] = { [field]: want };
  }
  return out;
}

class QualityModeService {
  constructor() {
    this._getConfig = null;
  }

  bindConfig(configService) {
    this._getConfig = () => {
      const agent = (configService.get('settings.llm.agent', {}) || {});
      const qm = agent.qualityMode || agent.mode || 'balanced';
      const ovr = agent.qualityOverride || null;
      return { mode: qm, override: ovr };
    };
  }

  // Resolve the active mode. If skillOverride is passed, it is layered on top.
  resolve(skillOverride) {
    const cfg = this._getConfig ? this._getConfig() : { mode: 'balanced' };
    const name = isMode(cfg.mode) ? cfg.mode : 'balanced';
    const base = { ...resolveMode(name), name };
    const withCfg = cfg.override ? withOverride(base, cfg.override) : base;
    return skillOverride ? withOverride(withCfg, skillOverride) : withCfg;
  }
}

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

const instance = new QualityModeService();
module.exports = instance;
module.exports.QualityModeService = QualityModeService;
module.exports.MODES = MODES;
module.exports.resolveMode = resolveMode;
module.exports.withOverride = withOverride;
module.exports.listModes = listModes;
module.exports.isMode = isMode;
module.exports.tightenOverride = tightenOverride;

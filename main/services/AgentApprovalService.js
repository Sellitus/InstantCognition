// AgentApprovalService — gates proposed agent tool calls. Invoked by the
// approval interceptor between step-planned and registry.invokeParallel.
//
// The verdict for each call comes from the pure permission engine
// (../agent/permissions/permissionEngine.js); this service owns the state it
// reads: permission mode (config + per-session override), rules, per-origin
// grants, session grants, and the IPC round-trip to the approval card.

const EventEmitter = require('events');
const policy = require('../agent/approvalPolicy');
const engine = require('../agent/permissions/permissionEngine');
const ruleMatch = require('../agent/permissions/ruleMatch');
const { callFacts, buildRequestPayload, promptTimeout } = require('../agent/permissions/approvalContext');
const { SessionGrants } = require('../agent/permissions/sessionGrants');
const { readAgentSettings, PERMISSION_MODES } = require('../agent/workspace/agentSettings');

const RULE_LISTS = Object.freeze(['allow', 'ask', 'deny']);
const SESSION_ID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;

function errMessage(err) { return (err instanceof Error && err.message) || String(err); }

class AgentApprovalService extends EventEmitter {
  constructor() {
    super();
    this._mainWindow = null;
    this._ipcMain = null;
    this._pending = new Map();
    this._seq = 0;
    this._configService = null;
    this._grants = new SessionGrants(); // per session: origin::class grants + session rules
    this._sessionModes = new Map(); // sessionId -> permission mode
    this._promptTimeoutMs = 60000;
  }

  bind(mainWindow, ipcMain, configService) {
    this._mainWindow = mainWindow;
    this._ipcMain = ipcMain;
    this._configService = configService;
    if (ipcMain && typeof ipcMain.on === 'function') {
      ipcMain.on('agent:approval-response', (_e, payload) => this._onResponse(payload));
    }
  }

  _onResponse(payload) {
    if (!payload || !payload.requestId) return;
    this._settle(payload.requestId, payload);
  }

  // Resolves a pending prompt once (later responses for it are no-ops) and
  // announces it: agent:approval-resolved {requestId, sessionId, decision,
  // reason?} to the window that got the request, plus the caller's onResolved.
  // 'allow_rule_always' approves this call too; the interceptor treats only
  // 'approve*' as approval, and the rule is always the main-side suggestion.
  _settle(requestId, raw) {
    const pending = this._pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this._pending.delete(requestId);
    const out = raw && raw.decision === 'allow_rule_always' ? { ...raw, decision: pending.suggestedRule ? 'approve_rule_always' : 'approve' } : raw;
    pending.resolve(out);
    const info = { requestId, sessionId: pending.sessionId, decision: String((out && out.decision) || 'reject') };
    if (out && out.reason) info.reason = out.reason;
    // The call is already decided; a closed window or a failing listener only
    // leaves a stale card behind, so it is logged rather than thrown.
    try {
      const mw = this._mainWindow;
      if (mw && !(typeof mw.isDestroyed === 'function' && mw.isDestroyed())) mw.webContents.send('agent:approval-resolved', info);
      if (pending.onResolved) pending.onResolved(info);
    } catch (err) {
      console.error(`[AgentApprovalService] announcing resolved approval ${requestId} failed:`, errMessage(err));
    }
    return true;
  }

  /** Rejects every pending prompt of `sessionId` (null: no session) and drops its session grants; returns how many prompts. */
  cancelSession(sessionId, reason = 'cancelled') {
    const sid = sessionId || null;
    const ids = [...this._pending].filter(([, p]) => p.sessionId === sid).map(([id]) => id);
    for (const id of ids) this._settle(id, { decision: 'reject', reason });
    this.clearSession(sid);
    return ids.length;
  }

  /** Drops the "approve for session" grants and rules of one session (null: no-session bucket). */
  clearSession(sessionId) { this._grants.clear(sessionId); }

  resetSessionGrants() { this._grants.clearAll(); }

  /** Effective permission mode: per-session override, else config. */
  getMode(sessionId) {
    if (sessionId && this._sessionModes.has(sessionId)) return this._sessionModes.get(sessionId);
    return this._settings().permissions.mode;
  }

  /** Per-session override; mode null clears it. */
  setSessionMode(sessionId, mode) {
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) throw new Error('invalid_session_id');
    if (mode === null) { this._sessionModes.delete(sessionId); return; }
    if (!PERMISSION_MODES.includes(mode)) throw new Error('invalid_mode');
    this._sessionModes.set(sessionId, mode);
  }

  getSessionModes() { return Object.fromEntries(this._sessionModes); }

  _settings() { return readAgentSettings(this._configService); }

  // { allowed, denied:[{call,reason}], prompts:[{call,class,origin,...}] }
  decide(calls, ctx) {
    const c = ctx || {};
    const settings = this._settings();
    const sessionId = typeof c.sessionId === 'string' ? c.sessionId : '';
    const legacy = this._loadRules();
    const r = settings.permissions.rules;
    const base = {
      mode: (sessionId && this._sessionModes.get(sessionId)) || settings.permissions.mode,
      allowedTools: c.allowedTools || c.toolFilter,
      rules: { allow: ruleMatch.compileList(r.allow), ask: ruleMatch.compileList(r.ask), deny: ruleMatch.compileList(r.deny) },
      classDeny: legacy.deny,
      perOrigin: legacy.perOrigin,
      url: c.url || '',
      sessionGrants: this._grants.grants(sessionId),
      sessionRules: this._grants.rules(sessionId),
      egress: this._loadEgress(),
    };
    const allowed = [];
    const denied = [];
    const prompts = [];
    for (const call of calls || []) {
      const facts = callFacts(call, settings);
      const v = engine.decide(call, { ...base, facts });
      if (v.verdict === 'allow') { allowed.push(call); continue; }
      if (v.verdict === 'deny') { denied.push({ call, reason: v.reason }); continue; }
      const prompt = { call, class: v.cls, origin: v.origin };
      if (sessionId) prompt.sessionId = sessionId;
      if (v.origins.length > 1) prompt.origins = v.origins;
      if (v.suggestedRule) prompt.suggestedRule = v.suggestedRule;
      if (Object.keys(facts).length) prompt.facts = facts;
      prompts.push(prompt);
    }
    return { allowed, denied, prompts };
  }

  /**
   * @param {any} prompt
   * @param {{ timeoutMs?: number, timeoutReason?: string, onResolved?: (info: any) => void }} [opts]
   *   timeoutMs: 0 = wait with no timer; > 0 = that bound (max 24h) with
   *   timeoutReason; absent = the service's 60s bound.
   */
  requestApproval(prompt, opts = {}) {
    return new Promise((resolve) => {
      const mw = this._mainWindow;
      const destroyed = mw && typeof mw.isDestroyed === 'function' ? mw.isDestroyed() : !mw;
      if (!mw || destroyed) { resolve({ decision: 'reject', reason: 'no_ui' }); return; }
      const requestId = `approval_${Date.now()}_${++this._seq}`;
      const t = promptTimeout(opts, this._promptTimeoutMs);
      const timer = t.ms ? setTimeout(() => this._settle(requestId, { decision: 'reject', reason: t.reason }), t.ms) : null;
      this._pending.set(requestId, {
        resolve, timer, sessionId: prompt.sessionId || null, suggestedRule: prompt.suggestedRule || null,
        onResolved: typeof opts.onResolved === 'function' ? opts.onResolved : null,
      });
      try {
        mw.webContents.send('agent:approval-request', buildRequestPayload(requestId, prompt, this._settings()));
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(requestId);
        console.error('[AgentApprovalService] approval request send failed:', errMessage(err));
        resolve({ decision: 'reject', reason: 'send_failed' });
      }
    });
  }

  applyDecision(prompt, decision) {
    const { class: cls, origin } = prompt;
    // A browser call with no page or destination host has nothing to scope a
    // grant or rule to, so it is approved once only.
    if (String((prompt.call && prompt.call.name) || '').startsWith('browser.') && !origin) return;
    const origins = Array.isArray(prompt.origins) && prompt.origins.length ? prompt.origins : [origin];
    if (decision === 'approve_session' && origin) {
      for (const o of origins) this._grants.addGrant(prompt.sessionId, `${o}::${cls}`);
    } else if (decision === 'approve_session' && prompt.suggestedRule) {
      this._grants.addRule(prompt.sessionId, ruleMatch.parse(prompt.suggestedRule));
    } else if ((decision === 'approve_rule_always' || decision === 'allow_rule_always') && prompt.suggestedRule) {
      try { this.addRule('allow', prompt.suggestedRule); }
      catch (err) { this._persistFailed({ rule: prompt.suggestedRule }, err); }
    } else if (decision === 'approve_origin' && origin) {
      for (const o of origins) this._persistOriginRule(o, cls, 'allow');
    } else if (decision === 'reject_origin' && origin) {
      for (const o of origins) this._persistOriginRule(o, cls, 'deny');
    }
  }

  getPermissions(sessionId) {
    const s = this._settings();
    return { mode: s.permissions.mode, effectiveMode: this.getMode(sessionId), sessionModes: this.getSessionModes(), rules: s.permissions.rules };
  }

  setMode(mode) {
    if (!PERMISSION_MODES.includes(mode)) throw new Error('invalid_mode');
    this._writePermissions((p) => ({ ...p, mode }));
  }

  addRule(list, rule) {
    if (!RULE_LISTS.includes(list)) throw new Error('invalid_rule_list');
    const parsed = ruleMatch.parse(rule);
    this._writePermissions((p) => {
      const rules = { ...(p.rules || {}) };
      const cur = Array.isArray(rules[list]) ? rules[list] : [];
      rules[list] = cur.includes(parsed.raw) ? cur : [...cur, parsed.raw];
      return { ...p, rules };
    });
    return parsed.raw;
  }

  removeRule(list, rule) {
    if (!RULE_LISTS.includes(list)) throw new Error('invalid_rule_list');
    if (typeof rule !== 'string') throw new Error('invalid_rule:not_a_string');
    let removed = false;
    this._writePermissions((p) => {
      const rules = { ...(p.rules || {}) };
      const cur = Array.isArray(rules[list]) ? rules[list] : [];
      rules[list] = cur.filter((x) => x !== rule && x !== rule.trim());
      removed = rules[list].length !== cur.length;
      return { ...p, rules };
    });
    return removed;
  }

  _writePermissions(update) {
    if (!this._configService || typeof this._configService.set !== 'function') throw new Error('no_config');
    const current = this._configService.get('settings.llm.agent.permissions', {}) || {};
    const s = this._settings().permissions;
    const next = update({ mode: s.mode, ...current, rules: { ...s.rules, ...(current.rules || {}) } });
    this._configService.set('settings.llm.agent.permissions', next);
  }

  _loadRules() {
    if (!this._configService) return { deny: [], perOrigin: {} };
    const cfg = this._configService.get('settings.llm.agent.approval', {}) || {};
    return {
      deny: Array.isArray(cfg.deny) ? cfg.deny : [],
      perOrigin: cfg.perOrigin && typeof cfg.perOrigin === 'object' ? cfg.perOrigin : {},
    };
  }

  _loadEgress() {
    if (!this._configService) return null;
    const cfg = this._configService.get('settings.llm.agent.egress', {}) || {};
    const mode = cfg.mode === 'allowlist' || cfg.mode === 'blocklist' ? cfg.mode : 'open';
    return {
      mode,
      allow: Array.isArray(cfg.allow) ? cfg.allow : [],
      block: Array.isArray(cfg.block) ? cfg.block : [],
      onViolation: cfg.onViolation === 'deny' ? 'deny' : 'prompt',
    };
  }

  // Best effort (here and for 'always' rules): the approval already applies
  // to the current call, so a failed save is reported, not thrown mid-step.
  _persistOriginRule(origin, actionClass, verdict) {
    if (!this._configService) return;
    const cfg = this._configService.get('settings.llm.agent.approval', {}) || {};
    const perOrigin = { ...(cfg.perOrigin || {}) };
    perOrigin[origin] = { ...(perOrigin[origin] || {}), [actionClass]: verdict };
    const merged = { ...cfg, perOrigin };
    try {
      if (typeof this._configService.set === 'function') {
        this._configService.set('settings.llm.agent.approval', merged);
      }
    } catch (err) {
      this._persistFailed({ origin, actionClass, verdict }, err);
    }
  }

  _persistFailed(what, err) {
    console.error('[AgentApprovalService] persisting approval failed:', errMessage(err));
    this.emit('persist-failed', { ...what, error: errMessage(err) });
  }

  _reset() {
    for (const requestId of [...this._pending.keys()]) this._settle(requestId, { decision: 'reject', reason: 'reset' });
    this._grants.clearAll();
    this._sessionModes.clear();
  }
}

const instance = new AgentApprovalService();
module.exports = instance;
module.exports.AgentApprovalService = AgentApprovalService;
// Re-export policy helpers for backward compatibility with existing tests.
module.exports.classify = policy.classify;
module.exports.upgradeClass = policy.upgradeClass;
module.exports.originOf = policy.originOf;
module.exports.BROWSER_CLASS_POLICY = policy.BROWSER_CLASS_POLICY;
module.exports.MODE_POLICY = policy.MODE_POLICY;
module.exports.egressVerdict = policy.egressVerdict;
module.exports.hostMatches = policy.hostMatches;
module.exports.destinationUrl = policy.destinationUrl;

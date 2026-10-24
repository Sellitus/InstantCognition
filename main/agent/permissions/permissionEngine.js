// permissionEngine — pure decide(call, ctx) for one proposed tool call.
//
// Evaluation order (first hit wins):
//   1. not in ctx.allowedTools                     → deny  tool_not_available
//   2. meta class                                  → allow
//   3. hard invariants: egress block / unlisted-deny, ctx.facts.blocked
//      (path escape, shell disabled, …)            → deny
//   4. deny rules, a read-deny rule inside the subtree an fs.search/fs.list
//      would walk, legacy class deny, per-origin deny → deny (beats Bypass)
//   5. Plan mode + non-planSafe class              → deny  plan_mode_read_only
//      invalid deny rule in config                 → ask   (fail closed)
//      write to a protected path                   → ask   (beats allow rules
//                                                    and Bypass; deny still wins)
//      egress-unlisted destination                 → ask   unless an allow rule names it
//   6. ask rules                                   → ask
//   7. allow rules, per-origin allow, session grants → allow
//   8. Bypass                                      → allow
//   9. mode table: browser classes per BROWSER_CLASS_POLICY; edit asks in Ask
//      and is allowed in Auto-edit; exec/external/delegate/unknown ask.
// Judges run after this, in the interceptor.
//
// A call that opens destinations (navigate, open_tab, every sources[].url of
// open_research_sources) is judged per destination: any denied or asked host
// or origin decides the call, while allow rules, per-origin allows and
// session grants must cover all of them. Origin-keyed state uses the
// destination origin; other browser calls key on the current page.
//
// ctx = {
//   mode: 'ask'|'auto-edit'|'plan'|'bypass',
//   allowedTools?: Set<string>|string[]|((name)=>boolean),
//   rules?: { allow, ask, deny } each a ruleMatch.compileList() result,
//   classDeny?: string[], perOrigin?: object, url?: string,
//   sessionGrants?: { has(key): boolean }, sessionRules?: parsed rule[],
//   egress?: { mode, allow, block, onViolation } | null,
//   facts?: { rel?: string, protected?: boolean, blocked?: string },
// }
// Result `origins` lists every origin the verdict keyed on (`origin` is the
// first), so a session/origin approval can cover all of them.

const policy = require('../approvalPolicy');
const { classify } = require('./toolCatalog');
const ruleMatch = require('./ruleMatch');

const MODES = Object.freeze(['ask', 'auto-edit', 'plan', 'bypass']);
const ALWAYS_ASK = new Set(['exec', 'external', 'delegate', 'unknown']);

function inAllowedSet(name, allowed) {
  if (allowed === undefined || allowed === null) return true;
  if (typeof allowed === 'function') return !!allowed(name);
  if (allowed instanceof Set) return allowed.has(name);
  if (Array.isArray(allowed)) return allowed.includes(name);
  return false;
}

// fs.search reads file contents, so a read deny also bounds its walk.
const WALKERS = Object.freeze({ 'fs.search': ['fs.search', 'fs.read'], 'fs.list': ['fs.list'] });

function egressState(dests, ctx) {
  const egress = ctx.egress;
  if (!egress) return null;
  const asks = [];
  for (const dest of dests) {
    const ev = policy.egressVerdict(dest, egress);
    const destOrigin = policy.originOf(dest);
    if (ev === 'block') return { deny: `egress_blocked:${destOrigin}` };
    if (ev !== 'unlisted') continue;
    const perO = ctx.perOrigin && ctx.perOrigin[destOrigin] && ctx.perOrigin[destOrigin].egress;
    if (perO === 'deny') return { deny: `egress_origin_deny:${destOrigin}` };
    if (perO === 'allow' || (ctx.sessionGrants && ctx.sessionGrants.has(`${destOrigin}::egress`))) continue;
    if (egress.onViolation === 'deny') return { deny: `egress_unlisted:${destOrigin}` };
    if (!asks.includes(destOrigin)) asks.push(destOrigin);
  }
  return asks.length ? { ask: asks } : null;
}

function subtreeDenyRule(name, rel, denyRules) {
  const as = WALKERS[name];
  if (!as || typeof rel !== 'string') return null;
  for (const r of denyRules || []) {
    if (as.some((n) => ruleMatch.matchToolName(r, n)) && ruleMatch.pathReachesUnder(r, rel)) return r;
  }
  return null;
}

// Hosts the call's host rules are judged against: each destination's, else
// the args.url / page host as before.
function hostsOf(dests, args, pageUrl) {
  const hosts = [...new Set(dests.map((u) => ruleMatch.hostFor({ url: u }, '')).filter(Boolean))];
  return hosts.length ? hosts : [ruleMatch.hostFor(args, pageUrl)];
}

function modeTable(mode, cls) {
  if (cls === 'edit') return mode === 'auto-edit' ? 'allow' : 'ask';
  if (ALWAYS_ASK.has(cls)) return 'ask';
  const v = policy.BROWSER_CLASS_POLICY[cls];
  if (v === 'allow') return 'allow';
  if (v === 'deny') return 'deny';
  return 'ask';
}

/**
 * @param {{ name?: string, args?: any }} call
 * @param {any} [ctxIn]
 * @returns {{ verdict: 'allow'|'ask'|'deny', reason: string, cls: string, origin: string, origins: string[], suggestedRule: string|null }}
 */
function decide(call, ctxIn) {
  const ctx = ctxIn || {};
  const name = call && typeof call.name === 'string' ? call.name : '';
  const args = call && call.args && typeof call.args === 'object' ? call.args : {};
  const mode = MODES.includes(ctx.mode) ? ctx.mode : 'ask';
  const facts = ctx.facts || {};
  const rules = ctx.rules || {};
  const { cls: baseCls, planSafe } = classify(name);
  const isBrowser = name.startsWith('browser.');
  const pageUrl = typeof ctx.url === 'string' ? ctx.url : '';
  const dests = isBrowser ? policy.destinationUrls(call) : [];
  const destOrigins = [...new Set(dests.map(policy.originOf).filter(Boolean))];
  const pageOrigin = isBrowser ? policy.originOf(pageUrl) : '';
  const origins = destOrigins.length ? destOrigins : (pageOrigin ? [pageOrigin] : []);
  const origin = origins[0] || '';
  const cls = isBrowser ? policy.upgradeClass(baseCls, call, { url: pageUrl }) : baseCls;
  const base = { argv: Array.isArray(args.argv) ? args.argv : null, path: typeof facts.rel === 'string' ? facts.rel : null };
  const factsList = hostsOf(dests, args, pageUrl).map((host) => ({ ...base, host }));
  const suggestedRule = factsList.length === 1 ? ruleMatch.suggest(name, factsList[0]) : null;
  const out = (verdict, reason, over) => ({ verdict, reason, cls, origin, origins, suggestedRule, ...(over || {}) });
  // deny/ask: any one destination hits; allow: every destination must hit.
  const anyHit = (rules0, lenient) => {
    for (const f of factsList) { const r = ruleMatch.firstMatch(rules0, name, f, { lenient }); if (r) return r; }
    return null;
  };
  const allHit = (rules0) => {
    const hits = factsList.map((f) => ruleMatch.firstMatch(rules0, name, f, { lenient: false }));
    return hits.every(Boolean) ? hits[0] : null;
  };
  const originRule = (o) => (ctx.perOrigin && ctx.perOrigin[o] ? ctx.perOrigin[o][cls] : undefined);

  if (!name || !inAllowedSet(name, ctx.allowedTools)) return out('deny', 'tool_not_available');
  if (baseCls === 'meta') return out('allow', 'meta');

  const eg = egressState(dests, ctx);
  if (eg && eg.deny) return out('deny', eg.deny);
  if (facts.blocked) return out('deny', String(facts.blocked));

  const denyRules = rules.deny && rules.deny.rules;
  const denyRule = anyHit(denyRules, true);
  if (denyRule) return out('deny', `rule_deny:${denyRule.raw}`);
  const subtreeRule = subtreeDenyRule(name, base.path, denyRules);
  if (subtreeRule) return out('deny', `deny_rule_in_subtree:${subtreeRule.raw}`);
  if (Array.isArray(ctx.classDeny) && ctx.classDeny.includes(cls)) return out('deny', `denied_by_policy:${cls}`);
  const deniedOrigin = origins.find((o) => originRule(o) === 'deny');
  if (deniedOrigin) return out('deny', `origin_deny:${deniedOrigin}`);

  if (mode === 'plan' && !planSafe) return out('deny', 'plan_mode_read_only');
  if (rules.deny && rules.deny.invalid && rules.deny.invalid.length) return out('ask', `invalid_deny_rule:${rules.deny.invalid[0].rule}`);
  if (cls === 'edit' && facts.protected) return out('ask', 'protected_path');
  const allowRule = allHit(rules.allow && rules.allow.rules);
  if (eg && eg.ask && !allowRule) return out('ask', 'egress_unlisted', { cls: 'egress', origin: eg.ask[0], origins: eg.ask, suggestedRule: null });

  const askRule = anyHit(rules.ask && rules.ask.rules, true);
  if (askRule) return out('ask', `rule_ask:${askRule.raw}`);

  if (allowRule) return out('allow', `rule_allow:${allowRule.raw}`);
  if (origins.length && origins.every((o) => originRule(o) === 'allow')) return out('allow', `origin_allow:${origin}`);
  const grants = ctx.sessionGrants;
  if (origins.length && grants && origins.every((o) => grants.has(`${o}::${cls}`))) return out('allow', 'session_grant');
  const sessionRule = allHit(ctx.sessionRules);
  if (sessionRule) return out('allow', `session_rule:${sessionRule.raw}`);

  if (mode === 'bypass') return out('allow', 'mode_bypass');

  const v = modeTable(mode, cls);
  if (v === 'allow') return out('allow', `mode:${mode}:${cls}`);
  if (v === 'deny') return out('deny', `mode_deny:${mode}:${cls}`);
  return out('ask', `mode_ask:${mode}:${cls}`);
}

module.exports = { decide, MODES };

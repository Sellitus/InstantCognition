// Browser action policy + pure classification and egress helpers shared by
// the permission engine, AgentApprovalService and the judge interceptor.

const { classify: catalogClassify } = require('./permissions/toolCatalog');

// Verdict per browser action class ('prompt' = ask the user). Classes the
// table does not name (edit, exec, external, delegate, unknown) are decided by
// the permission engine's mode table, never defaulted to allow here.
const BROWSER_CLASS_POLICY = Object.freeze({
  read: 'allow', meta: 'allow',
  navigate: 'allow', click: 'allow', type: 'allow', scroll: 'allow',
  submit: 'prompt', destructive: 'prompt',
  download: 'prompt', auth: 'prompt', payment: 'prompt',
});

// Per-quality-mode view kept for callers that index by mode name; every mode
// shares the one table.
const MODE_POLICY = Object.freeze({
  efficient: BROWSER_CLASS_POLICY,
  balanced: BROWSER_CLASS_POLICY,
  ultra: BROWSER_CLASS_POLICY,
});

function classify(toolName) {
  return catalogClassify(toolName).cls;
}

// Heuristic auto-upgrade: detect payment/auth from every destination URL the
// call opens (navigate, open_tab, research sources) or from the current tab
// URL when the agent types/clicks.
function upgradeClass(baseClass, call, ctx) {
  const dests = destinationUrls(call).map((d) => d.toLowerCase());
  if (dests.some((u) => /\/(checkout|pay|payment|billing|subscribe)(\/|$|\?)/.test(u))) return 'payment';
  if (dests.some((u) => /\/(login|signin|sign_in|auth|oauth)(\/|$|\?)/.test(u))) return 'auth';
  const url = ctx && ctx.url;
  if (url && typeof url === 'string') {
    const u = url.toLowerCase();
    if ((baseClass === 'click' || baseClass === 'type') && /\/(checkout|pay|payment|billing)(\/|$|\?)/.test(u)) return 'payment';
  }
  return baseClass;
}

function parseUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try { return new URL(url); } catch (_) { return null; } // unparseable: no origin, no host
}

// `evil.test.` names the same host as `evil.test`, so the root dot is dropped
// before any rule, grant or egress pattern compares hosts.
function normHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/\.+$/, '');
}

// Grants and per-origin rules key on scheme + normalized host + port.
function originOf(url) {
  const u = parseUrl(url);
  const host = u ? normHost(u.hostname) : '';
  return host ? `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}` : '';
}

// ── Egress control ─────────────────────────────────────────────────────────
// Only http(s) destinations are gated. Internal/agent URLs (about:, ic://,
// data:, chrome://) have no http host → never blocked. The port is not part
// of the host: a block on `evil.test` covers every port.
function hostOf(url) {
  const u = parseUrl(typeof url === 'string' ? url : String(url));
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return '';
  return normHost(u.hostname);
}

// Domain match: a pattern covers its exact host and every subdomain.
// `example.com`, `*.example.com`, `https://example.com/x` all normalize to
// `example.com`, which matches `example.com` and `a.b.example.com`.
function hostMatches(host, pattern) {
  if (!host || !pattern) return false;
  const p = String(pattern).trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^\*\./, '').replace(/\/.*$/, '').replace(/:\d*$/, '')
    .replace(/^\.+/, '').replace(/\.+$/, '');
  if (!p) return false;
  return host === p || host.endsWith('.' + p);
}

// Tools whose args carry a destination URL the agent chose (not a tab it has
// already reached). duplicate/fork reopen an existing tab's url → not gated.
const URL_ARG_TOOLS = new Set(['browser.navigate', 'browser.open_tab']);
function destinationUrl(call) {
  if (!call || !URL_ARG_TOOLS.has(call.name)) return '';
  const u = call.args && call.args.url;
  return typeof u === 'string' ? u : '';
}

// Every destination a call would open: open_research_sources fans out to
// each sources[].url, so all of them must pass egress and host rules.
function destinationUrls(call) {
  if (call && call.name === 'browser.open_research_sources') {
    const sources = call.args && call.args.sources;
    if (!Array.isArray(sources)) return [];
    return sources.map((s) => (s && typeof s.url === 'string' ? s.url : '')).filter(Boolean);
  }
  const u = destinationUrl(call);
  return u ? [u] : [];
}

// 'allow' | 'block' | 'unlisted'. `block` is honored in every mode.
function egressVerdict(url, egress) {
  if (!egress) return 'allow';
  const host = hostOf(url);
  if (!host) return 'allow';
  const block = Array.isArray(egress.block) ? egress.block : [];
  for (const pat of block) if (hostMatches(host, pat)) return 'block';
  if (egress.mode === 'allowlist') {
    const allow = Array.isArray(egress.allow) ? egress.allow : [];
    for (const pat of allow) if (hostMatches(host, pat)) return 'allow';
    return 'unlisted';
  }
  return 'allow';
}

module.exports = {
  BROWSER_CLASS_POLICY, MODE_POLICY, classify, upgradeClass, originOf,
  hostOf, hostMatches, destinationUrl, destinationUrls, egressVerdict,
};

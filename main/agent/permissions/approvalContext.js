// approvalContext — the I/O half of an approval decision, kept out of the
// pure permissionEngine: workspace path facts for fs.* / shell.run calls, the
// request payload an approval card renders, and how long that card may wait.

const { classify } = require('./toolCatalog');
const { resolveInside, resolveRoot, isProtected } = require('../workspace/pathGuard');
const fsTools = require('../tools/fsTools');
const { argvError } = require('../tools/shellTools');

const PREVIEW_STRING_MAX = 200;
const PREVIEW_MAX = 2000;
const FS_PATH_DEFAULTS = new Set(['fs.list', 'fs.search']);

function msg(err) { return (err instanceof Error && err.message) || String(err); }

/**
 * Facts the engine needs about where a call reaches. Never throws: anything
 * that cannot be proven inside the workspace comes back as `blocked`.
 * @param {{ name: string, args?: any }} call
 * @param {ReturnType<typeof import('../workspace/agentSettings').normalize>} settings
 */
function callFacts(call, settings) {
  const name = String((call && call.name) || '');
  const args = (call && call.args && typeof call.args === 'object') ? call.args : {};
  const isFs = name.startsWith('fs.');
  if (!isFs && name !== 'shell.run') return {};
  if (name === 'shell.run') {
    if (!settings.shell.enabled) return { blocked: 'shell_disabled' };
    const bad = argvError(args.argv);
    if (bad) return { blocked: bad };
  }
  try {
    const root = resolveRoot(settings.workspace.roots, args.root);
    if (name === 'shell.run') {
      const r = resolveInside(root, args.cwd === undefined ? '.' : args.cwd);
      return { cwd: r.abs, cwdRel: r.rel };
    }
    const forWrite = classify(name).cls === 'edit';
    const p = args.path === undefined && FS_PATH_DEFAULTS.has(name) ? '.' : args.path;
    const r = resolveInside(root, p, { forWrite });
    return { rel: r.rel, abs: r.abs, protected: forWrite && isProtected(r.rel, settings.workspace.protectedGlobs) };
  } catch (err) {
    return { blocked: msg(err) };
  }
}

function shortString(v) {
  if (typeof v === 'string' && v.length > PREVIEW_STRING_MAX) return `${v.slice(0, PREVIEW_STRING_MAX)}… (+${v.length - PREVIEW_STRING_MAX} chars)`;
  return v;
}

function shortValue(v) { return Array.isArray(v) ? v.map(shortString) : shortString(v); }

function argsPreview(args) {
  if (!args || typeof args !== 'object') return '';
  const shallow = Array.isArray(args) ? args.map(shortValue) : Object.fromEntries(Object.entries(args).map(([k, v]) => [k, shortValue(v)]));
  const s = JSON.stringify(shallow);
  return s.length > PREVIEW_MAX ? `${s.slice(0, PREVIEW_MAX)}…` : s;
}

function kindOf(name) {
  if (name === 'fs.write' || name === 'fs.edit') return 'fs_edit';
  if (name === 'shell.run') return 'shell';
  if (name.startsWith('browser.')) return 'browser';
  return 'tool';
}

/**
 * The agent:approval-request payload.
 * @param {string} requestId
 * @param {{ call: any, class: string, origin: string, sessionId?: string, suggestedRule?: string|null, facts?: any, origins?: string[] }} prompt
 * @param {any} settings normalized agent settings
 */
function buildRequestPayload(requestId, prompt, settings) {
  const call = prompt.call || {};
  const name = String(call.name || '');
  const args = call.args && typeof call.args === 'object' ? call.args : {};
  const kind = kindOf(name);
  /** @type {Record<string, any>} */
  const payload = {
    requestId, call, class: prompt.class, origin: prompt.origin,
    sessionId: prompt.sessionId || null, kind, toolName: name,
    argsPreview: argsPreview(args), suggestedRule: prompt.suggestedRule || null,
  };
  if (Array.isArray(prompt.origins) && prompt.origins.length) payload.origins = prompt.origins.slice();
  if (kind === 'fs_edit') {
    const tool = fsTools.find((t) => t.name === name);
    const m = tool.previewMutation(args, { agentSettings: settings });
    payload.path = m.path;
    payload.diff = m.diff;
    if (m.error) payload.previewError = m.error;
  } else if (kind === 'shell') {
    payload.argv = Array.isArray(args.argv) ? args.argv.slice() : [];
    const facts = prompt.facts && prompt.facts.cwd ? prompt.facts : callFacts(call, settings);
    payload.cwd = facts.cwd || null;
  } else if (name.startsWith('fs.')) {
    payload.path = prompt.facts && prompt.facts.rel ? prompt.facts.rel : (typeof args.path === 'string' ? args.path : null);
  }
  return payload;
}

const MAX_PROMPT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * How long an approval prompt may stay open. timeoutMs 0 means no timer (the
 * prompt waits for the user or a cancel); a positive value applies, capped at
 * 24h, with timeoutReason; anything else falls back to `defaultMs`.
 * @param {{ timeoutMs?: number, timeoutReason?: string }} opts
 * @param {number} defaultMs
 * @returns {{ ms: number, reason: string }} ms 0 = no timer
 */
function promptTimeout(opts, defaultMs) {
  if (opts.timeoutMs === 0) return { ms: 0, reason: '' };
  const limit = Number(opts.timeoutMs);
  if (Number.isFinite(limit) && limit > 0) return { ms: Math.min(limit, MAX_PROMPT_TIMEOUT_MS), reason: opts.timeoutReason || 'timeout' };
  return { ms: defaultMs, reason: 'timeout' };
}

module.exports = { callFacts, buildRequestPayload, argsPreview, kindOf, promptTimeout };

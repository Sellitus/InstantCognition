// Harness profiles — per-model knobs for the agent loop.
//
// resolveProfile(model, endpoint, userProfiles) → {
//   toolFormat:  'native' (OpenAI tools/tool_calls) | 'json' (text JSON calls)
//                | 'auto' (no profile matched: negotiate on the first reply),
//   systemStyle: 'system' (send system messages as-is) | 'merge' (fold them
//                into the first user turn, for chat templates without a
//                system role),
//   streamSteps: stream every agent step when settings.llm.agent.streamSteps
//                is 'auto',
//   temperature: number, or null for the runtime default,
//   name:        the matched profile ('default' when none matched),
// }
//
// Built-ins match the model id's basename (a local model id is often a file
// path, and its folder names — "llama.cpp/models/…" — say nothing about the
// model). User profiles (settings.llm.agent.harness.profiles) match a
// picomatch glob, case-insensitively, against the full id or its basename,
// optionally narrowed by an `endpoint` glob; the first match wins and its
// fields override the built-in one field by field.

const picomatch = require('picomatch');

const TOOL_FORMATS = Object.freeze(['native', 'json']);
const SYSTEM_STYLES = Object.freeze(['system', 'merge']);

/**
 * @typedef {{ name: string, toolFormat: 'native'|'json'|'auto', systemStyle: 'system'|'merge', streamSteps: boolean, temperature: number|null }} HarnessProfile
 * @typedef {{ name: string, test: RegExp, toolFormat: 'native'|'json', systemStyle: 'system'|'merge', streamSteps: boolean }} BuiltInProfile
 */

/** @type {Readonly<HarnessProfile>} */
const DEFAULT_PROFILE = Object.freeze({ name: 'default', toolFormat: 'auto', systemStyle: 'system', streamSteps: false, temperature: null });

// Order matters: gpt-oss before gpt.
/** @type {ReadonlyArray<BuiltInProfile>} */
const BUILT_INS = Object.freeze([
  { name: 'gpt-oss', test: /gpt-oss/i, toolFormat: 'native', systemStyle: 'system', streamSteps: true },
  { name: 'gemma', test: /gemma/i, toolFormat: 'json', systemStyle: 'merge', streamSteps: false },
  { name: 'qwen', test: /qwen|qwq/i, toolFormat: 'json', systemStyle: 'system', streamSteps: false },
  { name: 'llama', test: /llama/i, toolFormat: 'json', systemStyle: 'system', streamSteps: false },
  { name: 'mistral', test: /mistral|mixtral|devstral|magistral|codestral|ministral/i, toolFormat: 'native', systemStyle: 'system', streamSteps: true },
  { name: 'gpt', test: /gpt|^o[1-9](-|$)/i, toolFormat: 'native', systemStyle: 'system', streamSteps: true },
  { name: 'claude', test: /claude/i, toolFormat: 'native', systemStyle: 'system', streamSteps: true },
]);

const MAX_GLOB = 200;

function baseName(id) {
  const parts = String(id).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function builtInFor(model) {
  const name = baseName(model);
  if (!name) return null;
  return BUILT_INS.find((p) => p.test.test(name)) || null;
}

function globMatches(glob, values) {
  if (typeof glob !== 'string' || !glob || glob.length > MAX_GLOB) return false;
  const isMatch = picomatch(glob, { nocase: true, dot: true, nonegate: true });
  return values.some((v) => v && isMatch(v));
}

/**
 * Only the well-formed fields of a user profile; anything else falls through.
 * @returns {Partial<HarnessProfile>}
 */
function userFields(p) {
  /** @type {Partial<HarnessProfile>} */
  const out = {};
  if (TOOL_FORMATS.includes(p.toolFormat)) out.toolFormat = p.toolFormat;
  if (SYSTEM_STYLES.includes(p.systemStyle)) out.systemStyle = p.systemStyle;
  if (typeof p.streamSteps === 'boolean') out.streamSteps = p.streamSteps;
  if (typeof p.temperature === 'number' && Number.isFinite(p.temperature) && p.temperature >= 0 && p.temperature <= 2) out.temperature = p.temperature;
  return out;
}

function userProfileFor(model, endpoint, userProfiles) {
  if (!Array.isArray(userProfiles)) return null;
  const ids = [String(model || ''), baseName(model || '')];
  return userProfiles.find((p) => p && typeof p === 'object'
    && globMatches(p.match, ids)
    && (p.endpoint === undefined || globMatches(p.endpoint, [String(endpoint || '')]))) || null;
}

/**
 * @param {string|null|undefined} model
 * @param {string|null|undefined} endpoint
 * @param {any[]} [userProfiles]
 * @returns {HarnessProfile}
 */
function resolveProfile(model, endpoint, userProfiles) {
  const builtIn = builtInFor(model || '');
  /** @type {HarnessProfile} */
  const base = builtIn
    ? { ...DEFAULT_PROFILE, name: builtIn.name, toolFormat: builtIn.toolFormat, systemStyle: builtIn.systemStyle, streamSteps: builtIn.streamSteps }
    : { ...DEFAULT_PROFILE };
  const user = userProfileFor(model, endpoint, userProfiles);
  if (!user) return base;
  return { ...base, ...userFields(user), name: typeof user.name === 'string' && user.name ? user.name : `user:${user.match}` };
}

/**
 * settings.llm.agent.streamSteps ('auto' | 'on' | 'off') against the profile.
 * @param {any} setting @param {{ streamSteps: boolean }} profile
 */
function shouldStreamSteps(setting, profile) {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return !!(profile && profile.streamSteps);
}

/** Runtime protocol mode for a profile's tool format; null keeps negotiation. */
function runtimeModeFor(profile) {
  if (!profile) return null;
  if (profile.toolFormat === 'native') return 'tools';
  if (profile.toolFormat === 'json') return 'json';
  return null;
}

module.exports = { resolveProfile, shouldStreamSteps, runtimeModeFor, DEFAULT_PROFILE, BUILT_INS };

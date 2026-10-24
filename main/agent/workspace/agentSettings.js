// agentSettings — typed view of settings.llm.agent.{permissions,workspace,
// shell,instructions}. Each block is layered over DEFAULT_LLM_SETTINGS.agent so
// a hand-edited config with a missing or mistyped key falls back to the
// shipped (safe) value instead of disabling a guard.

const { DEFAULT_LLM_SETTINGS } = require('../../../shared/llmDefaults');

const D = DEFAULT_LLM_SETTINGS.agent;
const PERMISSION_MODES = Object.freeze(['ask', 'auto-edit', 'plan', 'bypass']);

function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
function strList(v, fallback) { return Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s) : fallback.slice(); }
function posInt(v, fallback) { return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback; }

/** @param {any} raw settings.llm.agent as stored */
function normalize(raw) {
  const a = obj(raw);
  const perm = obj(a.permissions);
  const rules = obj(perm.rules);
  const ws = obj(a.workspace);
  const sh = obj(a.shell);
  const ins = obj(a.instructions);
  return {
    permissions: {
      mode: PERMISSION_MODES.includes(perm.mode) ? perm.mode : D.permissions.mode,
      rules: {
        allow: strList(rules.allow, D.permissions.rules.allow),
        ask: strList(rules.ask, D.permissions.rules.ask),
        deny: strList(rules.deny, D.permissions.rules.deny),
      },
    },
    workspace: {
      roots: strList(ws.roots, D.workspace.roots),
      protectedGlobs: strList(ws.protectedGlobs, D.workspace.protectedGlobs),
      maxReadBytes: posInt(ws.maxReadBytes, D.workspace.maxReadBytes),
      maxWriteBytes: posInt(ws.maxWriteBytes, D.workspace.maxWriteBytes),
    },
    shell: {
      enabled: typeof sh.enabled === 'boolean' ? sh.enabled : D.shell.enabled,
      defaultTimeoutMs: posInt(sh.defaultTimeoutMs, D.shell.defaultTimeoutMs),
      maxTimeoutMs: posInt(sh.maxTimeoutMs, D.shell.maxTimeoutMs),
      maxOutputBytes: posInt(sh.maxOutputBytes, D.shell.maxOutputBytes),
      envAllow: strList(sh.envAllow, D.shell.envAllow),
    },
    instructions: {
      enabled: typeof ins.enabled === 'boolean' ? ins.enabled : D.instructions.enabled,
      maxBytes: posInt(ins.maxBytes, D.instructions.maxBytes),
    },
  };
}

/** @param {{ get: (k: string, d?: any) => any } | null | undefined} configService */
function readAgentSettings(configService) {
  if (!configService || typeof configService.get !== 'function') return normalize({});
  return normalize(configService.get('settings.llm.agent', {}));
}

// Tools read toolCtx.agentSettings when the host supplies it, else the live
// config. Required lazily: ConfigService touches electron paths at load.
function settingsFor(toolCtx) {
  if (toolCtx && toolCtx.agentSettings) return normalize(toolCtx.agentSettings);
  return readAgentSettings(require('../../services/ConfigService'));
}

module.exports = { PERMISSION_MODES, normalize, readAgentSettings, settingsFor };

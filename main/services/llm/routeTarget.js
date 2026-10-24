// routeTarget — per-target endpoint/auth/model resolution for LLM chat calls.
// Credentials are keyed to the target URL, not global engine status: a local
// engine and a configured remote can coexist (dual state) without leaking one's
// auth header into the other's traffic, which is what makes draft/verify
// routing work regardless of which endpoint getEndpoint() currently resolves.

function normalize(raw) {
  // Mirrors LLMManager.setRemoteEndpoint / client _resolveEndpoint so both sides compare canonical even if a caller passed an untrimmed form. Idempotent on already-normalized input (the common case).
  return String(raw || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

// True when the resolved target base is exactly the configured remote endpoint.
function targetIsRemote(targetBase, remoteCfg) {
  const a = normalize(targetBase);
  if (!a || !remoteCfg) return false;
  return a === normalize(remoteCfg.endpoint);
}

// Authorization for one request: Bearer key attaches ONLY when the resolved
// URL is itself the configured remote endpoint. Local targets get no auth.
function targetAuthHeaders(targetBase, remoteCfg) {
  const headers = { 'Content-Type': 'application/json' };
  if (targetIsRemote(targetBase, remoteCfg) && remoteCfg.apiKey) {
    headers.Authorization = `Bearer ${remoteCfg.apiKey}`;
  }
  return headers;
}

// Model fallback when the caller didn't pin one: a target that IS the remote
// endpoint uses its configured model id (server validates it against loaded);
// anything else falls back to status.model || 'local'. The explicit `options.model` always wins upstream, before this is consulted.
function resolveDefaultModel(targetBase, statusModel, remoteCfg) {
  if (targetIsRemote(targetBase, remoteCfg)) return (remoteCfg && remoteCfg.model) || 'local';
  return statusModel || 'local';
}

module.exports = { normalize, targetIsRemote, targetAuthHeaders, resolveDefaultModel };

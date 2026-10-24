// PermissionPromptService.js — Mediator for per-origin permission prompts.
//
// `PermissionService.decide()` may return the sentinel string 'prompt' to
// signal that the user should be asked. This service hands control to the
// renderer (which shows a modal), then resolves with the user's choice.
//
// Concurrent duplicate prompts for the same `(origin, permission)` pair are
// coalesced — they share a single outstanding Promise so the user sees one
// prompt, not N.
//
// A prompt nobody answers is denied after PROMPT_TIMEOUT_MS, so the page's
// permission request always settles.
//
// Events:
//   'prompt'  ({id, origin, permission, detail, ephemeral})  — ask renderer to render
//              the UI; ephemeral marks a private-session request, remembered only in memory
//   'resolved' ({id, decision, origin, permission}) — the prompt is settled; the
//              renderer drops it if it is still shown or queued

const { EventEmitter } = require('events');
const { onRendererReset } = require('../utils/rendererReset');

const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

let _counter = 0;
function nextId() {
  _counter += 1;
  return 'perm-' + Date.now().toString(36) + '-' + _counter.toString(36);
}

class PermissionPromptService extends EventEmitter {
  constructor() {
    super();
    this._pending = new Map();       // id -> {origin, permission, ephemeral, resolve, timer}
    this._inflightByKey = new Map(); // "[private|]origin|permission" -> Promise<'allow'|'deny'>
    this._permissionService = null;
  }

  /** @param {{ permissionService?: typeof import('./PermissionService') }} [deps] */
  initialize({ permissionService } = {}) {
    this._permissionService = permissionService || null;
  }

  // Returns Promise<'allow'|'deny'>. If `remember` is set via resolve(), the
  // decision is persisted to PermissionService overrides for future requests.
  // `detail` is extra text the prompt shows verbatim (the target of an external link).
  // An `ephemeral` request comes from the private session; its answer must not
  // be shared with a normal-session prompt for the same site.
  requestDecision(origin, permission, detail, { ephemeral = false } = {}) {
    const safeOrigin = origin || '*';
    const key = (ephemeral ? 'private|' : '') + safeOrigin + '|' + permission;
    if (this._inflightByKey.has(key)) return this._inflightByKey.get(key);

    const promise = new Promise((resolve) => {
      const id = nextId();
      const timer = setTimeout(() => this.resolve(id, 'deny', false), PROMPT_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      this._pending.set(id, { origin: safeOrigin, permission, ephemeral, resolve, timer });
      this.emit('prompt', { id, origin: safeOrigin, permission, detail: typeof detail === 'string' ? detail : undefined, ephemeral });
    });
    this._inflightByKey.set(key, promise);
    // Clean up the inflight map after the promise settles.
    promise.then(() => { this._inflightByKey.delete(key); },
                 () => { this._inflightByKey.delete(key); });
    return promise;
  }

  // Called by IPC when the user responds. `decision` must be 'allow' or 'deny'.
  // If `remember` is true, persist the choice so future requests skip the prompt.
  resolve(id, decision, remember) {
    const entry = this._pending.get(id);
    if (!entry) return false;
    this._pending.delete(id);
    clearTimeout(entry.timer);
    const safeDecision = decision === 'allow' ? 'allow' : 'deny';
    if (remember && this._permissionService && typeof this._permissionService.setOverride === 'function') {
      // A failed save still answers this request; the user is asked again next time.
      try { this._permissionService.setOverride(entry.origin, entry.permission, safeDecision, { ephemeral: entry.ephemeral }); }
      catch (err) { console.error('[PermissionPromptService] could not remember the decision:', err); }
    }
    entry.resolve(safeDecision);
    this.emit('resolved', { id, decision: safeDecision, origin: entry.origin, permission: entry.permission });
    return true;
  }

  listPending() {
    return Array.from(this._pending.entries()).map(([id, v]) => ({
      id, origin: v.origin, permission: v.permission,
    }));
  }

  // A reloaded or crashed shell lost its prompt queue; deny so no page waits forever.
  denyOnRendererReset(webContents) {
    onRendererReset(webContents, () => this.denyAllPending());
  }

  // Force-deny everything pending: the renderer that showed the prompts
  // reloaded or crashed, or the app is shutting down.
  denyAllPending() {
    for (const [id] of this._pending.entries()) this.resolve(id, 'deny', false);
  }
}

module.exports = new PermissionPromptService();
module.exports.PROMPT_TIMEOUT_MS = PROMPT_TIMEOUT_MS;

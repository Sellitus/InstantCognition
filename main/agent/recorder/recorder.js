// recorder — records what the user does in a webview (clicks, typing,
// selects, submits, Enter/Escape, navigations) into a trace that
// traceToSkill turns into a SKILL.md draft.
//
// Capture runs over CDP through the shared CdpSessionManager: a Runtime
// binding receives events from the injected captureScript, and Page events
// supply navigations. Binding calls are accepted only from the main frame's
// default execution context, then re-validated and re-redacted here, because
// any page script can call the binding.
//
// One recording per webContents. stop() removes the injected script, the
// binding and the listeners, and detaches the debugger only when the
// recorder was the one that attached it (agent tools may share the session).

const crypto = require('crypto');
const defaultCdp = require('../../services/CdpSessionManager');
const { BINDING_NAME, REDACTED, CAPTURE_SOURCE, UNINSTALL_SOURCE } = require('./captureScript');
const { isSensitiveField } = require('./domDescribe');

const DEFAULT_MAX_EVENTS = 500;
const DEFAULT_MAX_BYTES = 256 * 1024;
const MAX_PAYLOAD_CHARS = 8192;
const MAX_URL = 2048;
const MAX_VALUE = 500;
const EVENT_TYPES = new Set(['click', 'input', 'change', 'submit', 'key']);
const STRATEGIES = new Set(['id', 'testid', 'aria-label', 'name', 'role', 'text', 'css']);
const KEYS = new Set(['Enter', 'Escape']);

const errMsg = (err) => (err instanceof Error && err.message) || String(err);
const cap = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');

function sanitizeTarget(t) {
  if (!t || typeof t !== 'object' || typeof t.selector !== 'string' || !t.selector) return null;
  return {
    selector: cap(t.selector, 300),
    strategy: STRATEGIES.has(t.strategy) ? t.strategy : 'css',
    tag: cap(t.tag, 20),
    role: cap(t.role, 40),
    name: cap(t.name, 80),
    text: cap(t.text, 80),
  };
}

/**
 * Validate one binding payload (a JSON string from the page) into a trace
 * event, or null when it is malformed. Values of sensitive fields are
 * redacted here as well as in the page.
 * @param {unknown} payload
 * @returns {object|null}
 */
function sanitizeEvent(payload) {
  if (typeof payload !== 'string' || payload.length > MAX_PAYLOAD_CHARS) return null;
  let raw;
  try { raw = JSON.parse(payload); } catch (_) { return null; }
  if (!raw || typeof raw !== 'object' || !EVENT_TYPES.has(raw.type)) return null;
  const target = sanitizeTarget(raw.target);
  if (!target) return null;
  const ev = { type: raw.type, target };
  if (raw.type === 'key') {
    if (!KEYS.has(raw.key)) return null;
    ev.key = raw.key;
  }
  if (raw.type === 'input' || raw.type === 'change') {
    const field = raw.field && typeof raw.field === 'object' ? raw.field : {};
    ev.fieldType = cap(field.type, 20);
    if (typeof raw.checked === 'boolean') ev.checked = raw.checked;
    else {
      // The selector often embeds the field's name/id (input[name="cc-number"]).
      const sensitive = raw.redacted === true || isSensitiveField(field) || isSensitiveField({ name: target.selector });
      ev.value = sensitive ? REDACTED : cap(raw.value, MAX_VALUE);
      if (sensitive) ev.redacted = true;
    }
  }
  return ev;
}

class Recorder {
  /**
   * @param {{ cdp?: any, now?: () => number, onEvent?: (e: object) => void, maxEvents?: number, maxBytes?: number }} [opts]
   */
  constructor(opts = {}) {
    this._cdp = opts.cdp || defaultCdp;
    this._now = opts.now || Date.now;
    this._onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    this._maxEvents = opts.maxEvents || DEFAULT_MAX_EVENTS;
    this._maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
    /** @type {Map<string, any>} */ this._byId = new Map();
    /** @type {Map<number, string>} */ this._byWc = new Map();
  }

  isRecording(webContentsId) { return this._byWc.has(webContentsId); }

  /**
   * Start recording `wc`. Throws on failure, after releasing anything it set up.
   * @param {any} wc Electron WebContents
   * @returns {Promise<{ id: string, startUrl: string, count: number }>}
   */
  async start(wc) {
    if (!wc || typeof wc.id !== 'number' || !wc.debugger) throw new Error('webcontents_unavailable');
    if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) throw new Error('webcontents_destroyed');
    if (this._byWc.has(wc.id)) throw new Error('already_recording');
    const attachedByUs = !this._cdp.isAttached(wc);
    this._cdp.attach(wc);
    const rec = {
      id: `rec_${crypto.randomBytes(8).toString('hex')}`, wc, wcId: wc.id, attachedByUs,
      startedAt: this._now(), startUrl: '', title: '', events: [], bytes: 0, truncated: false,
      mainFrameId: null, contexts: new Set(), scriptId: null, bindingAdded: false, ended: null, listener: null, onDestroyed: null,
    };
    rec.listener = (_e, method, params) => this._onMessage(rec, method, params || {});
    wc.debugger.on('message', rec.listener);
    this._byId.set(rec.id, rec);
    this._byWc.set(wc.id, rec.id);
    try {
      await this._cdp.send(wc, 'Page.enable');
      const tree = await this._cdp.send(wc, 'Page.getFrameTree');
      const frame = (tree && tree.frameTree && tree.frameTree.frame) || {};
      rec.mainFrameId = frame.id || null;
      rec.startUrl = cap(frame.url, MAX_URL);
      await this._cdp.send(wc, 'Runtime.enable');
      await this._cdp.send(wc, 'Runtime.addBinding', { name: BINDING_NAME });
      rec.bindingAdded = true;
      const added = await this._cdp.send(wc, 'Page.addScriptToEvaluateOnNewDocument', { source: CAPTURE_SOURCE });
      rec.scriptId = (added && added.identifier) || null;
      await this._cdp.send(wc, 'Runtime.evaluate', { expression: CAPTURE_SOURCE });
    } catch (err) {
      const cleanup = await this._release(rec);
      const e = new Error(`recorder_start_failed: ${errMsg(err)}`);
      if (cleanup.length) /** @type {any} */ (e).cleanupErrors = cleanup;
      throw e;
    }
    rec.title = typeof wc.getTitle === 'function' ? cap(wc.getTitle(), 200) : '';
    rec.onDestroyed = () => this._end(rec, 'destroyed');
    if (typeof wc.once === 'function') wc.once('destroyed', rec.onDestroyed);
    if (rec.startUrl) this._push(rec, { type: 'navigate', url: rec.startUrl });
    return { id: rec.id, startUrl: rec.startUrl, count: rec.events.length };
  }

  /**
   * Stop a recording and return its trace. Cleanup failures do not lose the
   * trace; they come back as warnings.
   * @param {string} id
   */
  async stop(id) {
    const rec = this._byId.get(id);
    if (!rec) throw new Error('not_recording');
    const warnings = rec.ended ? [] : await this._release(rec);
    this._byId.delete(id);
    return { trace: this._trace(rec), warnings };
  }

  /** Stop every recording (window teardown). Returns the traces. */
  async stopAll() {
    const out = [];
    for (const id of Array.from(this._byId.keys())) out.push(await this.stop(id));
    return out;
  }

  _trace(rec) {
    return {
      version: 1, id: rec.id, startedAt: rec.startedAt, endedAt: this._now(), startUrl: rec.startUrl, title: rec.title,
      truncated: rec.truncated, endReason: rec.ended || 'stopped', eventCount: rec.events.length, events: rec.events.slice(),
    };
  }

  _end(rec, reason) {
    if (rec.ended) return;
    rec.ended = reason;
    if (rec.listener && rec.wc.debugger) rec.wc.debugger.removeListener('message', rec.listener);
    this._byWc.delete(rec.wcId);
    this._emit(rec, null);
  }

  // Undo everything start() set up; returns the cleanup steps that failed.
  async _release(rec) {
    const failures = [];
    const step = async (label, fn) => {
      try { await fn(); } catch (err) { failures.push(`${label}: ${errMsg(err)}`); }
    };
    const wc = rec.wc;
    if (rec.listener && wc.debugger) wc.debugger.removeListener('message', rec.listener);
    if (rec.onDestroyed && typeof wc.removeListener === 'function') wc.removeListener('destroyed', rec.onDestroyed);
    this._byWc.delete(rec.wcId);
    this._byId.delete(rec.id);
    rec.ended = rec.ended || 'stopped';
    const alive = !(typeof wc.isDestroyed === 'function' && wc.isDestroyed());
    if (alive && this._cdp.isAttached(wc)) {
      if (rec.scriptId) await step('remove_script', () => this._cdp.send(wc, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: rec.scriptId }));
      if (rec.bindingAdded) {
        await step('uninstall', () => this._cdp.send(wc, 'Runtime.evaluate', { expression: UNINSTALL_SOURCE }));
        await step('remove_binding', () => this._cdp.send(wc, 'Runtime.removeBinding', { name: BINDING_NAME }));
      }
    }
    if (alive && rec.attachedByUs) this._cdp.detach(wc);
    return failures;
  }

  _onMessage(rec, method, params) {
    if (rec.ended) return;
    if (method === 'Runtime.executionContextCreated') {
      const ctx = params.context || {};
      const aux = ctx.auxData || {};
      if (aux.isDefault && aux.frameId && aux.frameId === rec.mainFrameId) rec.contexts.add(ctx.id);
    } else if (method === 'Runtime.executionContextDestroyed') {
      rec.contexts.delete(params.executionContextId);
    } else if (method === 'Runtime.executionContextsCleared') {
      rec.contexts.clear();
    } else if (method === 'Runtime.bindingCalled') {
      if (params.name !== BINDING_NAME || !rec.contexts.has(params.executionContextId)) return;
      const ev = sanitizeEvent(params.payload);
      if (ev) this._push(rec, ev);
    } else if (method === 'Page.frameNavigated') {
      const frame = params.frame || {};
      if (frame.parentId) return;
      rec.mainFrameId = frame.id || rec.mainFrameId;
      this._pushNavigation(rec, frame.url);
    } else if (method === 'Page.navigatedWithinDocument') {
      if (params.frameId === rec.mainFrameId) this._pushNavigation(rec, params.url);
    }
  }

  _pushNavigation(rec, url) {
    const u = cap(url, MAX_URL);
    if (!u) return;
    const last = rec.events[rec.events.length - 1];
    if (last && last.type === 'navigate' && last.url === u) return;
    this._push(rec, { type: 'navigate', url: u });
  }

  _push(rec, ev) {
    const stamped = { t: Math.max(0, this._now() - rec.startedAt), ...ev };
    const last = rec.events[rec.events.length - 1];
    // Typing fires one input event per keystroke; keep only the latest value.
    if (last && ev.type === 'input' && last.type === 'input' && last.target.selector === ev.target.selector) {
      rec.bytes -= JSON.stringify(last).length;
      rec.events[rec.events.length - 1] = stamped;
      rec.bytes += JSON.stringify(stamped).length;
      this._emit(rec, stamped);
      return;
    }
    if (rec.truncated) return;
    const size = JSON.stringify(stamped).length;
    if (rec.events.length >= this._maxEvents || rec.bytes + size > this._maxBytes) {
      rec.truncated = true;
      this._emit(rec, null);
      return;
    }
    rec.events.push(stamped);
    rec.bytes += size;
    this._emit(rec, stamped);
  }

  _emit(rec, event) {
    if (!this._onEvent) return;
    this._onEvent({
      id: rec.id, webContentsId: rec.wcId, count: rec.events.length, truncated: rec.truncated,
      ended: rec.ended, event,
    });
  }
}

module.exports = { Recorder, sanitizeEvent, DEFAULT_MAX_EVENTS, DEFAULT_MAX_BYTES };

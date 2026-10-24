// sessionGrants — "approve for session" state, scoped per session id so an
// approval in one session never reaches another session, routine or
// subagent. A missing session id (foreground run without a session) is its
// own bucket.

const NO_SESSION = '';
const EMPTY = new Set();

class SessionGrants {
  constructor() {
    /** @type {Map<string, { grants: Set<string>, rules: any[] }>} */
    this._bySession = new Map();
  }

  _key(sessionId) { return typeof sessionId === 'string' && sessionId ? sessionId : NO_SESSION; }

  _entry(sessionId) {
    const key = this._key(sessionId);
    let e = this._bySession.get(key);
    if (!e) { e = { grants: new Set(), rules: [] }; this._bySession.set(key, e); }
    return e;
  }

  /** `origin::class` grants of the session; read-only. @returns {{ has(key: string): boolean }} */
  grants(sessionId) {
    const e = this._bySession.get(this._key(sessionId));
    return e ? e.grants : EMPTY;
  }

  /** Parsed session rules of the session. */
  rules(sessionId) {
    const e = this._bySession.get(this._key(sessionId));
    return e ? e.rules.slice() : [];
  }

  addGrant(sessionId, key) { this._entry(sessionId).grants.add(key); }

  addRule(sessionId, parsedRule) { this._entry(sessionId).rules.push(parsedRule); }

  clear(sessionId) { this._bySession.delete(this._key(sessionId)); }

  clearAll() { this._bySession.clear(); }

  isEmpty() { return this._bySession.size === 0; }
}

module.exports = { SessionGrants };

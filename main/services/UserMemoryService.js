// UserMemoryService — persistent facts the agent knows about the user.
// Mirrors the singleton-with-bindConfig shape of PersonaService and
// QualityModeService. Storage lives in settings.userMemory.facts (config.json),
// so memory survives restart and is fully local.
//
// A fact is { id, text, createdAt, source, pinned, archived }.
//   - text       string, ≤300 chars (callers should pre-trim)
//   - source     'user' | 'auto' | 'imported' (auto reserved for future capture)
//   - pinned     bool — pinned facts go to the top of the prompt block
//   - archived   bool — archived facts are hidden from the prompt + the editor
//                       default view, but kept in the JSON for restore/undo

const MAX_FACTS_DEFAULT = 50;
const MAX_FACT_LEN = 300;
// Auto-capture asks the model to extract durable user facts (diet, tools,
// preferences, commitments) from a finished turn. The schema is deliberately
// small so cheap models fill it reliably. Category is kept on the fact for
// future grouping but not used for prompt ordering today.
const CAPTURE_SCHEMA = { facts: 'array' };
const CAPTURE_MAX_TURNS = 6;
const CAPTURE_FACT_BUDGET = 3;

function genId() {
  // Short, time-prefixed id; collision-resistant enough for ≤50 facts.
  return 'um_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function clampText(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > MAX_FACT_LEN ? t.slice(0, MAX_FACT_LEN) : t;
}

// Normalized form for dedupe: lowercase, collapsed whitespace, standalone
// articles (a/an/the) removed — so "user is a vegan" and "user is vegan"
// compare equal. Verbs (is/are) are kept; they carry meaning.
function _normFact(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim()
    .replace(/\b(a|an|the)\b/g, '').replace(/\s+/g, ' ').trim();
}

function sortForPrompt(facts) {
  // Pinned first, then most recently edited (or created).
  const score = (f) => (f.pinned ? 1e15 : 0) + (f.editedAt || f.createdAt || 0);
  return facts.slice().sort((a, b) => score(b) - score(a));
}

class UserMemoryService {
  constructor() {
    this._cs = null;
    this._llm = null; // LLMClientService — set lazily so the capture path can reuse chatCompletionJson
    this._capturing = 0;
  }

  bindConfig(configService) { this._cs = configService; }

  // True while an auto-capture request holds the engine. It starts as a reply
  // finishes, after the chat/agent busy flags drop, so an engine restart must
  // wait on this too or it cuts the request off and loses that turn's facts.
  isCapturing() { return this._capturing > 0; }

  // Test seam + lazy wiring. Production callers pass the LLMClientService
  // singleton; tests pass a test double exposing chatCompletionJson.
  setLLMClient(c) { this._llm = c; }
  _getLLM() {
    if (this._llm) return this._llm;
    try { this._llm = require('./LLMClientService'); } catch (_) { return null; }
    return this._llm;
  }

  _getCfg() {
    if (!this._cs) return { enabled: true, facts: [], maxFacts: MAX_FACTS_DEFAULT, autoCapture: false };
    const cfg = this._cs.get('settings.userMemory', {}) || {};
    return {
      enabled: cfg.enabled !== false,
      facts: Array.isArray(cfg.facts) ? cfg.facts : [],
      maxFacts: Number.isFinite(cfg.maxFacts) ? cfg.maxFacts : MAX_FACTS_DEFAULT,
      autoCapture: !!cfg.autoCapture,
    };
  }

  _setFacts(next) {
    if (!this._cs) return;
    const cfg = this._cs.get('settings.userMemory', {}) || {};
    this._cs.set('settings.userMemory', { ...cfg, facts: next });
  }

  isEnabled() { return this._getCfg().enabled; }

  enable(on) {
    if (!this._cs) return;
    const cfg = this._cs.get('settings.userMemory', {}) || {};
    this._cs.set('settings.userMemory', { ...cfg, enabled: !!on });
  }

  list({ includeArchived = false } = {}) {
    const facts = this._getCfg().facts;
    return includeArchived ? facts.slice() : facts.filter((f) => !f.archived);
  }

  add(text, { source = 'user', pinned = false } = {}) {
    const cleaned = clampText(text);
    if (!cleaned) return null;
    const cfg = this._getCfg();
    const entry = {
      id: genId(),
      text: cleaned,
      createdAt: Date.now(),
      editedAt: Date.now(),
      source: source === 'auto' || source === 'imported' ? source : 'user',
      pinned: !!pinned,
      archived: false,
    };
    // Newest first. If we exceed the cap, archive the oldest non-pinned fact.
    const next = [entry, ...cfg.facts];
    if (next.length > cfg.maxFacts) {
      // Find oldest non-pinned, non-archived to archive.
      const idx = next.map((f, i) => ({ f, i })).reverse()
        .find((x) => !x.f.pinned && !x.f.archived);
      if (idx) next[idx.i] = { ...next[idx.i], archived: true };
    }
    this._setFacts(next);
    return entry;
  }

  edit(id, patch) {
    if (!id || !patch || typeof patch !== 'object') return null;
    const facts = this._getCfg().facts.slice();
    const idx = facts.findIndex((f) => f && f.id === id);
    if (idx < 0) return null;
    const prev = facts[idx];
    const merged = { ...prev };
    if (typeof patch.text === 'string') merged.text = clampText(patch.text);
    if (typeof patch.pinned === 'boolean') merged.pinned = patch.pinned;
    if (typeof patch.archived === 'boolean') merged.archived = patch.archived;
    merged.editedAt = Date.now();
    facts[idx] = merged;
    this._setFacts(facts);
    return merged;
  }

  remove(id) {
    const facts = this._getCfg().facts;
    const next = facts.filter((f) => f && f.id !== id);
    if (next.length === facts.length) return false;
    this._setFacts(next);
    return true;
  }

  archive(id) { return this.edit(id, { archived: true }); }
  unarchive(id) { return this.edit(id, { archived: false }); }
  pin(id, on = true) { return this.edit(id, { pinned: !!on }); }

  clearAll() { this._setFacts([]); return true; }

  // Build the system-prompt block injected by openingMessages.js. Returns ''
  // when disabled, no facts, or all facts are archived. Pinned facts come
  // first, then chronological by editedAt.
  buildPromptBlock() {
    const cfg = this._getCfg();
    if (!cfg.enabled) return '';
    const live = cfg.facts.filter((f) => f && !f.archived && f.text);
    if (live.length === 0) return '';
    const sorted = sortForPrompt(live).slice(0, cfg.maxFacts);
    const lines = sorted.map((f) => `- ${f.text}`);
    return `User memory (persistent facts about the user — apply when relevant):\n${lines.join('\n')}`;
  }

  // Replace-all (used by import). validate = true skips garbage entries.
  replaceAll(facts, { validate = true } = {}) {
    if (!Array.isArray(facts)) return false;
    const cleaned = [];
    for (const f of facts) {
      if (!f || typeof f !== 'object') continue;
      const text = clampText(f.text);
      if (validate && !text) continue;
      cleaned.push({
        id: typeof f.id === 'string' && f.id ? f.id : genId(),
        text,
        createdAt: Number.isFinite(f.createdAt) ? f.createdAt : Date.now(),
        editedAt: Number.isFinite(f.editedAt) ? f.editedAt : (Number.isFinite(f.createdAt) ? f.createdAt : Date.now()),
        source: f.source === 'auto' || f.source === 'imported' ? f.source : 'user',
        pinned: !!f.pinned,
        archived: !!f.archived,
      });
    }
    this._setFacts(cleaned);
    return true;
  }

  // Auto-capture: after a finished turn, ask the model to pull out durable
  // facts about the user (not ephemeral task state) and persist any that are
  // new. No-op when autoCapture is off or memory is disabled. Returns the list
  // of facts actually added (empty when nothing was captured). Errors are
  // swallowed by design — capture is best-effort background work and must
  // never break the chat/agent flow that invoked it.
  /**
   * @param {{ messages?: Array<{role: string, content: string}>, prompt?: string, answer?: string }} opts
   * @returns {Promise<Array<object>>}
   */
  async capture({ messages, prompt, answer } = {}) {
    const cfg = this._getCfg();
    if (!cfg.enabled || !cfg.autoCapture) return [];
    const turns = Array.isArray(messages) ? messages : [];
    const userText = prompt != null ? String(prompt) : '';
    const assistantText = answer != null ? String(answer) : '';
    if (!turns.length && !userText && !assistantText) return [];
    const llm = this._getLLM();
    if (!llm || typeof llm.chatCompletionJson !== 'function') return [];
    const recent = turns.slice(-CAPTURE_MAX_TURNS)
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`);
    if (userText) recent.push(`USER: ${userText}`);
    if (assistantText) recent.push(`ASSISTANT: ${assistantText}`);
    if (!recent.length) return [];
    const extractionPrompt = [{
      role: 'system',
      content: 'Extract durable facts about the USER from the conversation. A durable fact is a stable preference, identity detail, tool, environment, goal, or recurring constraint — NOT a one-off task, a question, or a fact about the world. Examples: "user is a React developer", "user prefers TypeScript", "user is vegan", "user works on a Mac". Omit anything ephemeral or task-specific. Reply with ONLY a JSON object: {"facts":[{"text":"<short factual statement, third person, no quotes>","category":"preference|identity|tool|environment|goal|other"}]}. If there are no durable facts, reply {"facts":[]}.',
    }, {
      role: 'user',
      content: recent.join('\n\n'),
    }];
    let res;
    this._capturing += 1;
    try {
      res = await llm.chatCompletionJson(extractionPrompt, CAPTURE_SCHEMA, { temperature: 0, maxTokens: 512 });
    } catch (err) { console.error('[UserMemoryService] capture request failed:', (err instanceof Error && err.message) || err); return []; }
    finally { this._capturing -= 1; }
    if (!res || !res.ok || !res.value || !Array.isArray(res.value.facts)) return [];
    const existing = cfg.facts.filter((f) => !f.archived);
    const added = [];
    for (const raw of res.value.facts.slice(0, CAPTURE_FACT_BUDGET)) {
      if (!raw || typeof raw !== 'object') continue;
      const text = clampText(raw.text);
      if (!text) continue;
      // Dedupe against live facts by normalized substring containment —
      // lowercases, collapses whitespace, and strips leading articles so
      // "user is vegan" matches "user is a vegan" without exact equality.
      const dupe = existing.some((f) => _normFact(text) === _normFact(f.text)
        || _normFact(f.text).includes(_normFact(text)) || _normFact(text).includes(_normFact(f.text)))
        || added.some((a) => _normFact(a.text) === _normFact(text));
      if (dupe) continue;
      const entry = this.add(text, { source: 'auto' });
      if (entry) { existing.push(entry); added.push(entry); }
    }
    return added;
  }
}

const instance = new UserMemoryService();
module.exports = instance;
module.exports.UserMemoryService = UserMemoryService;
module.exports.MAX_FACTS_DEFAULT = MAX_FACTS_DEFAULT;
module.exports.MAX_FACT_LEN = MAX_FACT_LEN;

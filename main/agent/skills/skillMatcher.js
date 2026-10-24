// skillMatcher — decides which installed skills a request should auto-trigger.
//
// Each skill is a document built from its name, description, `when` and
// `triggers`. The request and each skill become TF-IDF vectors over that small
// corpus (smoothed IDF from semanticIdf) and score by cosine similarity, so a
// word every skill shares ("file", "page") counts for little. A skill whose
// trigger phrase appears verbatim in the request scores 1.

const { buildDfMap, idf } = require('../../services/semanticIdf');
const { DEFAULT_LLM_SETTINGS } = require('../../../shared/llmDefaults');

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'was', 'are', 'be', 'about',
  'that', 'this', 'it', 'i', 'my', 'me', 'you', 'your', 'with', 'use', 'when', 'what', 'how', 'can',
  'please', 'skill', 'from', 'into', 'by', 'at', 'as', 'do', 'any', 'some',
]);
const DEFAULTS = DEFAULT_LLM_SETTINGS.agent.skills;

function tokenize(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function skillText(skill) {
  return [String(skill.name || '').replace(/-/g, ' '), skill.description, skill.when, (skill.triggers || []).join(' ')]
    .filter((x) => typeof x === 'string' && x).join(' ');
}

function vector(terms, dfMap, docCount) {
  const tf = new Map();
  for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
  const vec = new Map();
  for (const [t, n] of tf) vec.set(t, n * idf(t, dfMap, docCount));
  return vec;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [t, w] of a) { na += w * w; if (b.has(t)) dot += w * /** @type {number} */ (b.get(t)); }
  for (const w of b.values()) nb += w * w;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function triggerHit(skill, queryNorm) {
  return (skill.triggers || []).some((t) => {
    const phrase = tokenize(t).join(' ');
    return phrase && ` ${queryNorm} `.includes(` ${phrase} `);
  });
}

/**
 * Rank skills against a request.
 * @param {string} query
 * @param {Array<{name:string, description?:string, when?:string, triggers?:string[]}>} skills
 * @param {{ threshold?: number, limit?: number }} [opts]
 * @returns {Array<{ name: string, score: number, reason: 'trigger'|'similarity' }>}
 */
function matchSkills(query, skills, opts = {}) {
  const threshold = Number.isFinite(opts.threshold) ? Number(opts.threshold) : DEFAULTS.matchThreshold;
  const limit = Number.isInteger(opts.limit) && Number(opts.limit) > 0 ? Number(opts.limit) : 3;
  const list = Array.isArray(skills) ? skills.filter((s) => s && typeof s.name === 'string') : [];
  const qTerms = tokenize(query);
  if (!list.length || !qTerms.length) return [];
  const docs = list.map((s) => tokenize(skillText(s)));
  const dfMap = buildDfMap(docs.map((d) => new Set(d)));
  const qVec = vector(qTerms, dfMap, docs.length);
  const queryNorm = qTerms.join(' ');
  const out = [];
  list.forEach((skill, i) => {
    if (triggerHit(skill, queryNorm)) out.push({ name: skill.name, score: 1, reason: 'trigger' });
    else {
      const score = cosine(qVec, vector(docs[i], dfMap, docs.length));
      if (score >= threshold) out.push({ name: skill.name, score, reason: 'similarity' });
    }
  });
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** settings.llm.agent.skills with shipped defaults for missing or mistyped keys. */
function readSkillSettings(configService) {
  const raw = configService && typeof configService.get === 'function'
    ? configService.get('settings.llm.agent.skills', {}) : {};
  const s = raw && typeof raw === 'object' ? raw : {};
  const t = Number(s.matchThreshold);
  return {
    autoTrigger: typeof s.autoTrigger === 'boolean' ? s.autoTrigger : DEFAULTS.autoTrigger,
    matchThreshold: Number.isFinite(t) && t >= 0 && t <= 1 ? t : DEFAULTS.matchThreshold,
  };
}

module.exports = { matchSkills, readSkillSettings, tokenize };

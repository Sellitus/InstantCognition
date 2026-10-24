// searchIndex — pure helpers for filtering the settings registry.
//
// At registry build time, every setting gets a precomputed lowercased blob
// (title + description + synonyms + keywords + category + section title)
// that the row exposes via `data-search`. At query time we tokenize the
// query (whitespace-split, lowercase), AND-match every token against the
// blob, and rank the survivors with a small scoring function so `Enter`
// can jump to the most relevant hit.
//
// No LLM in the hot path — discoverability is the synonyms list's job.

function buildBlob(section, setting) {
  const parts = [];
  const push = (s) => { if (s) parts.push(String(s)); };

  push(setting.title);
  push(setting.description);
  push(setting.category);
  push(section && section.title);
  push(section && section.id);
  push(setting.id);
  push(setting.path);

  if (Array.isArray(setting.synonyms)) for (const s of setting.synonyms) push(s);
  if (Array.isArray(setting.keywords)) for (const s of setting.keywords) push(s);

  // Option labels are part of the searchable text — typing "duckduckgo" should
  // match the search-engine select even though the field title is "Default
  // search engine".
  if (Array.isArray(setting.options)) {
    for (const o of setting.options) { push(o && o.label); push(o && o.value); push(o && o.hint); }
  }

  return parts.join(' ').toLowerCase();
}

function tokenize(query) {
  if (!query || typeof query !== 'string') return [];
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function matches(blob, tokens) {
  if (!tokens.length) return true;
  if (!blob) return false;
  for (const t of tokens) if (!blob.includes(t)) return false;
  return true;
}

// Higher = better. Title-start > title-substring > synonym > description > keywords.
// Section title hits add a small bonus so multi-token queries land in the
// right section ("appearance theme" → Appearance > Theme).
function score(setting, section, tokens) {
  if (!tokens.length) return 0;
  const title = String(setting.title || '').toLowerCase();
  const synonyms = (setting.synonyms || []).join(' ').toLowerCase();
  const description = String(setting.description || '').toLowerCase();
  const keywords = (setting.keywords || []).join(' ').toLowerCase();
  const sectionTitle = String((section && section.title) || '').toLowerCase();

  let s = 0;
  let allTitleStart = true;
  let allTitle = true;
  let allSynonym = true;
  let allDescription = true;
  let allKeywords = true;

  for (const t of tokens) {
    if (!startsAtWord(title, t)) allTitleStart = false;
    if (!title.includes(t)) allTitle = false;
    if (!synonyms.includes(t)) allSynonym = false;
    if (!description.includes(t)) allDescription = false;
    if (!keywords.includes(t)) allKeywords = false;
    if (sectionTitle.includes(t)) s += 20;
  }

  if (allTitleStart) s += 100;
  else if (allTitle) s += 50;
  if (allSynonym) s += 25;
  if (allDescription) s += 10;
  if (allKeywords) s += 5;

  return s;
}

function startsAtWord(haystack, token) {
  if (!haystack || !token) return false;
  if (haystack.startsWith(token)) return true;
  return haystack.includes(' ' + token);
}

// Wrap matched substrings with `<mark>`. Cap to a small number of marks per
// row so we don't bloat the DOM on long descriptions. Caller is responsible
// for not feeding HTML — this assumes plain text input.
function highlight(text, tokens, maxMarks = 3) {
  if (!text) return '';
  if (!tokens || !tokens.length) return escape(text);
  // Sort tokens by length desc so longer matches win when tokens overlap.
  const sorted = [...new Set(tokens)].sort((a, b) => b.length - a.length).filter(Boolean);
  if (!sorted.length) return escape(text);
  const lower = text.toLowerCase();
  const ranges = [];
  for (const t of sorted) {
    let from = 0;
    while (true) {
      const idx = lower.indexOf(t, from);
      if (idx === -1) break;
      ranges.push([idx, idx + t.length]);
      from = idx + t.length;
      if (ranges.length > maxMarks * 4) break; // generous cap; merging trims
    }
  }
  if (!ranges.length) return escape(text);
  ranges.sort((a, b) => a[0] - b[0]);
  // Merge overlapping/adjacent ranges.
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    const cur = ranges[i];
    if (cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1]);
    else merged.push(cur);
  }
  const limited = merged.slice(0, maxMarks);
  let out = '';
  let cursor = 0;
  for (const [a, b] of limited) {
    if (a > cursor) out += escape(text.slice(cursor, a));
    out += '<mark>' + escape(text.slice(a, b)) + '</mark>';
    cursor = b;
  }
  if (cursor < text.length) out += escape(text.slice(cursor));
  return out;
}

function escape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Filter a registry array. Returns { sections: [...], totalMatches, top }
// where each section is { ...section, settings: SettingDef[] } with only the
// matching settings. Sections with zero matches are dropped.
function filter(registry, query) {
  const tokens = tokenize(query);
  const out = [];
  let total = 0;
  let top = null;
  let topScore = -1;
  for (const section of registry || []) {
    const survivors = [];
    for (const setting of section.settings || []) {
      const blob = setting._search || buildBlob(section, setting);
      if (!matches(blob, tokens)) continue;
      survivors.push(setting);
      total += 1;
      const sc = score(setting, section, tokens);
      if (sc > topScore) { topScore = sc; top = { section, setting, score: sc }; }
    }
    if (survivors.length) out.push({ ...section, settings: survivors });
  }
  return { sections: out, totalMatches: total, top };
}

module.exports = { buildBlob, tokenize, matches, score, highlight, filter, escape };

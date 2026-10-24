// semanticIdf — pure IDF helpers for SemanticIndexService. Extracted to keep
// the service under its line-count cap. No service wiring, no state, no
// imports (callers pass pre-tokenized term sets to avoid a circular require).

// docTermSets: array of Set<string> — the distinct terms per document.
// Returns Map<term, docCount> — how many docs contain each term at least once.
function buildDfMap(docTermSets) {
  const map = new Map();
  for (const terms of docTermSets) {
    for (const t of terms) map.set(t, (map.get(t) || 0) + 1);
  }
  return map;
}

// Smoothed IDF (log(1 + N/df)) — plain log(N/df) zeroes the signal for terms
// present in every doc, which is common in small personal corpora.
function idf(term, dfMap, docCount) {
  const df = dfMap.get(term) || 0;
  if (!df || docCount <= 1) return 1;
  return Math.log(1 + docCount / df);
}

module.exports = { buildDfMap, idf };

// PersonaService — catalog of agent personas (system-prompt overlays) plus
// resolve/merge plumbing. Layered ON TOP of QualityModeService — a persona
// suggests a qualityOverride, but the user's explicit quality choice always
// wins. Mirrors the shape of QualityModeService for consistency.
//
// A persona is flat config: name + label + systemOverlay + optional override.
// User-editable bits (enabled, notes, starterTabs, qualityOverride) live in
// settings.agentPersonas.builtinOverrides[name]. Custom user-defined personas
// live in settings.agentPersonas.customPersonas (full schema, not partial).

const { withOverride: withQualityOverride } = require('./QualityModeService');

const PERSONAS = {
  default: {
    name: 'default', label: 'Default', builtin: true,
    description: 'Direct, source-cited answers when no other persona fits.',
    systemOverlay: 'Be direct. Cite sources inline as you find them.',
    qualityOverride: null,
    starterTabs: [], notes: '', enabled: true,
    followUps: ['Tell me more', 'Find counter-evidence'],
  },
  explore: {
    name: 'explore', label: 'Explore', builtin: true,
    description: 'Open-ended browsing — answers always include hyperlinks.',
    systemOverlay: 'Browse broadly. Final summary MUST include clickable hyperlinks to every source so the user can click through. Format: bullet list with title + 1-line takeaway + (link).',
    qualityOverride: null,
    starterTabs: [], notes: '', enabled: true,
    followUps: ['Dig deeper into one of these', 'Show me related topics'],
  },
  research: {
    name: 'research', label: 'Research', builtin: true,
    description: 'Compare multiple primary sources, flag disagreement.',
    systemOverlay: 'Read multiple primary sources before concluding. Include a "Confidence" line at the end (low / medium / high) and explicitly flag where sources disagree. Prefer official docs, papers, and primary reporting over blog posts.',
    qualityOverride: { name: 'balanced', budget: { maxSteps: 50 } },
    starterTabs: [], notes: '', enabled: true,
    followUps: ['Find counter-evidence', 'Cite sources', 'What would change my mind?'],
  },
  shop: {
    name: 'shop', label: 'Shopping', builtin: true,
    description: 'Comparison-table answers with prices and store links.',
    systemOverlay: 'Output a markdown comparison table with columns: Model, Price, Store, Key spec, Link. End with a one-line recommendation explaining the trade-off. If a price is missing, write "—" instead of guessing.',
    qualityOverride: null,
    starterTabs: [], notes: '', enabled: true,
    followUps: ['Compare with similar models', 'Find used / refurbished', 'What about reviews?'],
  },
  code: {
    name: 'code', label: 'Code', builtin: true,
    description: 'Code-aware answers — official docs, fenced blocks, repros.',
    systemOverlay: 'Prefer official documentation over blog posts. Wrap code in fenced blocks with language tags. If a fix involves code, output a minimal reproduction. If diagnosing an error, name the root cause before suggesting a fix.',
    qualityOverride: null,
    starterTabs: [], notes: '', enabled: true,
    followUps: ['Show alternative approach', 'Generate tests', 'Explain the root cause'],
  },
  reddit: {
    name: 'reddit', label: 'Reddit', builtin: true,
    description: 'Subreddit-aware top-of-week summarization.',
    systemOverlay: 'STRONGLY prefer old.reddit.com over reddit.com — old.reddit serves content in the initial HTML so browser.read_tab returns real text instead of an empty SPA shell. For each subreddit visit https://old.reddit.com/r/<sub>/top/?t=week. To open a specific post, click the title link from snapshot_ax (don\'t fabricate URLs). Summarize as: title — 1-line takeaway — (link). Skip removed/deleted/[unavailable] posts. If the user named subreddits, prioritize those; otherwise pick the most relevant ones.',
    qualityOverride: { name: 'efficient', budget: { maxSteps: 60 } },
    starterTabs: [{ url: 'https://old.reddit.com/r/popular/top/?t=week' }],
    notes: '', enabled: true,
    followUps: ['Get a digest of these', 'Open all of these in tabs', 'What are people arguing about?'],
  },
  news: {
    name: 'news', label: 'News', builtin: true,
    description: 'Last-24-hour reporting with publish-date tagging.',
    systemOverlay: 'Prioritize sources from the last 24 hours. Tag each finding with its publish date (YYYY-MM-DD). If you cannot find anything from the past 24 hours, say so explicitly and broaden to the past week with a note.',
    qualityOverride: { name: 'efficient' },
    starterTabs: [], notes: '', enabled: true,
    followUps: ['Get the broader context', 'Why does this matter?'],
  },
  quick: {
    name: 'quick', label: 'Quick', builtin: true,
    description: 'One-paragraph answers, minimal tool use, for short prompts.',
    systemOverlay: 'Answer in one paragraph (max 4 sentences). Skip tool calls if the answer is general knowledge. If you must look something up, do ONE read and summarize.',
    qualityOverride: { name: 'efficient', budget: { maxSteps: 3 } },
    starterTabs: [], notes: '', enabled: true,
    followUps: ['Tell me more', 'Show sources'],
  },
};

const BUILTIN_NAMES = Object.keys(PERSONAS);

function isBuiltin(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(PERSONAS, name);
}

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

function resolveBuiltin(name) {
  if (!isBuiltin(name)) return deepClone(PERSONAS.default);
  return deepClone(PERSONAS[name]);
}

// Apply an override patch (partial fields) to a persona. Mirrors QualityModeService.withOverride.
function withPersonaOverride(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = { ...base };
  for (const k of Object.keys(patch)) {
    if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k])) {
      out[k] = { ...(base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? base[k] : {}), ...patch[k] };
    } else if (patch[k] !== undefined) {
      out[k] = patch[k];
    }
  }
  return out;
}

class PersonaService {
  constructor() { this._getCfg = null; }

  bindConfig(configService) {
    this._getCfg = () => {
      const cfg = configService.get('settings.agentPersonas', {}) || {};
      return {
        enabledPersonas: Array.isArray(cfg.enabledPersonas) ? cfg.enabledPersonas : BUILTIN_NAMES.slice(),
        routerEnabled: cfg.routerEnabled !== false,
        routerLLMFallback: cfg.routerLLMFallback !== false,
        customPersonas: Array.isArray(cfg.customPersonas) ? cfg.customPersonas : [],
        builtinOverrides: cfg.builtinOverrides && typeof cfg.builtinOverrides === 'object' ? cfg.builtinOverrides : {},
      };
    };
  }

  // Return a fully-resolved persona by name. Layers user overrides for built-ins;
  // returns a custom persona if the name matches; falls back to 'default' on miss.
  resolve(name) {
    const cfg = this._getCfg ? this._getCfg() : null;
    if (isBuiltin(name)) {
      const base = resolveBuiltin(name);
      if (cfg && cfg.builtinOverrides[name]) return withPersonaOverride(base, cfg.builtinOverrides[name]);
      return base;
    }
    if (cfg && Array.isArray(cfg.customPersonas)) {
      const found = cfg.customPersonas.find((p) => p && p.name === name);
      if (found) return { ...resolveBuiltin('default'), ...deepClone(found), builtin: false };
    }
    return resolveBuiltin('default');
  }

  // Return all personas the user has enabled (in display order). Built-ins first,
  // then custom. Each entry is a fully-resolved persona ready to display in a picker.
  listEnabled() {
    const cfg = this._getCfg ? this._getCfg() : null;
    const enabled = cfg ? cfg.enabledPersonas : BUILTIN_NAMES.slice();
    const out = [];
    for (const name of BUILTIN_NAMES) {
      if (!enabled.includes(name)) continue;
      const p = this.resolve(name);
      if (p.enabled !== false) out.push(p);
    }
    if (cfg) {
      for (const cp of cfg.customPersonas) {
        if (!cp || !cp.name || isBuiltin(cp.name)) continue; // custom can't shadow built-in
        if (!enabled.includes(cp.name)) continue;
        const p = this.resolve(cp.name);
        if (p.enabled !== false) out.push(p);
      }
    }
    return out;
  }

  // Picker view: built-ins (always listed, even if disabled) + custom. Used by the
  // settings editor; routing/picker UIs use listEnabled() instead.
  listAll() {
    const out = BUILTIN_NAMES.map((n) => this.resolve(n));
    const cfg = this._getCfg ? this._getCfg() : null;
    if (cfg) {
      for (const cp of cfg.customPersonas) {
        if (!cp || !cp.name || isBuiltin(cp.name)) continue;
        out.push(this.resolve(cp.name));
      }
    }
    return out;
  }

  // Merge a persona's qualityOverride on top of the active QualityMode object
  // produced by QualityModeService.resolve(). Returns a new mode object — does
  // not mutate. Persona override is layered ABOVE skill override (skill > persona).
  mergeQuality(qualityMode, persona) {
    if (!persona || !persona.qualityOverride) return qualityMode;
    return withQualityOverride(qualityMode, persona.qualityOverride);
  }

  // Router-config getters (read-only convenience).
  isRouterEnabled() { const c = this._getCfg ? this._getCfg() : null; return c ? c.routerEnabled : true; }
  isLLMFallbackEnabled() { const c = this._getCfg ? this._getCfg() : null; return c ? c.routerLLMFallback : true; }
  enabledNames() { const c = this._getCfg ? this._getCfg() : null; return c ? c.enabledPersonas.slice() : BUILTIN_NAMES.slice(); }
}

const instance = new PersonaService();
module.exports = instance;
module.exports.PersonaService = PersonaService;
module.exports.PERSONAS = PERSONAS;
module.exports.BUILTIN_NAMES = BUILTIN_NAMES;
module.exports.isBuiltin = isBuiltin;
module.exports.resolveBuiltin = resolveBuiltin;
module.exports.withPersonaOverride = withPersonaOverride;

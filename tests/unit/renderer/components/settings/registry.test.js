// Registry sanity: every entry has a unique id, a valid type, and any dotted
// `path` resolves to a defined key under DEFAULT_CONFIG. This guards against
// typo-style drift between the registry and the actual config schema.

// customModules is required for the renderModule-resolution test. It mounts
// LLMTab/PermissionsTab lazily and reads `electron` at module load — stub it
// so requiring the module here (node env) doesn't blow up.
jest.mock('electron', () => ({
  ipcRenderer: { send: jest.fn(), on: jest.fn(), removeListener: jest.fn(), invoke: jest.fn(() => Promise.resolve(null)) },
}), { virtual: true });

const {
  REGISTRY, ROWS, GROUPS, PAGES, ALIASES, buildRegistry, resolvePage,
} = require('../../../../../renderer/components/settings/registry');
const { SIDE_EFFECT_NAMES } = require('../../../../../renderer/components/settings/sideEffects');
const { DYNAMIC_OPTION_SOURCES } = require('../../../../../renderer/components/settings/dynamicOptions');
const { DEFAULT_CONFIG } = require('../../../../../shared/configDefaults');
const customModules = require('../../../../../renderer/components/settings/customModules');

function sectionById(id) {
  return REGISTRY.find((s) => s.id === id);
}
function settingById(id) {
  for (const s of REGISTRY) {
    for (const setting of s.settings || []) {
      if (setting.id === id) return setting;
    }
  }
  return null;
}

const VALID_TYPES = new Set([
  'toggle', 'select', 'slider', 'text', 'number', 'color',
  'radioGroup', 'pillGroup', 'button', 'custom',
]);

function resolveDottedPath(obj, path) {
  if (!path) return undefined;
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (!(p in cur)) return undefined;
    cur = cur[p];
  }
  return { found: true, value: cur };
}

describe('settings registry', () => {
  test('exposes a non-empty page list', () => {
    expect(Array.isArray(REGISTRY)).toBe(true);
    expect(REGISTRY.length).toBeGreaterThan(0);
  });

  test('section ids are unique', () => {
    const seen = new Set();
    for (const section of REGISTRY) {
      expect(seen.has(section.id)).toBe(false);
      seen.add(section.id);
    }
  });

  test('every setting id is unique across the whole registry', () => {
    const seen = new Set();
    for (const section of REGISTRY) {
      for (const setting of section.settings || []) {
        if (seen.has(setting.id)) throw new Error(`Duplicate setting id: ${setting.id}`);
        seen.add(setting.id);
      }
    }
  });

  test('every setting has a valid type', () => {
    for (const section of REGISTRY) {
      for (const setting of section.settings || []) {
        if (!VALID_TYPES.has(setting.type)) {
          throw new Error(`Setting ${setting.id} has invalid type: ${setting.type}`);
        }
      }
    }
  });

  test('every path-bearing setting resolves under DEFAULT_CONFIG (or is allowlisted)', () => {
    // Some settings legitimately don't have a `path` (buttons, custom-mounts).
    // Allowlist a small set of dynamic paths whose default lives outside
    // DEFAULT_CONFIG (e.g., spaces map keyed at runtime).
    const ALLOWLIST = new Set([]);
    const failures = [];
    for (const section of REGISTRY) {
      for (const setting of section.settings || []) {
        if (!setting.path) continue;
        if (ALLOWLIST.has(setting.path)) continue;
        const resolved = resolveDottedPath(DEFAULT_CONFIG, setting.path);
        if (!resolved || !resolved.found) {
          failures.push(`${setting.id} → ${setting.path}`);
        }
      }
    }
    if (failures.length) {
      throw new Error('Registry paths missing from DEFAULT_CONFIG:\n  ' + failures.join('\n  '));
    }
  });

  test('toggle settings resolve to a boolean default', () => {
    for (const section of REGISTRY) {
      for (const setting of section.settings || []) {
        if (setting.type !== 'toggle' || !setting.path) continue;
        const r = resolveDottedPath(DEFAULT_CONFIG, setting.path);
        if (!r) continue;
        expect(typeof r.value).toBe('boolean');
      }
    }
  });

  test('pillGroup / radioGroup settings declare options', () => {
    for (const section of REGISTRY) {
      for (const setting of section.settings || []) {
        if (setting.type !== 'pillGroup' && setting.type !== 'radioGroup') continue;
        expect(Array.isArray(setting.options)).toBe(true);
        expect(setting.options.length).toBeGreaterThan(0);
      }
    }
  });

  test('slider settings declare min/max', () => {
    for (const section of REGISTRY) {
      for (const setting of section.settings || []) {
        if (setting.type !== 'slider') continue;
        expect(Number.isFinite(setting.min)).toBe(true);
        expect(Number.isFinite(setting.max)).toBe(true);
        expect(setting.max).toBeGreaterThan(setting.min);
      }
    }
  });

  test('button settings declare a sideEffect', () => {
    for (const section of REGISTRY) {
      for (const setting of section.settings || []) {
        if (setting.type !== 'button') continue;
        expect(typeof setting.sideEffect).toBe('string');
        expect(setting.sideEffect.length).toBeGreaterThan(0);
      }
    }
  });

  test('buildRegistry precomputes _search blobs for every setting', () => {
    const registry = buildRegistry();
    let anyChecked = false;
    for (const section of registry) {
      for (const setting of section.settings || []) {
        anyChecked = true;
        expect(typeof setting._search).toBe('string');
        expect(setting._search.length).toBeGreaterThan(0);
        expect(setting._search).toBe(setting._search.toLowerCase());
      }
    }
    expect(anyChecked).toBe(true);
  });

  test('sections expose monotonically nondecreasing order', () => {
    let prev = -Infinity;
    for (const section of REGISTRY) {
      const o = typeof section.order === 'number' ? section.order : 0;
      expect(o).toBeGreaterThanOrEqual(prev);
      prev = o;
    }
  });

  test('every section has at least one setting', () => {
    for (const section of REGISTRY) {
      expect(Array.isArray(section.settings)).toBe(true);
      expect(section.settings.length).toBeGreaterThan(0);
    }
  });

  // -- New sections (Tier 2/3 + search) -----------------------------------

  test('every custom renderModule resolves to a function exported by customModules', () => {
    const missing = [];
    for (const section of REGISTRY) {
      for (const setting of section.settings || []) {
        if (setting.type !== 'custom') continue;
        expect(typeof setting.renderModule).toBe('string');
        if (typeof customModules[setting.renderModule] !== 'function') {
          missing.push(`${setting.id} → renderModule "${setting.renderModule}"`);
        }
      }
    }
    if (missing.length) {
      throw new Error('custom settings with unresolved renderModule:\n  ' + missing.join('\n  '));
    }
  });

  test('the Tier-2/3 rows live on their documented page + card with the right renderModule', () => {
    const expected = [
      { page: 'personas', card: 'packs', settingId: 'packs.catalog', renderModule: 'packs' },
      { page: 'assistant', card: 'agent-safety', settingId: 'agentSafety.egress', renderModule: 'agentSafety' },
      { page: 'voice-reading', card: 'voice', settingId: 'voiceReading.voice', renderModule: 'voiceReading' },
      { page: 'routines', card: 'routines', settingId: 'routines.editor', renderModule: 'routines' },
    ];
    for (const e of expected) {
      const setting = sectionById(e.page).settings.find((s) => s.id === e.settingId);
      expect(setting).toBeDefined();
      expect(setting.card).toBe(e.card);
      expect(setting.type).toBe('custom');
      expect(setting.renderModule).toBe(e.renderModule);
      expect(typeof customModules[setting.renderModule]).toBe('function');
    }
  });

  test('ask-browsing card on the Search page carries a toggle + numeric/text/slider settings', () => {
    const card = sectionById('search').cards.find((c) => c.id === 'ask-browsing');
    expect(card).toBeDefined();
    expect(card.wide).toBe(true);
    const enabled = card.settings.find((s) => s.id === 'askBrowsing.enabled');
    expect(enabled.type).toBe('toggle');
    expect(enabled.path).toBe('settings.askBrowsing.enabled');
    const types = card.settings.map((s) => s.type).sort();
    expect(types).toEqual(['number', 'slider', 'text', 'text', 'toggle', 'toggle']);
  });

  test('voice-reading section pairs a toggle + speed slider with the custom voice picker', () => {
    const section = sectionById('voice-reading');
    const ids = section.settings.map((s) => s.id);
    expect(ids).toEqual(['voiceReading.enabled', 'voiceReading.rate', 'voiceReading.voice']);
    expect(settingById('voiceReading.enabled').type).toBe('toggle');
    expect(settingById('voiceReading.rate').type).toBe('slider');
    expect(settingById('voiceReading.voice').type).toBe('custom');
  });

  test('routines section pairs the master and background toggles with the custom editor', () => {
    const section = sectionById('routines');
    expect(section.settings.map((s) => s.id)).toEqual(['routines.enabled', 'routines.runInBackground', 'routines.editor']);
    expect(settingById('routines.enabled').type).toBe('toggle');
    expect(settingById('routines.enabled').path).toBe('settings.routines.enabled');
    expect(settingById('routines.runInBackground').type).toBe('toggle');
    expect(settingById('routines.runInBackground').path).toBe('settings.routines.runInBackground');
    expect(DEFAULT_CONFIG.settings.routines.runInBackground).toBe(true);
    expect(settingById('routines.editor').renderModule).toBe('routines');
  });

  test('search section carries the new agent web-search keys with provider-gated visibleIf', () => {
    const section = sectionById('search');
    const byId = Object.fromEntries(section.settings.map((s) => [s.id, s]));
    for (const id of ['search.provider', 'search.inBrowserEngine', 'search.searxngUrl',
      'search.braveApiKey', 'search.tavilyApiKey', 'search.resultCount']) {
      expect(byId[id]).toBeDefined();
    }
    expect(byId['search.provider'].path).toBe('settings.search.provider');
    // visibleIf gates each provider-specific field on the chosen provider.
    const cfg = (provider) => ({ settings: { search: { provider } } });
    expect(byId['search.searxngUrl'].visibleIf(cfg('searxng'))).toBe(true);
    expect(byId['search.searxngUrl'].visibleIf(cfg('brave'))).toBe(false);
    expect(byId['search.braveApiKey'].visibleIf(cfg('brave'))).toBe(true);
    expect(byId['search.braveApiKey'].visibleIf(cfg('searxng'))).toBe(false);
    expect(byId['search.tavilyApiKey'].visibleIf(cfg('tavily'))).toBe(true);
    expect(byId['search.inBrowserEngine'].visibleIf(cfg('inBrowser'))).toBe(true);
    expect(byId['search.inBrowserEngine'].visibleIf(cfg('tavily'))).toBe(false);
    expect(byId['search.braveApiKey'].subtype).toBe('password');
    expect(byId['search.tavilyApiKey'].subtype).toBe('password');
  });

  test('packs catalog and agent-safety egress are custom-only (no config path)', () => {
    expect(settingById('packs.catalog').path).toBeUndefined();
    expect(settingById('packs.catalog').type).toBe('custom');
    expect(settingById('agentSafety.egress').path).toBeUndefined();
    expect(settingById('agentSafety.egress').renderModule).toBe('agentSafety');
  });

  test('the password copy names where saving and filling do not happen and how reveal is confirmed', () => {
    const offer = settingById('passwords.offerToSave').description;
    expect(offer).toMatch(/Private tabs/);
    expect(offer).toMatch(/pop-up/);
    expect(offer).toMatch(/certificate/);
    expect(settingById('passwords.saved').description).toMatch(/confirm/);
  });

  // -- Information architecture -------------------------------------------

  test('nav groups are General / Appearance / AI / Web / System in that order', () => {
    expect(GROUPS.map((g) => g.label)).toEqual(['General', 'Appearance', 'AI', 'Web', 'System']);
    const groupIds = new Set(GROUPS.map((g) => g.id));
    for (const page of REGISTRY) expect(groupIds.has(page.group)).toBe(true);
  });

  test('pages render grouped: every page of a group precedes every page of the next group', () => {
    const groupOrder = Object.fromEntries(GROUPS.map((g) => [g.id, g.order]));
    const seq = REGISTRY.map((p) => groupOrder[p.group]);
    expect(seq).toEqual([...seq].sort((a, b) => a - b));
    expect(REGISTRY.map((p) => p.id)).toEqual([
      'general', 'spaces', 'downloads', 'notifications',
      'appearance', 'layout', 'motion', 'language', 'voice-reading',
      'llm', 'assistant', 'projects', 'personas', 'skills', 'mcp-servers',
      'search', 'privacy', 'passwords',
      'routines', 'shortcuts', 'updates', 'advanced', 'about',
    ]);
  });

  test('every page has a title, icon, description and at least one card', () => {
    for (const page of REGISTRY) {
      expect(page.title).toBeTruthy();
      expect(page.icon).toBeTruthy();
      expect(page.description).toBeTruthy();
      expect(page.cards.length).toBeGreaterThan(0);
      const cardIds = page.cards.map((c) => c.id);
      expect(new Set(cardIds).size).toBe(cardIds.length);
      for (const card of page.cards) expect(card.settings.length).toBeGreaterThan(0);
    }
  });

  test('every ROW is placed exactly once and carries its page/card', () => {
    const placed = REGISTRY.flatMap((p) => p.settings);
    expect(placed.length).toBe(ROWS.length);
    expect(new Set(placed.map((s) => s.id)).size).toBe(ROWS.length);
    for (const page of REGISTRY) {
      for (const card of page.cards) {
        for (const s of card.settings) {
          expect(s.page).toBe(page.id);
          expect(s.card).toBe(card.id);
          expect(s.category).toBe(card.title);
        }
      }
    }
  });

  test('buildRegistry rejects unknown, duplicated and unplaced rows', () => {
    const rows = [{ id: 'a', type: 'toggle' }, { id: 'b', type: 'toggle' }];
    const page = (cardRows) => [{ id: 'p', title: 'P', order: 1, cards: [{ id: 'c', title: 'C', rows: cardRows }] }];
    expect(() => buildRegistry(rows, page(['a', 'zzz']))).toThrow('places unknown row "zzz"');
    expect(() => buildRegistry(rows, page(['a', 'b', 'a']))).toThrow('row "a" is placed on more than one card');
    expect(() => buildRegistry(rows, page(['a']))).toThrow('rows not placed on any page: b');
    expect(buildRegistry(rows, page(['b', 'a']))[0].settings.map((s) => s.id)).toEqual(['b', 'a']);
  });

  test('removed duplicate rows stay gone (one row per config path)', () => {
    expect(settingById('general.openConfig')).toBeNull();
    expect(settingById('startup.llmAutoStart')).toBeNull();
    expect(settingById('advanced.openConfig')).not.toBeNull();
    const paths = REGISTRY.flatMap((p) => p.settings).map((s) => s.path).filter(Boolean);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test('chromeAmbient scene + intensity live on Motion with intensity gated on scene', () => {
    const scene = settingById('appearance.chromeAmbient.scene');
    const intensity = settingById('appearance.chromeAmbient.intensity');
    expect(scene.page).toBe('motion');
    expect(scene.card).toBe('ambient');
    expect(scene.path).toBe('settings.chromeAmbient.scene');
    expect(intensity.path).toBe('settings.chromeAmbient.intensity');
    expect(scene.sideEffect).toBe('applyAnimations');
    expect(intensity.visibleIf({ settings: { chromeAmbient: { scene: 'aurora' } } })).toBe(true);
    expect(intensity.visibleIf({ settings: { chromeAmbient: { scene: 'off' } } })).toBe(false);
    expect(intensity.visibleIf({})).toBe(false);
  });

  test('every sideEffect names a registered effect', () => {
    const known = new Set(SIDE_EFFECT_NAMES);
    const bad = REGISTRY.flatMap((p) => p.settings)
      .filter((s) => s.sideEffect && !known.has(s.sideEffect))
      .map((s) => `${s.id} → ${s.sideEffect}`);
    expect(bad).toEqual([]);
  });

  test('every dynamicOptions source exists and the row is a select', () => {
    const known = new Set(DYNAMIC_OPTION_SOURCES);
    const dyn = REGISTRY.flatMap((p) => p.settings).filter((s) => s.dynamicOptions);
    expect(dyn.map((s) => s.id).sort()).toEqual(['general.defaultSpace', 'privacy.dnsProvider', 'search.defaultEngine']);
    for (const s of dyn) {
      expect(known.has(s.dynamicOptions)).toBe(true);
      expect(s.type).toBe('select');
    }
  });

  test('every alias resolves to an existing page and card', () => {
    for (const [alias, target] of Object.entries(ALIASES)) {
      const page = sectionById(target.page);
      expect(page).toBeDefined();
      if (target.card) expect(page.cards.some((c) => c.id === target.card)).toBe(true);
      expect(resolvePage(alias)).toEqual(target);
      expect(PAGES.some((p) => p.id === alias)).toBe(false);
    }
    expect(resolvePage('llm')).toEqual({ page: 'llm', card: null });
    expect(resolvePage('no-such-page')).toBeNull();
    expect(resolvePage('')).toBeNull();
  });
});

const personaService = require('../../../../main/services/PersonaService');
const { PersonaService, PERSONAS, BUILTIN_NAMES, isBuiltin, resolveBuiltin, withPersonaOverride } = require('../../../../main/services/PersonaService');

function fakeConfig(initial = {}) {
  let data = { settings: { agentPersonas: { ...initial } } };
  return {
    get: (path, fallback) => {
      const keys = path.split('.');
      let cur = data;
      for (const k of keys) cur = (cur && typeof cur === 'object') ? cur[k] : undefined;
      return cur === undefined ? fallback : cur;
    },
    set: (path, value) => {
      const keys = path.split('.');
      let cur = data;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
        cur = cur[keys[i]];
      }
      cur[keys[keys.length - 1]] = value;
    },
    _data: data,
  };
}

describe('PersonaService', () => {
  test('exposes 8 built-in personas', () => {
    expect(BUILTIN_NAMES.length).toBe(8);
    for (const name of ['default', 'explore', 'research', 'shop', 'code', 'reddit', 'news', 'quick']) {
      expect(BUILTIN_NAMES).toContain(name);
    }
  });

  test('every built-in has the required fields', () => {
    for (const name of BUILTIN_NAMES) {
      const p = PERSONAS[name];
      expect(typeof p.name).toBe('string');
      expect(typeof p.label).toBe('string');
      expect(typeof p.description).toBe('string');
      expect(typeof p.systemOverlay).toBe('string');
      expect(p.systemOverlay.length).toBeGreaterThan(20);
      expect(Array.isArray(p.starterTabs)).toBe(true);
      expect(Array.isArray(p.followUps)).toBe(true);
      expect(p.builtin).toBe(true);
    }
  });

  test('isBuiltin recognizes known names + rejects garbage', () => {
    expect(isBuiltin('shop')).toBe(true);
    expect(isBuiltin('moon')).toBe(false);
    expect(isBuiltin(null)).toBe(false);
    expect(isBuiltin(123)).toBe(false);
  });

  test('resolveBuiltin returns a deep clone — mutations do not leak', () => {
    const p1 = resolveBuiltin('shop');
    p1.systemOverlay = 'mutated';
    const p2 = resolveBuiltin('shop');
    expect(p2.systemOverlay).not.toBe('mutated');
  });

  test('resolveBuiltin falls back to default on unknown name', () => {
    const p = resolveBuiltin('moon');
    expect(p.name).toBe('default');
  });

  test('withPersonaOverride layers a partial patch', () => {
    const base = resolveBuiltin('shop');
    const out = withPersonaOverride(base, { notes: 'I prefer Amazon', enabled: false });
    expect(out.notes).toBe('I prefer Amazon');
    expect(out.enabled).toBe(false);
    expect(out.systemOverlay).toBe(base.systemOverlay); // unchanged
  });

  test('withPersonaOverride deep-merges object fields', () => {
    const base = resolveBuiltin('shop');
    const out = withPersonaOverride(base, { qualityOverride: { name: 'ultra' } });
    expect(out.qualityOverride).toEqual({ name: 'ultra' });
  });

  test('withPersonaOverride returns the base untouched for a null/non-object patch', () => {
    const base = resolveBuiltin('shop');
    expect(withPersonaOverride(base, null)).toBe(base);
    expect(withPersonaOverride(base, 'nope')).toBe(base);
    expect(withPersonaOverride(base, undefined)).toBe(base);
  });

  test('withPersonaOverride replaces a non-object base field with the patch object', () => {
    // base.qualityOverride is null (default persona). Patching it with an
    // object must replace, not attempt to spread the null base field.
    const base = resolveBuiltin('default');
    expect(base.qualityOverride).toBeNull();
    const out = withPersonaOverride(base, { qualityOverride: { name: 'efficient' } });
    expect(out.qualityOverride).toEqual({ name: 'efficient' });
  });

  test('withPersonaOverride ignores explicit-undefined patch values', () => {
    const base = resolveBuiltin('shop');
    const out = withPersonaOverride(base, { label: undefined, notes: 'kept' });
    expect(out.label).toBe(base.label); // undefined patch value skipped
    expect(out.notes).toBe('kept');
  });

  test('withPersonaOverride treats an array patch value as a scalar replace', () => {
    const base = resolveBuiltin('shop');
    const out = withPersonaOverride(base, { starterTabs: [{ url: 'https://x' }] });
    expect(out.starterTabs).toEqual([{ url: 'https://x' }]);
  });

  test('resolveBuiltin clones nested objects (no shared mutation across calls)', () => {
    const a = resolveBuiltin('research');
    a.qualityOverride.budget.maxSteps = 999;
    const b = resolveBuiltin('research');
    expect(b.qualityOverride.budget.maxSteps).toBe(50);
  });
});

describe('PersonaService instance binding', () => {
  let svc;
  beforeEach(() => { svc = new PersonaService(); });

  test('without bindConfig returns built-in defaults', () => {
    const p = svc.resolve('shop');
    expect(p.name).toBe('shop');
    expect(p.notes).toBe('');
  });

  test('after bindConfig, builtinOverrides apply', () => {
    const cs = fakeConfig({ builtinOverrides: { shop: { notes: 'I prefer B&H' } } });
    svc.bindConfig(cs);
    const p = svc.resolve('shop');
    expect(p.notes).toBe('I prefer B&H');
    expect(p.systemOverlay.length).toBeGreaterThan(0);
  });

  test('listEnabled filters by enabledPersonas array', () => {
    const cs = fakeConfig({ enabledPersonas: ['default', 'shop'] });
    svc.bindConfig(cs);
    const enabled = svc.listEnabled().map((p) => p.name);
    expect(enabled).toEqual(['default', 'shop']);
  });

  test('listAll always lists all built-ins (regardless of enabled)', () => {
    const cs = fakeConfig({ enabledPersonas: ['shop'] });
    svc.bindConfig(cs);
    const names = svc.listAll().map((p) => p.name).filter((n) => isBuiltin(n));
    expect(names.sort()).toEqual(BUILTIN_NAMES.slice().sort());
  });

  test('custom personas appear in listAll + listEnabled when enabled', () => {
    const cs = fakeConfig({
      enabledPersonas: ['default', 'travel'],
      customPersonas: [{ name: 'travel', label: 'Travel', description: 'flights+hotels', systemOverlay: 'Output cost+duration+booking link.', followUps: [] }],
    });
    svc.bindConfig(cs);
    const all = svc.listAll().map((p) => p.name);
    expect(all).toContain('travel');
    const enabled = svc.listEnabled().map((p) => p.name);
    expect(enabled).toContain('travel');
  });

  test('mergeQuality applies persona qualityOverride on top of mode', () => {
    const svc2 = new PersonaService();
    const baseMode = { name: 'balanced', budget: { maxSteps: 30, maxTokens: 100000 } };
    const persona = { qualityOverride: { name: 'efficient', budget: { maxSteps: 3 } } };
    const merged = svc2.mergeQuality(baseMode, persona);
    expect(merged.name).toBe('efficient');
    expect(merged.budget.maxSteps).toBe(3);
  });

  test('mergeQuality is a no-op when persona has no qualityOverride', () => {
    const svc2 = new PersonaService();
    const mode = { name: 'balanced', budget: { maxSteps: 30 } };
    const merged = svc2.mergeQuality(mode, { qualityOverride: null });
    expect(merged).toBe(mode); // identity preserved
  });

  test('isRouterEnabled defaults to true; respects explicit false', () => {
    const svc2 = new PersonaService();
    expect(svc2.isRouterEnabled()).toBe(true);
    const cs = fakeConfig({ routerEnabled: false });
    svc2.bindConfig(cs);
    expect(svc2.isRouterEnabled()).toBe(false);
  });

  test('singleton export is a PersonaService instance', () => {
    expect(personaService).toBeInstanceOf(PersonaService);
    expect(typeof personaService.resolve).toBe('function');
  });

  test('resolve falls back to default for an unknown name (no custom match)', () => {
    const cs = fakeConfig({ customPersonas: [{ name: 'travel' }] });
    svc.bindConfig(cs);
    const p = svc.resolve('does-not-exist');
    expect(p.name).toBe('default');
  });

  test('resolve returns a custom persona layered on the default skeleton', () => {
    const cs = fakeConfig({
      customPersonas: [{ name: 'travel', label: 'Travel', systemOverlay: 'cost+link' }],
    });
    svc.bindConfig(cs);
    const p = svc.resolve('travel');
    expect(p.name).toBe('travel');
    expect(p.builtin).toBe(false);
    expect(p.followUps).toEqual(resolveBuiltin('default').followUps); // skeleton fields kept
  });

  test('bindConfig coerces malformed agentPersonas sub-fields to safe types', () => {
    const cs = fakeConfig({
      enabledPersonas: 'not-an-array',
      customPersonas: 'nope',
      builtinOverrides: 'bad',
      routerEnabled: false,
      routerLLMFallback: false,
    });
    svc.bindConfig(cs);
    // enabledPersonas falls back to all built-ins; listAll still lists 8.
    const builtins = svc.listAll().filter((p) => isBuiltin(p.name));
    expect(builtins.map((p) => p.name).sort()).toEqual(BUILTIN_NAMES.slice().sort());
    expect(svc.isRouterEnabled()).toBe(false);
    expect(svc.isLLMFallbackEnabled()).toBe(false);
  });

  test('bindConfig tolerates configService.get returning null', () => {
    svc.bindConfig({ get: () => null });
    // Defaults: all built-ins enabled, router on.
    expect(svc.enabledNames().sort()).toEqual(BUILTIN_NAMES.slice().sort());
    expect(svc.isRouterEnabled()).toBe(true);
  });

  test('listEnabled / listAll without a bound config use built-in defaults', () => {
    expect(svc.listEnabled().map((p) => p.name)).toEqual(BUILTIN_NAMES);
    expect(svc.listAll().map((p) => p.name)).toEqual(BUILTIN_NAMES);
  });

  test('listEnabled excludes a built-in disabled via builtinOverrides.enabled=false', () => {
    const cs = fakeConfig({
      enabledPersonas: ['default', 'shop'],
      builtinOverrides: { shop: { enabled: false } },
    });
    svc.bindConfig(cs);
    const names = svc.listEnabled().map((p) => p.name);
    expect(names).toContain('default');
    expect(names).not.toContain('shop'); // enabled:false override filters it out
  });

  test('listEnabled skips custom entries that are malformed, shadow a built-in, or are not enabled', () => {
    const cs = fakeConfig({
      enabledPersonas: ['default', 'good', 'shop'],
      customPersonas: [
        null,                                  // malformed → skipped
        { label: 'no name' },                  // no name → skipped
        { name: 'shop', label: 'Shadow' },     // shadows a built-in → skipped
        { name: 'notEnabled', label: 'Off' },  // not in enabledPersonas → skipped
        { name: 'good', label: 'Good', systemOverlay: 'ok' }, // kept
      ],
    });
    svc.bindConfig(cs);
    const names = svc.listEnabled().map((p) => p.name);
    expect(names).toContain('good');
    expect(names).not.toContain('notEnabled');
    expect(names.filter((n) => n === 'shop')).toEqual(['shop']); // only the built-in
  });

  test('listEnabled drops a custom persona whose resolved enabled is false', () => {
    const cs = fakeConfig({
      enabledPersonas: ['off-custom'],
      customPersonas: [{ name: 'off-custom', label: 'Off', systemOverlay: 'x', enabled: false }],
    });
    svc.bindConfig(cs);
    expect(svc.listEnabled().map((p) => p.name)).not.toContain('off-custom');
  });

  test('listAll skips malformed / built-in-shadowing custom entries', () => {
    const cs = fakeConfig({
      customPersonas: [null, { label: 'no name' }, { name: 'code', label: 'Shadow' }, { name: 'fresh', label: 'Fresh', systemOverlay: 'y' }],
    });
    svc.bindConfig(cs);
    const names = svc.listAll().map((p) => p.name);
    expect(names).toContain('fresh');
    expect(names.filter((n) => n === 'code')).toEqual(['code']); // built-in only, no shadow
  });

  test('isLLMFallbackEnabled / enabledNames default true / all built-ins with no config', () => {
    const fresh = new PersonaService();
    expect(fresh.isLLMFallbackEnabled()).toBe(true);
    expect(fresh.enabledNames()).toEqual(BUILTIN_NAMES);
    // enabledNames returns a copy — mutating it must not affect future calls.
    fresh.enabledNames().push('mutated');
    expect(fresh.enabledNames()).toEqual(BUILTIN_NAMES);
  });

  test('isRouterEnabled / isLLMFallbackEnabled honor explicit config values', () => {
    const cs = fakeConfig({ routerEnabled: true, routerLLMFallback: false, enabledPersonas: ['shop'] });
    svc.bindConfig(cs);
    expect(svc.isRouterEnabled()).toBe(true);
    expect(svc.isLLMFallbackEnabled()).toBe(false);
    expect(svc.enabledNames()).toEqual(['shop']);
  });
});

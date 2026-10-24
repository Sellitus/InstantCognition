// personaPacks is the pure curated-pack catalog. The load-bearing contract is
// that every pack persona survives PersonaIoService.sanitizePersona unchanged
// in the fields that matter — otherwise "Apply pack" would silently install a
// mangled or dropped persona. sanitizePersona is internal code under test, so
// it is exercised for real (not mocked).

const { PACKS, getPack } = require('../../../shared/personaPacks');
const personaIo = require('../../../main/services/PersonaIoService');

describe('personaPacks catalog', () => {
  test('exposes a non-empty frozen-style array with the four committed packs', () => {
    expect(Array.isArray(PACKS)).toBe(true);
    expect(PACKS.length).toBe(4);
    expect(PACKS.map((p) => p.id).sort()).toEqual(
      ['deal-finder', 'job-hunt', 'lit-review', 'travel'],
    );
  });

  test('pack ids and persona names are unique and slug-safe', () => {
    const ids = PACKS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const names = PACKS.map((p) => p.persona.name);
    expect(new Set(names).size).toBe(names.length);
    names.forEach((n) => {
      expect(n).toMatch(/^pack_[a-z0-9_]+$/);
    });
  });

  test('every pack carries a persona, starter panes, and a reusable task', () => {
    PACKS.forEach((pack) => {
      expect(typeof pack.label).toBe('string');
      expect(pack.label.length).toBeGreaterThan(0);
      expect(typeof pack.description).toBe('string');
      expect(pack.description.length).toBeGreaterThan(0);
      expect(typeof pack.task).toBe('string');
      expect(pack.task.length).toBeGreaterThan(20);
      expect(Array.isArray(pack.persona.followUps)).toBe(true);
      expect(pack.persona.followUps.length).toBeGreaterThan(0);
      expect(Array.isArray(pack.panes)).toBe(true);
      expect(pack.panes.length).toBeGreaterThan(0);
      pack.panes.forEach((pane) => {
        expect(typeof pane.label).toBe('string');
        expect(pane.label.length).toBeGreaterThan(0);
        expect(pane.url).toMatch(/^https:\/\/\S+$/);
      });
    });
  });

  test('persona starterTabs are empty — panes open as user tabs, not the agent workspace', () => {
    // Persona.starterTabs would seed the isolated AGENT workspace; pack panes
    // must instead become ordinary user tabs (renderer openAdHocTab path).
    PACKS.forEach((pack) => {
      expect(pack.persona.starterTabs).toEqual([]);
    });
  });

  test('getPack resolves by id and is null-safe', () => {
    expect(getPack('travel')).toBe(PACKS.find((p) => p.id === 'travel'));
    expect(getPack('nope')).toBeNull();
    expect(getPack('')).toBeNull();
    expect(getPack()).toBeNull();
    expect(getPack(null)).toBeNull();
  });

  test('every pack persona survives sanitizePersona with its essential fields intact', () => {
    PACKS.forEach((pack) => {
      const sane = personaIo.sanitizePersona(pack.persona);
      expect(sane).not.toBeNull();
      // Names are already valid slugs → sanitize must not alter them.
      expect(sane.name).toBe(pack.persona.name);
      expect(sane.label).toBe(pack.persona.label);
      expect(sane.systemOverlay).toBe(pack.persona.systemOverlay);
      expect(sane.followUps).toEqual(pack.persona.followUps);
      // sanitize force-clears builtin so packs can't smuggle a built-in.
      expect(sane.builtin).toBe(false);
    });
  });
});

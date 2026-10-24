const fs = require('fs');
const os = require('os');
const path = require('path');
const personaIo = require('../../../../main/services/PersonaIoService');

function makeCs(initial = {}) {
  let data = { settings: { agentPersonas: { ...initial } } };
  return {
    get: (p, fb) => {
      const ks = p.split('.');
      let c = data;
      for (const k of ks) c = (c && typeof c === 'object') ? c[k] : undefined;
      return c === undefined ? fb : c;
    },
    set: (p, v) => {
      const ks = p.split('.');
      let c = data;
      for (let i = 0; i < ks.length - 1; i++) { if (!c[ks[i]] || typeof c[ks[i]] !== 'object') c[ks[i]] = {}; c = c[ks[i]]; }
      c[ks[ks.length - 1]] = v;
    },
    _data: data,
  };
}

describe('PersonaIoService.sanitizePersona', () => {
  test('rejects null / wrong shape', () => {
    expect(personaIo.sanitizePersona(null)).toBeNull();
    expect(personaIo.sanitizePersona({})).toBeNull();
    expect(personaIo.sanitizePersona({ name: '' })).toBeNull();
  });

  test('strips garbage keys + forces builtin=false', () => {
    const r = personaIo.sanitizePersona({ name: 'travel', label: 'Travel', systemOverlay: 'X', builtin: true, junk: 1 });
    expect(r.builtin).toBe(false);
    expect(r.junk).toBeUndefined();
  });

  test('lowercases name + strips invalid chars', () => {
    const r = personaIo.sanitizePersona({ name: 'My Persona!', systemOverlay: 'X' });
    expect(r.name).toBe('mypersona');
  });

  test('label defaults to name when missing', () => {
    const r = personaIo.sanitizePersona({ name: 'travel', systemOverlay: 'X' });
    expect(r.label).toBe('travel');
  });

  test('a non-string label falls back to the name', () => {
    const r = personaIo.sanitizePersona({ name: 'travel', label: { toString: () => '<b>x</b>' } });
    expect(r.label).toBe('travel');
  });

  test('label is stripped of control characters and capped at 120 chars', () => {
    const r = personaIo.sanitizePersona({ name: 'travel', label: `Tr\u0000av\u001bel\u007f ${'x'.repeat(300)}` });
    expect(r.label.startsWith('Travel x')).toBe(true);
    expect(r.label).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(r.label.length).toBe(120);
  });

  test('a label made only of control characters falls back to the name', () => {
    const r = personaIo.sanitizePersona({ name: 'travel', label: '\u0001\u0002 ' });
    expect(r.label).toBe('travel');
  });

  test('a normal label is kept verbatim', () => {
    const r = personaIo.sanitizePersona({ name: 'travel', label: 'Travel <planner> & co' });
    expect(r.label).toBe('Travel <planner> & co');
  });

  test('starterTabs and followUps default to []', () => {
    const r = personaIo.sanitizePersona({ name: 'travel', systemOverlay: 'X' });
    expect(r.starterTabs).toEqual([]);
    expect(r.followUps).toEqual([]);
  });
});

describe('PersonaIoService.buildExportPayload', () => {
  test('produces the v1 format', () => {
    const cs = makeCs({ customPersonas: [{ name: 'travel', label: 'Travel', systemOverlay: 'X' }], builtinOverrides: { shop: { notes: 'amazon' } } });
    const p = personaIo.buildExportPayload(cs);
    expect(p.format).toBe('instantcognition.personas.v1');
    expect(typeof p.exportedAt).toBe('string');
    expect(p.customPersonas).toHaveLength(1);
    expect(p.builtinOverrides.shop.notes).toBe('amazon');
  });

  test('handles missing/empty config', () => {
    const cs = makeCs({});
    const p = personaIo.buildExportPayload(cs);
    expect(p.customPersonas).toEqual([]);
    expect(p.builtinOverrides).toEqual({});
  });
});

describe('PersonaIoService.applyImport', () => {
  test('rejects unknown format', () => {
    const cs = makeCs({});
    const r = personaIo.applyImport({ format: 'wrong' }, cs);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unrecognized_format');
  });

  test('adds new personas + tracks count', () => {
    const cs = makeCs({ customPersonas: [], enabledPersonas: ['default'] });
    const r = personaIo.applyImport({ format: 'instantcognition.personas.v1', customPersonas: [
      { name: 'travel', label: 'Travel', systemOverlay: 'X' },
      { name: 'cook', label: 'Cook', systemOverlay: 'Y' },
    ] }, cs);
    expect(r.ok).toBe(true);
    expect(r.added).toBe(2);
    expect(r.skipped).toBe(0);
    expect(cs.get('settings.agentPersonas.customPersonas')).toHaveLength(2);
    expect(cs.get('settings.agentPersonas.enabledPersonas')).toContain('travel');
  });

  test('skips duplicates by name', () => {
    const cs = makeCs({ customPersonas: [{ name: 'travel', label: 'Travel', systemOverlay: 'X' }] });
    const r = personaIo.applyImport({ format: 'instantcognition.personas.v1', customPersonas: [
      { name: 'travel', label: 'Travel-2', systemOverlay: 'Z' },
      { name: 'cook', label: 'Cook', systemOverlay: 'Y' },
    ] }, cs);
    expect(r.added).toBe(1);
    expect(r.skipped).toBe(1);
  });

  test('merges builtinOverrides', () => {
    const cs = makeCs({ builtinOverrides: { shop: { notes: 'old' } } });
    personaIo.applyImport({ format: 'instantcognition.personas.v1', customPersonas: [], builtinOverrides: { code: { notes: 'gist' } } }, cs);
    const out = cs.get('settings.agentPersonas.builtinOverrides');
    expect(out.shop.notes).toBe('old');
    expect(out.code.notes).toBe('gist');
  });
});

describe('PersonaIoService — file round-trip', () => {
  let tmpFile;
  beforeEach(() => { tmpFile = path.join(os.tmpdir(), `persona-test-${Date.now()}.json`); });
  afterEach(() => { try { fs.unlinkSync(tmpFile); } catch (_) {} });

  test('exportToPath then importFromPath preserves customPersonas', async () => {
    const cs1 = makeCs({ customPersonas: [{ name: 'travel', label: 'Travel', systemOverlay: 'X' }] });
    await personaIo.exportToPath(tmpFile, cs1);
    const cs2 = makeCs({});
    const r = await personaIo.importFromPath(tmpFile, cs2);
    expect(r.ok).toBe(true);
    expect(r.added).toBe(1);
    const customs = cs2.get('settings.agentPersonas.customPersonas');
    expect(customs[0].name).toBe('travel');
  });

  test('importFromPath fails on invalid JSON', async () => {
    fs.writeFileSync(tmpFile, '{not-valid');
    const cs = makeCs({});
    const r = await personaIo.importFromPath(tmpFile, cs);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_json');
  });
});

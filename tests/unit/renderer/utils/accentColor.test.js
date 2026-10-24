const { deriveAccentVars, parseHexColor, ACCENT_KEYS } = require('../../../../renderer/utils/accentColor');

describe('parseHexColor', () => {
  test('parses 6-digit hex with or without leading #', () => {
    expect(parseHexColor('#0089AB')).toEqual({ r: 0, g: 137, b: 171 });
    expect(parseHexColor('0089ab')).toEqual({ r: 0, g: 137, b: 171 });
  });

  test('rejects malformed / empty / short values', () => {
    expect(parseHexColor('')).toBeNull();
    expect(parseHexColor(null)).toBeNull();
    expect(parseHexColor('#fff')).toBeNull();        // 3-digit not supported
    expect(parseHexColor('rgb(0,0,0)')).toBeNull();
  });
});

describe('deriveAccentVars', () => {
  test('returns null for an invalid color so the caller clears the override', () => {
    expect(deriveAccentVars('')).toBeNull();
    expect(deriveAccentVars('not-a-color')).toBeNull();
  });

  test('derives all seven accent tokens, darkening for hover/active', () => {
    const v = deriveAccentVars('#0089AB'); // rgb(0,137,171)
    expect(Object.keys(v).sort()).toEqual([...ACCENT_KEYS].sort());
    expect(v['--accent']).toBe('rgb(0, 137, 171)');
    expect(v['--accent-hover']).toBe('rgb(0, 116, 145)');   // *0.85
    expect(v['--accent-active']).toBe('rgb(0, 96, 120)');   // *0.70
    expect(v['--accent-subtle']).toBe('rgba(0, 137, 171, 0.13)');
    expect(v['--accent-muted']).toBe('rgba(0, 137, 171, 0.07)');
    expect(v['--accent-rgb']).toBe('0, 137, 171');
  });

  test('picks a dark on-color for light accents and white for dark accents', () => {
    expect(deriveAccentVars('#f5d90a')['--accent-on']).toBe('#1a1c20'); // bright yellow
    expect(deriveAccentVars('#1f3a93')['--accent-on']).toBe('#ffffff'); // deep blue
  });
});

describe('derived design tokens', () => {
  const fs = require('fs');
  const path = require('path');
  const stylesDir = path.resolve(__dirname, '../../../../renderer/styles');

  // [{ selectors: ['body', ...], decls: Map(name -> value) }] for top-level rules.
  function parseBlocks(file) {
    const css = fs.readFileSync(path.join(stylesDir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const blocks = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
      const decls = new Map();
      for (const d of m[2].split(';')) {
        const i = d.indexOf(':');
        const name = d.slice(0, i).trim();
        if (name.startsWith('--')) decls.set(name, d.slice(i + 1).trim());
      }
      blocks.push({ selectors: m[1].split(',').map((s) => s.trim()), decls });
    }
    return blocks;
  }

  const tokens = parseBlocks('base/tokens.css');
  const light = parseBlocks('themes/light.css');
  const onBody = (b) => b.selectors.some((s) => /^body\b/.test(s));
  const declaredOnBody = new Set(
    [...tokens, ...light].filter(onBody).flatMap((b) => [...b.decls.keys()]),
  );
  // Tokens a theme class or the user accent (inline on body) can change.
  const overridable = new Set([...ACCENT_KEYS, ...light.filter(onBody).flatMap((b) => [...b.decls.keys()])]);

  test('a token built from an overridable token is re-declared on body', () => {
    const stuck = [];
    for (const block of tokens) {
      for (const [name, value] of block.decls) {
        const refs = [...value.matchAll(/var\((--[a-z0-9-]+)/g)].map((r) => r[1]);
        if (refs.some((r) => overridable.has(r)) && !declaredOnBody.has(name)) stuck.push(name);
      }
    }
    expect(stuck).toEqual([]);
  });

  test('accent-derived aliases and focus rings follow the accent', () => {
    for (const name of ['--focus-ring', '--focus-ring-inset', '--primary', '--input-focus-border', '--accent-default']) {
      expect(declaredOnBody.has(name)).toBe(true);
    }
  });
});

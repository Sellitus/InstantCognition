// Search index: AND-tokenization, synonym hits, scoring rank, highlight cap.

const { buildBlob, tokenize, matches, score, highlight, filter } =
  require('../../../../../renderer/components/settings/searchIndex');

const sampleSection = { id: 'appearance', title: 'Appearance' };

const themeSetting = {
  id: 'appearance.theme',
  path: 'settings.theme',
  type: 'pillGroup',
  title: 'Theme',
  description: 'Switch between light and dark UI, or follow your operating system.',
  synonyms: ['dark mode', 'light mode', 'color scheme', 'appearance'],
  keywords: ['theme'],
  category: 'Theme',
  options: [
    { value: 'dark', label: 'Dark' },
    { value: 'light', label: 'Light' },
    { value: 'system', label: 'System' },
  ],
};

const zoomSetting = {
  id: 'appearance.pageZoomDefault',
  path: 'settings.pageZoomDefault',
  type: 'slider',
  title: 'Default page zoom',
  description: 'Initial zoom level for new pages.',
  synonyms: ['zoom level', 'page scale', 'make text bigger', 'make text smaller', 'font size', 'larger'],
  keywords: ['zoom', 'scale', 'size'],
  category: 'Layout',
};

const widthSetting = {
  id: 'appearance.sidebarExpandedWidth',
  path: 'settings.sidebarExpandedWidth',
  type: 'slider',
  title: 'Sidebar width',
  description: 'How wide the chrome sidebar gets when expanded.',
  synonyms: ['sidebar size', 'chrome width', 'rail width', 'wider', 'narrower'],
  keywords: ['width', 'pixels'],
  category: 'Layout',
};

function withBlobs(section, settings) {
  const sec = { ...section, settings };
  for (const s of sec.settings) s._search = buildBlob(sec, s);
  return sec;
}

describe('searchIndex.tokenize', () => {
  test('splits on whitespace and lowercases', () => {
    expect(tokenize('Make Text Bigger')).toEqual(['make', 'text', 'bigger']);
  });
  test('returns empty array on empty / non-string input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(null)).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
    expect(tokenize(123)).toEqual([]);
  });
  test('collapses runs of whitespace', () => {
    expect(tokenize('  zoom   level  ')).toEqual(['zoom', 'level']);
  });
});

describe('searchIndex.buildBlob', () => {
  test('includes title, description, category, synonyms, keywords, and option labels', () => {
    const blob = buildBlob(sampleSection, themeSetting);
    expect(blob).toContain('theme');
    expect(blob).toContain('dark mode');
    expect(blob).toContain('color scheme');
    expect(blob).toContain('switch between light and dark');
    expect(blob).toContain('appearance');
    expect(blob).toContain('dark'); // option label
  });

  test('returns a lowercase string', () => {
    const blob = buildBlob(sampleSection, themeSetting);
    expect(blob).toBe(blob.toLowerCase());
  });
});

describe('searchIndex.matches', () => {
  test('AND-matches every token against the blob', () => {
    const blob = buildBlob(sampleSection, themeSetting);
    expect(matches(blob, ['dark', 'mode'])).toBe(true);
    expect(matches(blob, ['dark', 'zoom'])).toBe(false); // "zoom" not in theme blob
  });
  test('empty token list matches anything', () => {
    expect(matches('anything', [])).toBe(true);
  });
  test('non-string blob never matches non-empty tokens', () => {
    expect(matches(undefined, ['x'])).toBe(false);
    expect(matches('', ['x'])).toBe(false);
  });
});

describe('searchIndex.score', () => {
  test('title-start match outscores synonym-only match', () => {
    const titleHit = score(themeSetting, sampleSection, ['theme']);
    const synonymHit = score(themeSetting, sampleSection, ['color', 'scheme']);
    expect(titleHit).toBeGreaterThan(synonymHit);
  });

  test('section-title token boosts the score', () => {
    const withSection = score(themeSetting, sampleSection, ['appearance']);
    const withoutSection = score(themeSetting, { id: 'x', title: 'X' }, ['appearance']);
    expect(withSection).toBeGreaterThan(withoutSection);
  });

  test('zero score when no tokens match the blob fields', () => {
    expect(score(themeSetting, sampleSection, ['xyzzy'])).toBe(0);
  });
});

describe('searchIndex.highlight', () => {
  test('wraps matched substrings in <mark>', () => {
    const out = highlight('Default page zoom', ['zoom']);
    expect(out).toContain('<mark>zoom</mark>');
  });
  test('escapes HTML in non-matched regions', () => {
    const out = highlight('A <b>bold</b> claim', ['bold']);
    expect(out).toContain('&lt;b&gt;');
    expect(out).toContain('<mark>bold</mark>');
  });
  test('caps the number of marks', () => {
    const out = highlight('zoom zoom zoom zoom zoom', ['zoom'], 2);
    const count = (out.match(/<mark>/g) || []).length;
    expect(count).toBeLessThanOrEqual(2);
  });
  test('returns the escaped text unchanged when no token matches', () => {
    const out = highlight('Hello "world"', ['xyzzy']);
    expect(out).not.toContain('<mark>');
    expect(out).toContain('&quot;world&quot;');
  });
  test('returns escaped text on empty token list', () => {
    expect(highlight('hi', [])).toBe('hi');
  });
});

describe('searchIndex.filter', () => {
  test('drops sections with zero matches and ranks the top', () => {
    const registry = [withBlobs(sampleSection, [themeSetting, zoomSetting, widthSetting])];
    const result = filter(registry, 'zoom');
    expect(result.totalMatches).toBe(1);
    expect(result.sections.length).toBe(1);
    expect(result.sections[0].settings[0].id).toBe('appearance.pageZoomDefault');
    expect(result.top.setting.id).toBe('appearance.pageZoomDefault');
  });

  test('synonym query matches the right setting (make text bigger → pageZoomDefault)', () => {
    const registry = [withBlobs(sampleSection, [themeSetting, zoomSetting, widthSetting])];
    const result = filter(registry, 'make text bigger');
    expect(result.totalMatches).toBe(1);
    expect(result.top.setting.id).toBe('appearance.pageZoomDefault');
  });

  test('AND-tokenization: "dark mode" matches theme; "dark zoom" matches nothing', () => {
    const registry = [withBlobs(sampleSection, [themeSetting, zoomSetting, widthSetting])];
    expect(filter(registry, 'dark mode').totalMatches).toBe(1);
    expect(filter(registry, 'dark zoom').totalMatches).toBe(0);
  });

  test('empty query returns full registry shape', () => {
    const registry = [withBlobs(sampleSection, [themeSetting, zoomSetting])];
    const result = filter(registry, '');
    expect(result.totalMatches).toBe(2);
    expect(result.sections[0].settings.length).toBe(2);
  });

  test('ranks the top hit by relevance, not registry order', () => {
    // "width" matches sidebar width's title (start) AND zoom's keyword "size"
    // is unrelated; so width should be ranked higher than zoom for "width".
    const registry = [withBlobs(sampleSection, [zoomSetting, widthSetting])];
    const result = filter(registry, 'width');
    expect(result.top.setting.id).toBe('appearance.sidebarExpandedWidth');
  });
});

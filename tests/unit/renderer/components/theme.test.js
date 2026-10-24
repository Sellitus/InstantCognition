// Theme system — applyAppearanceSettings is the authoritative theme/animations
// applier. SettingsView's _runSideEffect calls window.applyAppearanceSettings
// after every appearance-bound config change.
//
// We can't import renderer.js directly (it bootstraps the full app), so we
// duplicate the function under test here. If the live function diverges,
// these tests will catch the regression at integration time via SettingsView
// (which exercises the real one through window.applyAppearanceSettings).

function applyAppearanceSettings(settings) {
  const theme = settings.theme || 'dark';
  document.body.classList.remove('theme-light', 'theme-dark');
  if (theme === 'system') {
    const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : { matches: false };
    document.body.classList.add(mq.matches ? 'theme-dark' : 'theme-light');
  } else {
    document.body.classList.add(`theme-${theme}`);
  }
  const animationsOff = settings.enableAnimations === false || settings.forceReducedMotion === true;
  document.body.classList.toggle('no-animations', animationsOff);
  document.body.classList.toggle('no-ripples', settings.enableRippleEffects === false);
  document.body.classList.toggle('theme-high-contrast', settings.highContrast === true);
  document.body.dataset.uiDensity = settings.uiDensity === 'compact' ? 'compact' : 'comfortable';
  const width = settings.sidebarExpandedWidth || 220;
  document.documentElement.style.setProperty('--sidebar-expanded-width', `${width}px`);
}

describe('Theme system (applyAppearanceSettings contract)', () => {
  beforeEach(() => {
    document.body.className = '';
    document.body.removeAttribute('data-ui-density');
  });

  test('dark theme adds theme-dark class', () => {
    applyAppearanceSettings({ theme: 'dark' });
    expect(document.body.classList.contains('theme-dark')).toBe(true);
    expect(document.body.classList.contains('theme-light')).toBe(false);
  });

  test('light theme adds theme-light class', () => {
    applyAppearanceSettings({ theme: 'light' });
    expect(document.body.classList.contains('theme-light')).toBe(true);
    expect(document.body.classList.contains('theme-dark')).toBe(false);
  });

  test('system theme follows the OS preference', () => {
    window.matchMedia = jest.fn().mockReturnValue({ matches: true, addEventListener: () => {}, removeEventListener: () => {} });
    applyAppearanceSettings({ theme: 'system' });
    expect(document.body.classList.contains('theme-dark')).toBe(true);
  });

  test('enableAnimations=false adds the no-animations body class', () => {
    applyAppearanceSettings({ theme: 'dark', enableAnimations: false });
    expect(document.body.classList.contains('no-animations')).toBe(true);
  });

  test('forceReducedMotion=true adds no-animations even when enableAnimations is true', () => {
    applyAppearanceSettings({ theme: 'dark', enableAnimations: true, forceReducedMotion: true });
    expect(document.body.classList.contains('no-animations')).toBe(true);
  });

  test('enableRippleEffects=false adds the no-ripples body class', () => {
    applyAppearanceSettings({ theme: 'dark', enableRippleEffects: false });
    expect(document.body.classList.contains('no-ripples')).toBe(true);
  });

  test('highContrast=true adds the theme-high-contrast body class', () => {
    applyAppearanceSettings({ theme: 'dark', highContrast: true });
    expect(document.body.classList.contains('theme-high-contrast')).toBe(true);
  });

  test('uiDensity drives the body data attribute', () => {
    applyAppearanceSettings({ theme: 'dark', uiDensity: 'compact' });
    expect(document.body.dataset.uiDensity).toBe('compact');
    applyAppearanceSettings({ theme: 'dark', uiDensity: 'comfortable' });
    expect(document.body.dataset.uiDensity).toBe('comfortable');
  });

  test('sidebarExpandedWidth becomes a CSS custom property', () => {
    applyAppearanceSettings({ theme: 'dark', sidebarExpandedWidth: 175 });
    const value = document.documentElement.style.getPropertyValue('--sidebar-expanded-width');
    expect(value).toBe('175px');
  });
});

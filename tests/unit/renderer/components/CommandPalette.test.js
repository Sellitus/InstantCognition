/**
 * @jest-environment jsdom
 */

describe('CommandPalette', () => {
  let palette;
  let ctxProvider;
  let mockSpaceManager;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.body.classList.add('no-animations');
    jest.resetModules();
    palette = require('../../../../renderer/components/CommandPalette');
    mockSpaceManager = { select: jest.fn() };
    ctxProvider = () => ({
      spaces: {
        custom1: { name: 'ChatGPT', url: 'https://chat.openai.com', type: 'ai-service' },
        custom2: { name: 'Claude', url: 'https://claude.ai', type: 'ai-service' },
      },
      spaceManager: mockSpaceManager,
    });
    palette.initialize(ctxProvider);
  });

  afterEach(() => {
    if (palette && palette.isOpen) palette.close();
  });

  test('builds inner content on initialize', () => {
    expect(palette.content).toBeTruthy();
    expect(palette.input).toBeTruthy();
    expect(palette.list).toBeTruthy();
    // Inner content is mounted but the surface is not in the DOM until open().
    expect(document.querySelector('.app-dropdown')).toBeNull();
  });

  test('open() shows the dropdown and clears input', () => {
    palette.open();
    const surface = document.querySelector('.app-dropdown');
    expect(surface).toBeTruthy();
    expect(palette.isOpen).toBe(true);
    expect(palette.input.value).toBe('');
  });

  test('close() detaches the dropdown', () => {
    palette.open();
    palette.close();
    expect(document.querySelector('.app-dropdown')).toBeNull();
    expect(palette.isOpen).toBe(false);
  });

  test('toggle() opens then closes', () => {
    palette.toggle();
    expect(palette.isOpen).toBe(true);
    palette.toggle();
    expect(palette.isOpen).toBe(false);
  });

  test('open() populates results from registry', () => {
    palette.open();
    expect(palette.results.length).toBeGreaterThan(0);
    const items = document.querySelectorAll('.command-palette-item');
    expect(items.length).toBe(palette.results.length);
  });

  test('typing in input filters results', () => {
    palette.open();
    palette.input.value = 'claude';
    palette.input.dispatchEvent(new Event('input'));
    expect(palette.results.length).toBeGreaterThan(0);
    expect(palette.results.some((c) => c.title === 'Claude')).toBe(true);
  });

  test('arrow keys move selection', () => {
    palette.open();
    const initial = palette.selectedIndex;
    palette._move(1);
    expect(palette.selectedIndex).toBe(initial + 1);
    palette._move(-1);
    expect(palette.selectedIndex).toBe(initial);
  });

  test('selection wraps at boundaries', () => {
    palette.open();
    palette.selectedIndex = 0;
    palette._move(-1);
    expect(palette.selectedIndex).toBe(palette.results.length - 1);
  });

  test('Enter executes selected command and closes', () => {
    palette.open();
    palette.input.value = 'claude';
    palette.input.dispatchEvent(new Event('input'));
    palette._execute(0);
    expect(palette.isOpen).toBe(false);
    expect(mockSpaceManager.select).toHaveBeenCalledWith('custom2');
  });

  test('renders empty state when no matches', () => {
    palette.open();
    palette.input.value = 'qqqqzzzz';
    palette.input.dispatchEvent(new Event('input'));
    const empty = document.querySelector('.command-palette-empty');
    expect(empty).toBeTruthy();
    expect(empty.textContent).toMatch(/no matching/i);
  });

  test('execute is a no-op when index out of range', () => {
    palette.open();
    expect(() => palette._execute(9999)).not.toThrow();
  });

  test('escapes HTML in command titles', () => {
    const evilProvider = () => ({
      spaces: {
        evil: { name: '<script>alert(1)</script>', url: 'https://x', type: 'ai-service' },
      },
      spaceManager: mockSpaceManager,
    });
    palette.contextProvider = evilProvider;
    palette.open();
    palette.input.value = 'script';
    palette.input.dispatchEvent(new Event('input'));
    expect(document.querySelector('.command-palette-list script')).toBeNull();
  });
});

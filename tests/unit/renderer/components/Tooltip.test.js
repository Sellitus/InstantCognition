// jest.resetModules before each test so the module-level singleton
// (tooltipEl + active state) is fresh per test.
describe('Tooltip', () => {
  let Tooltip;

  beforeEach(() => {
    jest.useFakeTimers();
    document.body.textContent = '';
    document.body.classList.remove('no-animations');
    delete document.body.dataset.chromeLayout;
    jest.resetModules();
    Tooltip = require('../../../../renderer/components/Tooltip');
  });

  afterEach(() => {
    jest.useRealTimers();
    document.body.textContent = '';
  });

  function makeButton(label = 'Click me') {
    const btn = document.createElement('button');
    btn.textContent = label;
    document.body.appendChild(btn);
    return btn;
  }

  function getTooltipEl() {
    return document.querySelector('.app-tooltip');
  }

  test('attach() sets up listeners and stores the label on the element', () => {
    const btn = makeButton();
    Tooltip.attach(btn, 'Find in page');
    expect(btn.__appTooltipLabel).toBe('Find in page');
    expect(btn.__appTooltipAttached).toBe(true);
  });

  test('attach() with an existing element updates the label without re-binding', () => {
    const btn = makeButton();
    Tooltip.attach(btn, 'A');
    Tooltip.attach(btn, 'B');
    expect(btn.__appTooltipLabel).toBe('B');
  });

  test('hover shows tooltip after 150ms delay', () => {
    const btn = makeButton();
    Tooltip.attach(btn, 'Tip');
    btn.dispatchEvent(new MouseEvent('mouseenter'));

    // Not yet visible at 100ms.
    jest.advanceTimersByTime(100);
    let tip = getTooltipEl();
    expect(tip === null || tip.hidden === true).toBe(true);

    // Visible at 150ms.
    jest.advanceTimersByTime(60);
    tip = getTooltipEl();
    expect(tip).not.toBeNull();
    expect(tip.hidden).toBe(false);
    expect(tip.textContent).toBe('Tip');
    expect(tip.classList.contains('is-visible')).toBe(true);
  });

  test('mouseleave hides the tooltip', () => {
    const btn = makeButton();
    Tooltip.attach(btn, 'Tip');
    btn.dispatchEvent(new MouseEvent('mouseenter'));
    jest.advanceTimersByTime(200);
    expect(getTooltipEl().classList.contains('is-visible')).toBe(true);

    btn.dispatchEvent(new MouseEvent('mouseleave'));
    jest.advanceTimersByTime(200);
    expect(getTooltipEl().classList.contains('is-visible')).toBe(false);
  });

  test('body.no-animations skips the show delay', () => {
    document.body.classList.add('no-animations');
    const btn = makeButton();
    Tooltip.attach(btn, 'Tip');
    btn.dispatchEvent(new MouseEvent('mouseenter'));

    // Even without advancing timers fully, the timer of 0 fires when timers run.
    jest.advanceTimersByTime(0);
    const tip = getTooltipEl();
    expect(tip).not.toBeNull();
    expect(tip.classList.contains('is-visible')).toBe(true);
  });

  test('suppressed when host is inside .chrome-sidebar--expanded', () => {
    const expandedSidebar = document.createElement('div');
    expandedSidebar.className = 'chrome-sidebar--expanded';
    const btn = document.createElement('button');
    expandedSidebar.appendChild(btn);
    document.body.appendChild(expandedSidebar);

    Tooltip.attach(btn, 'Should not appear');
    btn.dispatchEvent(new MouseEvent('mouseenter'));
    jest.advanceTimersByTime(500);

    const tip = getTooltipEl();
    expect(tip === null || tip.classList.contains('is-visible') === false).toBe(true);
  });

  test('mousedown hides the tooltip immediately', () => {
    const btn = makeButton();
    Tooltip.attach(btn, 'Tip');
    btn.dispatchEvent(new MouseEvent('mouseenter'));
    jest.advanceTimersByTime(200);
    expect(getTooltipEl().classList.contains('is-visible')).toBe(true);

    btn.dispatchEvent(new MouseEvent('mousedown'));
    expect(getTooltipEl().classList.contains('is-visible')).toBe(false);
  });

  test('detach() removes listeners; further hovers do not show', () => {
    const btn = makeButton();
    Tooltip.attach(btn, 'Tip');
    Tooltip.detach(btn);

    btn.dispatchEvent(new MouseEvent('mouseenter'));
    jest.advanceTimersByTime(500);
    const tip = getTooltipEl();
    // Tooltip element may exist (singleton) but should not be visible.
    expect(tip === null || tip.classList.contains('is-visible') === false).toBe(true);
    expect(btn.__appTooltipAttached).toBeUndefined();
  });

  test('positions tooltip on the correct side per body.dataset.chromeLayout', () => {
    const btn = makeButton();
    Tooltip.attach(btn, 'Tip');
    // Stub bounding rect so position is deterministic.
    btn.getBoundingClientRect = () => ({
      left: 100, right: 130, top: 200, bottom: 230, width: 30, height: 30,
      x: 100, y: 200, toJSON() {},
    });

    // Each layout anchors on a different edge of the host. Verify the
    // tooltip transform reflects that edge by checking the relevant
    // coordinate is on the expected side of the button.
    const cases = [
      // top: tip below the host → top > bottom edge (230)
      { layout: 'top', axis: 'y', cmp: (n) => n >= 230 },
      // bottom: tip above the host → top < top edge (200)
      { layout: 'bottom', axis: 'y', cmp: (n) => n < 200 },
      // left: tip to the right of host → left >= right edge (130)
      { layout: 'left', axis: 'x', cmp: (n) => n >= 130 },
      // right: tip to the left of host → left < left edge (100)
      { layout: 'right', axis: 'x', cmp: (n) => n < 100 },
    ];

    for (const { layout, axis, cmp } of cases) {
      document.body.dataset.chromeLayout = layout;
      btn.dispatchEvent(new MouseEvent('mouseenter'));
      jest.advanceTimersByTime(200);
      const tip = getTooltipEl();
      expect(tip).not.toBeNull();
      expect(tip.classList.contains('is-visible')).toBe(true);

      const m = tip.style.transform.match(/translate\((-?\d+)px,\s*(-?\d+)px\)/);
      expect(m).not.toBeNull();
      const [, xs, ys] = m;
      const value = axis === 'x' ? Number(xs) : Number(ys);
      expect(cmp(value)).toBe(true);

      btn.dispatchEvent(new MouseEvent('mouseleave'));
      jest.advanceTimersByTime(300);
    }
  });
});

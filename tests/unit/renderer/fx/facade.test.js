/**
 * @jest-environment jsdom
 */
// Facade (renderer/fx/index.js) gating, plus the shared rAF ticker. matchMedia,
// requestAnimationFrame and canvas contexts are browser boundaries: stubbed.

let frames;
let reducedMotion;

function stubBrowser() {
  frames = [];
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
  reducedMotion = false;
  window.matchMedia = jest.fn(() => ({ matches: reducedMotion, addEventListener: jest.fn() }));
}

function runFrame(now) {
  const due = frames;
  frames = [];
  due.forEach((cb) => cb(now));
}

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  document.body.innerHTML = '';
  document.body.className = '';
  stubBrowser();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('fx/ticker', () => {
  test('runs callbacks with capped dt and stops requesting frames once idle', () => {
    const ticker = require('../../../../renderer/fx/ticker');
    const dts = [];
    let n = 0;
    ticker.add((dt) => { dts.push(dt); return ++n < 3; });
    expect(frames).toHaveLength(1);
    runFrame(1000);
    runFrame(1016);
    runFrame(2000);
    expect(dts[1]).toBeCloseTo(0.016, 6);
    expect(dts[2]).toBe(0.05);
    expect(ticker.size()).toBe(0);
    expect(frames).toHaveLength(0);
  });

  test('remover unregisters and a single loop serves many callbacks', () => {
    const ticker = require('../../../../renderer/fx/ticker');
    const a = jest.fn();
    const removeA = ticker.add(a);
    ticker.add(jest.fn());
    expect(frames).toHaveLength(1);
    removeA();
    runFrame(10);
    expect(a).not.toHaveBeenCalled();
    expect(ticker.size()).toBe(1);
  });
});

describe('fx facade', () => {
  function load() { return require('../../../../renderer/fx'); }

  function pane(id) {
    const wrapper = document.createElement('div');
    wrapper.className = 'space-webview-wrapper';
    wrapper.dataset.spaceId = id;
    wrapper.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 });
    const wv = document.createElement('webview');
    wv.id = id;
    wrapper.appendChild(wv);
    document.body.appendChild(wrapper);
    return wrapper;
  }

  function agentPanel() {
    const panel = document.createElement('div');
    panel.id = 'agent-panel';
    document.body.appendChild(panel);
    return panel;
  }

  test('level is off until settings are applied', () => {
    expect(load().getLevel()).toBe('off');
  });

  test('applySettings maps the level and power mode onto body classes', () => {
    const fx = load();
    fx.applySettings({ motionEffects: 'subtle' });
    expect(document.body.classList.contains('fx-subtle')).toBe(true);
    expect(document.body.classList.contains('fx-full')).toBe(false);
    fx.applySettings({ motionEffects: 'full', hardwareAcceleration: 'off' });
    expect(document.body.classList.contains('fx-full')).toBe(true);
    expect(document.body.classList.contains('fx-subtle')).toBe(false);
    expect(document.body.classList.contains('fx-lowpower')).toBe(true);
  });

  test('OS reduced motion turns everything off regardless of the setting', () => {
    reducedMotion = true;
    const fx = load();
    fx.applySettings({ motionEffects: 'full' });
    expect(fx.getLevel()).toBe('off');
    expect(document.body.classList.contains('fx-full')).toBe(false);
  });

  test('off: hooks draw nothing and touch no canvas', () => {
    const fx = load();
    fx.applySettings({ motionEffects: 'off' });
    const panel = agentPanel();
    fx.agentActivity(true);
    expect(panel.querySelector('.fx-rim')).toBeNull();
    const canvas = document.createElement('canvas');
    canvas.getContext = jest.fn();
    fx.starfield(canvas, { warp: true }).start();
    fx.voiceOrb(canvas, 1);
    expect(canvas.getContext).not.toHaveBeenCalled();
    const bar = document.createElement('div');
    const tab = document.createElement('div');
    tab.className = 'tab-bar-tab';
    tab.animate = jest.fn();
    bar.appendChild(tab);
    fx.tabsBeforeRender(bar)();
    expect(tab.animate).not.toHaveBeenCalled();
  });

  test('subtle: agent running shows the live rim; stopping removes it', () => {
    const fx = load();
    fx.applySettings({ motionEffects: 'subtle' });
    const panel = agentPanel();
    fx.agentActivity(true);
    expect(panel.querySelector('.fx-rim')).not.toBeNull();
    fx.agentActivity(false);
    jest.advanceTimersByTime(400);
    expect(panel.querySelector('.fx-rim')).toBeNull();
  });

  test('subtle: a planned browser action rims the focused pane briefly; web search does not', () => {
    const fx = load();
    fx.init({ state: { get: (k) => (k === 'currentSpaceId' ? 'space-1' : null) } });
    fx.applySettings({ motionEffects: 'subtle' });
    const wrapper = pane('space-1');
    fx.agentStepPlanned({ calls: [{ name: 'browser.web_search', args: {} }] });
    expect(wrapper.querySelector('.fx-rim')).toBeNull();
    fx.agentStepPlanned({ calls: [{ name: 'browser.click', args: {} }] });
    expect(wrapper.querySelector('.fx-rim')).not.toBeNull();
    jest.advanceTimersByTime(1400 + 400);
    expect(wrapper.querySelector('.fx-rim')).toBeNull();
  });

  test('explicit spaceId targets that pane over the focused one', () => {
    const fx = load();
    fx.init({ state: { get: () => 'space-1' } });
    fx.applySettings({ motionEffects: 'subtle' });
    const focused = pane('space-1');
    const other = pane('space-2');
    fx.agentStepPlanned({ calls: [{ name: 'browser.click', args: { spaceId: 'space-2' } }] });
    expect(other.querySelector('.fx-rim')).not.toBeNull();
    expect(focused.querySelector('.fx-rim')).toBeNull();
  });

  test('council rims every councillor pane and clears them on stop', () => {
    const fx = load();
    fx.applySettings({ motionEffects: 'subtle' });
    const a = pane('c-1');
    const b = pane('c-2');
    fx.councilStart(['c-1', 'c-2', 'missing']);
    expect(a.querySelector('.fx-rim')).not.toBeNull();
    expect(b.querySelector('.fx-rim')).not.toBeNull();
    fx.councilStop();
    jest.advanceTimersByTime(400);
    expect(a.querySelector('.fx-rim')).toBeNull();
    expect(b.querySelector('.fx-rim')).toBeNull();
  });

  test('layout morph is skipped while the window is stabilizing', () => {
    const fx = load();
    fx.applySettings({ motionEffects: 'full' });
    const container = document.createElement('div');
    const w = pane('l-1');
    container.appendChild(w);
    w.animate = jest.fn();
    document.body.classList.add('window-stabilizing');
    const settle = fx.layoutBeforeApply(container);
    w.getBoundingClientRect = () => ({ left: 200, top: 0, width: 200, height: 300 });
    settle();
    expect(w.animate).not.toHaveBeenCalled();
    document.body.classList.remove('window-stabilizing');
    w.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300 });
    const settle2 = fx.layoutBeforeApply(container);
    w.getBoundingClientRect = () => ({ left: 200, top: 0, width: 200, height: 300 });
    settle2();
    expect(w.animate).toHaveBeenCalledTimes(1);
  });
});

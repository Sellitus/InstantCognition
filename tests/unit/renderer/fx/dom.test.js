/**
 * @jest-environment jsdom
 */
// DOM-facing fx helpers. jsdom has no layout and no Element.animate, so rects
// are stubbed per element and animate is a spy (both are browser boundaries).

const { captureRects, diffRects, playFlip } = require('../../../../renderer/fx/flip');
const streamReveal = require('../../../../renderer/fx/streamReveal');
const { glide } = require('../../../../renderer/fx/glide');
const rim = require('../../../../renderer/fx/rim');

function rect(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
}

function keyed(container, key, r) {
  const el = document.createElement('div');
  el.className = 'item';
  el.dataset.key = key;
  el.getBoundingClientRect = () => r;
  container.appendChild(el);
  return el;
}

describe('fx/flip', () => {
  test('diffRects classifies moved, added and removed keys', () => {
    const before = new Map([['a', rect(0, 0, 100, 30)], ['b', rect(100, 0, 100, 30)], ['c', rect(200, 0, 100, 30)]]);
    const after = new Map([['a', rect(0, 0, 100, 30)], ['b', rect(0, 40, 100, 30)], ['d', rect(200, 0, 100, 30)]]);
    const diff = diffRects(before, after);
    expect(diff.moved).toEqual([{ key: 'b', dx: 100, dy: -40, sx: 1, sy: 1 }]);
    expect(diff.added).toEqual(['d']);
    expect(diff.removed).toEqual([{ key: 'c', rect: before.get('c') }]);
  });

  test('sub-pixel jitter is not treated as movement', () => {
    const diff = diffRects(new Map([['a', rect(0, 0, 100, 30)]]), new Map([['a', rect(0.5, 0.5, 100.5, 30)]]));
    expect(diff.moved).toEqual([]);
  });

  test('captureRects skips unkeyed and zero-size elements', () => {
    const c = document.createElement('div');
    keyed(c, 'a', rect(0, 0, 10, 10));
    keyed(c, 'hidden', rect(0, 0, 0, 0));
    keyed(c, '', rect(0, 0, 10, 10));
    expect([...captureRects(c, '.item', (el) => el.dataset.key).keys()]).toEqual(['a']);
  });

  test('playFlip animates moved elements from their old offset; scale:false is translate only', () => {
    const c = document.createElement('div');
    const before = new Map([['a', rect(50, 0, 80, 30)], ['b', rect(0, 0, 100, 30)]]);
    const a = keyed(c, 'a', rect(0, 0, 100, 30));
    const b = keyed(c, 'b', rect(0, 0, 100, 30));
    a.animate = jest.fn();
    b.animate = jest.fn();
    const diff = playFlip(c, '.item', (el) => el.dataset.key, before, { easing: 'linear', duration: 300, scale: false });
    expect(a.animate).toHaveBeenCalledTimes(1);
    expect(a.animate.mock.calls[0][0][0].transform).toBe('translate(50px, 0px)');
    expect(a.animate.mock.calls[0][1]).toEqual({ duration: 300, easing: 'linear' });
    expect(b.animate).not.toHaveBeenCalled();
    expect(diff.els.get('a')).toBe(a);
  });

  test('playFlip includes scale by default', () => {
    const c = document.createElement('div');
    const a = keyed(c, 'a', rect(0, 0, 100, 50));
    a.animate = jest.fn();
    playFlip(c, '.item', (el) => el.dataset.key, new Map([['a', rect(0, 0, 50, 25)]]), { easing: 'linear', duration: 1 });
    expect(a.animate.mock.calls[0][0][0].transform).toBe('translate(0px, 0px) scale(0.5, 0.5)');
  });
});

describe('fx/streamReveal', () => {
  const CARET = '<span class="agent-answer-caret">▍</span>';
  let body;
  const render = (html, now) => { body.innerHTML = html + CARET; streamReveal.afterRender(body, now); };
  const toks = () => [...body.querySelectorAll('.fx-tok')];

  beforeEach(() => { body = document.createElement('div'); });

  test('wraps newly arrived characters and continues older fades with a negative delay', () => {
    render('<p>Hello</p>', 1000);
    expect(toks().map((t) => t.textContent)).toEqual(['Hello']);
    render('<p>Hello world</p>', 1100);
    const t = toks();
    expect(t.map((x) => x.textContent)).toEqual(['Hello', ' world']);
    expect(t[0].style.animationDelay).toBe('-100ms');
    expect(t[1].style.animationDelay).toBe('0ms');
    expect(body.textContent).toBe('Hello world▍');
  });

  test('ranges older than the reveal window are left unwrapped', () => {
    render('<p>Hello</p>', 0);
    render('<p>Hello!</p>', streamReveal.REVEAL_MS + 50);
    expect(toks().map((x) => x.textContent)).toEqual(['!']);
  });

  test('never wraps the caret or whitespace-only slices', () => {
    render('<p>Hi</p>', 0);
    render('<p>Hi</p>\n\n', 10);
    expect(body.querySelector('.agent-answer-caret .fx-tok')).toBeNull();
    expect(toks().every((x) => x.textContent.trim().length > 0)).toBe(true);
  });

  test('wraps across element boundaries without changing the text', () => {
    render('<p>One <strong>two</strong></p>', 0);
    render('<p>One <strong>two</strong> three</p><ul><li>four</li></ul>', 50);
    expect(body.textContent).toBe('One two threefour▍');
    expect(toks().map((x) => x.textContent)).toEqual(['One ', 'two', ' three', 'four']);
  });

  test('a shrinking canonical re-render resets without animating', () => {
    render('<p>**bold</p>', 0);
    render('<p><strong>bold</strong></p>', 20);
    expect(toks()).toHaveLength(0);
  });

  test('reset forgets history so the next answer reveals from the start', () => {
    render('<p>First</p>', 0);
    streamReveal.reset(body);
    render('<p>First</p>', 1);
    expect(toks().map((x) => x.textContent)).toEqual(['First']);
  });
});

describe('fx/glide', () => {
  const S = { easing: 'linear(0, 1)', duration: 250 };
  let list;
  beforeEach(() => {
    list = document.createElement('ul');
    list.innerHTML = '<li class="opt selected">a</li><li class="opt">b</li>';
    document.body.appendChild(list);
  });
  afterEach(() => list.remove());

  test('inserts one aria-hidden indicator as the first child, placed without transition', () => {
    glide(list, '.opt.selected', S);
    const ind = list.firstElementChild;
    expect(ind.className).toBe('fx-glide');
    expect(ind.getAttribute('aria-hidden')).toBe('true');
    expect(ind.hidden).toBe(false);
    expect(ind.style.transition).toBe('none');
    expect(list.classList.contains('fx-glide-host')).toBe(true);
  });

  test('subsequent moves spring with the given easing', () => {
    glide(list, '.opt.selected', S);
    list.children[1].classList.remove('selected');
    list.children[2].classList.add('selected');
    glide(list, '.opt.selected', S);
    expect(list.querySelectorAll('.fx-glide')).toHaveLength(1);
    expect(list.firstElementChild.style.transition).toContain('250ms linear(0, 1)');
  });

  test('hides when nothing is selected and survives an innerHTML re-render', () => {
    glide(list, '.opt.selected', S);
    list.innerHTML = '<li class="opt">x</li>';
    glide(list, '.opt.selected', S);
    expect(list.firstElementChild.className).toBe('fx-glide');
    expect(list.firstElementChild.hidden).toBe(true);
  });
});

describe('fx/rim', () => {
  beforeEach(() => { jest.useFakeTimers(); document.body.innerHTML = ''; });
  afterEach(() => jest.useRealTimers());

  test('attach builds one gradient rim per host and shared defs once', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    document.body.append(a, b);
    rim.attach(a);
    rim.attach(a);
    rim.attach(b);
    expect(a.querySelectorAll('.fx-rim')).toHaveLength(1);
    expect(a.querySelectorAll('.fx-rim rect')).toHaveLength(3);
    expect(document.querySelectorAll('#fx-defs')).toHaveLength(1);
    expect(document.getElementById('fx-grad')).not.toBeNull();
  });

  test('detach removes the rim after the fade-out', () => {
    const a = document.createElement('div');
    document.body.appendChild(a);
    rim.attach(a);
    rim.detach(a);
    expect(a.querySelector('.fx-rim')).not.toBeNull();
    jest.advanceTimersByTime(400);
    expect(a.querySelector('.fx-rim')).toBeNull();
  });

  test('re-attaching during the fade-out cancels the removal', () => {
    const a = document.createElement('div');
    document.body.appendChild(a);
    rim.attach(a);
    rim.detach(a);
    rim.attach(a);
    jest.advanceTimersByTime(400);
    const svg = a.querySelector('.fx-rim');
    expect(svg).not.toBeNull();
    expect(svg.classList.contains('is-on')).toBe(true);
  });

  test('detach on a host without a rim is a no-op', () => {
    expect(() => rim.detach(document.createElement('div'))).not.toThrow();
    expect(() => rim.detach(null)).not.toThrow();
  });
});

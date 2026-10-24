// modalStack decides which modal layer owns Escape. Every modal listens on
// `document` in the capture phase, so without this a confirm opened over
// Settings resolved the confirm AND closed Settings behind it.

const modalStack = require('../../../../renderer/utils/modalStack');

describe('modalStack', () => {
  test('the most recently pushed layer owns Escape', () => {
    const settings = modalStack.push();
    expect(modalStack.isTop(settings)).toBe(true);

    const confirmLayer = modalStack.push();
    expect(modalStack.isTop(confirmLayer)).toBe(true);
    expect(modalStack.isTop(settings)).toBe(false);

    modalStack.pop(confirmLayer);
    expect(modalStack.isTop(settings)).toBe(true);
    modalStack.pop(settings);
  });

  test('popping out of order leaves the remaining layers intact', () => {
    const a = modalStack.push();
    const b = modalStack.push();
    const c = modalStack.push();

    modalStack.pop(b);
    expect(modalStack.depth()).toBe(2);
    expect(modalStack.isTop(c)).toBe(true);

    modalStack.pop(c);
    expect(modalStack.isTop(a)).toBe(true);
    modalStack.pop(a);
    expect(modalStack.depth()).toBe(0);
  });

  test('popping twice is harmless', () => {
    const a = modalStack.push();
    modalStack.pop(a);
    modalStack.pop(a);
    expect(modalStack.depth()).toBe(0);
    expect(modalStack.isTop(a)).toBe(false);
  });

  test('isTop is false when nothing is open', () => {
    const a = modalStack.push();
    modalStack.pop(a);
    expect(modalStack.isTop(a)).toBe(false);
  });
});

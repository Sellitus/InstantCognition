// rendererReset — the one signal that a shell renderer started over. A
// webContents is the external boundary, faked with an EventEmitter.

const { EventEmitter } = require('events');
const { onRendererReset } = require('../../../../main/utils/rendererReset');

function setup() {
  const wc = new EventEmitter();
  const fn = jest.fn();
  onRendererReset(wc, fn);
  return { wc, fn };
}

describe('onRendererReset', () => {
  test('a main-frame document navigation (reload) fires', () => {
    const { wc, fn } = setup();
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('a crashed render process fires', () => {
    const { wc, fn } = setup();
    wc.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('a sub-frame load (an artifact iframe) does not fire', () => {
    const { wc, fn } = setup();
    wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    wc.emit('did-start-loading');
    expect(fn).not.toHaveBeenCalled();
  });

  test('a same-document navigation (hash change) does not fire', () => {
    const { wc, fn } = setup();
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect(fn).not.toHaveBeenCalled();
  });
});

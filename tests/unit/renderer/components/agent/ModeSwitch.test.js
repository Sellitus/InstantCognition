/**
 * @jest-environment jsdom
 */

// ModeSwitch: Auto/Chat/Agent radiogroup. No boundaries; onSelect is the
// owner's callback, recorded with a jest.fn.

const ModeSwitch = require('../../../../../renderer/components/agent/ModeSwitch');

function setup() {
  const onSelect = jest.fn();
  const sw = new ModeSwitch({ onSelect });
  document.body.appendChild(sw.el);
  const btn = (id) => sw.el.querySelector(`[data-mode="${id}"]`);
  return { sw, onSelect, btn };
}

afterEach(() => { document.body.textContent = ''; });

describe('ModeSwitch', () => {
  test('renders a radiogroup with Auto checked and the only tab stop', () => {
    const { sw, btn } = setup();
    expect(sw.el.getAttribute('role')).toBe('radiogroup');
    expect(btn('auto').getAttribute('aria-checked')).toBe('true');
    expect([btn('auto').tabIndex, btn('chat').tabIndex, btn('agent').tabIndex]).toEqual([0, -1, -1]);
    expect(sw.mode).toBe('auto');
  });

  test('clicking a different mode checks it and notifies once; re-clicking does not notify', () => {
    const { sw, onSelect, btn } = setup();
    btn('chat').click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('chat');
    expect(btn('chat').classList.contains('is-active')).toBe(true);
    expect(btn('auto').getAttribute('aria-checked')).toBe('false');
    btn('chat').click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(sw.mode).toBe('chat');
  });

  test('set() reflects a mode silently and maps unknown values to Auto', () => {
    const { sw, onSelect, btn } = setup();
    sw.set('agent');
    expect(btn('agent').getAttribute('aria-checked')).toBe('true');
    sw.set('nonsense');
    expect(sw.mode).toBe('auto');
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('arrow keys wrap around, move focus and notify the owner', () => {
    const { onSelect, btn } = setup();
    btn('auto').focus();
    btn('auto').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(onSelect).toHaveBeenLastCalledWith('agent');
    expect(document.activeElement).toBe(btn('agent'));
    btn('agent').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(onSelect).toHaveBeenLastCalledWith('auto');
    expect(document.activeElement).toBe(btn('auto'));
  });

  test('other keys are ignored', () => {
    const { onSelect, btn } = setup();
    const ev = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    btn('auto').dispatchEvent(ev);
    expect(onSelect).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });
});

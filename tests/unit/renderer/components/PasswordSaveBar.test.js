/**
 * @jest-environment jsdom
 */

// PasswordSaveBar — non-modal save offer driven by 'passwords:offer'; answers
// through 'passwords:resolve-offer'. External boundary: electron.ipcRenderer
// as a real EventEmitter. Toast runs for real and is read from the DOM.

jest.mock('electron', () => {
  const { EventEmitter: EE } = require('events');
  const em = new EE();
  em.invoke = jest.fn(() => Promise.resolve({ ok: true }));
  global.__pwBus = em;
  return { ipcRenderer: em };
});

let bus;
let bar;

const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
const barEl = () => document.querySelector('.password-bar');
const button = (label) => Array.from(barEl().querySelectorAll('button')).find((b) => b.textContent.trim() === label);
const offer = (over = {}) => bus.emit('passwords:offer', {}, { id: 'o1', origin: 'https://a.test', host: 'a.test', username: 'alice', kind: 'save', ...over });
const toasts = () => Array.from(document.querySelectorAll('.toast')).map((t) => t.textContent);

beforeEach(() => {
  jest.resetModules();
  document.body.innerHTML = '';
  bar = require('../../../../renderer/components/PasswordSaveBar');
  bus = global.__pwBus;
  bus.removeAllListeners();
  bus.invoke.mockReset();
  bus.invoke.mockResolvedValue({ ok: true });
  bar.initialize();
});

describe('PasswordSaveBar', () => {
  test('shows host and username with three labelled actions, without taking focus', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    offer();
    const el = barEl();
    expect(el.getAttribute('role')).toBe('dialog');
    expect(el.getAttribute('aria-modal')).toBe('false');
    expect(document.getElementById(el.getAttribute('aria-labelledby')).textContent).toBe('Save password for a.test?');
    expect(el.textContent).toContain('alice');
    expect(Array.from(el.querySelectorAll('button')).map((b) => b.textContent.trim())).toEqual(['Save', 'Never for this site', 'Not now']);
    expect(document.activeElement).toBe(input);
  });

  test('an update offer reads "Update password"', () => {
    offer({ kind: 'update' });
    expect(barEl().textContent).toContain('Update password for a.test?');
    expect(button('Update')).toBeTruthy();
  });

  test('the bar never renders a password even if one were sent', () => {
    offer({ password: 'leaked-pw' });
    expect(document.body.innerHTML).not.toContain('leaked-pw');
  });

  test.each([
    ['Save', 'save'],
    ['Never for this site', 'never'],
    ['Not now', 'dismiss'],
  ])('%s answers with action %s and closes the bar', async (label, action) => {
    offer();
    button(label).click();
    expect(bus.invoke).toHaveBeenCalledWith('passwords:resolve-offer', { id: 'o1', action });
    expect(barEl()).toBeNull();
    await flush();
  });

  test('Escape inside the bar answers Not now', () => {
    offer();
    button('Save').focus();
    button('Save').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(bus.invoke).toHaveBeenCalledWith('passwords:resolve-offer', { id: 'o1', action: 'dismiss' });
    expect(barEl()).toBeNull();
  });

  test('Escape outside the bar leaves it alone', () => {
    offer();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(bus.invoke).not.toHaveBeenCalled();
    expect(barEl()).not.toBeNull();
  });

  test('a failed save is shown to the user', async () => {
    bus.invoke.mockResolvedValue({ ok: false, error: 'Passwords cannot be saved because the keychain is locked.' });
    offer();
    button('Save').click();
    await flush();
    expect(toasts().join(' ')).toContain('keychain is locked');
  });

  test('an IPC rejection is logged and shown', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    bus.invoke.mockRejectedValue(new Error('channel closed'));
    offer();
    button('Save').click();
    await flush();
    expect(errSpy).toHaveBeenCalled();
    expect(toasts().join(' ')).toContain('channel closed');
    errSpy.mockRestore();
  });

  test('a newer offer replaces the bar; expiry of the current offer closes it', () => {
    offer();
    offer({ id: 'o2', host: 'b.test' });
    expect(document.querySelectorAll('.password-bar')).toHaveLength(1);
    expect(barEl().textContent).toContain('b.test');
    bus.emit('passwords:offer-expired', {}, { id: 'o1' });
    expect(barEl()).not.toBeNull();
    bus.emit('passwords:offer-expired', {}, { id: 'o2' });
    expect(barEl()).toBeNull();
  });

  test('offers from several tabs queue: answering the shown one brings back the one before it', async () => {
    offer({ id: 'o1', host: 'a.test' });
    offer({ id: 'o2', host: 'b.test' });
    expect(barEl().textContent).toContain('b.test');
    button('Not now').click();
    expect(bus.invoke).toHaveBeenCalledWith('passwords:resolve-offer', { id: 'o2', action: 'dismiss' });
    expect(document.querySelectorAll('.password-bar')).toHaveLength(1);
    expect(barEl().textContent).toContain('a.test');
    button('Save').click();
    expect(bus.invoke).toHaveBeenLastCalledWith('passwords:resolve-offer', { id: 'o1', action: 'save' });
    expect(barEl()).toBeNull();
    await flush();
  });

  test('a queued offer that expires is not brought back', async () => {
    offer({ id: 'o1', host: 'a.test' });
    offer({ id: 'o2', host: 'b.test' });
    bus.emit('passwords:offer-expired', {}, { id: 'o1' });
    button('Not now').click();
    expect(barEl()).toBeNull();
    await flush();
  });

  test('a save that failed but can be retried shows the offer again', async () => {
    bus.invoke.mockResolvedValueOnce({ ok: false, error: 'The keychain is locked.', retryable: true });
    offer();
    button('Save').click();
    await flush();
    expect(toasts().join(' ')).toContain('keychain is locked');
    expect(barEl().textContent).toContain('Save password for a.test?');
    button('Save').click();
    await flush();
    expect(bus.invoke).toHaveBeenCalledTimes(2);
    expect(barEl()).toBeNull();
  });

  test('a failure that cannot be retried leaves the bar closed', async () => {
    bus.invoke.mockResolvedValueOnce({ ok: false, error: 'This save offer expired.' });
    offer();
    button('Save').click();
    await flush();
    expect(toasts().join(' ')).toContain('expired');
    expect(barEl()).toBeNull();
  });

  test('notices from main become toasts', () => {
    bus.emit('passwords:notice', {}, { kind: 'warn', message: 'No login form was found on this page to fill.' });
    expect(toasts().join(' ')).toContain('No login form');
  });
});

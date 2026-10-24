/**
 * @jest-environment jsdom
 */

// ConfirmDialog — Promise<boolean> destructive-action confirmation. Only
// external boundary is the DOM (jsdom) + focusTrap; nothing is mocked here.
// Fake timers (Dropdown.test convention) drive trap()'s setTimeout(0) and
// the 150ms leave-removal deterministically.

jest.mock('electron', () => ({}), { virtual: true });

const { confirm } = require('../../../../renderer/components/ConfirmDialog');

describe('ConfirmDialog', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    document.body.textContent = '';
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    document.body.textContent = '';
  });

  test('renders title, message and custom labels with the danger kind', () => {
    confirm({
      title: 'Clear history?',
      message: 'This removes everything.',
      confirmLabel: 'Clear',
      cancelLabel: 'Keep',
      confirmKind: 'danger',
    });
    const overlay = document.querySelector('.confirm-dialog-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.querySelector('.confirm-dialog-title').textContent).toBe('Clear history?');
    expect(overlay.querySelector('.confirm-dialog-message').textContent).toBe('This removes everything.');
    const confirmBtn = overlay.querySelector('.confirm-dialog-confirm');
    expect(confirmBtn.textContent).toBe('Clear');
    expect(confirmBtn.classList.contains('confirm-dialog-danger')).toBe(true);
    expect(overlay.querySelector('.confirm-dialog-cancel').textContent).toBe('Keep');
  });

  test('defaults: title, no message node, primary kind, Confirm/Cancel labels', () => {
    confirm();
    const overlay = document.querySelector('.confirm-dialog-overlay');
    expect(overlay.querySelector('.confirm-dialog-title').textContent).toBe('Are you sure?');
    expect(overlay.querySelector('.confirm-dialog-message')).toBeNull();
    const confirmBtn = overlay.querySelector('.confirm-dialog-confirm');
    expect(confirmBtn.textContent).toBe('Confirm');
    expect(confirmBtn.classList.contains('confirm-dialog-primary')).toBe(true);
    expect(confirmBtn.classList.contains('confirm-dialog-danger')).toBe(false);
    expect(overlay.querySelector('.confirm-dialog-cancel').textContent).toBe('Cancel');
  });

  test('an unknown confirmKind falls back to primary (not danger)', () => {
    confirm({ confirmKind: 'whatever' });
    const confirmBtn = document.querySelector('.confirm-dialog-confirm');
    expect(confirmBtn.classList.contains('confirm-dialog-primary')).toBe(true);
    expect(confirmBtn.classList.contains('confirm-dialog-danger')).toBe(false);
  });

  test('escapes HTML in title and message', () => {
    confirm({ title: '<img src=x>', message: 'a & b < c' });
    const overlay = document.querySelector('.confirm-dialog-overlay');
    expect(overlay.querySelector('.confirm-dialog-title').textContent).toBe('<img src=x>');
    expect(overlay.querySelector('.confirm-dialog-title').querySelector('img')).toBeNull();
    expect(overlay.querySelector('.confirm-dialog-message').textContent).toBe('a & b < c');
  });

  test('clicking confirm resolves true and removes the overlay', async () => {
    const p = confirm({ title: 'X' });
    document.querySelector('.confirm-dialog-confirm').click();
    await expect(p).resolves.toBe(true);
    jest.advanceTimersByTime(150);
    expect(document.querySelector('.confirm-dialog-overlay')).toBeNull();
  });

  test('clicking cancel resolves false and removes the overlay', async () => {
    const p = confirm({ title: 'X' });
    document.querySelector('.confirm-dialog-cancel').click();
    await expect(p).resolves.toBe(false);
    jest.advanceTimersByTime(150);
    expect(document.querySelector('.confirm-dialog-overlay')).toBeNull();
  });

  test('Escape key resolves false', async () => {
    const p = confirm({ title: 'X' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(p).resolves.toBe(false);
  });

  test('Enter key resolves true when focus is not on the cancel button', async () => {
    const p = confirm({ title: 'X' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await expect(p).resolves.toBe(true);
  });

  test('Enter key does NOT confirm while the cancel button is focused', async () => {
    const p = confirm({ title: 'X' });
    const cancelBtn = document.querySelector('.confirm-dialog-cancel');
    cancelBtn.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    // Still open — no resolution path triggered.
    expect(document.querySelector('.confirm-dialog-overlay')).not.toBeNull();
    cancelBtn.click();
    await expect(p).resolves.toBe(false);
  });

  test('the close icon resolves false, and Enter while it is focused does not confirm', async () => {
    const p = confirm({ title: 'X' });
    const closeBtn = document.querySelector('.confirm-dialog-close');
    expect(closeBtn.getAttribute('aria-label')).toBe('Close');
    expect(closeBtn.querySelector('svg')).not.toBeNull();
    closeBtn.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(document.querySelector('.confirm-dialog-overlay')).not.toBeNull();
    closeBtn.click();
    await expect(p).resolves.toBe(false);
  });

  test('mousedown directly on the backdrop resolves false', async () => {
    const p = confirm({ title: 'X' });
    const overlay = document.querySelector('.confirm-dialog-overlay');
    overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await expect(p).resolves.toBe(false);
  });

  test('mousedown inside the dialog body does NOT resolve', async () => {
    const p = confirm({ title: 'X' });
    const overlay = document.querySelector('.confirm-dialog-overlay');
    const dialog = overlay.querySelector('.confirm-dialog');
    dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.querySelector('.confirm-dialog-overlay')).not.toBeNull();
    overlay.querySelector('.confirm-dialog-cancel').click();
    await expect(p).resolves.toBe(false);
  });

  test('keydown listener is removed after the dialog finishes (no double-resolve)', async () => {
    const p = confirm({ title: 'X' });
    document.querySelector('.confirm-dialog-confirm').click();
    await expect(p).resolves.toBe(true);
    jest.advanceTimersByTime(150);
    expect(document.querySelector('.confirm-dialog-overlay')).toBeNull();
    // A second Escape after close must not throw or recreate the overlay.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.confirm-dialog-overlay')).toBeNull();
  });

  test('focus is moved into the dialog (initialFocus = confirm button)', () => {
    confirm({ title: 'X' });
    // trap() is deferred via setTimeout(0); fake timers flush it.
    jest.advanceTimersByTime(1);
    expect(document.activeElement).toBe(document.querySelector('.confirm-dialog-confirm'));
  });

  test('resolves false immediately when document.body is unavailable', async () => {
    const realBody = document.body;
    Object.defineProperty(document, 'body', { value: null, configurable: true });
    try {
      await expect(confirm({ title: 'X' })).resolves.toBe(false);
    } finally {
      Object.defineProperty(document, 'body', { value: realBody, configurable: true });
    }
  });
});

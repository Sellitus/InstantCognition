/**
 * @jest-environment jsdom
 */

// PromptDialog — Promise<string|null> text-input modal. Only external boundary
// is the DOM (jsdom) + focusTrap; nothing is mocked here. Fake timers drive
// trap()'s setTimeout(0) and the 150ms leave-removal deterministically.

jest.mock('electron', () => ({}), { virtual: true });

const { prompt } = require('../../../../renderer/components/PromptDialog');

describe('PromptDialog', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    document.body.textContent = '';
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    document.body.textContent = '';
  });

  test('renders title, message, input, and custom labels with the danger kind', () => {
    prompt({
      title: 'New project',
      message: 'Give the project a name.',
      placeholder: 'Untitled',
      confirmLabel: 'Create',
      cancelLabel: 'Dismiss',
      confirmKind: 'danger',
    });
    const overlay = document.querySelector('.prompt-dialog-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.querySelector('.prompt-dialog-title').textContent).toBe('New project');
    expect(overlay.querySelector('.prompt-dialog-message').textContent).toBe('Give the project a name.');
    const input = overlay.querySelector('.prompt-dialog-input');
    expect(input.placeholder).toBe('Untitled');
    const confirmBtn = overlay.querySelector('.prompt-dialog-confirm');
    expect(confirmBtn.textContent).toBe('Create');
    expect(confirmBtn.classList.contains('prompt-dialog-danger')).toBe(true);
    expect(overlay.querySelector('.prompt-dialog-cancel').textContent).toBe('Dismiss');
  });

  test('defaults: title, no message node, primary kind, OK/Cancel labels', () => {
    prompt();
    const overlay = document.querySelector('.prompt-dialog-overlay');
    expect(overlay.querySelector('.prompt-dialog-title').textContent).toBe('Enter a value');
    expect(overlay.querySelector('.prompt-dialog-message')).toBeNull();
    const confirmBtn = overlay.querySelector('.prompt-dialog-confirm');
    expect(confirmBtn.textContent).toBe('OK');
    expect(confirmBtn.classList.contains('prompt-dialog-primary')).toBe(true);
    expect(overlay.querySelector('.prompt-dialog-cancel').textContent).toBe('Cancel');
  });

  test('escapes HTML in title and message', () => {
    prompt({ title: '<img src=x>', message: 'a & b < c' });
    const overlay = document.querySelector('.prompt-dialog-overlay');
    expect(overlay.querySelector('.prompt-dialog-title').textContent).toBe('<img src=x>');
    expect(overlay.querySelector('.prompt-dialog-title').querySelector('img')).toBeNull();
    expect(overlay.querySelector('.prompt-dialog-message').textContent).toBe('a & b < c');
  });

  test('the input is prefilled with defaultValue', () => {
    prompt({ defaultValue: 'hello' });
    expect(document.querySelector('.prompt-dialog-input').value).toBe('hello');
  });

  test('confirming resolves with the trimmed value and removes the overlay', async () => {
    const p = prompt({ defaultValue: '  keep me  ' });
    document.querySelector('.prompt-dialog-confirm').click();
    await expect(p).resolves.toBe('keep me');
    jest.advanceTimersByTime(150);
    expect(document.querySelector('.prompt-dialog-overlay')).toBeNull();
  });

  test('cancel resolves null and removes the overlay', async () => {
    const p = prompt({ defaultValue: 'x' });
    document.querySelector('.prompt-dialog-cancel').click();
    await expect(p).resolves.toBeNull();
    jest.advanceTimersByTime(150);
    expect(document.querySelector('.prompt-dialog-overlay')).toBeNull();
  });

  test('Escape resolves null', async () => {
    const p = prompt({ defaultValue: 'x' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(p).resolves.toBeNull();
  });

  test('Enter submits the trimmed value', async () => {
    const p = prompt({ defaultValue: 'abc' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await expect(p).resolves.toBe('abc');
  });

  test('Enter does NOT submit while the cancel button is focused', async () => {
    const p = prompt({ defaultValue: 'x' });
    const cancelBtn = document.querySelector('.prompt-dialog-cancel');
    cancelBtn.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(document.querySelector('.prompt-dialog-overlay')).not.toBeNull();
    cancelBtn.click();
    await expect(p).resolves.toBeNull();
  });

  test('mousedown on the backdrop resolves null', async () => {
    const p = prompt({ defaultValue: 'x' });
    const overlay = document.querySelector('.prompt-dialog-overlay');
    overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await expect(p).resolves.toBeNull();
  });

  test('mousedown inside the dialog body does NOT resolve', async () => {
    const p = prompt({ defaultValue: 'x' });
    const dialog = document.querySelector('.prompt-dialog');
    dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.querySelector('.prompt-dialog-overlay')).not.toBeNull();
    document.querySelector('.prompt-dialog-cancel').click();
    await expect(p).resolves.toBeNull();
  });

  test('the close icon resolves null, and Enter while it is focused does not submit', async () => {
    const p = prompt({ title: 'X', defaultValue: 'kept' });
    const closeBtn = document.querySelector('.prompt-dialog-close');
    expect(closeBtn.getAttribute('aria-label')).toBe('Close');
    closeBtn.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(document.querySelector('.prompt-dialog-overlay')).not.toBeNull();
    closeBtn.click();
    await expect(p).resolves.toBeNull();
  });

  test('the input is described by the validation hint element', () => {
    prompt({ title: 'X' });
    const input = document.querySelector('.prompt-dialog-input');
    const hint = document.getElementById(input.getAttribute('aria-describedby'));
    expect(hint).toBe(document.querySelector('.prompt-dialog-hint'));
  });

  test('a failing validate() keeps the dialog open and shows the hint; fixing the value submits', async () => {
    const p = prompt({
      defaultValue: '',
      validate: (v) => (v.trim() ? null : 'Name cannot be empty'),
    });
    const confirmBtn = document.querySelector('.prompt-dialog-confirm');
    const input = document.querySelector('.prompt-dialog-input');
    const hintEl = document.querySelector('.prompt-dialog-hint');

    // First submit: empty value rejected, hint shown, dialog stays open.
    confirmBtn.click();
    expect(document.querySelector('.prompt-dialog-overlay')).not.toBeNull();
    expect(hintEl.hidden).toBe(false);
    expect(hintEl.textContent).toBe('Name cannot be empty');
    expect(input.getAttribute('aria-invalid')).toBe('true');

    // Typing clears the hint.
    input.value = 'ok';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(hintEl.hidden).toBe(true);

    // Second submit: valid value resolves.
    confirmBtn.click();
    await expect(p).resolves.toBe('ok');
    jest.advanceTimersByTime(150);
    expect(document.querySelector('.prompt-dialog-overlay')).toBeNull();
  });

  test('keydown listener is removed after finish (no double-resolve)', async () => {
    const p = prompt({ defaultValue: 'x' });
    document.querySelector('.prompt-dialog-confirm').click();
    await expect(p).resolves.toBe('x');
    jest.advanceTimersByTime(150);
    expect(document.querySelector('.prompt-dialog-overlay')).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.prompt-dialog-overlay')).toBeNull();
  });

  test('focus is moved into the dialog (initialFocus = input)', () => {
    prompt({ defaultValue: 'x' });
    jest.advanceTimersByTime(1);
    expect(document.activeElement).toBe(document.querySelector('.prompt-dialog-input'));
  });

  test('resolves null immediately when document.body is unavailable', async () => {
    const realBody = document.body;
    Object.defineProperty(document, 'body', { value: null, configurable: true });
    try {
      await expect(prompt({ defaultValue: 'x' })).resolves.toBeNull();
    } finally {
      Object.defineProperty(document, 'body', { value: realBody, configurable: true });
    }
  });
});

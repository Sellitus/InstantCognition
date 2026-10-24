// InlinePalette — the composer's `/` and `@` listbox against a mocked IPC
// boundary: triggers, aria wiring, keyboard precedence (modal → palette →
// composer), insertion, blur, and IPC failures as error rows.

const InlinePalette = require('../../../../../renderer/components/assistant/InlinePalette');
const PermissionModeSwitch = require('../../../../../renderer/components/assistant/PermissionModeSwitch');

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

const COMMANDS = [
  { name: 'summarize', description: 'Summarize the page', kind: 'builtin' },
  { name: 'compact', description: 'Compact the conversation', kind: 'builtin' },
  { name: 'pdf-report', description: 'Make a PDF', kind: 'skill' },
];

let composer, input, palette, ipc, modalOpen, onCommand;

function mockIpc(routes) {
  return { invoke: jest.fn((ch, arg) => Promise.resolve().then(() => routes[ch](arg))) };
}
const okRoutes = () => ({
  'commands:list': jest.fn(() => ({ ok: true, commands: COMMANDS })),
  'workspace:search-files': jest.fn(({ query }) => ({ ok: true, roots: 1, truncated: false, results: query === 'src' ? [{ root: '/w', rootName: 'w', path: 'src/app.js', name: 'app.js' }, { root: '/w', rootName: 'w', path: 'src/my notes.md', name: 'my notes.md' }] : [] })),
});

function make(routes = okRoutes()) {
  composer = document.createElement('div');
  input = document.createElement('textarea');
  composer.appendChild(input);
  document.body.appendChild(composer);
  ipc = mockIpc(routes);
  modalOpen = false;
  onCommand = jest.fn(() => false);
  palette = new InlinePalette({ input, container: composer, ipc, isModalOpen: () => modalOpen, onCommand, debounceMs: 0 });
  input.focus();
  return routes;
}

async function type(text) {
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  await new Promise((r) => setTimeout(r, 1));
  await flush();
}

function key(k, opts = {}) {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts });
  const consumed = palette.onKey(e);
  return { consumed, prevented: e.defaultPrevented, e };
}

const labels = () => Array.from(palette.el.querySelectorAll('[role="option"]')).map((o) => o.querySelector('.inline-palette__label').textContent);
const active = () => document.getElementById(input.getAttribute('aria-activedescendant') || '');

afterEach(() => { palette.destroy(); composer.remove(); });

describe('InlinePalette triggers', () => {
  test('`/` at the start lists commands; the first option is active via aria-activedescendant', async () => {
    make();
    await type('/');
    expect(palette.isOpen()).toBe(true);
    expect(labels()).toEqual(['/summarize', '/compact', '/pdf-report']);
    expect(palette.el.getAttribute('role')).toBe('listbox');
    expect(input.getAttribute('aria-controls')).toBe(palette.el.id);
    expect(active().textContent).toContain('/summarize');
    expect(active().getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(input);
  });

  test('typing filters, preferring prefix matches; commands load once per open', async () => {
    const routes = make();
    await type('/');
    await type('/c');
    expect(labels()).toEqual(['/compact']);
    await type('/re');
    expect(labels()).toEqual(['/pdf-report']);
    expect(routes['commands:list']).toHaveBeenCalledTimes(1);
  });

  test('`/` mid-message and an email-style `@` do not open', async () => {
    make();
    await type('see a/b');
    expect(palette.isOpen()).toBe(false);
    await type('mail me@host');
    expect(palette.isOpen()).toBe(false);
  });

  test('`@` lists context tokens then workspace files from workspace:search-files', async () => {
    const routes = make();
    await type('look at @');
    expect(labels()).toEqual(['@page', '@selection', '@spaces', '@browsing']);
    await type('look at @src');
    expect(routes['workspace:search-files']).toHaveBeenLastCalledWith({ query: 'src' });
    expect(labels()).toEqual(['src/app.js', 'src/my notes.md']);
    await type('look at @se');
    expect(labels()).toEqual(['@selection']);
  });

  test('the `@` palette stays closed while the project @-mention menu is showing', async () => {
    make();
    const menu = document.createElement('div');
    menu.className = 'proj-mention-menu';
    menu.setAttribute('role', 'listbox');
    composer.appendChild(menu);
    await type('@');
    expect(palette.isOpen()).toBe(false);
  });
});

describe('InlinePalette keyboard', () => {
  test('arrows wrap and Enter inserts the active command with a trailing space', async () => {
    make();
    await type('/');
    expect(key('ArrowUp').consumed).toBe(true);
    expect(active().textContent).toContain('/pdf-report');
    expect(key('ArrowDown').consumed).toBe(true);
    expect(active().textContent).toContain('/summarize');
    const { consumed, prevented } = key('Enter');
    expect([consumed, prevented]).toEqual([true, true]);
    expect(input.value).toBe('/summarize ');
    expect(input.selectionStart).toBe('/summarize '.length);
    expect(palette.isOpen()).toBe(false);
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
  });

  test('Tab chooses; a file path with spaces is quoted; text after the caret survives', async () => {
    make();
    input.value = 'read @src and summarize';
    input.setSelectionRange(9, 9);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(); await new Promise((r) => setTimeout(r, 1)); await flush();
    key('ArrowDown');
    key('ArrowDown');
    expect(active().textContent).toContain('src/app.js');
    key('ArrowDown');
    expect(key('Tab').consumed).toBe(true);
    expect(input.value).toBe('read @"src/my notes.md" and summarize');
    expect(input.selectionStart).toBe('read @"src/my notes.md"'.length);
  });

  test('Esc closes only the palette: default prevented and propagation stopped', async () => {
    make();
    const outer = jest.fn();
    document.addEventListener('keydown', outer);
    try {
      await type('/');
      const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      input.addEventListener('keydown', (ev) => palette.onKey(ev), { once: true });
      input.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(true);
      expect(outer).not.toHaveBeenCalled();
      expect(palette.isOpen()).toBe(false);
      expect(input.value).toBe('/');
    } finally { document.removeEventListener('keydown', outer); }
  });

  test('a closed palette consumes nothing; Esc then reaches the panel', async () => {
    make();
    await type('hello');
    for (const k of ['ArrowDown', 'Enter', 'Tab', 'Escape']) expect(key(k).consumed).toBe(false);
  });

  test('with a modal open the palette ignores every key', async () => {
    make();
    await type('/');
    modalOpen = true;
    const r = key('Escape');
    expect(r).toMatchObject({ consumed: false, prevented: false });
    expect(palette.isOpen()).toBe(true);
  });

  test('Shift+Tab with the palette open moves the selection and never cycles the permission mode', async () => {
    make();
    const switchIpc = { invoke: jest.fn(() => Promise.resolve({ ok: true, mode: 'ask', effectiveMode: 'ask', sessionModes: {}, rules: {} })) };
    const sw = new PermissionModeSwitch({
      ipc: switchIpc,
      getInput: () => input,
      isPopupOpen: () => !!composer.querySelector('[role="listbox"]:not([hidden])'),
      isShiftTabEnabled: () => true,
    });
    await type('/');
    const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'target', { value: input });
    const consumed = palette.onKey(e) || sw.onComposerKey(e);
    expect(consumed).toBe(true);
    expect(active().textContent).toContain('/pdf-report');
    expect(switchIpc.invoke.mock.calls.filter((c) => c[0] === 'permissions:set-mode')).toEqual([]);
    sw.destroy();
  });

  test('IME composition keys pass through', async () => {
    make();
    await type('/');
    expect(key('Enter', { isComposing: true }).consumed).toBe(false);
  });
});

describe('InlinePalette commands, pointer and blur', () => {
  test('a built-in the host handles is run and its typed token removed', async () => {
    make();
    onCommand.mockReturnValue(true);
    await type('/comp');
    key('Enter');
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ name: 'compact', kind: 'builtin' }));
    expect(input.value).toBe('');
  });

  test('a skill is inserted as text, never run', async () => {
    make();
    await type('/pdf');
    key('Enter');
    expect(onCommand).not.toHaveBeenCalled();
    expect(input.value).toBe('/pdf-report ');
  });

  test('mousedown on an option chooses it without blurring the textarea', async () => {
    make();
    await type('@');
    const opt = Array.from(palette.el.querySelectorAll('[role="option"]')).find((o) => o.textContent.includes('@page'));
    const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    opt.dispatchEvent(md);
    expect(md.defaultPrevented).toBe(true);
    expect(input.value).toBe('@page ');
  });

  test('blur closes the palette', async () => {
    make();
    await type('/');
    input.dispatchEvent(new Event('blur'));
    expect(palette.isOpen()).toBe(false);
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('InlinePalette IPC failures', () => {
  test('a rejected commands:list shows a disabled error row that cannot be chosen', async () => {
    make({ 'commands:list': jest.fn(() => { throw new Error('skills_not_bound'); }) });
    await type('/');
    const row = palette.el.querySelector('[role="option"]');
    expect(row.textContent).toContain('skills_not_bound');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.classList.contains('is-error')).toBe(true);
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    expect(key('Enter').consumed).toBe(true);
    expect(input.value).toBe('/');
    expect(palette.isOpen()).toBe(false);
  });

  test('an {ok:false} file search keeps the context tokens and adds an error row', async () => {
    make({ 'commands:list': jest.fn(), 'workspace:search-files': jest.fn(() => ({ ok: false, error: 'no_workspace_root' })) });
    await type('@x');
    const rows = Array.from(palette.el.querySelectorAll('[role="option"]'));
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('no_workspace_root');
    expect(rows[0].getAttribute('aria-disabled')).toBe('true');
  });

  test('a stale file-search reply is dropped once the palette closed', async () => {
    let release;
    const routes = { 'commands:list': jest.fn(), 'workspace:search-files': jest.fn(() => new Promise((r) => { release = r; })) };
    make(routes);
    await type('@sr');
    palette.close();
    release({ ok: true, roots: 1, results: [{ root: '/w', rootName: 'w', path: 'late.js', name: 'late.js' }] });
    await flush();
    expect(palette.isOpen()).toBe(false);
    expect(labels()).toEqual([]);
  });
});

/**
 * @jest-environment jsdom
 */

// Settings → Passwords: saved logins with reveal / copy / delete and the
// never-save list. Only electron ipcRenderer (the main-process boundary) is
// mocked; each test scripts the passwords:* replies.

jest.mock('electron', () => ({ ipcRenderer: { invoke: jest.fn() } }));

const { ipcRenderer } = require('electron');
const { savedPasswords } = require('../../../../../renderer/components/settings/modules/passwords');

const flush = () => new Promise((r) => setTimeout(r, 0));
const LOGIN = { id: 'l1', origin: 'https://a.test', username: 'alice', createdAt: 1, updatedAt: 1, lastUsedAt: null };
const OK_STATUS = { available: true, reason: null };
const listing = (over = {}) => ({ ok: true, entries: [LOGIN], neverSave: [], status: OK_STATUS, authMode: 'dialog', quarantined: null, ...over });

function route(replies) {
  ipcRenderer.invoke.mockImplementation(async (ch, payload) => {
    const r = replies[ch];
    if (r === undefined) throw new Error(`unexpected channel ${ch}`);
    return typeof r === 'function' ? r(payload) : r;
  });
}

function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const teardown = savedPasswords({ host });
  return { host, teardown };
}

const button = (host, label) => /** @type {HTMLButtonElement} */ (host.querySelector(`button[aria-label="${label}"]`));
const list = (host) => host.querySelector('[data-role="password-list"]');
const row = (host) => list(host).querySelector('[data-login="l1"]');
const calls = (ch) => ipcRenderer.invoke.mock.calls.filter((c) => c[0] === ch);

let errSpy;
beforeEach(() => {
  document.body.innerHTML = '';
  ipcRenderer.invoke.mockReset();
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe('saved passwords settings module', () => {
  test('lists saved logins by site and username without any password', async () => {
    route({ 'passwords:list': listing({ entries: [LOGIN, { ...LOGIN, id: 'l2', username: '', lastUsedAt: Date.UTC(2026, 0, 2) }] }) });
    const { host } = mount();
    await flush();
    expect(row(host).textContent).toContain('a.test');
    expect(row(host).textContent).toContain('alice');
    expect(row(host).textContent).toContain('Never used');
    expect(list(host).querySelector('[data-login="l2"]').textContent).toContain('(no username)');
    expect(list(host).querySelector('[data-login="l2"]').textContent).toContain('Last used');
    expect(host.querySelector('[data-role="revealed"]')).toBeNull();
  });

  test('an empty store shows the empty state', async () => {
    route({ 'passwords:list': listing({ entries: [] }) });
    const { host } = mount();
    await flush();
    expect(list(host).textContent).toContain('No saved passwords');
  });

  test('a failed list renders an error row and logs it', async () => {
    route({ 'passwords:list': { ok: false, error: 'Not allowed from this sender.' } });
    const { host } = mount();
    await flush();
    expect(list(host).querySelector('[role="alert"]').textContent).toBe("Couldn't load saved passwords: Not allowed from this sender.");
    expect(errSpy).toHaveBeenCalled();
  });

  test('a rejected list call renders an error row', async () => {
    route({ 'passwords:list': () => { throw new Error('channel closed'); } });
    const { host } = mount();
    await flush();
    expect(list(host).querySelector('[role="alert"]').textContent).toContain('channel closed');
  });

  test('unavailable secure storage and a set-aside file are shown', async () => {
    route({
      'passwords:list': listing({
        status: { available: false, reason: 'Passwords cannot be saved because no system keyring was found.' },
        quarantined: '/u/passwords.json.corrupt-5',
      }),
    });
    const { host } = mount();
    await flush();
    const alerts = Array.from(host.querySelectorAll('[role="alert"]')).map((n) => n.textContent).join(' | ');
    expect(alerts).toContain('no system keyring was found');
    expect(alerts).toContain('/u/passwords.json.corrupt-5');
  });

  test('with the dialog auth mode, Reveal goes to main (which confirms) and Hide removes the password', async () => {
    route({ 'passwords:list': listing(), 'passwords:reveal': { ok: true, password: 's3cret' } });
    const { host } = mount();
    await flush();
    button(host, 'Reveal password for alice on a.test').click();
    await flush();
    expect(calls('passwords:reveal')).toEqual([['passwords:reveal', 'l1']]);
    expect(row(host).querySelector('[data-role="revealed"]').textContent).toBe('s3cret');
    button(host, 'Hide password for alice on a.test').click();
    expect(host.innerHTML).not.toContain('s3cret');
  });

  test('with Touch ID, Reveal goes straight to main (which prompts)', async () => {
    route({ 'passwords:list': listing({ authMode: 'touchid' }), 'passwords:reveal': { ok: true, password: 's3cret' } });
    const { host } = mount();
    await flush();
    button(host, 'Reveal password for alice on a.test').click();
    await flush();
    expect(calls('passwords:reveal')).toHaveLength(1);
    expect(row(host).querySelector('[data-role="revealed"]').textContent).toBe('s3cret');
  });

  test('a reveal cancelled in main\'s confirmation dialog shows no password', async () => {
    route({ 'passwords:list': listing(), 'passwords:reveal': { ok: false, error: 'Cancelled.' } });
    const { host } = mount();
    await flush();
    button(host, 'Reveal password for alice on a.test').click();
    await flush();
    expect(row(host).querySelector('.is-error').textContent).toBe('Could not reveal: Cancelled.');
    expect(host.querySelector('[data-role="revealed"]')).toBeNull();
  });

  test('a refused Touch ID reveal shows the reason and no password', async () => {
    route({ 'passwords:list': listing({ authMode: 'touchid' }), 'passwords:reveal': { ok: false, error: 'User canceled' } });
    const { host } = mount();
    await flush();
    button(host, 'Reveal password for alice on a.test').click();
    await flush();
    expect(row(host).querySelector('.is-error').textContent).toBe('Could not reveal: User canceled');
    expect(host.querySelector('[data-role="revealed"]')).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  test('Copy goes to main (which confirms) and says so', async () => {
    route({ 'passwords:list': listing(), 'passwords:copy': { ok: true } });
    const { host } = mount();
    await flush();
    button(host, 'Copy password for alice on a.test').click();
    await flush();
    expect(calls('passwords:copy')).toEqual([['passwords:copy', 'l1']]);
    expect(row(host).querySelector('.is-ok').textContent).toBe('Copied to the clipboard');
    expect(host.innerHTML).not.toContain('s3cret');
  });

  test('a failed copy is shown', async () => {
    route({ 'passwords:list': listing({ authMode: 'touchid' }), 'passwords:copy': { ok: false, error: 'User canceled' } });
    const { host } = mount();
    await flush();
    button(host, 'Copy password for alice on a.test').click();
    await flush();
    expect(row(host).querySelector('.is-error').textContent).toBe('Could not copy: User canceled');
  });

  test('Delete asks in-row; confirming deletes and reloads', async () => {
    let entries = [LOGIN];
    route({
      'passwords:list': () => listing({ entries }),
      'passwords:delete': (id) => { entries = entries.filter((e) => e.id !== id); return { ok: true }; },
    });
    const { host } = mount();
    await flush();
    button(host, 'Delete password for alice on a.test').click();
    expect(calls('passwords:delete')).toHaveLength(0);
    button(host, 'Delete saved password').click();
    await flush();
    await flush();
    expect(calls('passwords:delete')).toEqual([['passwords:delete', 'l1']]);
    expect(list(host).textContent).toContain('No saved passwords');
  });

  test('a failed delete keeps the row and shows why', async () => {
    route({ 'passwords:list': listing(), 'passwords:delete': { ok: false, error: 'Saved login not found.' } });
    const { host } = mount();
    await flush();
    button(host, 'Delete password for alice on a.test').click();
    button(host, 'Delete saved password').click();
    await flush();
    expect(row(host).querySelector('.is-error').textContent).toBe('Could not delete: Saved login not found.');
  });

  test('the never-save list shows sites and Remove takes one off', async () => {
    route({
      'passwords:list': listing({ neverSave: ['https://b.test'] }),
      'passwords:never-save-remove': { ok: true, neverSave: [] },
    });
    const { host } = mount();
    await flush();
    const never = host.querySelector('[data-role="never-save-list"]');
    expect(never.textContent).toContain('b.test');
    button(host, 'Allow saving on b.test').click();
    await flush();
    expect(calls('passwords:never-save-remove')).toEqual([['passwords:never-save-remove', 'https://b.test']]);
    expect(never.textContent).toContain('No sites are excluded');
  });

  test('a failed never-save removal keeps the site and shows why', async () => {
    route({
      'passwords:list': listing({ neverSave: ['https://b.test'] }),
      'passwords:never-save-remove': () => { throw new Error('disk full'); },
    });
    const { host } = mount();
    await flush();
    button(host, 'Allow saving on b.test').click();
    await flush();
    const never = host.querySelector('[data-role="never-save-list"]');
    expect(never.textContent).toContain('b.test');
    expect(never.querySelector('.is-error').textContent).toBe('Could not remove: disk full');
  });

  test('teardown clears a revealed password from the page', async () => {
    route({ 'passwords:list': listing({ authMode: 'touchid' }), 'passwords:reveal': { ok: true, password: 's3cret' } });
    const { host, teardown } = mount();
    await flush();
    button(host, 'Reveal password for alice on a.test').click();
    await flush();
    teardown();
    expect(host.innerHTML).not.toContain('s3cret');
  });
});

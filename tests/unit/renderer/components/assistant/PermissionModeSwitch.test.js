// PermissionModeSwitch — the composer's permission pill against a mocked
// permissions:* IPC boundary: load, optimistic switch + revert, the Bypass
// confirmation, Shift+Tab cycling guards, and live announcements.

const PermissionModeSwitch = require('../../../../../renderer/components/assistant/PermissionModeSwitch');

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function mockIpc(routes) {
  return { invoke: jest.fn((ch, arg) => Promise.resolve().then(() => routes[ch](arg))) };
}
const okRoutes = (mode = 'ask') => ({
  'permissions:get': jest.fn(() => ({ ok: true, mode, effectiveMode: mode, sessionModes: {}, rules: {} })),
  'permissions:set-mode': jest.fn(({ mode: m }) => ({ ok: true, mode: m })),
});

let input, sw, ipc, popupOpen, shiftTabOn;

function make(routes) {
  ipc = mockIpc(routes);
  sw = new PermissionModeSwitch({
    ipc,
    getInput: () => input,
    isPopupOpen: () => popupOpen,
    isShiftTabEnabled: () => shiftTabOn,
  });
  document.body.append(input, sw.el);
  return sw;
}

function shiftTab(target = input) {
  const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
  Object.defineProperty(e, 'target', { value: target });
  const handled = sw.onComposerKey(e);
  return { handled, prevented: e.defaultPrevented };
}

const setModeCalls = () => ipc.invoke.mock.calls.filter((c) => c[0] === 'permissions:set-mode');
const item = (mode) => sw.menu.querySelector(`[data-mode="${mode}"]`);

beforeEach(() => {
  document.body.innerHTML = '';
  input = document.createElement('textarea');
  popupOpen = false;
  shiftTabOn = true;
});
afterEach(() => { if (sw) sw.destroy(); sw = null; });

test('load shows the effective mode from main', async () => {
  make(okRoutes('plan'));
  await sw.load();
  expect(ipc.invoke).toHaveBeenCalledWith('permissions:get', {});
  expect(sw.mode).toBe('plan');
  expect(sw.pill.textContent).toBe('Plan');
  expect(sw.pill.getAttribute('aria-label')).toBe('Permission mode: Plan');
  expect(item('plan').getAttribute('aria-checked')).toBe('true');
});

test('a failed load shows a visible error and keeps the current pill', async () => {
  make({ 'permissions:get': () => ({ ok: false, error: 'boom' }) });
  await sw.load();
  expect(sw.errorEl.hidden).toBe(false);
  expect(sw.errorEl.textContent).toMatch(/Couldn't read the permission mode: boom/);
  expect(sw.mode).toBe('ask');
});

test('choosing a mode from the menu calls set-mode, then announces it', async () => {
  make(okRoutes());
  sw.pill.click();
  expect(sw.menu.hidden).toBe(false);
  expect(sw.pill.getAttribute('aria-expanded')).toBe('true');
  item('auto-edit').click();
  expect(sw.menu.hidden).toBe(true);
  await flush();
  expect(setModeCalls()).toEqual([['permissions:set-mode', { mode: 'auto-edit' }]]);
  expect(sw.mode).toBe('auto-edit');
  expect(sw.liveEl.textContent).toBe('Permission mode: Auto-edit');
});

test('the session id scopes reads and writes once set', async () => {
  const routes = okRoutes();
  make(routes);
  await sw.setSessionId('s_abc123');
  expect(routes['permissions:get']).toHaveBeenLastCalledWith({ sessionId: 's_abc123' });
  await sw.requestMode('plan');
  expect(setModeCalls()[0][1]).toEqual({ mode: 'plan', sessionId: 's_abc123' });
});

test('Bypass needs confirmation; Cancel sends no IPC and keeps the mode', async () => {
  make(okRoutes());
  const pending = sw.requestMode('bypass');
  expect(sw.confirmEl.hidden).toBe(false);
  expect(document.activeElement.textContent).toBe('Cancel');
  sw.confirmEl.querySelector('.permission-mode__confirm-no').click();
  expect(await pending).toBe(false);
  await flush();
  expect(setModeCalls()).toHaveLength(0);
  expect(sw.mode).toBe('ask');
  expect(sw.confirmEl.hidden).toBe(true);
});

test('Escape in the confirmation cancels it', async () => {
  make(okRoutes());
  const pending = sw.requestMode('bypass');
  sw.confirmEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(await pending).toBe(false);
  expect(setModeCalls()).toHaveLength(0);
});

test('confirmed Bypass applies with the danger style and is not asked again this session', async () => {
  make(okRoutes());
  const pending = sw.requestMode('bypass');
  sw.confirmEl.querySelector('.permission-mode__confirm-yes').click();
  expect(await pending).toBe(true);
  expect(sw.mode).toBe('bypass');
  expect(sw.pill.classList.contains('is-danger')).toBe(true);
  await sw.requestMode('ask');
  await sw.requestMode('bypass');
  expect(sw.confirmEl.hidden).toBe(true);
  expect(setModeCalls().map((c) => c[1].mode)).toEqual(['bypass', 'ask', 'bypass']);

  // A different session must confirm again.
  await sw.setSessionId('s_new0001');
  expect(sw.mode).toBe('ask');
  const again = sw.requestMode('bypass');
  expect(sw.confirmEl.hidden).toBe(false);
  sw.confirmEl.querySelector('.permission-mode__confirm-no').click();
  expect(await again).toBe(false);
  expect(setModeCalls()).toHaveLength(3);
});

test('a refused or failed switch reverts the pill and shows the error', async () => {
  make({ ...okRoutes(), 'permissions:set-mode': () => ({ ok: false, error: 'invalid_session_id' }) });
  expect(await sw.requestMode('plan')).toBe(false);
  expect(sw.mode).toBe('ask');
  expect(sw.pill.textContent).toBe('Ask');
  expect(sw.errorEl.hidden).toBe(false);
  expect(sw.errorEl.textContent).toMatch(/Couldn't switch to Plan: invalid_session_id\. Still Ask\./);
  expect(sw.liveEl.textContent).toBe('');

  make({ ...okRoutes(), 'permissions:set-mode': () => { throw new Error('ipc down'); } });
  expect(await sw.requestMode('auto-edit')).toBe(false);
  expect(sw.mode).toBe('ask');
  expect(sw.errorEl.textContent).toMatch(/ipc down/);
});

test('Shift+Tab in the focused composer cycles Ask → Auto-edit → Plan → Ask, skipping unconfirmed Bypass', async () => {
  make(okRoutes());
  input.focus();
  const r = shiftTab();
  expect(r).toEqual({ handled: true, prevented: true });
  await flush();
  expect(sw.mode).toBe('auto-edit');
  shiftTab(); await flush();
  expect(sw.mode).toBe('plan');
  shiftTab(); await flush();
  expect(sw.mode).toBe('ask');
  expect(sw.confirmEl.hidden).toBe(true);
  expect(setModeCalls().map((c) => c[1].mode)).toEqual(['auto-edit', 'plan', 'ask']);
});

test('Shift+Tab does nothing while a palette is open', async () => {
  make(okRoutes());
  input.focus();
  popupOpen = true;
  expect(shiftTab()).toEqual({ handled: false, prevented: false });
  await flush();
  expect(setModeCalls()).toHaveLength(0);
});

test('Shift+Tab does nothing when the setting is off', async () => {
  make(okRoutes());
  input.focus();
  shiftTabOn = false;
  expect(shiftTab().handled).toBe(false);
  await flush();
  expect(setModeCalls()).toHaveLength(0);
});

test('Shift+Tab does nothing unless the composer has focus', async () => {
  make(okRoutes());
  const other = document.createElement('button');
  document.body.appendChild(other);
  other.focus();
  expect(shiftTab(input).handled).toBe(false);
  expect(shiftTab(other).handled).toBe(false);
  const plainTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  input.focus();
  Object.defineProperty(plainTab, 'target', { value: input });
  expect(sw.onComposerKey(plainTab)).toBe(false);
  await flush();
  expect(setModeCalls()).toHaveLength(0);
});

test('menu keyboard: arrows move, Escape closes back to the pill', () => {
  make(okRoutes());
  sw.openMenu();
  expect(document.activeElement).toBe(item('ask'));
  sw.menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(document.activeElement).toBe(item('auto-edit'));
  sw.menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  sw.menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  expect(document.activeElement).toBe(item('bypass'));
  sw.menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(sw.menu.hidden).toBe(true);
  expect(document.activeElement).toBe(sw.pill);
});

test('an unknown mode is refused without IPC', async () => {
  make(okRoutes());
  expect(await sw.requestMode('yolo')).toBe(false);
  expect(setModeCalls()).toHaveLength(0);
});

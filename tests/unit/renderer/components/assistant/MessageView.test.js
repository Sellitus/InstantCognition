// MessageView + BranchNav in isolation: markdown rendering, rAF-coalesced
// streaming, the keyboard-reachable actions menu, branch bounds and the
// edit-and-resend form (an empty edit hands nothing off).
const MessageView = require('../../../../../renderer/components/assistant/MessageView');
const BranchNav = require('../../../../../renderer/components/assistant/BranchNav');

const key = (el, k, extra = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));

let frames;
beforeEach(() => {
  document.body.innerHTML = '';
  frames = [];
  global.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
  global.cancelAnimationFrame = (id) => { frames[id - 1] = null; };
});
const runFrames = () => { const due = frames.splice(0); due.forEach((cb) => cb && cb(0)); };

function view(opts) {
  const v = new MessageView(opts);
  document.body.appendChild(v.el);
  return v;
}

describe('BranchNav', () => {
  test('requires onSelect', () => {
    expect(() => new BranchNav(/** @type {any} */ ({}))).toThrow(TypeError);
  });

  test('hidden without siblings; shows n/m and disables at the bounds', () => {
    const onSelect = jest.fn();
    const nav = new BranchNav({ onSelect });
    nav.set({ index: 0, count: 1, siblingIds: ['a'] });
    expect(nav.el.hidden).toBe(true);
    nav.set({ index: 0, count: 3, siblingIds: ['a', 'b', 'c'] });
    expect(nav.el.hidden).toBe(false);
    expect(nav.label.textContent).toBe('1/3');
    expect(nav.prevBtn.disabled).toBe(true);
    expect(nav.nextBtn.disabled).toBe(false);
    nav.prevBtn.click();
    expect(onSelect).not.toHaveBeenCalled();
    nav.nextBtn.click();
    expect(onSelect).toHaveBeenCalledWith('b');
    nav.set({ index: 2, count: 3, siblingIds: ['a', 'b', 'c'] });
    expect(nav.label.textContent).toBe('3/3');
    expect(nav.nextBtn.disabled).toBe(true);
    nav.prevBtn.click();
    expect(onSelect).toHaveBeenLastCalledWith('b');
  });

  test('disabled while a run owns the head', () => {
    const onSelect = jest.fn();
    const nav = new BranchNav({ onSelect });
    nav.set({ index: 1, count: 3, siblingIds: ['a', 'b', 'c'] });
    nav.setDisabled(true);
    expect(nav.prevBtn.disabled).toBe(true);
    expect(nav.nextBtn.disabled).toBe(true);
    nav._step(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('an out-of-range index is treated as no siblings', () => {
    const nav = new BranchNav({ onSelect: jest.fn() });
    nav.set({ index: 5, count: 2, siblingIds: ['a', 'b'] });
    expect(nav.el.hidden).toBe(true);
  });
});

describe('MessageView rendering', () => {
  test('rejects an unknown role', () => {
    expect(() => new MessageView(/** @type {any} */ ({ role: 'system' }))).toThrow(TypeError);
  });

  test('assistant text renders as markdown, and raw HTML is not injected', () => {
    const v = view({ role: 'assistant', text: '**bold** and `code`\n\n<img src=x onerror=alert(1)>' });
    expect(v.bodyEl.querySelector('strong').textContent).toBe('bold');
    expect(v.bodyEl.querySelector('code').textContent).toBe('code');
    expect(v.bodyEl.querySelector('img')).toBeNull();
    expect(v.el.classList.contains('chat-msg--assistant')).toBe(true);
  });

  test('user text renders as markdown too', () => {
    const v = view({ role: 'user', text: '- one\n- two' });
    expect(v.bodyEl.querySelectorAll('li')).toHaveLength(2);
    expect(v.el.classList.contains('agent-msg-user')).toBe(true);
  });

  test('streaming re-renders once per animation frame', () => {
    const v = view({ role: 'assistant', text: '' });
    v.appendStream('Hel');
    v.appendStream('lo **wor');
    v.appendStream('ld**');
    expect(frames.filter(Boolean)).toHaveLength(1);
    expect(v.bodyEl.textContent).toBe('');
    runFrames();
    expect(v.bodyEl.querySelector('strong').textContent).toBe('world');
    v.appendStream('!');
    v.endStream();
    expect(frames.filter(Boolean)).toHaveLength(0);
    expect(v.text).toBe('Hello **world**!');
  });
});

describe('MessageView actions', () => {
  test('session actions wait for a node id and an idle session; copy and export do not', () => {
    const v = view({ role: 'assistant', text: 'x' });
    const item = (k) => /** @type {HTMLButtonElement} */ (v.menuEl.querySelector(`[data-action="${k}"]`));
    expect(v.regenBtn.disabled).toBe(true);
    expect(item('fork').disabled).toBe(true);
    expect(item('export').disabled).toBe(false);
    expect(item('rewind')).toBeNull();
    v.setNodeId('n2');
    expect(v.regenBtn.disabled).toBe(false);
    expect(item('fork').disabled).toBe(false);
    v.setBusy(true);
    expect(v.regenBtn.disabled).toBe(true);
    expect(item('fork').disabled).toBe(false);
  });

  test('every toolbar button has an accessible name', () => {
    const v = view({ role: 'user', text: 'x', nodeId: 'n1' });
    v.el.querySelectorAll('.chat-msg__action').forEach((b) => expect(b.getAttribute('aria-label')).toBeTruthy());
    expect(v.moreBtn.getAttribute('aria-haspopup')).toBe('menu');
  });

  test('the menu opens from the keyboard, moves with arrows, closes on Escape', () => {
    const onFork = jest.fn();
    const v = view({ role: 'user', text: 'x', nodeId: 'n1', actions: { onFork } });
    key(v.moreBtn, 'ArrowDown');
    expect(v.menuEl.hidden).toBe(false);
    expect(v.moreBtn.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement.dataset.action).toBe('fork');
    key(document.activeElement, 'ArrowDown');
    expect(document.activeElement.dataset.action).toBe('rewind');
    key(document.activeElement, 'End');
    expect(document.activeElement.dataset.action).toBe('export');
    key(document.activeElement, 'Escape');
    expect(v.menuEl.hidden).toBe(true);
    expect(document.activeElement).toBe(v.moreBtn);
    v.openMenu();
    /** @type {HTMLElement} */ (v.menuEl.querySelector('[data-action="fork"]')).click();
    expect(onFork).toHaveBeenCalledWith(v, undefined);
    expect(v.menuEl.hidden).toBe(true);
  });

  test('a pointer outside the message closes the menu', () => {
    const v = view({ role: 'assistant', text: 'x', nodeId: 'n2' });
    v.openMenu();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(v.menuEl.hidden).toBe(true);
  });
});

describe('edit and resend', () => {
  test('an empty edit sends nothing', async () => {
    const onEdit = jest.fn(async () => {});
    const v = view({ role: 'user', text: 'original', nodeId: 'n1', actions: { onEdit } });
    v.editBtn.click();
    expect(v.editorEl.hidden).toBe(false);
    expect(v.editInput.value).toBe('original');
    v.editInput.value = '   ';
    await expect(v.submitEdit()).resolves.toBe(false);
    expect(onEdit).not.toHaveBeenCalled();
    expect(v.editError.hidden).toBe(false);
    expect(v.editError.textContent).toBe('Write a message to send.');
  });

  test('unchanged text just closes the editor', async () => {
    const onEdit = jest.fn(async () => {});
    const v = view({ role: 'user', text: 'same', nodeId: 'n1', actions: { onEdit } });
    v.startEdit();
    await expect(v.submitEdit()).resolves.toBe(false);
    expect(onEdit).not.toHaveBeenCalled();
    expect(v.editorEl.hidden).toBe(true);
  });

  test('Cmd+Enter submits the new text; Escape cancels', async () => {
    const onEdit = jest.fn(async () => {});
    const v = view({ role: 'user', text: 'old', nodeId: 'n1', actions: { onEdit } });
    v.startEdit();
    key(v.editInput, 'Escape');
    expect(v.editorEl.hidden).toBe(true);
    v.startEdit();
    v.editInput.value = 'new text';
    key(v.editInput, 'Enter', { metaKey: true });
    await Promise.resolve();
    expect(onEdit).toHaveBeenCalledWith(v, 'new text');
  });

  test('a failed resend stays in the editor with the reason', async () => {
    const onEdit = jest.fn(async () => { throw new Error('session_busy'); });
    const v = view({ role: 'user', text: 'old', nodeId: 'n1', actions: { onEdit } });
    v.startEdit();
    v.editInput.value = 'new';
    await expect(v.submitEdit()).resolves.toBe(false);
    expect(v.editorEl.hidden).toBe(false);
    expect(v.editError.textContent).toBe('Couldn’t resend: session_busy');
    expect(v.editSave.disabled).toBe(false);
  });

  test('editing needs a persisted node', () => {
    const v = view({ role: 'user', text: 'old' });
    v.startEdit();
    expect(v.editorEl.hidden).toBe(true);
  });
});

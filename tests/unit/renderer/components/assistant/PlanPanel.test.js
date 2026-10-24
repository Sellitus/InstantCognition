// PlanPanel: the three plan payload shapes fold into one todo list, an empty
// payload renders nothing, and the proposal card sends each decision (and the
// edited plan) through session:plan-decision.
const { PlanPanel, normalizePlan } = require('../../../../../renderer/components/assistant/PlanPanel');

const SID = 's_abc123';

function mockIpc(reply = { ok: true }) {
  return { invoke: jest.fn(async () => (typeof reply === 'function' ? reply() : reply)) };
}

function mounted(ipc) {
  const panel = new PlanPanel({ ipc });
  panel.mount(document.body);
  return panel;
}

const items = (panel, scope = panel.listEl) => Array.from(scope.querySelectorAll('.plan-panel__item'))
  .map((li) => [li.querySelector('.plan-panel__text').textContent, li.className.replace(/.*plan-panel__item--/, '')]);

const btn = (panel, cls) => /** @type {HTMLButtonElement} */ (panel.cardEl.querySelector(`.plan-panel__btn--${cls}`));
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => { document.body.innerHTML = ''; });

describe('normalizePlan', () => {
  test('{} and junk normalize to nothing', () => {
    expect(normalizePlan({})).toBeNull();
    expect(normalizePlan(null)).toBeNull();
    expect(normalizePlan('plan')).toBeNull();
    expect(normalizePlan({ steps: ['', '   '] })).toBeNull();
    expect(normalizePlan({ plan: {} })).toBeNull();
  });

  test('{steps} becomes pending items', () => {
    expect(normalizePlan({ steps: ['Read the file', ' Fix the bug '] })).toEqual({
      summary: '',
      items: [{ text: 'Read the file', status: 'pending' }, { text: 'Fix the bug', status: 'pending' }],
    });
  });

  test('{ledger:{plan}} maps ledger statuses and keeps notes', () => {
    const out = normalizePlan({ ledger: { plan: [
      { step: 'a', status: 'done' }, { step: 'b', status: 'doing', note: 'halfway' },
      { step: 'c', status: 'todo' }, { step: 'd', status: 'blocked' }, { step: 'e', status: 'weird' },
    ] } });
    expect(out.items.map((i) => i.status)).toEqual(['completed', 'in_progress', 'pending', 'blocked', 'pending']);
    expect(out.items[1].note).toBe('halfway');
  });

  test('{plan:{summary,todos}} uses activeForm for the item in progress', () => {
    const out = normalizePlan({ plan: { summary: 'Refactor', todos: [
      { content: 'Write tests', activeForm: 'Writing tests', status: 'in_progress' },
      { content: 'Ship', activeForm: 'Shipping', status: 'pending' },
      { content: 'Plan', status: 'completed' },
    ] } });
    expect(out).toEqual({ summary: 'Refactor', items: [
      { text: 'Writing tests', status: 'in_progress' },
      { text: 'Ship', status: 'pending' },
      { text: 'Plan', status: 'completed' },
    ] });
  });
});

describe('live list', () => {
  test('{} renders nothing', () => {
    const panel = mounted(mockIpc());
    panel.setPlan({});
    expect(panel.el.hidden).toBe(true);
    expect(panel.listEl.children).toHaveLength(0);
  });

  test('renders the list with progress, then clears', () => {
    const panel = mounted(mockIpc());
    panel.setPlan({ sessionId: SID, ledger: { plan: [{ step: 'a', status: 'done' }, { step: 'b', status: 'doing' }] } });
    expect(panel.el.hidden).toBe(false);
    expect(panel.listEl.querySelector('.plan-panel__progress').textContent).toBe('1/2');
    expect(items(panel)).toEqual([['a', 'completed'], ['b', 'in_progress']]);
    expect(panel.listEl.querySelector('.plan-panel__sr').textContent).toBe(' (Done)');
    panel.clear();
    expect(panel.el.hidden).toBe(true);
  });

  test('step text is rendered as text, never as markup', () => {
    const panel = mounted(mockIpc());
    panel.setPlan({ steps: ['<img src=x onerror=alert(1)>'] });
    expect(panel.listEl.querySelector('img')).toBeNull();
    expect(items(panel)[0][0]).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('proposal card', () => {
  const proposal = { sessionId: SID, plan: { summary: 'Do it', todos: [{ content: 'one', status: 'pending' }, { content: 'two', status: 'pending' }] } };

  test('needs a session and a plan to show', () => {
    const panel = mounted(mockIpc());
    expect(panel.showProposal({ sessionId: null, plan: proposal.plan })).toBe(false);
    expect(panel.showProposal({ sessionId: SID, plan: {} })).toBe(false);
    expect(panel.cardEl.hidden).toBe(true);
    expect(panel.showProposal(proposal)).toBe(true);
    expect(panel.cardEl.hidden).toBe(false);
    expect(items(panel, panel.cardEl).map((i) => i[0])).toEqual(['one', 'two']);
  });

  test.each([
    ['approve', 'approve'],
    ['approve-auto', 'approve_auto_edit'],
    ['reject', 'reject'],
  ])('%s sends decision %s and hides the card', async (cls, decision) => {
    const ipc = mockIpc();
    const panel = mounted(ipc);
    panel.showProposal(proposal);
    btn(panel, cls).click();
    await flush();
    expect(ipc.invoke).toHaveBeenCalledWith('session:plan-decision', { sessionId: SID, decision });
    expect(panel.cardEl.hidden).toBe(true);
  });

  test('a failed decision keeps the card and shows the error', async () => {
    const ipc = mockIpc({ ok: false, error: 'no_pending_plan' });
    const panel = mounted(ipc);
    panel.showProposal(proposal);
    btn(panel, 'approve').click();
    await flush();
    expect(panel.cardEl.hidden).toBe(false);
    const err = panel.cardEl.querySelector('.plan-panel__error');
    expect(err.hidden).toBe(false);
    expect(err.textContent).toContain('no_pending_plan');
    expect(btn(panel, 'approve').disabled).toBe(false);
  });

  test('a rejected IPC call is shown, not thrown', async () => {
    const ipc = { invoke: jest.fn(async () => { throw new Error('channel closed'); }) };
    const panel = mounted(ipc);
    panel.showProposal(proposal);
    await expect(panel.decide('reject')).resolves.toBe(false);
    expect(panel.cardEl.querySelector('.plan-panel__error').textContent).toContain('channel closed');
  });

  test('Edit sends the edited todo list', async () => {
    const ipc = mockIpc();
    const panel = mounted(ipc);
    panel.showProposal(proposal);
    btn(panel, 'edit').click();
    const inputs = panel.cardEl.querySelectorAll('.plan-panel__todo-input');
    expect(inputs).toHaveLength(2);
    expect(document.activeElement).toBe(inputs[0]);
    /** @type {HTMLInputElement} */ (inputs[0]).value = 'one, revised';
    panel.cardEl.querySelectorAll('.plan-panel__btn--remove')[1].dispatchEvent(new MouseEvent('click'));
    btn(panel, 'add').click();
    const added = panel.cardEl.querySelectorAll('.plan-panel__todo-input');
    /** @type {HTMLInputElement} */ (added[1]).value = 'three';
    btn(panel, 'submit-edit').click();
    await flush();
    expect(ipc.invoke).toHaveBeenCalledWith('session:plan-decision', {
      sessionId: SID,
      decision: 'edit',
      plan: { summary: 'Do it', todos: [{ content: 'one, revised', status: 'pending' }, { content: 'three', status: 'pending' }] },
    });
  });

  test('an edit with no steps sends nothing', async () => {
    const ipc = mockIpc();
    const panel = mounted(ipc);
    panel.showProposal(proposal);
    btn(panel, 'edit').click();
    panel.cardEl.querySelectorAll('.plan-panel__todo-input').forEach((i) => { /** @type {HTMLInputElement} */ (i).value = '  '; });
    await expect(panel.submitEdit()).resolves.toBe(false);
    expect(ipc.invoke).not.toHaveBeenCalled();
    expect(panel.cardEl.querySelector('.plan-panel__error').textContent).toBe('Add at least one step.');
  });

  test('Cancel in the editor returns to the card without sending', () => {
    const ipc = mockIpc();
    const panel = mounted(ipc);
    panel.showProposal(proposal);
    btn(panel, 'edit').click();
    btn(panel, 'cancel-edit').click();
    expect(btn(panel, 'approve')).not.toBeNull();
    expect(ipc.invoke).not.toHaveBeenCalled();
  });
});

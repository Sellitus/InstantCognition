// PlanPanel — the active session's live todo list and the exit-plan card.
//
// Plan updates arrive in three shapes (agent.set_plan → {steps}, update_ledger
// → {ledger:{plan}}, todo_write → {plan, todos}); normalizePlan folds them into
// one list, and an empty payload hides the panel. A plan proposed in Plan mode
// shows a card with Approve / Approve + auto-edit / Edit / Reject; Edit turns
// the todos into an editable list. Decisions go to session:plan-decision.

const { errMsg } = require('../../../shared/errMsg');

const LEDGER_STATUS = { todo: 'pending', doing: 'in_progress', done: 'completed', blocked: 'blocked' };
const ITEM_STATUSES = ['pending', 'in_progress', 'completed'];
const STATUS_LABELS = { pending: 'Pending', in_progress: 'In progress', completed: 'Done', blocked: 'Blocked' };
const MAX_PLAN_ITEMS = 50;

/** @typedef {{ text: string, status: 'pending'|'in_progress'|'completed'|'blocked', note?: string }} PlanItem */

const str = (v) => (typeof v === 'string' ? v.trim() : '');

function todoStatus(s) { return ITEM_STATUSES.includes(s) ? s : 'pending'; }

/**
 * @param {any} payload
 * @returns {{ summary: string, items: PlanItem[] }|null} null when there is nothing to show
 */
function normalizePlan(payload) {
  if (!payload || typeof payload !== 'object') return null;
  /** @type {PlanItem[]} */
  let items = [];
  let summary = '';
  if (Array.isArray(payload.todos) && payload.todos.length) {
    items = payload.todos.map((t) => ({
      text: str(t && t.status === 'in_progress' && t.activeForm ? t.activeForm : t && t.content),
      status: /** @type {any} */ (todoStatus(t && t.status)),
    }));
  } else if (payload.plan && typeof payload.plan === 'object' && !Array.isArray(payload.plan)) {
    const inner = normalizePlan(payload.plan);
    return inner && (inner.items.length || inner.summary) ? inner : null;
  } else if (Array.isArray(payload.plan)) {
    items = payload.plan.map((p) => ({ text: str(p && p.step), status: /** @type {any} */ (LEDGER_STATUS[p && p.status] || 'pending'), note: str(p && p.note) || undefined }));
  } else if (payload.ledger && Array.isArray(payload.ledger.plan)) {
    items = payload.ledger.plan.map((p) => ({ text: str(p && p.step), status: /** @type {any} */ (LEDGER_STATUS[p && p.status] || 'pending'), note: str(p && p.note) || undefined }));
  } else if (Array.isArray(payload.steps)) {
    items = payload.steps.map((s) => ({ text: str(s), status: /** @type {any} */ ('pending') }));
  }
  summary = str(payload.summary);
  items = items.filter((i) => i.text);
  if (!items.length && !summary) return null;
  return { summary, items };
}

/** @param {string} tag @param {string} [className] @param {string} [text] */
function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** @param {string} className @param {string} text @returns {HTMLButtonElement} */
function button(className, text) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = text;
  return b;
}

function renderItems(items) {
  const ol = node('ol', 'plan-panel__list');
  for (const item of items) {
    const li = node('li', `plan-panel__item plan-panel__item--${item.status}`);
    const mark = node('span', 'plan-panel__mark');
    mark.setAttribute('aria-hidden', 'true');
    const text = node('span', 'plan-panel__text', item.text);
    const sr = node('span', 'plan-panel__sr', ` (${STATUS_LABELS[item.status]})`);
    li.append(mark, text, sr);
    if (item.note) li.appendChild(node('span', 'plan-panel__note', item.note));
    ol.appendChild(li);
  }
  return ol;
}

class PlanPanel {
  /** @param {{ ipc?: { invoke: Function } }} [opts] */
  constructor(opts) {
    this._ipc = (opts && opts.ipc) || require('electron').ipcRenderer;
    this.el = node('section', 'plan-panel');
    this.el.setAttribute('aria-label', 'Plan');
    this.el.hidden = true;
    this.listEl = node('div', 'plan-panel__live');
    this.listEl.hidden = true;
    this.cardEl = node('div', 'plan-panel__proposal');
    this.cardEl.hidden = true;
    this.el.append(this.listEl, this.cardEl);
    this._plan = null;
    this._proposal = null;
    this._editing = false;
  }

  /** @param {HTMLElement} parent @param {Node|null} [before] */
  mount(parent, before) {
    parent.insertBefore(this.el, before || null);
  }

  _sync() {
    this.el.hidden = this.listEl.hidden && this.cardEl.hidden;
  }

  /** Live todo list from plan-updated. */
  setPlan(payload) {
    this._plan = normalizePlan(payload);
    this.listEl.innerHTML = '';
    this.listEl.hidden = !this._plan;
    if (this._plan) {
      const done = this._plan.items.filter((i) => i.status === 'completed').length;
      const head = node('div', 'plan-panel__head');
      head.appendChild(node('span', 'plan-panel__title', 'Plan'));
      if (this._plan.items.length) head.appendChild(node('span', 'plan-panel__progress', `${done}/${this._plan.items.length}`));
      this.listEl.appendChild(head);
      if (this._plan.summary) this.listEl.appendChild(node('p', 'plan-panel__summary', this._plan.summary));
      if (this._plan.items.length) this.listEl.appendChild(renderItems(this._plan.items));
    }
    this._sync();
  }

  /** @param {{ sessionId?: string|null, plan: any }} proposal */
  showProposal(proposal) {
    const plan = proposal && normalizePlan(proposal.plan);
    if (!proposal || !proposal.sessionId || !plan) { this.hideProposal(); return false; }
    this._proposal = { sessionId: proposal.sessionId, plan };
    this._editing = false;
    this._renderCard();
    return true;
  }

  hideProposal() {
    this._proposal = null;
    this._editing = false;
    this.cardEl.innerHTML = '';
    this.cardEl.hidden = true;
    this._sync();
  }

  clear() {
    this.setPlan(null);
    this.hideProposal();
  }

  _renderCard() {
    const p = this._proposal;
    this.cardEl.innerHTML = '';
    this.cardEl.hidden = false;
    this.cardEl.setAttribute('role', 'group');
    this.cardEl.setAttribute('aria-label', 'Proposed plan');
    this.cardEl.appendChild(node('div', 'plan-panel__title', 'Proposed plan'));
    if (!this._editing) {
      if (p.plan.summary) this.cardEl.appendChild(node('p', 'plan-panel__summary', p.plan.summary));
      if (p.plan.items.length) this.cardEl.appendChild(renderItems(p.plan.items));
    } else {
      this.cardEl.appendChild(this._buildEditor(p.plan));
    }
    this._errorEl = node('div', 'plan-panel__error');
    this._errorEl.setAttribute('role', 'alert');
    this._errorEl.hidden = true;
    this.cardEl.appendChild(this._errorEl);
    const row = node('div', 'plan-panel__actions');
    if (this._editing) {
      const cancel = button('plan-panel__btn plan-panel__btn--cancel-edit', 'Cancel');
      const submit = button('plan-panel__btn plan-panel__btn--primary plan-panel__btn--submit-edit', 'Approve edited plan');
      cancel.addEventListener('click', () => { this._editing = false; this._renderCard(); });
      submit.addEventListener('click', () => this.submitEdit());
      row.append(cancel, submit);
    } else {
      const approve = button('plan-panel__btn plan-panel__btn--primary plan-panel__btn--approve', 'Approve');
      const auto = button('plan-panel__btn plan-panel__btn--approve-auto', 'Approve + auto-edit');
      const edit = button('plan-panel__btn plan-panel__btn--edit', 'Edit');
      const reject = button('plan-panel__btn plan-panel__btn--reject', 'Reject');
      approve.addEventListener('click', () => this.decide('approve'));
      auto.addEventListener('click', () => this.decide('approve_auto_edit'));
      edit.addEventListener('click', () => { this._editing = true; this._renderCard(); this._focusFirstInput(); });
      reject.addEventListener('click', () => this.decide('reject'));
      row.append(approve, auto, edit, reject);
    }
    this.cardEl.appendChild(row);
    this._sync();
  }

  _buildEditor(plan) {
    const wrap = node('div', 'plan-panel__editor');
    this._summaryInput = /** @type {HTMLTextAreaElement} */ (node('textarea', 'plan-panel__summary-input'));
    this._summaryInput.rows = 2;
    this._summaryInput.value = plan.summary;
    this._summaryInput.setAttribute('aria-label', 'Plan summary');
    this._todoList = node('ol', 'plan-panel__edit-list');
    wrap.append(this._summaryInput, this._todoList);
    plan.items.forEach((item) => this._addTodoRow(item.text));
    const add = button('plan-panel__btn plan-panel__btn--add', 'Add step');
    add.addEventListener('click', () => this._addTodoRow('', true));
    wrap.appendChild(add);
    return wrap;
  }

  _addTodoRow(text, focus) {
    if (this._todoList.children.length >= MAX_PLAN_ITEMS) return;
    const li = node('li', 'plan-panel__edit-row');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'plan-panel__todo-input';
    input.value = text;
    input.setAttribute('aria-label', 'Plan step');
    const remove = button('plan-panel__btn plan-panel__btn--remove', 'Remove');
    remove.setAttribute('aria-label', 'Remove step');
    remove.addEventListener('click', () => li.remove());
    li.append(input, remove);
    this._todoList.appendChild(li);
    if (focus) input.focus();
  }

  _focusFirstInput() {
    const first = /** @type {HTMLElement|null} */ (this.cardEl.querySelector('.plan-panel__todo-input')
      || this.cardEl.querySelector('.plan-panel__summary-input'));
    if (first) first.focus();
  }

  _showError(message) {
    if (!this._errorEl) return;
    this._errorEl.textContent = message;
    this._errorEl.hidden = false;
  }

  /** @returns {Promise<boolean>} */
  submitEdit() {
    const todos = Array.from(this._todoList.querySelectorAll('.plan-panel__todo-input'))
      .map((i) => /** @type {HTMLInputElement} */ (i).value.trim())
      .filter(Boolean)
      .map((content) => ({ content, status: 'pending' }));
    if (!todos.length) { this._showError('Add at least one step.'); return Promise.resolve(false); }
    return this.decide('edit', { summary: this._summaryInput.value.trim(), todos });
  }

  /**
   * @param {'approve'|'approve_auto_edit'|'reject'|'edit'} decision
   * @param {{ summary: string, todos: { content: string, status: string }[] }} [plan]
   * @returns {Promise<boolean>}
   */
  async decide(decision, plan) {
    const p = this._proposal;
    if (!p) return false;
    const buttons = Array.from(this.cardEl.querySelectorAll('button'));
    buttons.forEach((b) => { b.disabled = true; });
    /** @type {{ sessionId: string, decision: string, plan?: any }} */
    const payload = { sessionId: p.sessionId, decision };
    if (decision === 'edit') payload.plan = plan;
    let res;
    try {
      res = await this._ipc.invoke('session:plan-decision', payload);
    } catch (err) {
      res = { ok: false, error: errMsg(err) };
    }
    if (this._proposal !== p) return false;
    buttons.forEach((b) => { b.disabled = false; });
    if (!res || !res.ok) {
      this._showError(`Couldn’t send your decision: ${(res && res.error) || 'no response'}`);
      return false;
    }
    this.hideProposal();
    return true;
  }
}

module.exports = { PlanPanel, normalizePlan };

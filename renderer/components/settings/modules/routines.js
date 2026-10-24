// Scheduled routines editor.

const { ipcRenderer } = require('electron');
const { el } = require('../controls');
const { errMsg } = require('../../../../shared/errMsg');
const { actionButton, voiceField } = require('./kit');

// -- Scheduled routines ----------------------------------------------------

// Create / edit / run / delete scheduled agent tasks. Stored in
// settings.routines.items; RoutineService (main) reads them, ticks, and fires
// due routines into the isolated agent workspace. "Run now" goes through the
// routine:run-now IPC so it shares the same single-flight gate.
function routines({ host, configBridge }) {
  const { validateRoutine, normalizeRoutine, describeSchedule, computeNextRun } = require('../../../../shared/routineSchema');

  host.appendChild(el('p', { class: 'sv-section-intro' }, [
    'Routines re-run a saved agent task on a schedule (e.g. "every morning, open these sites and build a digest"). They run in the isolated agent workspace and never touch your tabs. The agent runs the task fresh each time.',
  ]));

  const listEl = el('div', { class: 'sv-spaces-list' });
  host.appendChild(listEl);

  const readItems = () => {
    const snap = configBridge.snapshot() || {};
    const items = snap.settings && snap.settings.routines && snap.settings.routines.items;
    return Array.isArray(items) ? items.slice() : [];
  };
  const writeItems = (items) => configBridge.set('settings.routines.items', items);

  function scheduleControls(initial) {
    const wrap = el('div', { class: 'sv-row' });
    const kindSel = el('select', { class: 'sv-select', 'aria-label': 'Schedule type' });
    kindSel.appendChild(el('option', { value: 'interval' }, ['Every N minutes']));
    kindSel.appendChild(el('option', { value: 'daily' }, ['Daily at a time']));
    kindSel.value = initial.kind === 'daily' ? 'daily' : 'interval';
    const minutes = el('input', {
      type: 'number', class: 'sv-text', min: '5', step: '5',
      value: String(initial.kind === 'interval' ? initial.everyMinutes : 60),
      'aria-label': 'Interval minutes',
    });
    const pad = (n) => String(n).padStart(2, '0');
    const time = el('input', {
      type: 'time', class: 'sv-text',
      value: `${pad(initial.kind === 'daily' ? initial.atHour : 8)}:${pad(initial.kind === 'daily' ? initial.atMinute : 0)}`,
      'aria-label': 'Daily time',
    });
    const sync = () => {
      const daily = kindSel.value === 'daily';
      time.style.display = daily ? '' : 'none';
      minutes.style.display = daily ? 'none' : '';
    };
    kindSel.addEventListener('change', sync);
    sync();
    wrap.append(kindSel, minutes, time);
    const readSchedule = () => {
      if (kindSel.value === 'daily') {
        const [h, m] = String(time.value || '08:00').split(':');
        return { kind: 'daily', atHour: parseInt(h, 10) || 0, atMinute: parseInt(m, 10) || 0 };
      }
      return { kind: 'interval', everyMinutes: Math.max(5, parseInt(minutes.value, 10) || 60) };
    };
    return { node: wrap, readSchedule };
  }

  function rowFor(routine) {
    const r = normalizeRoutine(routine);
    const row = el('div', { class: 'sv-space-row' });

    const head = el('div', { class: 'sv-persona-row-head' });
    const enabledCb = el('input', { type: 'checkbox' });
    enabledCb.checked = r.enabled;
    enabledCb.addEventListener('change', () => {
      const items = readItems().map((x) => (x && x.id === r.id ? { ...x, enabled: enabledCb.checked } : x));
      writeItems(items);
    });
    const title = el('span', { class: 'sv-persona-title' }, [r.name || r.id]);
    const nextMs = computeNextRun(r, Date.now());
    const sub = el('span', { class: 'sv-persona-sub' }, [
      `${describeSchedule(r)} · next ${new Date(nextMs).toLocaleString()}`,
    ]);
    head.append(enabledCb, title, sub);
    row.appendChild(head);

    const nameInput = el('input', { type: 'text', class: 'sv-text', value: r.name, placeholder: 'Routine name' });
    const taskArea = el('textarea', { class: 'sv-text', rows: '3', placeholder: 'The agent task to run, e.g. "Open these sites, summarize each, and build a digest."' });
    taskArea.value = r.task;
    const sched = scheduleControls(r.schedule);
    const status = el('span', { class: 'sv-validation-status' }, ['']);

    const saveBtn = actionButton('Save', 'sv-button sv-button--primary', 'check');
    saveBtn.addEventListener('click', () => {
      const next = normalizeRoutine({
        ...r, name: nameInput.value, task: taskArea.value, schedule: sched.readSchedule(),
      });
      const v = validateRoutine(next);
      if (!v.ok) {
        status.className = 'sv-validation-status is-error';
        status.textContent = `Cannot save: ${v.errors.join(', ')}`;
        return;
      }
      writeItems(readItems().map((x) => (x && x.id === r.id ? next : x)));
      status.className = 'sv-validation-status is-ok';
      status.textContent = '✓ Saved';
    });

    const runBtn = actionButton('Run now', 'sv-button', 'agent');
    runBtn.addEventListener('click', async () => {
      status.className = 'sv-validation-status is-pending';
      status.textContent = 'Starting…';
      try {
        const res = await ipcRenderer.invoke('routine:run-now', { id: r.id });
        if (res && res.ok) { status.className = 'sv-validation-status is-ok'; status.textContent = '✓ Started in the agent workspace'; }
        else { status.className = 'sv-validation-status is-error'; status.textContent = res && res.error === 'busy' ? 'Agent is busy — try again shortly.' : `Could not start: ${(res && res.error) || 'unknown'}`; }
      } catch (err) {
        status.className = 'sv-validation-status is-error';
        status.textContent = errMsg(err) || 'Could not start.';
      }
    });

    const delBtn = actionButton('Delete', 'sv-button sv-button--danger', 'trash');
    delBtn.addEventListener('click', () => {
      writeItems(readItems().filter((x) => !(x && x.id === r.id)));
      render();
    });

    const actions = el('div', { class: 'sv-actions-row' }, [saveBtn, runBtn, delBtn, status]);
    row.append(nameInput, voiceField(taskArea, 'Dictate routine task', configBridge), sched.node, actions);
    return row;
  }

  function render() {
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    const items = readItems();
    if (!items.length) {
      listEl.appendChild(el('div', { class: 'sv-empty-row' }, ['No routines yet. Add one below.']));
    } else {
      items.forEach((it) => listEl.appendChild(rowFor(it)));
    }
  }

  // Add form
  host.appendChild(el('h4', { class: 'sv-subhead' }, ['Add a routine']));
  const addName = el('input', { type: 'text', class: 'sv-text', placeholder: 'Name (e.g. Morning news digest)' });
  const addTask = el('textarea', { class: 'sv-text', rows: '3', placeholder: 'The agent task to run on this schedule.' });
  const addSched = scheduleControls({ kind: 'interval', everyMinutes: 60 });
  const addStatus = el('span', { class: 'sv-validation-status' }, ['']);
  const addBtn = actionButton('Add routine', 'sv-button sv-button--primary', 'plus');
  addBtn.addEventListener('click', () => {
    const routine = normalizeRoutine({
      id: `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      name: addName.value, task: addTask.value, schedule: addSched.readSchedule(),
      enabled: true, lastRunAt: null, createdAt: Date.now(), version: 1,
    });
    const v = validateRoutine(routine);
    if (!v.ok) {
      addStatus.className = 'sv-validation-status is-error';
      addStatus.textContent = `Cannot add: ${v.errors.join(', ')}`;
      return;
    }
    writeItems(readItems().concat([routine]));
    addName.value = ''; addTask.value = '';
    addStatus.className = 'sv-validation-status is-ok';
    addStatus.textContent = '✓ Added';
    render();
  });
  host.appendChild(el('div', { class: 'sv-row-stack' }, [
    addName,
    voiceField(addTask, 'Dictate new routine task', configBridge),
    addSched.node,
    el('div', { class: 'sv-actions-row' }, [addBtn, addStatus]),
  ]));

  render();
}

module.exports = { routines };

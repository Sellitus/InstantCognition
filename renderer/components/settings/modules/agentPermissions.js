// Agent permission rules, workspace folders and the global instructions file.
// Every read and write goes through main (permissions:*, workspace:*,
// instructions:*), which validates rules and picks folders in its own dialog;
// this module only renders results and surfaces refusals.

const { ipcRenderer } = require('electron');
const { el } = require('../controls');
const { errMsg } = require('../../../../shared/errMsg');
const { actionButton, errorRow, setStatus } = require('./kit');

const RULE_LISTS = [
  { id: 'deny', title: 'Deny', hint: 'Always refused, even in Bypass mode.' },
  { id: 'ask', title: 'Ask', hint: 'Always asks first, even when an allow rule also matches.' },
  { id: 'allow', title: 'Allow', hint: 'Runs without asking (unless a deny or ask rule matches).' },
];

const ERROR_TEXT = {
  'invalid_rule:empty': 'Enter a rule first.',
  'invalid_rule:not_a_string': 'Enter a rule first.',
  'invalid_rule:too_long': 'That rule is too long (512 characters at most).',
  'invalid_rule:control_char': 'Rules cannot contain control characters.',
  'invalid_rule:tool_part': 'The tool part is not valid. Use a tool name or glob such as fs.write or mcp.github.*.',
  'invalid_rule:empty_spec': 'Nothing follows the colon. Remove it, or add a pattern such as git *.',
  'invalid_rule:spec_not_supported': 'Only shell.run, fs.* and browser.* rules take a pattern after the colon.',
  'invalid_rule:spec_too_long': 'That pattern has too many parts (64 at most).',
  root_is_filesystem_root: 'A drive or filesystem root cannot be a workspace.',
  root_contains_home: 'Your home folder (or a folder that contains it) cannot be a workspace. Pick a project folder.',
  root_overlaps_app_data: 'That folder overlaps InstantCognition\'s own data folder.',
  not_a_directory: 'That is not a folder.',
  unknown_root: 'That folder is no longer in the list.',
  too_large: 'The instructions are larger than the size limit.',
  not_a_regular_file: 'The instructions path is not a regular file.',
  instructions_global_file_not_absolute: 'The configured instructions file must be an absolute path.',
  permission_denied: 'The instructions file cannot be read (permission denied).',
  path_unresolvable: 'The instructions path cannot be resolved (symlink loop or no access).',
};

const friendly = (code) => ERROR_TEXT[code] || String(code || 'unknown error');

/** Calls main and resolves to `{ok:true,...}`; any other answer rejects. */
function call(channel, arg) {
  return Promise.resolve()
    .then(() => ipcRenderer.invoke(channel, arg))
    .then((r) => {
      if (r && r.ok === true) return r;
      throw new Error(friendly(r && r.error ? r.error : 'no response from the app'));
    });
}

function loadingRow() { return el('div', { class: 'sv-empty-row', role: 'status' }, ['Loading…']); }

// -- Permission rules --------------------------------------------------------

function agentPermissionRules({ host }) {
  let disposed = false;
  host.appendChild(el('p', { class: 'sv-section-intro' }, [
    'Rules are ', el('code', {}, ['tool[:pattern]']), '. Examples: ',
    el('code', {}, ['shell.run:git status']), ', ',
    el('code', {}, ['shell.run:npm *']), ', ',
    el('code', {}, ['fs.write:src/**']), ', ',
    el('code', {}, ['browser.navigate:*.example.com']), ', ',
    el('code', {}, ['mcp.github.*']), '. Deny beats ask, ask beats allow.',
  ]));
  const body = el('div', { class: 'sv-perm-rules' });
  host.appendChild(body);

  function render(rules) {
    body.textContent = '';
    for (const list of RULE_LISTS) body.appendChild(listSection(list, Array.isArray(rules[list.id]) ? rules[list.id] : []));
  }

  function reload() {
    body.textContent = '';
    body.appendChild(loadingRow());
    return call('permissions:get', {}).then(
      (r) => { if (!disposed) render(r.rules || {}); },
      (err) => {
        if (disposed) return;
        body.textContent = '';
        body.appendChild(errorRow(`Couldn't load the permission rules: ${errMsg(err)}`));
      },
    );
  }

  function listSection(list, rules) {
    const section = el('div', { class: 'sv-perm-list', 'data-list': list.id });
    section.appendChild(el('div', { class: 'sv-field-label' }, [`${list.title} rules`]));
    section.appendChild(el('p', { class: 'sv-hint' }, [list.hint]));
    const ul = el('ul', { class: 'sv-perm-items', 'aria-label': `${list.title} rules` });
    const status = el('div', { class: 'sv-validation-status' });
    if (!rules.length) ul.appendChild(el('li', { class: 'sv-empty-row' }, ['None.']));
    for (const rule of rules) {
      const remove = actionButton('Remove', 'sv-button sv-button--danger', 'trash');
      remove.setAttribute('aria-label', `Remove ${list.id} rule ${rule}`);
      remove.addEventListener('click', () => {
        remove.disabled = true;
        call('permissions:remove-rule', { list: list.id, rule }).then(
          () => { if (!disposed) reload(); },
          (err) => { remove.disabled = false; setStatus(status, 'error', `Couldn't remove ${rule}: ${errMsg(err)}`); },
        );
      });
      ul.appendChild(el('li', { class: 'sv-perm-item' }, [el('code', { class: 'sv-perm-rule' }, [rule]), remove]));
    }
    section.appendChild(ul);

    const input = el('input', { type: 'text', class: 'sv-text', spellcheck: 'false', 'aria-label': `New ${list.id} rule` });
    const add = actionButton(`Add ${list.id} rule`, 'sv-button', 'plus');
    const submit = () => {
      const rule = input.value.trim();
      if (!rule) { input.setAttribute('aria-invalid', 'true'); setStatus(status, 'error', friendly('invalid_rule:empty')); return; }
      add.disabled = true;
      setStatus(status, 'pending', 'Saving…');
      call('permissions:add-rule', { list: list.id, rule }).then(
        () => { if (!disposed) reload(); },
        (err) => {
          add.disabled = false;
          input.setAttribute('aria-invalid', 'true');
          setStatus(status, 'error', `Not added: ${errMsg(err)}`);
        },
      );
    };
    add.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    input.addEventListener('input', () => { input.removeAttribute('aria-invalid'); setStatus(status, null, ''); });
    section.appendChild(el('div', { class: 'sv-row sv-perm-add' }, [input, add]));
    section.appendChild(status);
    return section;
  }

  reload();
  return () => { disposed = true; };
}

// -- Workspace folders ------------------------------------------------------

function agentWorkspaceRoots({ host }) {
  let disposed = false;
  host.appendChild(el('p', { class: 'sv-section-intro' }, [
    'File tools only reach inside these folders, and shell commands start in one of them. ',
    'Commands can still touch other paths your account can reach, so they always ask unless a rule allows them.',
  ]));
  const listEl = el('div', { class: 'sv-spaces-list sv-workspace-roots' });
  const status = el('div', { class: 'sv-validation-status' });
  const addBtn = actionButton('Add folder', 'sv-button sv-button--primary', 'folder');
  host.append(listEl, el('div', { class: 'sv-actions-row' }, [addBtn]), status);

  function render(roots) {
    listEl.textContent = '';
    if (!roots.length) {
      listEl.appendChild(el('div', { class: 'sv-empty-row' }, ['No workspace folders. File and shell tools have nowhere to work until you add one.']));
      return;
    }
    roots.forEach((root, index) => {
      const remove = actionButton('Remove', 'sv-button sv-button--danger', 'trash');
      remove.setAttribute('aria-label', `Remove workspace folder ${root}`);
      remove.addEventListener('click', () => {
        remove.disabled = true;
        call('workspace:remove-root', { index }).then(
          (r) => { if (!disposed) { setStatus(status, null, ''); render(Array.isArray(r.roots) ? r.roots : []); } },
          (err) => { remove.disabled = false; setStatus(status, 'error', `Couldn't remove the folder: ${errMsg(err)}`); },
        );
      });
      listEl.appendChild(el('div', { class: 'sv-space-row' }, [el('code', { class: 'sv-workspace-root' }, [root]), remove]));
    });
  }

  function reload() {
    listEl.textContent = '';
    listEl.appendChild(loadingRow());
    return call('workspace:list-roots', {}).then(
      (r) => { if (!disposed) render(Array.isArray(r.roots) ? r.roots : []); },
      (err) => {
        if (disposed) return;
        listEl.textContent = '';
        listEl.appendChild(errorRow(`Couldn't load the workspace folders: ${errMsg(err)}`));
      },
    );
  }

  addBtn.addEventListener('click', () => {
    addBtn.disabled = true;
    setStatus(status, 'pending', 'Choose a folder…');
    Promise.resolve()
      .then(() => ipcRenderer.invoke('workspace:add-root', {}))
      .then((r) => {
        if (disposed) return;
        addBtn.disabled = false;
        if (r && r.ok === true) {
          setStatus(status, 'ok', `Added ${r.path}`);
          render(Array.isArray(r.roots) ? r.roots : []);
        } else if (r && r.canceled) {
          setStatus(status, null, '');
        } else {
          const where = r && r.path ? ` (${r.path})` : '';
          setStatus(status, 'error', `Not added${where}: ${friendly(r && r.error ? r.error : 'no response from the app')}`);
        }
      }, (err) => {
        addBtn.disabled = false;
        setStatus(status, 'error', `Couldn't add the folder: ${errMsg(err)}`);
      });
  });

  reload();
  return () => { disposed = true; };
}

// -- Global instructions ----------------------------------------------------

function agentGlobalInstructions({ host }) {
  let disposed = false;
  host.appendChild(el('p', { class: 'sv-section-intro' }, [
    'Standing instructions sent to the agent in every session, ahead of any AGENTS.md or INSTRUCTIONS.md in the workspace.',
  ]));
  const area = el('textarea', { class: 'sv-text sv-instructions', rows: '8', spellcheck: 'true', 'aria-label': 'Global agent instructions' });
  area.disabled = true;
  const meta = el('div', { class: 'sv-hint' });
  const saveBtn = actionButton('Save instructions', 'sv-button sv-button--primary', 'check');
  saveBtn.disabled = true;
  const status = el('div', { class: 'sv-validation-status' });
  host.append(area, meta, el('div', { class: 'sv-actions-row' }, [saveBtn]), status);
  let maxBytes = 0;

  // UTF-8 length, matching main's Buffer.byteLength check.
  const bytes = (s) => {
    let n = 0;
    for (const ch of s) {
      const cp = /** @type {number} */ (ch.codePointAt(0));
      n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    }
    return n;
  };
  const paintMeta = () => {
    const n = bytes(area.value);
    meta.textContent = maxBytes ? `${n} of ${maxBytes} bytes` : `${n} bytes`;
    const over = maxBytes > 0 && n > maxBytes;
    if (over) area.setAttribute('aria-invalid', 'true');
    else area.removeAttribute('aria-invalid');
    saveBtn.disabled = over;
  };

  call('instructions:get-global', {}).then((r) => {
    if (disposed) return;
    maxBytes = Number(r.maxBytes) || 0;
    area.value = typeof r.content === 'string' ? r.content : '';
    area.disabled = false;
    paintMeta();
    if (r.enabled === false) {
      host.insertBefore(el('div', { class: 'sv-empty-row sv-instructions-off', role: 'note' }, [
        'Instructions are turned off (settings.llm.agent.instructions.enabled is false in config.json). Edits are saved but not sent to the agent.',
      ]), area);
    }
    if (r.truncated) setStatus(status, 'error', `The file is larger than ${maxBytes} bytes; only the first part is shown and used.`);
  }, (err) => {
    if (disposed) return;
    host.insertBefore(errorRow(`Couldn't load the instructions: ${errMsg(err)}`), area);
  });

  area.addEventListener('input', () => { paintMeta(); setStatus(status, null, ''); });
  saveBtn.addEventListener('click', () => {
    saveBtn.disabled = true;
    setStatus(status, 'pending', 'Saving…');
    call('instructions:set-global', { content: area.value }).then(
      () => { if (!disposed) { setStatus(status, 'ok', 'Saved.'); paintMeta(); } },
      (err) => { if (!disposed) { paintMeta(); setStatus(status, 'error', `Not saved: ${errMsg(err)}`); } },
    );
  });
  return () => { disposed = true; };
}

module.exports = { agentPermissionRules, agentWorkspaceRoots, agentGlobalInstructions };

// Skills gallery: installed SKILL.md skills with enable toggles, install from
// an https link, copy-import from Claude Code / Codex, and delete with an
// in-row confirmation. All data comes from the skills:* IPC (SkillsService).

const { ipcRenderer } = require('electron');
const { el } = require('../controls');
const { errMsg } = require('../../../../shared/errMsg');
const { actionButton, errorRow, setStatus } = require('./kit');

const ERROR_TEXT = {
  https_only: 'Only https:// links can be installed.',
  invalid_url: 'That is not a valid link.',
  credentials_in_url: 'Links with a username or password are not accepted.',
  too_large: 'The file is larger than the 256 KB skill limit.',
  exists: 'A skill with that name is already installed.',
  invalid_name: 'The skill name must be lowercase letters, digits and hyphens (max 64).',
  missing_frontmatter: 'The file has no SKILL.md header (--- name / description ---).',
  missing_description: 'The skill has no description.',
};
const describeError = (code) => ERROR_TEXT[code] || String(code || 'unknown error');

function importSummary(res) {
  if (res.sourceMissing) return { kind: 'error', text: `No skills folder found at ${res.dir}.` };
  const results = Array.isArray(res.results) ? res.results : [];
  const imported = results.filter((r) => r.status === 'imported').length;
  const existing = results.filter((r) => r.status === 'exists').length;
  const failed = results.filter((r) => r.status === 'error');
  const parts = [`Imported ${imported}`];
  if (existing) parts.push(`${existing} already installed`);
  if (failed.length) parts.push(`${failed.length} failed (${failed.map((r) => `${r.dir}: ${describeError(r.error)}`).join('; ')})`);
  return { kind: failed.length ? 'error' : 'ok', text: results.length ? parts.join(', ') + '.' : `No skills found in ${res.dir}.` };
}

function skills({ host }) {
  let disposed = false;
  const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

  host.appendChild(el('p', { class: 'sv-section-intro' }, [
    'A skill is a folder with a SKILL.md file: a description of when to use it plus step-by-step instructions. ',
    'A skill\'s allowed-tools list only narrows which tools the assistant sees while following it; every action still asks for permission as usual.',
  ]));

  const listStatus = el('span', { class: 'sv-validation-status', 'aria-live': 'polite' }, ['']);
  const listEl = el('div', { class: 'sv-spaces-list', 'data-role': 'skills-list' });
  host.append(listStatus, listEl);

  function warningList(warnings) {
    if (!Array.isArray(warnings) || !warnings.length) return null;
    return el('ul', { class: 'sv-hint', 'data-role': 'skill-warnings' }, warnings.map((w) => el('li', {}, [w])));
  }

  function rowFor(skill) {
    const row = el('div', { class: 'sv-space-row', 'data-skill': skill.name });
    const enabledCb = el('input', { type: 'checkbox', 'aria-label': `Enable ${skill.name}` });
    enabledCb.checked = skill.enabled !== false;
    const status = el('span', { class: 'sv-validation-status' }, ['']);
    enabledCb.addEventListener('change', async () => {
      const want = enabledCb.checked;
      try {
        const res = await invoke('skills:set-enabled', { name: skill.name, enabled: want });
        if (!res || !res.ok) throw new Error(describeError(res && res.error));
        setStatus(status, null, '');
      } catch (err) {
        enabledCb.checked = !want;
        setStatus(status, 'error', `Could not update: ${errMsg(err)}`);
      }
    });
    row.appendChild(el('div', { class: 'sv-persona-row-head' }, [
      enabledCb,
      el('span', { class: 'sv-persona-title' }, [skill.name]),
      el('span', { class: 'sv-persona-sub' }, [skill.description || '']),
    ]));
    const warn = warningList(skill.warnings);
    if (warn) row.appendChild(warn);

    const actions = el('div', { class: 'sv-actions-row' });
    const delBtn = actionButton('Delete', 'sv-button sv-button--danger', 'trash');
    const showIdle = () => actions.replaceChildren(delBtn, status);
    delBtn.addEventListener('click', () => {
      const confirmBtn = actionButton(`Delete ${skill.name}`, 'sv-button sv-button--danger', 'trash');
      const cancelBtn = actionButton('Cancel', 'sv-button');
      cancelBtn.addEventListener('click', showIdle);
      confirmBtn.addEventListener('click', async () => {
        confirmBtn.disabled = true;
        try {
          const res = await invoke('skills:delete', { name: skill.name });
          if (!res || !res.ok) throw new Error(describeError(res && res.error));
          refresh();
        } catch (err) {
          showIdle();
          setStatus(status, 'error', `Could not delete: ${errMsg(err)}`);
        }
      });
      actions.replaceChildren(el('span', { class: 'sv-field-label' }, [`Delete "${skill.name}" and its files?`]), confirmBtn, cancelBtn);
      confirmBtn.focus();
    });
    showIdle();
    row.appendChild(actions);
    return row;
  }

  async function refresh() {
    setStatus(listStatus, 'pending', 'Loading skills…');
    let res;
    try {
      res = await invoke('skills:list');
      if (!res || !res.ok) throw new Error(describeError(res && res.error));
    } catch (err) {
      if (disposed) return;
      setStatus(listStatus, null, '');
      listEl.replaceChildren(errorRow(`Couldn't load skills: ${errMsg(err)}`));
      return;
    }
    if (disposed) return;
    setStatus(listStatus, null, '');
    const rows = (res.skills || []).map(rowFor);
    const broken = (res.errors || []).map((e) => errorRow(`${e.dir}: ${describeError(e.error)}`));
    const migration = res.migration && Array.isArray(res.migration.errors) ? res.migration.errors : [];
    const legacy = migration.map((e) => errorRow(`Old skill ${e.file} could not be converted: ${e.error}`));
    if (!rows.length && !broken.length && !legacy.length) {
      listEl.replaceChildren(el('div', { class: 'sv-empty-row' }, ['No skills installed yet. Install one from a link or import from Claude Code or Codex below.']));
      return;
    }
    listEl.replaceChildren(...rows, ...broken, ...legacy);
  }

  // Install from URL
  host.appendChild(el('h4', { class: 'sv-subhead' }, ['Install from a link']));
  const urlInput = el('input', { type: 'url', class: 'sv-text', 'aria-label': 'SKILL.md link (https)', spellcheck: 'false' });
  const installStatus = el('span', { class: 'sv-validation-status', 'aria-live': 'polite' }, ['']);
  const installBtn = actionButton('Install', 'sv-button sv-button--primary', 'download');
  installBtn.addEventListener('click', async () => {
    const url = String(urlInput.value || '').trim();
    if (!/^https:\/\//i.test(url)) { setStatus(installStatus, 'error', describeError('https_only')); return; }
    installBtn.disabled = true;
    setStatus(installStatus, 'pending', 'Installing…');
    try {
      const res = await invoke('skills:install-url', { url });
      if (!res || !res.ok) throw new Error(describeError(res && res.error));
      const n = Array.isArray(res.warnings) ? res.warnings.length : 0;
      setStatus(installStatus, 'ok', `✓ Installed ${res.skill.name}${n ? ` (${n} warning${n === 1 ? '' : 's'})` : ''}`);
      urlInput.value = '';
      refresh();
    } catch (err) {
      setStatus(installStatus, 'error', `Install failed: ${errMsg(err)}`);
    } finally {
      installBtn.disabled = false;
    }
  });
  host.appendChild(el('div', { class: 'sv-row-stack' }, [
    el('label', { class: 'sv-field-label' }, ['Paste an https:// link to a SKILL.md file (GitHub file links work).']),
    urlInput,
    el('div', { class: 'sv-actions-row' }, [installBtn, installStatus]),
  ]));

  // Import
  host.appendChild(el('h4', { class: 'sv-subhead' }, ['Import']));
  const importStatus = el('span', { class: 'sv-validation-status', 'aria-live': 'polite' }, ['']);
  const importBtn = (source, label) => {
    const btn = actionButton(label, 'sv-button', 'download');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      setStatus(importStatus, 'pending', 'Importing…');
      try {
        const res = await invoke('skills:import', { source });
        if (!res || !res.ok) throw new Error(describeError(res && res.error));
        const summary = importSummary(res);
        setStatus(importStatus, summary.kind, summary.text);
        refresh();
      } catch (err) {
        setStatus(importStatus, 'error', `Import failed: ${errMsg(err)}`);
      } finally {
        btn.disabled = false;
      }
    });
    return btn;
  };
  host.appendChild(el('div', { class: 'sv-row-stack' }, [
    el('label', { class: 'sv-field-label' }, ['Copy skills from ~/.claude/skills or ~/.codex/skills. Originals are left untouched.']),
    el('div', { class: 'sv-actions-row' }, [
      importBtn('claude', 'Import from Claude Code'),
      importBtn('codex', 'Import from Codex'),
      importStatus,
    ]),
  ]));

  refresh();
  return () => { disposed = true; };
}

module.exports = { skills, importSummary };

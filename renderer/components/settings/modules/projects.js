// Projects manager: file/image collections the assistant can read.

const { ipcRenderer } = require('electron');
const { el } = require('../controls');
const { icon: makeIcon } = require('../../Icon');
const { errMsg } = require('../../../../shared/errMsg');
const { confirm } = require('../../ConfirmDialog');
const toast = require('../../Toast');
const { actionButton, errorRow } = require('./kit');

// projects:* handlers resolve {ok:false, error} instead of rejecting; treat
// that shape as a failure so every caller reaches its visible error path.
async function invokeOk(channel, payload) {
  const r = await ipcRenderer.invoke(channel, payload);
  if (r && r.ok === false) throw new Error(r.error || `${channel} failed`);
  return r;
}

const PROJECT_IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

function isImageName(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  return PROJECT_IMAGE_TYPES.has(ext);
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function projects({ host }) {
  const intro = el('p', { class: 'sv-section-intro' }, [
    'Projects are persistent collections of files and images. The LLM can search and read them via the project tools, and projects marked "always in context" are injected into every prompt. Files are stored locally under the app data directory and never leave your machine except as part of a prompt.',
  ]);
  host.appendChild(intro);

  const listEl = el('div', { class: 'sv-projects-list' });
  host.appendChild(listEl);

  async function refresh() {
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    let projectsList;
    try {
      const r = await invokeOk('projects:list');
      projectsList = (r && Array.isArray(r.projects)) ? r.projects : [];
    } catch (err) {
      listEl.appendChild(errorRow(`Couldn't load projects: ${errMsg(err)}`));
      return;
    }
    if (projectsList.length === 0) {
      listEl.appendChild(el('div', { class: 'sv-empty-row' }, ['No projects yet. Create one below to start attaching files.']));
      return;
    }
    for (const p of projectsList) listEl.appendChild(projectRow(p, refresh));
  }

  // Create row
  const addRow = el('div', { class: 'sv-row sv-projects-add-row' });
  const nameInput = el('input', { type: 'text', class: 'sv-text', placeholder: 'New project name (e.g. "Q4 Research", "API Spec")', 'aria-label': 'New project name' });
  const addBtn = actionButton('Create project', 'sv-button sv-button--primary', 'plus');
  async function submitCreate() {
    const name = nameInput.value.trim();
    if (!name) return;
    try {
      await invokeOk('projects:create', { name });
    } catch (err) {
      toast.error(`Couldn't create project: ${errMsg(err)}`);
      return;
    }
    nameInput.value = '';
    refresh();
  }
  addBtn.addEventListener('click', submitCreate);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitCreate(); } });
  addRow.append(nameInput, addBtn);
  host.appendChild(addRow);

  refresh();
}

function projectRow(p, refresh) {
  const card = el('div', { class: 'sv-project-card' });

  // Header: name + actions
  const head = el('div', { class: 'sv-project-head' });
  const nameEl = el('input', { type: 'text', class: 'sv-text sv-project-name', value: p.name || p.id, 'aria-label': 'Project name' });
  nameEl.addEventListener('change', async () => {
    const next = nameEl.value.trim();
    if (!next || next === p.name) { nameEl.value = p.name; return; }
    try {
      await invokeOk('projects:rename', { id: p.id, name: next });
      p.name = next;
    } catch (err) {
      nameEl.value = p.name;
      toast.error(`Couldn't rename project: ${errMsg(err)}`);
    }
  });
  const delBtn = el('button', { type: 'button', class: 'sv-button sv-button--ghost sv-project-delete', 'aria-label': 'Delete project', title: 'Delete project' }, ['Delete']);
  delBtn.addEventListener('click', async () => {
    const ok = await confirm({
      title: `Delete project "${p.name || p.id}"?`,
      message: 'All its files will be permanently removed.',
      confirmLabel: 'Delete project',
      confirmKind: 'danger',
    });
    if (!ok) return;
    try {
      await invokeOk('projects:delete', { id: p.id });
    } catch (err) {
      toast.error(`Couldn't delete project: ${errMsg(err)}`);
      return;
    }
    refresh();
  });
  head.append(nameEl, delBtn);
  card.appendChild(head);

  // Always-in-context toggle
  const toggleRow = el('div', { class: 'sv-row sv-row--toggles sv-project-toggle-row' });
  const ctxCb = el('input', { type: 'checkbox' });
  ctxCb.checked = !!p.alwaysInContext;
  const ctxLabel = el('label', { class: 'sv-toggle-label' });
  ctxLabel.append(ctxCb, document.createTextNode(' Always in context (inject this project\'s text files into every prompt)'));
  ctxCb.addEventListener('change', async () => {
    try {
      await invokeOk('projects:setContext', { id: p.id, on: ctxCb.checked });
      p.alwaysInContext = ctxCb.checked;
    } catch (err) {
      ctxCb.checked = !!p.alwaysInContext;
      toast.error(`Couldn't change "always in context": ${errMsg(err)}`);
    }
  });
  toggleRow.append(ctxLabel);
  card.appendChild(toggleRow);

  // File list
  const filesWrap = el('div', { class: 'sv-project-files' });
  const filesList = el('div', { class: 'sv-project-files-list' });
  async function refreshFiles() {
    while (filesList.firstChild) filesList.removeChild(filesList.firstChild);
    let files;
    try {
      const r = await invokeOk('projects:files', { id: p.id });
      files = (r && Array.isArray(r.files)) ? r.files : [];
    } catch (err) {
      filesList.appendChild(errorRow(`Couldn't load project files: ${errMsg(err)}`));
      return;
    }
    if (files.length === 0) {
      filesList.appendChild(el('div', { class: 'sv-empty-row' }, ['No files yet. Add files below.']));
      return;
    }
    for (const f of files) {
      const chip = el('div', { class: 'sv-file-chip' + (f.isImage ? ' is-image' : '') });
      const icon = makeIcon(f.isImage ? 'image' : 'file', { className: 'sv-file-chip-icon' });
      const label = el('span', { class: 'sv-file-chip-name', title: f.name }, [f.name]);
      const size = el('span', { class: 'sv-file-chip-size' }, [fmtBytes(f.size)]);
      const rm = el('button', { type: 'button', class: 'sv-file-chip-remove', 'aria-label': `Remove ${f.name}`, title: 'Remove file' }, ['✕']);
      rm.addEventListener('click', async () => {
        try {
          await invokeOk('projects:removeFile', { id: p.id, fileId: f.id });
        } catch (err) {
          toast.error(`Couldn't remove ${f.name}: ${errMsg(err)}`);
          return;
        }
        refreshFiles();
      });
      chip.append(icon, label, size, rm);
      filesList.appendChild(chip);
    }
  }
  filesWrap.appendChild(filesList);
  card.appendChild(filesWrap);

  // Add files: hidden <input type=file multiple> triggered by the button.
  const fileInput = el('input', { type: 'file', multiple: 'true', style: { display: 'none' }, 'aria-label': 'Upload files' });
  const uploadRow = el('div', { class: 'sv-actions-row sv-project-upload-row' });
  const uploadBtn = actionButton('Add files…', 'sv-button', 'plus');
  const shotBtn = actionButton('Screenshot current page', 'sv-button', 'camera');
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const picked = Array.from(fileInput.files || []);
    fileInput.value = '';
    for (const f of picked) await uploadOneFile(p.id, f);
    refreshFiles();
  });
  shotBtn.addEventListener('click', async () => {
    shotBtn.disabled = true;
    try {
      const r = await ipcRenderer.invoke('projects:screenshotActive', { id: p.id });
      if (!r || !r.ok) toast.error('Screenshot failed' + (r && r.error ? ': ' + r.error : ''));
    } catch (err) {
      toast.error('Screenshot failed: ' + errMsg(err));
    }
    finally { shotBtn.disabled = false; refreshFiles(); }
  });
  uploadRow.append(uploadBtn, shotBtn, fileInput);
  card.appendChild(uploadRow);

  refreshFiles();
  return card;
}

async function uploadOneFile(projectId, file) {
  const isImg = isImageName(file.name) || (file.type && file.type.startsWith('image/'));
  try {
    if (isImg) {
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(file);
      });
      await invokeOk('projects:addImage', { id: projectId, name: file.name, dataUrl });
    } else {
      const text = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => reject(fr.error);
        fr.readAsText(file);
      });
      await invokeOk('projects:addFile', { id: projectId, name: file.name, text });
    }
  } catch (err) {
    toast.error('Upload failed: ' + file.name + ' — ' + errMsg(err));
  }
}

module.exports = { projects };

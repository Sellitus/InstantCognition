// ProjectComposer — the Projects surface inside AgentPanel.
//
// Owns three composer affordances for the active project:
//   1. A project selector bar (pick which project file uploads + @-mentions
//      target; persists the choice in settings.projects.lastActiveId).
//   2. @-mention file autocomplete in the textarea: typing "@" opens a list of
//      the active project's files; selecting one inserts a [[file:Name]] token
//      and records the file id for context injection at send time.
//   3. Drag-and-drop + paste image upload onto the composer: dropped/pasted
//      images are added to the active project (a transient "Uploads" project
//      is created if none is active) and attached to the next message.
//
// At send time AgentPanel calls collectAttachments() to resolve mentioned +
// dropped files into text blocks via projects:read. Designed to be self-
// contained: AgentPanel only mounts it and reads back attachments.
//
// The bar renders into the host element passed to the constructor (formerly
// `.agent-panel-project-slot`; now the AssistantMenu's PROJECT section host).
// Callers that want to embed the bar in a different container can pass any
// HTMLElement — the composer's only assumption is that it can `appendChild`
// the rendered `.proj-bar` into that host.

const { ipcRenderer } = require('electron');
const { errMsg } = require('../../../shared/errMsg');
const { iconHTML } = require('../Icon');

const MENTION_RE = /\[\[file:([^\]]+)\]\]/g;

class ProjectComposer {
  constructor(opts) {
    const { host, input, onChange } = /** @type {any} */ (opts || {});
    this._host = host || null;
    this._input = input || null;
    this._onChange = onChange || function () {};
    this._projects = [];       // [{id,name,alwaysInContext,fileCount}]
    this._activeId = null;
    this._files = [];          // files of the active project
    this._mentionMenu = null;  // transient autocomplete list element
    this._mentionQuery = '';
    this._pendingImages = [];  // [{projectId,fileId,name}] staged before send
    this._barEl = null;
    this._selectorEl = null;
    this._attachBtn = null;
    this._fileInput = null;
    this._inFlight = Promise.resolve();
  }

  async mount() {
    if (!this._host) return;
    this._renderBar();
    this._wireInput();
    await this._loadProjects();
    this._wireDropPaste();
  }

  _renderBar() {
    this._host.innerHTML =
      '<div class="proj-bar">'
      + '  <button type="button" class="proj-bar-selector" title="Choose a project for uploads and @-mentions">'
      + `    <span class="proj-bar-icon" aria-hidden="true">${iconHTML('folder')}</span>`
      + '    <span class="proj-bar-name">No project</span>'
      + `    <span class="proj-bar-caret" aria-hidden="true">${iconHTML('down')}</span>`
      + '  </button>'
      + `  <button type="button" class="proj-bar-attach" title="Attach a file to the active project">${iconHTML('plus')}<span>File</span></button>`
      + `  <button type="button" class="proj-bar-shot" title="Screenshot the active tab and add it to the project">${iconHTML('camera')}<span>Page</span></button>`
      + '  <input type="file" class="proj-bar-file-input" hidden multiple />'
      + '  <span class="proj-bar-hint"></span>'
      + '</div>';
    this._barEl = /** @type {HTMLElement} */ (this._host.querySelector('.proj-bar'));
    this._selectorEl = /** @type {HTMLElement} */ (this._host.querySelector('.proj-bar-selector'));
    this._selectorName = /** @type {HTMLElement} */ (this._host.querySelector('.proj-bar-name'));
    this._attachBtn = /** @type {HTMLElement} */ (this._host.querySelector('.proj-bar-attach'));
    this._shotBtn = /** @type {HTMLElement} */ (this._host.querySelector('.proj-bar-shot'));
    this._fileInput = /** @type {HTMLInputElement} */ (this._host.querySelector('.proj-bar-file-input'));
    this._hintEl = /** @type {HTMLElement} */ (this._host.querySelector('.proj-bar-hint'));
    if (this._selectorEl) this._selectorEl.addEventListener('click', () => this._toggleMenu());
    if (this._attachBtn) this._attachBtn.addEventListener('click', () => this._fileInput && this._fileInput.click());
    if (this._shotBtn) this._shotBtn.addEventListener('click', () => this._capturePage());
    if (this._fileInput) this._fileInput.addEventListener('change', () => this._onFileInput());
  }

  _wireInput() {
    if (!this._input) return;
    this._input.addEventListener('input', () => this._onInput());
    this._input.addEventListener('keydown', (e) => this._onKeydown(e));
    this._input.addEventListener('blur', () => { setTimeout(() => this._closeMentionMenu(), 180); });
  }

  _wireDropPaste() {
    const target = this._input || this._host;
    if (!target) return;
    target.addEventListener('dragover', (e) => {
      if (!e.dataTransfer) return;
      const hasFiles = Array.from(e.dataTransfer.types || []).includes('Files');
      if (hasFiles) { e.preventDefault(); target.classList.add('is-drop-target'); }
    });
    target.addEventListener('dragleave', () => target.classList.remove('is-drop-target'));
    // DOM listeners cannot be awaited, so the upload each one starts is kept
    // here for whenSettled().
    target.addEventListener('drop', (e) => { this._inFlight = this._onDrop(e); });
    if (this._input) {
      this._input.addEventListener('paste', (e) => { this._inFlight = this._onPaste(e); });
    }
  }

  /** Resolves once the upload started by the most recent drop or paste finishes. */
  async whenSettled() {
    await this._inFlight;
  }

  async _loadProjects() {
    try {
      const r = await ipcRenderer.invoke('projects:list');
      this._projects = (r && r.ok && Array.isArray(r.projects)) ? r.projects : [];
    } catch (err) {
      console.error('projects:list failed', (err instanceof Error && err.message) || err);
      this._projects = [];
    }
    // Restore last active choice.
    const last = configBridgeGet('settings.projects.lastActiveId');
    if (last && this._projects.some((p) => p.id === last)) this._activeId = last;
    else if (this._projects.length) this._activeId = this._projects[0].id;
    else this._activeId = null;
    await this._refreshFiles();
    this._renderSelector();
  }

  async _refreshFiles() {
    if (!this._activeId) { this._files = []; return; }
    try {
      const r = await ipcRenderer.invoke('projects:files', { id: this._activeId });
      this._files = (r && r.ok && Array.isArray(r.files)) ? r.files : [];
    } catch (err) {
      console.error('projects:files failed', (err instanceof Error && err.message) || err);
      this._files = [];
    }
  }

  _renderSelector() {
    if (!this._selectorName) return;
    const p = this._projects.find((x) => x.id === this._activeId);
    this._selectorName.textContent = p ? p.name : 'No project';
    if (this._attachBtn) this._attachBtn.hidden = !p;
    if (this._shotBtn) this._shotBtn.hidden = !p;
    if (this._hintEl) this._hintEl.textContent = p ? 'Type @ to mention a file · drop or paste images' : 'Create a project in Settings → Assistant & AI → Projects';
  }

  _toggleMenu() { this._menuEl ? this._closeMenu() : this._openProjectMenu(); }

  _openProjectMenu() {
    this._closeMenu();
    if (!this._barEl) return;
    const menu = document.createElement('div');
    menu.className = 'proj-menu';
    menu.setAttribute('role', 'listbox');
    if (!this._projects.length) {
      const empty = document.createElement('div');
      empty.className = 'proj-menu-empty';
      empty.textContent = 'No projects yet — create one in Settings → Projects.';
      menu.appendChild(empty);
    }
    this._projects.forEach((p) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'proj-menu-item' + (p.id === this._activeId ? ' is-active' : '');
      item.textContent = p.name + (p.fileCount ? `  (${p.fileCount})` : '');
      item.addEventListener('click', () => { this._setActive(p.id); this._closeMenu(); });
      menu.appendChild(item);
    });
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'proj-menu-item proj-menu-create';
    create.textContent = '＋ New project…';
    create.addEventListener('click', () => { this._closeMenu(); this._createProject(); });
    menu.appendChild(create);
    this._barEl.appendChild(menu);
    this._menuEl = menu;
    setTimeout(() => {
      const onDoc = (e) => {
        if (!this._menuEl) return;
        if (e.target instanceof Node && this._menuEl.contains(e.target)) return;
        if (e.target instanceof Node && this._selectorEl && this._selectorEl.contains(e.target)) return;
        this._closeMenu();
        document.removeEventListener('click', onDoc, true);
      };
      document.addEventListener('click', onDoc, true);
    }, 0);
  }

  _closeMenu() {
    if (this._menuEl) { this._menuEl.remove(); this._menuEl = null; }
  }

  async _createProject() {
    const { prompt } = require('../PromptDialog');
    const name = await prompt({
      title: 'New project',
      message: 'Give the project a name.',
      defaultValue: 'New project',
      confirmLabel: 'Create',
      validate: (v) => (v.trim() ? null : 'Name cannot be empty'),
    });
    if (!name) return;
    try {
      const r = await ipcRenderer.invoke('projects:create', { name: name.trim() });
      if (r && r.ok) {
        await this._loadProjects();
        this._setActive(r.project.id);
      } else {
        this._flashHint(r && r.error ? 'Could not create project: ' + r.error : 'Could not create project');
      }
    } catch (err) {
      console.error('projects:create failed', errMsg(err));
      this._flashHint('Could not create project: ' + errMsg(err));
    }
  }

  async _setActive(id) {
    this._activeId = id;
    configBridgeSet('settings.projects.lastActiveId', id);
    await this._refreshFiles();
    this._renderSelector();
    this._onChange();
  }

  getActiveProjectId() { return this._activeId; }

  // -- @-mention autocomplete --------------------------------------------

  _onInput() {
    if (!this._input) return;
    const val = this._input.value;
    const caret = this._input.selectionStart || val.length;
    // Find the token starting at the most recent '@' with no whitespace after.
    const before = val.slice(0, caret);
    const at = before.lastIndexOf('@');
    if (at < 0) { this._closeMentionMenu(); return; }
    // Must be at start or preceded by whitespace (not an email).
    if (at > 0 && !/\s/.test(before[at - 1])) { this._closeMentionMenu(); return; }
    const query = before.slice(at + 1);
    if (query.includes('\n') || query.length > 40) { this._closeMentionMenu(); return; }
    this._mentionQuery = query;
    this._openMentionMenu(query, at);
  }

  _openMentionMenu(query, at) {
    if (!this._files.length) { this._closeMentionMenu(); return; }
    const q = (query || '').toLowerCase();
    const matches = this._files
      .filter((f) => !q || f.name.toLowerCase().includes(q))
      .slice(0, 8);
    if (!matches.length) { this._closeMentionMenu(); return; }
    this._closeMentionMenu();
    const menu = document.createElement('div');
    menu.className = 'proj-mention-menu';
    menu.setAttribute('role', 'listbox');
    menu.dataset.at = String(at);
    matches.forEach((f) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'proj-mention-item';
      item.innerHTML = `<span class="proj-mention-icon" aria-hidden="true">${iconHTML(f.isImage ? 'image' : 'file')}</span>`;
      const label = document.createElement('span');
      label.className = 'proj-mention-name';
      label.textContent = f.name;
      item.appendChild(label);
      item.dataset.fileId = f.id;
      item.dataset.fileName = f.name;
      item.addEventListener('mousedown', (e) => { e.preventDefault(); this._insertMention(f); });
      menu.appendChild(item);
    });
    // Position below the textarea caret line (approx: below the input).
    if (this._input && this._input.parentElement) {
      this._input.parentElement.appendChild(menu);
    }
    this._mentionMenu = menu;
  }

  _closeMentionMenu() {
    if (this._mentionMenu) { this._mentionMenu.remove(); this._mentionMenu = null; }
  }

  _insertMention(file) {
    if (!this._input) return;
    const val = this._input.value;
    const caret = this._input.selectionStart || val.length;
    const before = val.slice(0, caret);
    const at = before.lastIndexOf('@');
    if (at < 0) return;
    const token = `[[file:${file.name}]]`;
    const next = val.slice(0, at) + token + ' ' + val.slice(caret);
    this._input.value = next;
    const pos = at + token.length + 1;
    try { this._input.setSelectionRange(pos, pos); } catch (err) { console.error('setSelectionRange failed', (err instanceof Error && err.message) || err); }
    this._input.focus();
    this._closeMentionMenu();
    this._onChange();
  }

  _onKeydown(e) {
    if (!this._mentionMenu) return;
    const items = Array.from(this._mentionMenu.querySelectorAll('.proj-mention-item'));
    if (!items.length) return;
    const cur = this._mentionMenu.querySelector('.proj-mention-item.is-selected');
    let idx = cur ? items.indexOf(cur) : -1;
    if (e.key === 'ArrowDown') { e.preventDefault(); idx = (idx + 1) % items.length; this._selectItem(items, idx); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = (idx <= 0 ? items.length - 1 : idx - 1); this._selectItem(items, idx); }
    else if (e.key === 'Enter' || e.key === 'Tab') {
      if (idx >= 0) {
        e.preventDefault();
        // Rows listen on mousedown so they beat the textarea's blur; a
        // synthesized click would never reach that handler.
        const id = /** @type {HTMLElement} */ (items[idx]).dataset.fileId;
        const file = this._files.find((f) => f.id === id);
        if (file) this._insertMention(file);
      }
    } else if (e.key === 'Escape') { e.preventDefault(); this._closeMentionMenu(); }
  }

  _selectItem(items, idx) {
    items.forEach((i) => i.classList.remove('is-selected'));
    items[idx].classList.add('is-selected');
    items[idx].scrollIntoView({ block: 'nearest' });
  }

  // -- File + image upload ------------------------------------------------

  async _capturePage() {
    if (!this._activeId) { this._flashHint('Select or create a project first'); return; }
    try {
      const r = await ipcRenderer.invoke('projects:screenshotActive', { id: this._activeId });
      if (r && r.ok) {
        await this._refreshFiles();
        this._renderSelector();
        this._flashHint('Page screenshot added');
        this._onChange();
      } else {
        this._flashHint(r && r.error ? 'Screenshot failed: ' + r.error : 'Screenshot failed');
      }
    } catch (err) {
      console.error('projects:screenshotActive failed', (err instanceof Error && err.message) || err);
      this._flashHint('Screenshot failed');
    }
  }

  async _onFileInput() {
    if (!this._fileInput || !this._fileInput.files || !this._fileInput.files.length) return;
    const pid = await this._ensureProject();
    if (!pid) return;
    for (const file of Array.from(this._fileInput.files)) {
      await this._uploadFile(pid, file);   
    }
    this._fileInput.value = '';
    await this._refreshFiles();
    this._onChange();
  }

  async _onDrop(e) {
    if (!e.dataTransfer) return;
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;
    e.preventDefault();
    const target = this._input || this._host;
    target.classList.remove('is-drop-target');
    const pid = await this._ensureProject();
    if (!pid) return;
    for (const file of files) {
      await this._uploadFile(pid, file);   
    }
    await this._refreshFiles();
    this._renderSelector();
    this._flashHint(files.length + ' file' + (files.length === 1 ? '' : 's') + ' added');
    this._onChange();
  }

  async _onPaste(e) {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const images = [];
    for (const it of Array.from(items)) {
      if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) images.push(f);
      }
    }
    if (!images.length) return;
    e.preventDefault();
    const pid = await this._ensureProject();
    if (!pid) return;
    for (const img of images) {
      // _uploadFile already stages images; staging again here would send the
      // same picture to the model twice.
      await this._uploadFile(pid, img);
    }
    await this._refreshFiles();
    this._renderSelector();
    this._flashHint(images.length + ' image' + (images.length === 1 ? '' : 's') + ' pasted');
    this._onChange();
  }

  async _ensureProject() {
    if (this._activeId) return this._activeId;
    try {
      const r = await ipcRenderer.invoke('projects:create', { name: 'Uploads' });
      if (r && r.ok) { await this._loadProjects(); this._setActive(r.project.id); return r.project.id; }
      this._flashHint(r && r.error ? 'Could not create project: ' + r.error : 'Could not create project');
    } catch (err) {
      console.error('projects:create failed', errMsg(err));
      this._flashHint('Could not create project: ' + errMsg(err));
    }
    return null;
  }

  async _uploadFile(projectId, file) {
    const isImage = file.type && file.type.startsWith('image/');
    try {
      if (isImage) {
        const dataUrl = await readAsDataUrl(file);
        const r = await ipcRenderer.invoke('projects:addImage', { id: projectId, name: file.name, dataUrl });
        if (r && r.ok) { this._pendingImages.push({ projectId, fileId: r.file.id, name: r.file.name }); return r.file; }
      } else {
        const text = await readAsText(file);
        const r = await ipcRenderer.invoke('projects:addFile', { id: projectId, name: file.name, text });
        if (r && r.ok) return r.file;
      }
    } catch (err) {
      console.error('project upload failed', file && file.name, errMsg(err));
      this._flashHint('Upload failed: ' + ((file && file.name) || 'file'));
      return null;
    }
    // A well-formed reply that is not ok still means the file never landed.
    this._flashHint('Upload failed: ' + ((file && file.name) || 'file'));
    return null;
  }

  _flashHint(msg) {
    if (!this._hintEl) return;
    this._hintEl.textContent = msg;
    clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => this._renderSelector(), 2400);
  }

  // -- Resolve attachments at send time ----------------------------------

  // Resolves mentioned + dropped/pasted files via projects:read. Returns
  // { text: string, images: [{name,dataUrl}] } — text blocks for the prompt
  // and base64 data URLs for any images (consumed by the chat vision path to
  // build multimodal message content). Best-effort: a read failure is logged
  // and skipped rather than blocking the send.
  async collectAttachments() {
    const blocks = [];
    const images = [];
    const mentionedIds = this._resolveMentionedFileIds();
    const all = [];
    mentionedIds.forEach((m) => all.push({ ...m, kind: 'mention' }));
    this._pendingImages.forEach((m) => {
      if (!mentionedIds.some((x) => x.fileId === m.fileId)) all.push({ ...m, kind: 'image' });
    });
    for (const att of all) {
      try {
        const r = await ipcRenderer.invoke('projects:read', { projectId: att.projectId, fileId: att.fileId });   
        if (!r || !r.ok || !r.file) continue;
        if (r.file.isImage) {
          if (r.dataUrl) images.push({ name: r.file.name, dataUrl: r.dataUrl });
          else blocks.push(`--- Image: ${r.file.name} (in project) ---`);
        } else if (typeof r.text === 'string') {
          const cap = 12000;
          const body = r.text.length > cap ? r.text.slice(0, cap) + '\n…[truncated]' : r.text;
          blocks.push(`--- File: ${r.file.name} ---\n${body}`);
        }
      } catch (err) { console.error('projects:read failed', att, (err instanceof Error && err.message) || err); }
    }
    return { text: blocks.join('\n\n'), images };
  }

  // Map [[file:Name]] tokens in the textarea to active-project file ids.
  _resolveMentionedFileIds() {
    if (!this._input || !this._activeId) return [];
    const out = [];
    const seen = new Set();
    let m;
    MENTION_RE.lastIndex = 0;
    while ((m = MENTION_RE.exec(this._input.value)) !== null) {
      const name = m[1];
      const f = this._files.find((x) => x.name === name);
      if (f && !seen.has(f.id)) { seen.add(f.id); out.push({ projectId: this._activeId, fileId: f.id, name: f.name }); }
    }
    return out;
  }

  // Strip [[file:Name]] tokens from the message text the LLM sees, since the
  // file bodies are injected as context blocks instead. Keeps the user-facing
  // mention readable in the transcript while the model never sees the markup.
  static stripMentionTokens(text) {
    return String(text || '').replace(MENTION_RE, '').replace(/[ \t]{2,}/g, ' ').trim();
  }

  clearPending() { this._pendingImages = []; }

  async refresh() { await this._loadProjects(); this._renderSelector(); }
}

// -- helpers (module scope) ------------------------------------------------

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error || new Error('FileReader error'));
    fr.readAsDataURL(file);
  });
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error || new Error('FileReader error'));
    fr.readAsText(file);
  });
}

function configBridgeGet(key) {
  const cb = require('../../core/configBridge');
  return cb.get(key);
}
function configBridgeSet(key, val) {
  const cb = require('../../core/configBridge');
  cb.set(key, val);
}

module.exports = ProjectComposer;

// ArtifactsPane — the side pane listing a session's artifacts, with a live
// preview (ArtifactFrame), a version picker, copy and save.
//
// Mount: `const pane = new ArtifactsPane({ container, ipc }); pane.setSession(id)`.
// `ipc` is ipcRenderer-shaped ({ invoke, on, removeListener }). Pushes on
// artifact:upserted are applied only for the session being shown, and every
// async reply is dropped if the session or selection changed meanwhile.

const ArtifactFrame = require('./ArtifactFrame');

const TYPE_LABELS = { html: 'Page', markdown: 'Document', mermaid: 'Diagram', code: 'Code', svg: 'Image' };
const COPY_RESET_MS = 1600;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function errorText(res, fallback) {
  return (res && typeof res.error === 'string' && res.error) || fallback;
}

class ArtifactsPane {
  /** @param {{ container: HTMLElement, ipc?: any }} opts */
  constructor(opts) {
    if (!opts || !opts.container) throw new TypeError('ArtifactsPane requires a container');
    this._ipc = opts.ipc || require('electron').ipcRenderer;
    this._sessionId = null;
    this._artifacts = [];
    this._current = null; // the artifact version on screen
    this._listSeq = 0;
    this._viewSeq = 0;
    this._copyTimer = null;
    this._build(opts.container);
    this._onUpserted = (_e, payload) => this._applyUpsert(payload);
    this._ipc.on('artifact:upserted', this._onUpserted);
    this._showStatus('empty', 'No session selected.');
  }

  _build(container) {
    const root = el('section', 'artifacts-pane');
    root.setAttribute('aria-label', 'Artifacts');
    const header = el('header', 'artifacts-pane__header');
    header.appendChild(el('h2', 'artifacts-pane__heading', 'Artifacts'));
    this._status = el('div', 'artifacts-pane__status');
    this._retry = el('button', 'artifacts-pane__retry', 'Retry');
    this._retry.type = 'button';
    this._retry.hidden = true;
    this._retry.addEventListener('click', () => this.refresh());
    this._list = el('ul', 'artifacts-pane__list');
    this._list.setAttribute('aria-label', 'Artifacts in this session');

    this._viewer = el('div', 'artifacts-pane__viewer');
    this._viewer.hidden = true;
    const bar = el('div', 'artifacts-pane__toolbar');
    this._title = el('h3', 'artifacts-pane__title');
    this._version = /** @type {HTMLSelectElement} */ (el('select', 'artifacts-pane__version'));
    this._version.setAttribute('aria-label', 'Artifact version');
    this._version.addEventListener('change', () => this._open(this._current.id, Number(this._version.value)));
    this._copy = el('button', 'artifacts-pane__action', 'Copy');
    this._copy.type = 'button';
    this._copy.setAttribute('aria-label', 'Copy artifact source');
    this._copy.addEventListener('click', () => this._copySource());
    this._save = el('button', 'artifacts-pane__action', 'Save…');
    this._save.type = 'button';
    this._save.setAttribute('aria-label', 'Save artifact to a file');
    this._save.addEventListener('click', () => this._saveToFile());
    bar.append(this._title, this._version, this._copy, this._save);
    this._notice = el('p', 'artifacts-pane__notice');
    this._notice.setAttribute('role', 'status');
    this._frame = new ArtifactFrame({ ipc: this._ipc });
    const frameWrap = el('div', 'artifacts-pane__frame');
    frameWrap.appendChild(this._frame.el);
    this._viewer.append(bar, this._notice, frameWrap);

    root.append(header, this._status, this._retry, this._list, this._viewer);
    container.appendChild(root);
    this.el = root;
  }

  /** @param {string|null} sessionId */
  setSession(sessionId) {
    const id = typeof sessionId === 'string' && sessionId ? sessionId : null;
    if (id === this._sessionId) return Promise.resolve();
    this._sessionId = id;
    this._artifacts = [];
    this._current = null;
    this._viewSeq += 1;
    this._viewer.hidden = true;
    this._renderList();
    if (!id) {
      this._listSeq += 1;
      this._showStatus('empty', 'No session selected.');
      return Promise.resolve();
    }
    return this.refresh();
  }

  refresh() {
    const sessionId = this._sessionId;
    if (!sessionId) return Promise.resolve();
    const seq = ++this._listSeq;
    this._showStatus('loading', 'Loading artifacts…');
    const stale = () => seq !== this._listSeq || sessionId !== this._sessionId;
    return Promise.resolve()
      .then(() => this._ipc.invoke('artifact:list', { sessionId }))
      .then((res) => {
        if (stale()) return undefined;
        if (!res || !res.ok) throw new Error(errorText(res, 'list_failed'));
        this._artifacts = Array.isArray(res.artifacts) ? res.artifacts : [];
        this._renderList();
        if (!this._artifacts.length) {
          this._showStatus('empty', 'No artifacts yet. Ask the assistant for a page, diagram, document or code file.');
          return undefined;
        }
        this._showStatus(null);
        const keep = this._current && this._artifacts.find((a) => a.id === this._current.id);
        const first = this._artifacts.find((a) => !a.error);
        return !keep && first ? this._open(first.id) : undefined;
      })
      .catch((err) => {
        if (stale()) return;
        this._showStatus('error', `Could not load artifacts: ${(err && err.message) || String(err)}`);
      });
  }

  _showStatus(kind, text) {
    this._status.className = `artifacts-pane__status${kind ? ` artifacts-pane__status--${kind}` : ''}`;
    this._status.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    this._status.textContent = text || '';
    this._status.hidden = !kind;
    this._retry.hidden = kind !== 'error';
    this.el.setAttribute('aria-busy', String(kind === 'loading'));
  }

  _renderList() {
    this._list.replaceChildren();
    for (const a of this._artifacts) {
      const li = el('li', 'artifacts-pane__item');
      const btn = el('button', 'artifacts-pane__item-btn');
      btn.type = 'button';
      btn.dataset.artifactId = a.id;
      const selected = !!this._current && this._current.id === a.id;
      btn.setAttribute('aria-current', String(selected));
      if (a.error) {
        btn.disabled = true;
        btn.append(el('span', 'artifacts-pane__item-title', a.id), el('span', 'artifacts-pane__item-meta', `Unreadable: ${a.error}`));
      } else {
        btn.append(el('span', 'artifacts-pane__item-title', a.title), el('span', 'artifacts-pane__item-meta', `${TYPE_LABELS[a.type] || a.type} · v${a.version}`));
        btn.addEventListener('click', () => this._open(a.id));
      }
      li.appendChild(btn);
      this._list.appendChild(li);
    }
  }

  _open(artifactId, version) {
    const sessionId = this._sessionId;
    if (!sessionId) return Promise.resolve();
    const seq = ++this._viewSeq;
    this._setNotice('Loading…');
    const args = { sessionId, artifactId };
    if (Number.isInteger(version)) args.version = version;
    return Promise.resolve()
      .then(() => this._ipc.invoke('artifact:get', args))
      .then((res) => {
        if (seq !== this._viewSeq || sessionId !== this._sessionId) return;
        if (!res || !res.ok || !res.artifact) throw new Error(errorText(res, 'get_failed'));
        this._show(res.artifact);
      })
      .catch((err) => {
        if (seq !== this._viewSeq || sessionId !== this._sessionId) return;
        this._viewer.hidden = false;
        this._setNotice(`Could not open artifact: ${(err && err.message) || String(err)}`, true);
      });
  }

  _show(artifact) {
    this._current = artifact;
    this._viewer.hidden = false;
    this._title.textContent = artifact.title;
    const summary = this._artifacts.find((a) => a.id === artifact.id);
    const versions = Array.isArray(artifact.versions) ? artifact.versions : (summary && summary.versions) || [artifact.version];
    this._version.replaceChildren(...versions.slice().reverse().map((v) => {
      const opt = /** @type {HTMLOptionElement} */ (el('option', '', `v${v}`));
      opt.value = String(v);
      return opt;
    }));
    this._version.value = String(artifact.version);
    this._version.disabled = versions.length < 2;
    this._setNotice('');
    const seq = this._viewSeq;
    this._frame.render(artifact).catch((err) => {
      if (seq !== this._viewSeq || this._current !== artifact) return;
      this._setNotice(`Could not show artifact: ${(err && err.message) || String(err)}`, true);
    });
    this._renderList();
  }

  _applyUpsert(payload) {
    if (!payload || payload.sessionId !== this._sessionId || !payload.artifact) return;
    const a = payload.artifact;
    const prev = this._artifacts.find((x) => x.id === a.id);
    const versions = Array.from(new Set([...((prev && prev.versions) || []), a.version])).sort((x, y) => x - y);
    const summary = { id: a.id, type: a.type, title: a.title, language: a.language, version: a.version, versions, updatedAt: a.createdAt };
    this._artifacts = [summary, ...this._artifacts.filter((x) => x.id !== a.id)];
    this._showStatus(null);
    this._viewSeq += 1;
    this._show({ ...a, versions });
  }

  _setNotice(text, isError) {
    this._notice.textContent = text;
    this._notice.setAttribute('role', isError ? 'alert' : 'status');
    this._notice.classList.toggle('artifacts-pane__notice--error', !!isError);
  }

  _copySource() {
    if (!this._current) return Promise.resolve(false);
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : null;
    const done = (ok, text) => {
      this._copy.textContent = ok ? 'Copied' : 'Copy';
      if (!ok) this._setNotice(text, true);
      clearTimeout(this._copyTimer);
      this._copyTimer = setTimeout(() => { this._copy.textContent = 'Copy'; }, COPY_RESET_MS);
      return ok;
    };
    if (!clip || typeof clip.writeText !== 'function') return Promise.resolve(done(false, 'Copy failed: clipboard is unavailable'));
    return Promise.resolve()
      .then(() => clip.writeText(this._current.content))
      .then(() => done(true), (err) => done(false, `Copy failed: ${(err && err.message) || String(err)}`));
  }

  _saveToFile() {
    const cur = this._current;
    if (!cur || !this._sessionId) return Promise.resolve();
    return Promise.resolve()
      .then(() => this._ipc.invoke('artifact:save', { sessionId: this._sessionId, artifactId: cur.id, version: cur.version }))
      .then((res) => {
        if (res && res.ok) this._setNotice(`Saved to ${res.path}`);
        else if (!res || res.error !== 'cancelled') this._setNotice(`Save failed: ${errorText(res, 'save_failed')}`, true);
      })
      .catch((err) => this._setNotice(`Save failed: ${(err && err.message) || String(err)}`, true));
  }

  destroy() {
    this._ipc.removeListener('artifact:upserted', this._onUpserted);
    clearTimeout(this._copyTimer);
    this._frame.destroy();
    this.el.remove();
  }
}

module.exports = ArtifactsPane;

// Artifacts pane IPC: artifact:list / artifact:get / artifact:save, plus the
// artifact:upserted push whenever the store writes a version. artifact:save
// writes only to a path the user picked in a main-side save dialog; a path
// from the renderer is never accepted.
const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const { getDefaultArtifactStore, ArtifactError } = require('../agent/artifacts/artifactStore');

const EXT_BY_TYPE = { html: 'html', markdown: 'md', mermaid: 'mmd', svg: 'svg' };
const EXT_BY_LANGUAGE = {
  javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', python: 'py', py: 'py', json: 'json',
  bash: 'sh', sh: 'sh', shell: 'sh', css: 'css', html: 'html', xml: 'xml', markdown: 'md', md: 'md',
  go: 'go', rust: 'rs', java: 'java', c: 'c', cpp: 'cpp', ruby: 'rb', sql: 'sql', yaml: 'yml',
};

function extensionFor(artifact) {
  if (artifact.type === 'code') return EXT_BY_LANGUAGE[String(artifact.language || '').toLowerCase()] || 'txt';
  return EXT_BY_TYPE[artifact.type] || 'txt';
}

function defaultFileName(artifact) {
  const stem = String(artifact.title || '').replace(/[^\w .-]+/g, '').replace(/\s+/g, ' ').replace(/^[\s.]+/, '').trim().slice(0, 80) || artifact.id;
  return `${stem}.${extensionFor(artifact)}`;
}

const msg = (err) => (err instanceof ArtifactError ? err.code : (err instanceof Error && err.message) || String(err));
const handle = (ch, fn) => ipcMain.handle(ch, async (_e, arg) => {
  try { return await fn(arg && typeof arg === 'object' ? arg : {}); } catch (err) { return { ok: false, error: msg(err) }; }
});
const versionArg = (v) => (v === undefined || v === null ? undefined : v);

function register(mainWindow, services) {
  const store = (services && services.artifactStore) || getDefaultArtifactStore();

  store.on('upserted', (payload) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('artifact:upserted', payload);
  });

  handle('artifact:list', ({ sessionId }) => ({ ok: true, artifacts: store.list(sessionId) }));
  handle('artifact:get', ({ sessionId, artifactId, version }) => ({ ok: true, artifact: store.get(sessionId, artifactId, versionArg(version)) }));
  handle('artifact:save', async ({ sessionId, artifactId, version }) => {
    const artifact = store.get(sessionId, artifactId, versionArg(version));
    const ext = extensionFor(artifact);
    const r = await dialog.showSaveDialog(mainWindow, {
      title: 'Save artifact',
      defaultPath: defaultFileName(artifact),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All files', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, error: 'cancelled' };
    fs.writeFileSync(r.filePath, artifact.content, 'utf8');
    return { ok: true, path: r.filePath };
  });
}

module.exports = { register, extensionFor, defaultFileName };

// Projects IPC: drives the Projects settings tab (create/list/delete/upload)
// and the screenshot-current-page action. Each handler delegates to
// ProjectService and returns {ok, ...} / {ok:false, error} so the renderer can
// branch on a consistent shape. The LLM-reach tools (project.search /
// project.read_file) are dispatched through the agent toolRegistry, not here.

const { ipcMain } = require('electron');

function register(_mainWindow, services = {}) {
  const { projectService } = /** @type {any} */ (services);
  if (!projectService) return;

  const wrap = (fn) => async (_e, arg) => {
    try { return await fn(arg || {}); }
    catch (err) { return { ok: false, error: (err instanceof Error && err.message) || 'failed' }; }
  };

  ipcMain.handle('projects:list', wrap(() => ({ ok: true, projects: projectService.list() })));
  ipcMain.handle('projects:create', wrap((a) => projectService.create(a)));
  ipcMain.handle('projects:rename', wrap((a) => projectService.rename(a)));
  ipcMain.handle('projects:setContext', wrap((a) => projectService.setContext(a)));
  ipcMain.handle('projects:delete', wrap((a) => projectService.delete(a)));
  ipcMain.handle('projects:files', wrap((a) => projectService.files(a)));
  ipcMain.handle('projects:read', wrap(async (a) => {
    const res = await projectService.read(a.projectId, a.fileId);
    if (!res) return { ok: false, error: 'not_found' };
    return { ok: true, file: res.file, text: res.text, imagePath: res.imagePath, dataUrl: res.dataUrl };
  }));
  ipcMain.handle('projects:addFile', wrap((a) => projectService.addFile(a)));
  ipcMain.handle('projects:addImage', wrap((a) => projectService.addImage(a)));
  ipcMain.handle('projects:removeFile', wrap((a) => projectService.removeFile(a)));
  ipcMain.handle('projects:screenshotActive', wrap((a) => projectService.screenshotActive(a)));
}

module.exports = { register };

// Stages artifact preview documents for the shell's sandboxed iframes and
// serves them over ic-artifact: (main/services/artifactFrames.js). The scheme
// itself is registered pre-ready in main/index.js.
const { ipcMain, session } = require('electron');
const artifactFrames = require('../services/artifactFrames');

function register() {
  artifactFrames.install(session.defaultSession);
  ipcMain.handle('artifact-frame:stage', (_event, html) => artifactFrames.stage(html));
  ipcMain.handle('artifact-frame:release', (_event, url) => { artifactFrames.release(url); });
}

module.exports = { register };

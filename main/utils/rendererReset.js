// Calls fn when a renderer starts over: a main-frame document navigation (a
// reload) or a dead render process. did-start-loading is the wrong signal: it
// also fires for every sub-frame load, such as an artifact iframe in the shell.
function onRendererReset(webContents, fn) {
  webContents.on('did-start-navigation', (details) => {
    if (details && details.isMainFrame && !details.isSameDocument) fn();
  });
  webContents.on('render-process-gone', () => fn());
}

module.exports = { onRendererReset };

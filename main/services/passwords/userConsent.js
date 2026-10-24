// userConsent — main's own check before a saved password is shown or copied.
// Main asks the user itself (Touch ID, else a native dialog on the app
// window), so a renderer that skips its own UI still cannot read a password
// without the user's say-so.

/** @returns {'touchid'|'dialog'} */
function authMode(platform) {
  if (platform !== 'darwin') return 'dialog';
  return require('electron').systemPreferences.canPromptTouchID() ? 'touchid' : 'dialog';
}

/**
 * Resolves once the user approved; rejects on a failed Touch ID, a cancelled
 * dialog, or no window to ask in.
 * @param {{ platform: string, mainWindow: any, verb: 'reveal'|'copy', entry: { origin: string, username: string } }} req
 */
async function confirmAccess({ platform, mainWindow, verb, entry }) {
  const { systemPreferences, dialog } = require('electron');
  if (authMode(platform) === 'touchid') {
    await systemPreferences.promptTouchID(`${verb} a saved password`);
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('The app window is not available to confirm this.');
  const action = verb === 'reveal' ? 'Show' : 'Copy';
  const who = `${entry.username || '(no username)'} on ${new URL(entry.origin).host}`;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Cancel', `${action} password`],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: `${action} the saved password for ${who}?`,
  });
  if (response !== 1) throw new Error('Cancelled.');
}

module.exports = { authMode, confirmAccess };

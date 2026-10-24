// privateTabs — ends private browsing when its last tab closes. Main keeps the
// in-memory partition for the life of the app (a tray app rarely quits), so
// its cookies, storage and caches are wiped here and the reopen stack forgets
// every private page. A new private tab loads only once main reports that
// wipe finished, so it never sees the previous session's data.

const { ipcRenderer } = require('electron');
const { errMsg } = require('../../shared/errMsg');

/**
 * @param {Array<{ private?: boolean }>} closedTabs the reopen stack, pruned in place
 * @returns {Promise<boolean>} true once main has wiped the private session
 */
function endPrivateSession(closedTabs) {
  for (let i = closedTabs.length - 1; i >= 0; i -= 1) {
    if (closedTabs[i].private) closedTabs.splice(i, 1);
  }
  return ipcRenderer.invoke('session:clear-private').then((res) => {
    if (!res || !res.ok) throw new Error((res && res.error) || 'no reply from the main process');
    return true;
  }).catch((err) => {
    console.error('[privateTabs] the private session could not be cleared:', errMsg(err));
    require('../components/Toast').error(
      'Cookies and site data from the closed private tabs could not be cleared. Quit the app to discard them.',
      { title: 'Private session not cleared' },
    );
    return false;
  });
}

/**
 * Point a newly mounted private webview at its page once main confirms no
 * wipe of earlier private tabs is running or owed. Until then it stays blank.
 * @param {{ src: string, isConnected: boolean }} webview
 * @param {string} url
 * @returns {Promise<boolean>} true once the page was set
 */
function loadPrivateWebview(webview, url) {
  return ipcRenderer.invoke('session:private-ready').then((res) => {
    if (!res || !res.ok) throw new Error((res && res.error) || 'no reply from the main process');
    if (!webview.isConnected) return false;
    webview.src = url;
    return true;
  }).catch((err) => {
    console.error('[privateTabs] a private tab was held back because earlier private data is still present:', errMsg(err));
    require('../components/Toast').error(
      'Cookies and site data from earlier private tabs could not be cleared, so this private tab was not loaded. Quit the app to discard them.',
      { title: 'Private tab not loaded' },
    );
    return false;
  });
}

module.exports = { endPrivateSession, loadPrivateWebview };

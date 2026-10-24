// historyRecorder — records a user pane's visits in browsing history.
//
// Hooks main-frame navigations: full loads (did-navigate) and SPA pushState
// routes (did-navigate-in-page), which never fire dom-ready. Each URL commits
// once, after a short settle delay, because SPA titles usually change after the
// URL does. A later title change for the committed URL is re-sent; the main
// side collapses a repeat of the newest entry into a title update. A private
// pane (SessionService's in-memory partition) is never recorded.

const COMMIT_DELAY_MS = 1500;
const PRIVATE_PARTITION = 'private';

/**
 * @param {any} webview Electron <webview> element
 * @param {{ invoke: (channel: string, payload: any) => Promise<any>, onCommit?: (url: string) => void, delayMs?: number }} opts
 */
function attachHistoryRecorder(webview, { invoke, onCommit, delayMs = COMMIT_DELAY_MS }) {
  let pendingUrl = null;
  let timer = null;
  let committedUrl = null;
  let committedTitle = '';

  const send = (url, title) => {
    invoke('history:add', { url, title, spaceId: webview.id || null })
      .catch((err) => { console.error('[historyRecorder] history:add failed:', err instanceof Error ? err.message : String(err)); });
  };

  const commit = () => {
    timer = null;
    const url = pendingUrl;
    pendingUrl = null;
    // A pane closed during the settle delay has no title to read; drop the visit.
    if (!url || url === committedUrl || !webview.isConnected) return;
    if (webview.getAttribute('partition') === PRIVATE_PARTITION) return;
    committedUrl = url;
    committedTitle = webview.getTitle() || '';
    send(url, committedTitle);
    if (onCommit) onCommit(url);
  };

  const schedule = (url) => {
    if (typeof url !== 'string' || !/^https?:/i.test(url)) return;
    pendingUrl = url;
    if (timer) clearTimeout(timer);
    timer = setTimeout(commit, delayMs);
  };

  webview.addEventListener('did-navigate', (e) => schedule(e.url));
  webview.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) schedule(e.url); });
  webview.addEventListener('page-title-updated', (e) => {
    if (pendingUrl || !committedUrl || !e.title || e.title === committedTitle) return;
    if (webview.getURL() !== committedUrl) return;
    committedTitle = e.title;
    send(committedUrl, committedTitle);
  });
}

module.exports = { attachHistoryRecorder, COMMIT_DELAY_MS, PRIVATE_PARTITION };

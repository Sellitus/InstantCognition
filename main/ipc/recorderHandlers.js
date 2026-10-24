// Record & Replay IPC: record user actions in a webview, keep the traces under
// {userData}/recordings, and draft a SKILL.md from one. The renderer names a
// webview by webContentsId or spaceId only; ids are validated before any
// lookup or path is built. Live progress is pushed as recorder:event.
const { ipcMain } = require('electron');
const { Recorder } = require('../agent/recorder/recorder');
const { getDefaultTraceStore, isTraceId } = require('../agent/recorder/traceStore');
const { traceToSkill } = require('../agent/recorder/traceToSkill');
const tabRegistry = require('../services/tabRegistry');

const SPACE_ID_RX = /^[\w:.-]{1,128}$/;
const MAX_HINT = 500;

const msg = (err) => (err instanceof Error && err.message) || String(err);
const bad = (error) => ({ ok: false, error });

function handle(ch, fn) {
  ipcMain.handle(ch, async (_e, arg) => {
    try { return await fn(arg && typeof arg === 'object' && !Array.isArray(arg) ? arg : {}); }
    catch (err) { return { ok: false, error: msg(err) }; }
  });
}

function defaultFromId(id) { return require('electron').webContents.fromId(id); }

/**
 * @param {Electron.BrowserWindow} mainWindow
 * @param {object} [services] optional overrides: recorder, traceStore, llmClient, webContentsFromId
 */
function register(mainWindow, services = {}) {
  const s = /** @type {any} */ (services);
  const push = (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('recorder:event', payload);
  };
  const recorder = s.recorder || new Recorder({ onEvent: push });
  const store = () => s.traceStore || getDefaultTraceStore();
  const fromId = s.webContentsFromId || defaultFromId;
  const llm = () => s.llmClient || require('../services/LLMClientService');

  function resolveWebContents({ webContentsId, spaceId }) {
    let id = webContentsId;
    if (id === undefined && spaceId !== undefined) {
      if (typeof spaceId !== 'string' || !SPACE_ID_RX.test(spaceId)) throw new Error('invalid_space');
      const entry = tabRegistry.get(spaceId);
      if (!entry) throw new Error('unknown_space');
      id = entry.webContentsId;
    }
    if (!Number.isInteger(id) || id <= 0) throw new Error('invalid_webcontents');
    const wc = fromId(id);
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) throw new Error('webcontents_unavailable');
    return wc;
  }

  handle('recorder:start', async (arg) => {
    const started = await recorder.start(resolveWebContents(arg));
    return { ok: true, ...started };
  });
  handle('recorder:stop', async ({ id }) => {
    if (!isTraceId(id)) return bad('invalid_id');
    const { trace, warnings } = await recorder.stop(id);
    const recording = store().save(trace);
    return { ok: true, recording, trace, warnings };
  });
  handle('recorder:list', () => ({ ok: true, ...store().list() }));
  handle('recorder:delete', ({ id }) => {
    if (!isTraceId(id)) return bad('invalid_id');
    store().delete(id);
    return { ok: true };
  });
  handle('recorder:to-skill', ({ id, hint }) => {
    if (!isTraceId(id)) return bad('invalid_id');
    if (hint !== undefined && (typeof hint !== 'string' || hint.length > MAX_HINT)) return bad('invalid_hint');
    return traceToSkill(llm(), store().get(id), { hint });
  });
}

module.exports = { register };

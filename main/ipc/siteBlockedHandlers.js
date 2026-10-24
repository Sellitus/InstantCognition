// IPC for the "site blocked" popup. The renderer asks main to add a host to
// the allowlist when the user clicks "Add to allowlist", to retry a failed
// load via the originating webContents id, or to load a page over HTTP after
// an HTTPS-only upgrade failed.
const { ipcMain, webContents: webContentsMod } = require('electron');
const browsingPrivacy = require('../services/BrowsingPrivacyService');

function normalizeHostname(input) {
  if (!input || typeof input !== 'string') return null;
  let trimmed = input.trim();
  if (!trimmed) return null;
  // Accept either a bare hostname or a URL.
  try {
    if (/^[a-z]+:\/\//i.test(trimmed)) {
      const u = new URL(trimmed);
      trimmed = u.hostname || '';
    }
  } catch (_) { /* fall through to direct use */ }
  trimmed = trimmed.replace(/^\[|\]$/g, '').toLowerCase();
  if (!trimmed) return null;
  // Strip a leading wildcard so users who paste "*.example.com" still work.
  trimmed = trimmed.replace(/^\*\./, '');
  // Basic shape check — reject anything with spaces or invalid URL chars.
  if (/\s/.test(trimmed)) return null;
  return trimmed;
}

function register(_mainWindow, services) {
  const { configService, adblockerService } = services || {};
  if (!configService) return;

  // Saves the list, then pushes it into the running engine; if the engine
  // rejects it the saved list is restored, so settings never show a host the
  // ad blocker is still blocking.
  const commit = async (previous, next) => {
    configService.set('settings.siteAllowlist', next);
    if (!adblockerService || typeof adblockerService.applyAllowlist !== 'function') return null;
    try { await adblockerService.applyAllowlist(next); return null; }
    catch (err) {
      configService.set('settings.siteAllowlist', previous);
      console.error('[site-allowlist] the ad blocker rejected the change:', err);
      return `The ad blocker could not apply the change: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  ipcMain.handle('site-allowlist:add', async (_e, host) => {
    const normalized = normalizeHostname(host);
    if (!normalized) return { ok: false, error: 'Invalid hostname' };
    const current = configService.get('settings.siteAllowlist', []);
    const list = Array.isArray(current) ? current.slice() : [];
    if (list.includes(normalized)) return { ok: true, hostname: normalized, list };
    const error = await commit(list, [...list, normalized]);
    return error ? { ok: false, error } : { ok: true, hostname: normalized, list: [...list, normalized] };
  });

  ipcMain.handle('site-allowlist:remove', async (_e, host) => {
    const normalized = normalizeHostname(host);
    if (!normalized) return { ok: false, error: 'Invalid hostname' };
    const current = configService.get('settings.siteAllowlist', []);
    const list = Array.isArray(current) ? current.slice() : [];
    const filtered = list.filter((h) => h !== normalized);
    const error = await commit(list, filtered);
    return error ? { ok: false, error } : { ok: true, list: filtered };
  });

  ipcMain.on('site-blocked:retry', (_e, payload = {}) => {
    const id = Number(payload && payload.webContentsId);
    if (!Number.isInteger(id)) return;
    try {
      const wc = webContentsMod.fromId(id);
      if (wc && !wc.isDestroyed()) wc.reload();
    } catch (_) { /* ignore */ }
  });

  // HTTPS-only fallback: loads the HTTP URL main recorded for this webview, never a renderer-supplied one.
  ipcMain.on('site-blocked:continue-http', (_e, payload = {}) => {
    const wc = webContentsMod.fromId(Number(payload && payload.webContentsId));
    if (!wc || wc.isDestroyed()) return;
    if (!browsingPrivacy.continueOverHttp(wc)) console.error('[site-blocked] no HTTPS upgrade is pending for this view; HTTP fallback ignored');
  });
}

module.exports = { register, normalizeHostname };

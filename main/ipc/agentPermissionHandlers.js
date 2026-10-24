// Permission mode + rules, workspace roots and the global instructions file.
// workspace:add-root only ever takes a folder the user picked in a main-side
// dialog; a path from the renderer is never accepted.
const { ipcMain, dialog, app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { readAgentSettings, PERMISSION_MODES } = require('../agent/workspace/agentSettings');
const { normalizeInstructions, globalInstructionsPath, readInstructionsFile } = require('../agent/workspace/instructions');

const CI = process.platform === 'darwin' || process.platform === 'win32';
const key = (p) => (CI ? p.toLowerCase() : p);
const within = (dir, p) => key(p).startsWith(key(dir.endsWith(path.sep) ? dir : dir + path.sep));
const msg = (err) => (err instanceof Error && err.message) || String(err);
const handle = (ch, fn) => ipcMain.handle(ch, async (_e, arg) => {
  try { return await fn(arg && typeof arg === 'object' ? arg : {}); } catch (err) { return { ok: false, error: msg(err) }; }
});

// A root must not be a filesystem/drive root, the home folder or one of its
// ancestors, or overlap the app's own data (config.json holds these rules).
function rootRejection(real, userData) {
  if (path.parse(real).root === real) return 'root_is_filesystem_root';
  const home = fs.realpathSync.native(os.homedir());
  if (key(real) === key(home) || within(real, home)) return 'root_contains_home';
  if (key(real) === key(userData) || within(real, userData) || within(userData, real)) return 'root_overlaps_app_data';
  return null;
}

// A globalFile symlinked into a dotfiles repo stays a link: the write lands on its target.
function writeTarget(file) {
  let real;
  try { real = fs.realpathSync.native(file); } catch (err) { if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return file; throw err; }
  if (!fs.statSync(real).isFile()) throw new Error('not_a_regular_file');
  return real;
}

function register(mainWindow, services) {
  const { configService } = services || {};
  if (!configService) return;
  const approval = (services && services.approvalService) || require('../services/AgentApprovalService');
  const settings = () => readAgentSettings(configService);
  const setRoots = (roots) => configService.set('settings.llm.agent.workspace.roots', roots);

  handle('permissions:get', ({ sessionId }) => ({ ok: true, ...approval.getPermissions(typeof sessionId === 'string' ? sessionId : '') }));
  handle('permissions:set-mode', ({ mode, sessionId }) => {
    if (!PERMISSION_MODES.includes(mode)) return { ok: false, error: 'invalid_mode' };
    if (sessionId !== undefined) approval.setSessionMode(sessionId, mode);
    else approval.setMode(mode);
    return { ok: true, mode };
  });
  handle('permissions:add-rule', ({ list, rule }) => ({ ok: true, rule: approval.addRule(list, rule) }));
  handle('permissions:remove-rule', ({ list, rule }) => ({ ok: true, removed: approval.removeRule(list, rule) }));

  handle('workspace:list-roots', () => ({ ok: true, roots: settings().workspace.roots }));
  handle('workspace:add-root', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { title: 'Add workspace folder', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
    const real = fs.realpathSync.native(r.filePaths[0]);
    if (!fs.statSync(real).isDirectory()) return { ok: false, error: 'not_a_directory' };
    const rejected = rootRejection(real, fs.realpathSync.native(app.getPath('userData')));
    if (rejected) return { ok: false, error: rejected, path: real };
    const roots = settings().workspace.roots;
    if (!roots.some((x) => key(x) === key(real))) setRoots([...roots, real]);
    return { ok: true, path: real, roots: settings().workspace.roots };
  });
  handle('workspace:remove-root', ({ index, path: p }) => {
    const roots = settings().workspace.roots;
    const i = Number.isInteger(index) ? index : roots.indexOf(typeof p === 'string' ? p : '');
    if (i < 0 || i >= roots.length) return { ok: false, error: 'unknown_root' };
    const next = roots.filter((_, j) => j !== i);
    setRoots(next);
    return { ok: true, roots: next };
  });

  const instructions = () => {
    const cfg = normalizeInstructions(configService.get('settings.llm.agent', {}));
    return { cfg, file: globalInstructionsPath(cfg.globalFile, app.getPath('userData')) };
  };
  handle('instructions:get-global', () => {
    const { cfg, file } = instructions();
    const meta = { path: file, maxBytes: cfg.maxBytes, enabled: cfg.enabled };
    const r = readInstructionsFile(file, cfg.maxBytes);
    if (r && 'skipped' in r) return { ok: false, error: r.skipped, ...meta };
    return { ok: true, content: r ? r.text : '', truncated: !!(r && r.truncated), ...meta };
  });
  handle('instructions:set-global', ({ content }) => {
    if (typeof content !== 'string') return { ok: false, error: 'content_must_be_string' };
    const { cfg: { maxBytes }, file: configured } = instructions();
    if (Buffer.byteLength(content, 'utf8') > maxBytes) return { ok: false, error: 'too_large', maxBytes };
    const file = writeTarget(configured);
    const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
    try { fs.renameSync(tmp, file); } catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
    return { ok: true, path: file, bytes: Buffer.byteLength(content, 'utf8') };
  });
}

module.exports = { register, rootRejection };

// Skills IPC: the skills settings page, the composer's slash palette and
// "Create skill from this chat". Every payload is shape-checked here; the
// service re-validates names and content before touching disk.
const { ipcMain } = require('electron');
const { SESSION_ID_RE } = require('../agent/sessions/sessionStore');

const NAME_RE = /^[a-z0-9-]{1,64}$/;
const MAX_URL = 2048;
const MAX_TASK = 20000;
const MAX_DRAFT_MESSAGES = 500;
const SOURCES = ['claude', 'codex'];

// Built-in composer commands. summarize…research mirror SLASH_ACTIONS in
// renderer/utils/chatContext.js (a test keeps the two in step).
const BUILTIN_COMMANDS = Object.freeze([
  { name: 'summarize', description: 'Summarize the current page or selection' },
  { name: 'explain', description: 'Explain the current page or selection' },
  { name: 'compare', description: 'Compare the visible panes' },
  { name: 'council', description: 'Ask several models and synthesize one answer' },
  { name: 'research', description: 'Research a question across sources and write a cited report' },
  { name: 'compact', description: 'Summarize earlier turns to free up context' },
]);

const msg = (err) => (err instanceof Error && err.message) || String(err);
const bad = (error) => ({ ok: false, error });
const isName = (n) => typeof n === 'string' && NAME_RE.test(n);

function handle(ch, fn) {
  ipcMain.handle(ch, async (_e, arg) => {
    try { return await fn(arg && typeof arg === 'object' && !Array.isArray(arg) ? arg : {}); }
    catch (err) { return { ok: false, error: msg(err) }; }
  });
}

function register(_mainWindow, services = {}) {
  const { skillsService } = /** @type {any} */ (services);
  if (!skillsService) return;

  handle('skills:list', () => skillsService.list());
  handle('skills:get', ({ name }) => (isName(name) ? skillsService.get(name) : bad('invalid_name')));
  handle('skills:save', ({ skill, overwrite }) => {
    if (!skill || typeof skill !== 'object' || Array.isArray(skill)) return bad('invalid_skill');
    return skillsService.save(skill, { overwrite: overwrite === true });
  });
  handle('skills:delete', ({ name }) => (isName(name) ? skillsService.delete(name) : bad('invalid_name')));
  handle('skills:set-enabled', ({ name, enabled }) => {
    if (!isName(name)) return bad('invalid_name');
    if (typeof enabled !== 'boolean') return bad('invalid_enabled');
    return skillsService.setEnabled(name, enabled);
  });
  handle('skills:import', ({ source, overwrite }) => (
    SOURCES.includes(source) ? skillsService.importFrom(source, { overwrite: overwrite === true }) : bad('invalid_source')
  ));
  handle('skills:install-url', ({ url, overwrite }) => {
    if (typeof url !== 'string' || !url.trim() || url.length > MAX_URL) return bad('invalid_url');
    return skillsService.installFromUrl(url.trim(), { overwrite: overwrite === true });
  });
  handle('skills:draft-from-session', ({ messages, hint }) => {
    if (!Array.isArray(messages) || !messages.length || messages.length > MAX_DRAFT_MESSAGES) return bad('invalid_transcript');
    return skillsService.draftFromTranscript(messages, { hint: typeof hint === 'string' ? hint : undefined });
  });
  // sessionId (optional) makes the run a turn in that session; a present but malformed one is refused.
  handle('skills:run', ({ name, task, webContentsId, sessionId }) => {
    if (!isName(name)) return bad('invalid_name');
    if (task !== undefined && (typeof task !== 'string' || task.length > MAX_TASK)) return bad('invalid_task');
    if (!Number.isInteger(webContentsId)) return bad('invalid_webcontents');
    if (sessionId != null && (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId))) return bad('invalid_session_id');
    return skillsService.run({ name, task, webContentsId, ...(sessionId != null ? { sessionId } : {}) });
  });
  handle('commands:list', () => {
    const listed = skillsService.list();
    const skills = listed.ok ? listed.skills.filter((s) => s.enabled) : [];
    return {
      ok: true,
      commands: [
        ...BUILTIN_COMMANDS.map((c) => ({ ...c, kind: 'builtin' })),
        ...skills.map((s) => ({ name: s.name, description: s.description, kind: 'skill' })),
      ],
    };
  });
}

module.exports = { register, BUILTIN_COMMANDS };

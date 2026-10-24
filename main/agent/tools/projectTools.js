// projectTools.js — agent tools for Projects. Two on-demand reach paths over
// the user's file/image collections:
//   - project.search: relevance search (lexical + stored summary) across a
//     project's files. Use when the user references an uploaded file by topic.
//   - project.read_file: read a specific file's full text by id (returned by
//     search or by project.list, which is not exposed — ids come from search).
// Distinct from browser.ask_browsing (history/bookmarks, not uploads). The
// always-in-context path (buildPromptBlock) injects file bodies into the
// system prompt automatically; these tools are for the files NOT pre-loaded.
// Read-only: no tab, no side effect.

const projectService = require('../../services/ProjectService');

const MAX_LIMIT = 25;

function activeProjectId() {
  try { return projectService._cs ? projectService._cs.get('settings.projects.lastActiveId', null) : null; }
  catch (_) { return null; }
}

const projectSearch = {
  name: 'project.search',
  description: 'Search the user\'s uploaded project files by meaning or keywords, ranked by relevance. Use when the user references a file they uploaded ("check the notes I added", "what did my spec say about X"). Returns ranked {fileId,name,isImage,score}. Then call project.read_file on the best fileId to see the contents.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for (natural language or keywords).' },
      projectId: { type: 'string', description: 'Project to search. Omit to search the user\'s currently active project.' },
      limit: { type: 'number', description: 'Max results (default 8, max 25).' },
    },
    required: ['query'],
  },
  handler: async (args) => {
    const query = String((args && args.query) || '').trim();
    if (!query) return { ok: false, error: 'empty_query' };
    const pid = String((args && args.projectId) || '').trim() || activeProjectId();
    if (!pid) return { ok: false, error: 'no_active_project' };
    const limit = Math.max(1, Math.min(MAX_LIMIT, Number((args && args.limit) || 8)));
    try {
      const results = projectService.search(pid, query, { limit });
      if (!results.length) return { ok: true, results: [], note: 'No matching files. The project may be empty or the query did not match any file name or contents.' };
      return { ok: true, projectId: pid, results };
    } catch (err) {
      return { ok: false, error: (err instanceof Error && err.message) || 'project_search_failed' };
    }
  },
};

const projectReadFile = {
  name: 'project.read_file',
  description: 'Read the full text contents of a specific uploaded project file by its fileId (the id returned by project.search). Returns {file,text}. Image files return {file,isImage:true} with no text — describe them only if vision is enabled.',
  parameters: {
    type: 'object',
    properties: {
      fileId: { type: 'string', description: 'The file id from project.search results.' },
      projectId: { type: 'string', description: 'Project the file belongs to. Omit to use the active project.' },
    },
    required: ['fileId'],
  },
  handler: async (args) => {
    const fileId = String((args && args.fileId) || '').trim();
    if (!fileId) return { ok: false, error: 'empty_file_id' };
    const pid = String((args && args.projectId) || '').trim() || activeProjectId();
    if (!pid) return { ok: false, error: 'no_active_project' };
    try {
      const res = await projectService.read(pid, fileId);
      if (!res) return { ok: false, error: 'file_not_found' };
      return { ok: true, file: { id: res.file.id, name: res.file.name, isImage: !!res.file.isImage }, text: res.text || null };
    } catch (err) {
      return { ok: false, error: (err instanceof Error && err.message) || 'project_read_failed' };
    }
  },
};

module.exports = [projectSearch, projectReadFile];

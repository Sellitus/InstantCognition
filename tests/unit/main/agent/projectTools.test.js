// projectTools — the agent's on-demand reach into Projects. Handlers are
// exercised directly with a stubbed ProjectService (the external boundary);
// the tool logic itself (arg validation, active-project resolution, result
// shaping) is what's under test.

const tools = require('../../../../main/agent/tools/projectTools');
const projectService = require('../../../../main/services/ProjectService');

const search = tools.find((t) => t.name === 'project.search');
const readFile = tools.find((t) => t.name === 'project.read_file');

function stubService(over) {
  const base = {
    search: jest.fn(() => []),
    read: jest.fn(async () => null),
    _cs: { get: jest.fn(() => null) },
  };
  return Object.assign(base, over);
}

describe('projectTools shape', () => {
  test('exposes project.search and project.read_file', () => {
    expect(tools.map((t) => t.name).sort()).toEqual(['project.read_file', 'project.search']);
    tools.forEach((t) => {
      expect(typeof t.handler).toBe('function');
      expect(t.parameters.type).toBe('object');
      expect(t.parameters.required).toContain('query' in t.parameters.properties ? 'query' : 'fileId');
    });
  });
});

describe('project.search handler', () => {
  test('rejects an empty query', async () => {
    const r = await search.handler({ query: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('empty_query');
  });

  test('rejects when no active project and none given', async () => {
    const orig = projectService._cs;
    projectService._cs = { get: () => null };
    const r = await search.handler({ query: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_active_project');
    projectService._cs = orig;
  });

  test('returns ranked results from the active project', async () => {
    const orig = projectService._cs;
    projectService._cs = { get: () => 'proj_1' };
    const origSearch = projectService.search;
    projectService.search = jest.fn(() => [{ fileId: 'f1', name: 'spec.md', isImage: false, score: 3 }]);
    const r = await search.handler({ query: 'widget' });
    expect(r.ok).toBe(true);
    expect(r.projectId).toBe('proj_1');
    expect(r.results[0]).toMatchObject({ name: 'spec.md', score: 3 });
    expect(projectService.search).toHaveBeenCalledWith('proj_1', 'widget', { limit: 8 });
    projectService.search = origSearch;
    projectService._cs = orig;
  });

  test('clamps limit to the max', async () => {
    const orig = projectService._cs;
    projectService._cs = { get: () => 'proj_1' };
    const origSearch = projectService.search;
    projectService.search = jest.fn(() => []);
    await search.handler({ query: 'x', limit: 999 });
    expect(projectService.search.mock.calls[0][2].limit).toBe(25);
    projectService.search = origSearch;
    projectService._cs = orig;
  });

  test('returns a note when no files match', async () => {
    const orig = projectService._cs;
    projectService._cs = { get: () => 'proj_1' };
    const origSearch = projectService.search;
    projectService.search = jest.fn(() => []);
    const r = await search.handler({ query: 'widget' });
    expect(r.ok).toBe(true);
    expect(r.results).toEqual([]);
    expect(typeof r.note).toBe('string');
    projectService.search = origSearch;
    projectService._cs = orig;
  });
});

describe('project.read_file handler', () => {
  test('rejects an empty fileId', async () => {
    const r = await readFile.handler({ fileId: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('empty_file_id');
  });

  test('returns file_not_found when read yields null', async () => {
    const orig = projectService._cs;
    const origRead = projectService.read;
    projectService._cs = { get: () => 'proj_1' };
    projectService.read = jest.fn(async () => null);
    const r = await readFile.handler({ fileId: 'f1' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('file_not_found');
    projectService.read = origRead;
    projectService._cs = orig;
  });

  test('returns text for a text file', async () => {
    const orig = projectService._cs;
    const origRead = projectService.read;
    projectService._cs = { get: () => 'proj_1' };
    projectService.read = jest.fn(async () => ({ file: { id: 'f1', name: 'a.txt', isImage: false }, text: 'hello' }));
    const r = await readFile.handler({ fileId: 'f1' });
    expect(r.ok).toBe(true);
    expect(r.file.name).toBe('a.txt');
    expect(r.text).toBe('hello');
    projectService.read = origRead;
    projectService._cs = orig;
  });

  test('returns null text for an image file', async () => {
    const orig = projectService._cs;
    const origRead = projectService.read;
    projectService._cs = { get: () => 'proj_1' };
    projectService.read = jest.fn(async () => ({ file: { id: 'f1', name: 'i.png', isImage: true }, imagePath: '/x/i.png' }));
    const r = await readFile.handler({ fileId: 'f1' });
    expect(r.ok).toBe(true);
    expect(r.file.isImage).toBe(true);
    expect(r.text).toBeNull();
    projectService.read = origRead;
    projectService._cs = orig;
  });
});

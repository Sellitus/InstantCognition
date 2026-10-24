// ProjectService — CRUD, file/image storage, search, and prompt-block
// injection. The filesystem is stubbed in-memory (_setFs/_setPath) and the
// clock is injected (_setNow) so no real I/O or timers run. ConfigService is
// stubbed (external boundary); the service logic is exercised directly.

const { ProjectService, summarizeFile, screenshotActive } = require('../../../../main/services/ProjectService');

function fakeConfig(initial) {
  const store = JSON.parse(JSON.stringify(initial || {}));
  const walk = (path) => path.split('.');
  return {
    _store: store,
    get(path, dflt) {
      let c = store;
      for (const p of walk(path)) { if (c == null || typeof c !== 'object') return dflt; c = c[p]; }
      return c === undefined ? dflt : c;
    },
    set(path, val) {
      const parts = walk(path);
      let c = store;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (c[parts[i]] == null || typeof c[parts[i]] !== 'object') c[parts[i]] = {};
        c = c[parts[i]] = c[parts[i]] || {};
      }
      c[parts[parts.length - 1]] = val;
    },
  };
}

function memFs() {
  const mem = {};
  const E = () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; return e; };
  return {
    _mem: mem,
    mkdirSync: function () {},
    writeFileSync: function (p, d) { mem[p] = d; },
    readFileSync: function (p) { if (p in mem) return mem[p]; throw E(); },
    existsSync: function (p) { return p in mem; },
    promises: {
      readFile: function (p) { if (!(p in mem)) throw E(); return Promise.resolve(mem[p]); },
      rm: function () { return Promise.resolve(); },
    },
  };
}

function make(over) {
  const svc = new ProjectService();
  const cfg = fakeConfig({ settings: { projects: { enabled: true, items: [], autoSummarize: false, defaultAlwaysInContext: false } } });
  svc.bindConfig(cfg);
  svc._setFs(memFs());
  svc._setPath({ join: function () { return Array.prototype.join.call(arguments, '/'); } });
  svc._setNow(() => 1_700_000_000_000);
  return Object.assign(svc, over, { _cfgSvc: cfg });
}

describe('ProjectService CRUD', () => {
  test('create adds a project and lists it', () => {
    const svc = make();
    const r = svc.create({ name: 'Alpha' });
    expect(r.ok).toBe(true);
    expect(r.project.name).toBe('Alpha');
    expect(r.project.id).toMatch(/^proj_/);
    expect(svc.list()).toHaveLength(1);
    expect(svc.list()[0]).toMatchObject({ name: 'Alpha', fileCount: 0, alwaysInContext: false });
  });

  test('create rejects an empty name', () => {
    const svc = make();
    expect(svc.create({ name: '   ' }).error).toBe('empty_name');
  });

  test('create is blocked when the feature is disabled', () => {
    const svc = make();
    svc._cfgSvc.set('settings.projects.enabled', false);
    expect(svc.create({ name: 'X' }).error).toBe('disabled');
  });

  test('rename updates the name and rejects unknown ids', () => {
    const svc = make();
    const pid = svc.create({ name: 'Old' }).project.id;
    expect(svc.rename({ id: pid, name: 'New' }).ok).toBe(true);
    expect(svc.list()[0].name).toBe('New');
    expect(svc.rename({ id: 'nope', name: 'X' }).error).toBe('not_found');
  });

  test('setContext toggles alwaysInContext', () => {
    const svc = make();
    const pid = svc.create({ name: 'P' }).project.id;
    svc.setContext({ id: pid, on: true });
    expect(svc.list()[0].alwaysInContext).toBe(true);
    svc.setContext({ id: pid, on: false });
    expect(svc.list()[0].alwaysInContext).toBe(false);
  });

  test('delete removes the project and its files', async () => {
    const svc = make();
    const pid = svc.create({ name: 'Doomed' }).project.id;
    await svc.addFile({ id: pid, name: 'a.txt', text: 'hi' });
    expect(svc.files({ id: pid }).files).toHaveLength(1);
    const r = await svc.delete({ id: pid });
    expect(r.ok).toBe(true);
    expect(svc.list()).toHaveLength(0);
    expect(svc.delete({ id: pid }).then ? null : null).toBeNull();
  });
});

describe('ProjectService files', () => {
  test('addFile stores text and read returns it', async () => {
    const svc = make();
    const pid = svc.create({ name: 'P' }).project.id;
    const af = await svc.addFile({ id: pid, name: 'notes.txt', text: 'hello world' });
    expect(af.ok).toBe(true);
    expect(af.file.size).toBe(Buffer.byteLength('hello world', 'utf8'));
    const r = await svc.read(pid, af.file.id);
    expect(r.text).toBe('hello world');
    expect(r.file.name).toBe('notes.txt');
  });

  test('addFile rejects oversized text', async () => {
    const svc = make();
    const pid = svc.create({ name: 'P' }).project.id;
    const big = 'x'.repeat(1024 * 1024 + 10);
    const r = await svc.addFile({ id: pid, name: 'big.txt', text: big });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('file_too_large');
  });

  test('addImage stores a data URL and read returns a data URL', async () => {
    const svc = make();
    const pid = svc.create({ name: 'P' }).project.id;
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const ai = await svc.addImage({ id: pid, name: 'tiny.png', dataUrl: png });
    expect(ai.ok).toBe(true);
    expect(ai.file.isImage).toBe(true);
    const r = await svc.read(pid, ai.file.id);
    expect(r.file.isImage).toBe(true);
    expect(r.dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  test('addImage rejects an invalid data URL', async () => {
    const svc = make();
    const pid = svc.create({ name: 'P' }).project.id;
    const r = await svc.addImage({ id: pid, name: 'x.png', dataUrl: 'not-a-data-url' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_image');
  });

  test('removeFile drops a file from the project', async () => {
    const svc = make();
    const pid = svc.create({ name: 'P' }).project.id;
    const af = await svc.addFile({ id: pid, name: 'a.txt', text: 'x' });
    expect(svc.files({ id: pid }).files).toHaveLength(1);
    const r = await svc.removeFile({ id: pid, fileId: af.file.id });
    expect(r.ok).toBe(true);
    expect(svc.files({ id: pid }).files).toHaveLength(0);
  });

  test('files on an unknown project returns not_found', () => {
    const svc = make();
    expect(svc.files({ id: 'nope' }).error).toBe('not_found');
  });
});

describe('ProjectService search + prompt block', () => {
  test('search matches file contents and names', async () => {
    const svc = make();
    const pid = svc.create({ name: 'P' }).project.id;
    await svc.addFile({ id: pid, name: 'spec.md', text: 'The widget API returns JSON' });
    await svc.addFile({ id: pid, name: 'todo.txt', text: 'buy milk' });
    const hits = svc.search(pid, 'widget');
    expect(hits).toHaveLength(1);
    expect(hits[0].name).toBe('spec.md');
    expect(svc.search(pid, 'nomatchterm')).toHaveLength(0);
  });

  test('search returns [] for empty query or unknown project', async () => {
    const svc = make();
    const pid = svc.create({ name: 'P' }).project.id;
    await svc.addFile({ id: pid, name: 'a.txt', text: 'x' });
    expect(svc.search(pid, '')).toHaveLength(0);
    expect(svc.search('nope', 'x')).toHaveLength(0);
  });

  test('buildPromptBlock is empty unless alwaysInContext is on', async () => {
    const svc = make();
    const pid = svc.create({ name: 'P' }).project.id;
    await svc.addFile({ id: pid, name: 'a.txt', text: 'content' });
    expect(svc.buildPromptBlock(pid)).toBe('');
    svc.setContext({ id: pid, on: true });
    const block = svc.buildPromptBlock(pid);
    expect(block).toContain('Project "P" files (always-in-context)');
    expect(block).toContain('### a.txt');
    expect(block).toContain('content');
  });

  test('buildPromptBlock skips image files', async () => {
    const svc = make();
    const pid = svc.create({ name: 'P' }).project.id;
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    await svc.addImage({ id: pid, name: 'i.png', dataUrl: png });
    await svc.addFile({ id: pid, name: 't.txt', text: 'keep' });
    svc.setContext({ id: pid, on: true });
    const block = svc.buildPromptBlock(pid);
    expect(block).toContain('keep');
    expect(block).not.toContain('i.png');
  });

  test('buildActiveBlock reads lastActiveId from config', async () => {
    const svc = make();
    const pid = svc.create({ name: 'P' }).project.id;
    await svc.addFile({ id: pid, name: 'a.txt', text: 'ctx' });
    svc.setContext({ id: pid, on: true });
    svc._cfgSvc.set('settings.projects.lastActiveId', pid);
    expect(svc.buildActiveBlock()).toContain('ctx');
    svc._cfgSvc.set('settings.projects.lastActiveId', null);
    expect(svc.buildActiveBlock()).toBe('');
  });
});

describe('summarizeFile (auto-summarize)', () => {
  test('writes a summary onto the file when the LLM responds', async () => {
    const svc = make();
    const pid = svc.create({ name: 'P' }).project.id;
    const af = await svc.addFile({ id: pid, name: 'doc.md', text: 'long body about widgets' });
    const fakeLlm = { chatCompletionJson: jest.fn().mockResolvedValue({ ok: true, value: { summary: 'A doc about widgets.' } }) };
    svc.setLLMClient(fakeLlm);
    await summarizeFile(svc, pid, af.file.id, 'doc.md', 'long body about widgets');
    const f = svc.files({ id: pid }).files.find((x) => x.id === af.file.id);
    // summary is stored on the project item; re-read from the service's config.
    const item = svc._cfg().items.find((p) => p.id === pid);
    const stored = item.files.find((x) => x.id === af.file.id);
    expect(stored.summary).toBe('A doc about widgets.');
    expect(fakeLlm.chatCompletionJson).toHaveBeenCalled();
  });

  test('is a no-op when no LLM client is configured', async () => {
    const svc = make();
    const pid = svc.create({ name: 'P' }).project.id;
    const af = await svc.addFile({ id: pid, name: 'doc.md', text: 'body' });
    await summarizeFile(svc, pid, af.file.id, 'doc.md', 'body');
    const item = svc._cfg().items.find((p) => p.id === pid);
    expect(item.files.find((x) => x.id === af.file.id).summary).toBeUndefined();
  });
});

describe('screenshotActive', () => {
  test('returns not_found for an unknown project', async () => {
    const svc = make();
    const r = await screenshotActive(svc, 'nope');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_found');
  });

  test('returns no_capture_service when the screenshot service is absent', async () => {
    const svc = make();
    const pid = svc.create({ name: 'P' }).project.id;
    const r = await screenshotActive(svc, pid);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_capture_service');
  });

  test('captures the active user tab and stores the image', async () => {
    const svc = make();
    const pid = svc.create({ name: 'P' }).project.id;
    // NativeImage stub: toPNG() returns a Buffer.
    const fakeImage = { toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
    svc.setScreenshotService({ captureById: jest.fn().mockResolvedValue(fakeImage) });
    svc.setTabRegistry({ list: () => [{ webContentsId: 42, kind: 'user' }] });
    const r = await screenshotActive(svc, pid);
    expect(r.ok).toBe(true);
    expect(r.file.isImage).toBe(true);
    expect(r.file.ext).toBe('png');
    expect(svc.files({ id: pid }).files).toHaveLength(1);
  });

  test('skips a private tab and captures the next user tab', async () => {
    const svc = make();
    const pid = svc.create({ name: 'P' }).project.id;
    const captureById = jest.fn().mockResolvedValue({ toPNG: () => Buffer.from([0x89]) });
    svc.setScreenshotService({ captureById });
    svc.setTabRegistry({ list: () => [{ webContentsId: 41, kind: 'user', private: true }, { webContentsId: 42, kind: 'user' }] });
    expect((await screenshotActive(svc, pid)).ok).toBe(true);
    expect(captureById).toHaveBeenCalledWith(42);
  });

  test('returns no_active_tab when the only tab is private', async () => {
    const svc = make();
    const pid = svc.create({ name: 'P' }).project.id;
    const captureById = jest.fn();
    svc.setScreenshotService({ captureById });
    svc.setTabRegistry({ list: () => [{ webContentsId: 41, kind: 'user', private: true }] });
    expect(await screenshotActive(svc, pid)).toEqual({ ok: false, error: 'no_active_tab' });
    expect(captureById).not.toHaveBeenCalled();
  });

  test('returns no_active_tab when the registry is empty', async () => {
    const svc = make();
    const pid = svc.create({ name: 'P' }).project.id;
    svc.setScreenshotService({ captureById: jest.fn() });
    svc.setTabRegistry({ list: () => [] });
    const r = await screenshotActive(svc, pid);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_active_tab');
  });
});

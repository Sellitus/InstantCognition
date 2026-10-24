// The network boundary (https.get) is replaced by mockGet, which serves
// scripted responses as real streams so the byte cap and redirect logic run
// unmodified.
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const {
  normalizeInstallUrl, fetchCapped, fetchSkillFromUrl,
} = require('../../../../../main/agent/skills/skillInstall');
const { MAX_SKILL_BYTES } = require('../../../../../main/agent/skills/skillFormat');

const SKILL = '---\nname: pdf-extract\ndescription: Extract tables from PDFs\nallowed-tools: Read, NotebookEdit\n---\n\nSteps.\n';

/** @param {Array<{ status?: number, headers?: object, chunks?: (string|Buffer)[] }>} script */
function mockGet(script) {
  const calls = [];
  const responses = [];
  const get = jest.fn((url, _opts, cb) => {
    calls.push(url);
    const req = Object.assign(new EventEmitter(), { setTimeout: jest.fn(), destroy: jest.fn() });
    const spec = script.shift() || { status: 500 };
    const res = Object.assign(new PassThrough(), { statusCode: spec.status || 200, headers: spec.headers || {} });
    responses.push(res);
    setImmediate(() => {
      cb(res);
      for (const c of spec.chunks || []) { if (!res.destroyed) res.write(c); }
      if (!res.destroyed) res.end();
    });
    return req;
  });
  return { get, calls, responses };
}

describe('skillInstall.normalizeInstallUrl', () => {
  test('rejects http:, non-URLs and URLs with credentials', () => {
    expect(normalizeInstallUrl('http://example.com/SKILL.md')).toEqual({ ok: false, error: 'https_only' });
    expect(normalizeInstallUrl('file:///etc/passwd')).toEqual({ ok: false, error: 'https_only' });
    expect(normalizeInstallUrl('not a url')).toEqual({ ok: false, error: 'invalid_url' });
    expect(normalizeInstallUrl('https://u:p@example.com/x')).toEqual({ ok: false, error: 'credentials_in_url' });
    expect(normalizeInstallUrl(`https://e.com/${'a'.repeat(3000)}`)).toEqual({ ok: false, error: 'invalid_url' });
  });

  test('rewrites a GitHub blob link to the raw file', () => {
    expect(normalizeInstallUrl('https://github.com/o/r/blob/main/skills/x/SKILL.md'))
      .toEqual({ ok: true, url: 'https://raw.githubusercontent.com/o/r/main/skills/x/SKILL.md' });
  });
});

describe('skillInstall.fetchSkillFromUrl', () => {
  test('downloads and parses a skill, surfacing mapping warnings', async () => {
    const net = mockGet([{ chunks: [SKILL] }]);
    const res = await fetchSkillFromUrl('https://example.com/SKILL.md', { get: net.get });
    expect(res).toMatchObject({ ok: true, url: 'https://example.com/SKILL.md', skill: { name: 'pdf-extract', tools: ['fs.read'] } });
    if (res.ok === true) expect(res.warnings).toEqual([expect.stringContaining('NotebookEdit')]);
  });

  test('an http: URL is rejected before any request', async () => {
    const net = mockGet([{ chunks: [SKILL] }]);
    expect(await fetchSkillFromUrl('http://example.com/SKILL.md', { get: net.get })).toEqual({ ok: false, error: 'https_only' });
    expect(net.get).not.toHaveBeenCalled();
  });

  test('a body that streams past the cap is aborted and rejected', async () => {
    const big = Buffer.alloc(64 * 1024, 'a');
    const net = mockGet([{ chunks: [big, big, big, big, big, big] }]);
    expect(await fetchSkillFromUrl('https://example.com/SKILL.md', { get: net.get })).toEqual({ ok: false, error: 'too_large' });
    expect(net.responses[0].destroyed).toBe(true);
  });

  test('a declared Content-Length over the cap is refused without reading', async () => {
    const net = mockGet([{ headers: { 'content-length': String(MAX_SKILL_BYTES + 1) }, chunks: ['x'] }]);
    expect(await fetchSkillFromUrl('https://example.com/SKILL.md', { get: net.get })).toEqual({ ok: false, error: 'too_large' });
  });

  test('a skill named ../x is rejected', async () => {
    const net = mockGet([{ chunks: ['---\nname: ../x\ndescription: d\n---\nbody'] }]);
    expect(await fetchSkillFromUrl('https://example.com/SKILL.md', { get: net.get })).toEqual({ ok: false, error: 'invalid_name' });
  });

  test('follows an https redirect but refuses a downgrade to http', async () => {
    const ok = mockGet([{ status: 302, headers: { location: 'https://cdn.example.com/S.md' } }, { chunks: [SKILL] }]);
    expect((await fetchSkillFromUrl('https://example.com/S.md', { get: ok.get })).ok).toBe(true);
    expect(ok.calls).toEqual(['https://example.com/S.md', 'https://cdn.example.com/S.md']);

    const down = mockGet([{ status: 301, headers: { location: 'http://example.com/S.md' } }]);
    expect(await fetchSkillFromUrl('https://example.com/S.md', { get: down.get })).toEqual({ ok: false, error: 'https_only' });
    expect(down.get).toHaveBeenCalledTimes(1);
  });

  test('a non-2xx status and a network error are reported', async () => {
    const notFound = mockGet([{ status: 404 }]);
    expect(await fetchSkillFromUrl('https://example.com/S.md', { get: notFound.get })).toEqual({ ok: false, error: 'http_404' });

    const failing = jest.fn(() => {
      const req = Object.assign(new EventEmitter(), { setTimeout: jest.fn(), destroy: jest.fn() });
      setImmediate(() => req.emit('error', new Error('ECONNRESET')));
      return req;
    });
    expect(await fetchCapped('https://example.com/S.md', { get: /** @type {any} */ (failing) }).catch((e) => e.message)).toBe('ECONNRESET');
  });

  test('a non-skill document is rejected with the parse error', async () => {
    const net = mockGet([{ chunks: ['<html>not a skill</html>'] }]);
    expect(await fetchSkillFromUrl('https://example.com/S.md', { get: net.get })).toEqual({ ok: false, error: 'missing_frontmatter' });
  });
});

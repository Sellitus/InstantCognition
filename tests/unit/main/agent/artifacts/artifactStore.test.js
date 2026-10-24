// artifactStore — versioned per-session artifact files under
// {userData}/sessions/<sid>/artifacts/<aid>/v<n>.json.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createArtifactStore, MAX_CONTENT_BYTES } = require('../../../../../main/agent/artifacts/artifactStore');

const SID = 's_abc123';
let base, store;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-artifacts-'));
  store = createArtifactStore({ baseDir: base });
});
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

const codeOf = (fn) => { try { fn(); } catch (err) { return /** @type {any} */ (err).code; } return null; };

test('create writes v1 under the session and returns the record', () => {
  const a = store.create(SID, { type: 'html', title: '  Demo page ', content: '<h1>Hi</h1>' });
  expect(a).toMatchObject({ version: 1, type: 'html', title: 'Demo page', content: '<h1>Hi</h1>' });
  expect(a.id).toMatch(/^a_[a-z0-9]{12}$/);
  const file = path.join(base, SID, 'artifacts', a.id, 'v1.json');
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(a);
  expect(fs.readdirSync(path.dirname(file))).toEqual(['v1.json']);
});

test('update increments the version, inherits unspecified fields and keeps old versions', () => {
  const a = store.create(SID, { type: 'code', language: 'python', title: 'Script', content: 'print(1)' });
  const b = store.update(SID, a.id, { content: 'print(2)' });
  const c = store.update(SID, a.id, { content: 'print(3)', title: 'Script v3' });
  expect([b.version, c.version]).toEqual([2, 3]);
  expect(b).toMatchObject({ id: a.id, type: 'code', language: 'python', title: 'Script', content: 'print(2)' });
  expect(c.title).toBe('Script v3');
  expect(store.get(SID, a.id).content).toBe('print(3)');
  expect(store.get(SID, a.id).versions).toEqual([1, 2, 3]);
  expect(store.get(SID, a.id, 1).content).toBe('print(1)');
});

test('list returns summaries without content, newest first', () => {
  const a = store.create(SID, { type: 'markdown', title: 'Notes', content: '# x' });
  const b = store.create(SID, { type: 'svg', title: 'Logo', content: '<svg/>' });
  store.update(SID, a.id, { content: '# y' });
  const listed = store.list(SID);
  expect(listed.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
  const notes = listed.find((x) => x.id === a.id);
  expect(notes).toMatchObject({ type: 'markdown', title: 'Notes', version: 2, versions: [1, 2] });
  expect(notes).not.toHaveProperty('content');
  expect(store.list('s_unknown1')).toEqual([]);
});

test('emits upserted with the session and full record on create and update', () => {
  const seen = [];
  const off = store.on('upserted', (p) => seen.push(p));
  const a = store.create(SID, { type: 'mermaid', title: 'Flow', content: 'graph TD; A-->B' });
  store.update(SID, a.id, { content: 'graph TD; A-->C' });
  off();
  store.update(SID, a.id, { content: 'graph TD; A-->D' });
  expect(seen.map((p) => [p.sessionId, p.artifact.version])).toEqual([[SID, 1], [SID, 2]]);
  expect(seen[1].artifact.content).toBe('graph TD; A-->C');
});

test('oversize content is rejected and nothing is written', () => {
  const big = 'x'.repeat(MAX_CONTENT_BYTES + 1);
  let err;
  try { store.create(SID, { type: 'html', title: 'Big', content: big }); } catch (e) { err = e; }
  expect(err.code).toBe('content_too_large');
  expect(err.extra).toEqual({ bytes: MAX_CONTENT_BYTES + 1, maxBytes: MAX_CONTENT_BYTES });
  expect(fs.existsSync(path.join(base, SID))).toBe(false);
  // Multi-byte characters count by UTF-8 bytes, not string length.
  const a = store.create(SID, { type: 'html', title: 'ok', content: 'x' });
  expect(codeOf(() => store.update(SID, a.id, { content: 'é'.repeat(MAX_CONTENT_BYTES / 2 + 1) }))).toBe('content_too_large');
  expect(store.get(SID, a.id).versions).toEqual([1]);
});

test('invalid session and artifact ids are rejected before touching disk', () => {
  for (const bad of ['../x', 's_ABC123', 's_ab', '', null, 's_abc123/../../etc']) {
    expect(codeOf(() => store.create(bad, { type: 'html', title: 't', content: 'c' }))).toBe('invalid_session_id');
    expect(codeOf(() => store.list(bad))).toBe('invalid_session_id');
  }
  for (const bad of ['../a_abcdef', 'a_ab', 'b_abcdef', 'a_abcdef/..', 42]) {
    expect(codeOf(() => store.get(SID, bad))).toBe('invalid_artifact_id');
    expect(codeOf(() => store.update(SID, bad, { content: 'c' }))).toBe('invalid_artifact_id');
  }
  expect(fs.readdirSync(base)).toEqual([]);
});

test('field validation: type, title, language, empty content, version', () => {
  const ok = { type: 'html', title: 't', content: 'c' };
  expect(codeOf(() => store.create(SID, { ...ok, type: 'pdf' }))).toBe('invalid_type');
  expect(codeOf(() => store.create(SID, { ...ok, title: '   ' }))).toBe('invalid_title');
  expect(codeOf(() => store.create(SID, { ...ok, title: 'x'.repeat(201) }))).toBe('title_too_long');
  expect(codeOf(() => store.create(SID, { ...ok, language: 'py thon' }))).toBe('invalid_language');
  expect(codeOf(() => store.create(SID, { ...ok, content: '' }))).toBe('invalid_content');
  expect(codeOf(() => store.create(SID, { ...ok, content: 5 }))).toBe('invalid_content');
  const a = store.create(SID, ok);
  expect(codeOf(() => store.get(SID, a.id, 0))).toBe('invalid_version');
  expect(codeOf(() => store.get(SID, a.id, 1.5))).toBe('invalid_version');
  expect(codeOf(() => store.get(SID, a.id, 9))).toBe('version_not_found');
});

test('update and get of a missing artifact report artifact_not_found', () => {
  expect(codeOf(() => store.update(SID, 'a_missing1', { content: 'c' }))).toBe('artifact_not_found');
  expect(codeOf(() => store.get(SID, 'a_missing1'))).toBe('artifact_not_found');
});

test('a corrupt version file is surfaced, not hidden', () => {
  const a = store.create(SID, { type: 'html', title: 't', content: 'c' });
  fs.writeFileSync(path.join(base, SID, 'artifacts', a.id, 'v1.json'), '{not json');
  expect(codeOf(() => store.get(SID, a.id))).toBe('artifact_corrupt');
  expect(store.list(SID)).toEqual([{ id: a.id, version: 1, versions: [1], error: 'artifact_corrupt' }]);
});

test('requires an absolute baseDir', () => {
  expect(() => createArtifactStore({ baseDir: 'relative/dir' })).toThrow(/absolute baseDir/);
});

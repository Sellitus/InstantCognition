// artifactTool — artifact.create / artifact.update over a real store in a
// tmp dir, invoked through the real tool registry.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRegistry } = require('../../../../../main/agent/toolRegistry');
const { createArtifactStore } = require('../../../../../main/agent/artifacts/artifactStore');
const { registerArtifactTools } = require('../../../../../main/agent/tools/artifactTool');
const { classify } = require('../../../../../main/agent/permissions/toolCatalog');

const SID = 's_tool01';
let base, store, registry;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-artifact-tool-'));
  store = createArtifactStore({ baseDir: base });
  registry = createRegistry();
  registerArtifactTools(registry, { store });
});
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

test('registers both tools with OpenAI schemas', () => {
  const names = registry.list().map((t) => t.function.name);
  expect(names).toEqual(['artifact.create', 'artifact.update']);
  const create = registry.get('artifact.create');
  expect(create.parameters.required).toEqual(['type', 'title', 'content']);
  expect(create.parameters.properties.type.enum).toEqual(['html', 'markdown', 'mermaid', 'code', 'svg']);
  expect(registry.get('artifact.update').parameters.required).toEqual(['id', 'content']);
});

test('the catalog classifies both as plan-safe meta tools', () => {
  for (const name of ['artifact.create', 'artifact.update']) {
    expect(classify(name)).toEqual({ cls: 'meta', tier: 1, planSafe: true });
  }
});

test('create then update stores versions and returns a summary without content', async () => {
  const ctx = { sessionId: SID };
  const created = await registry.invoke('artifact.create', { type: 'code', language: 'js', title: 'Util', content: 'let a = 1;' }, ctx);
  expect(created).toEqual({ ok: true, id: expect.stringMatching(/^a_/), version: 1, type: 'code', title: 'Util', language: 'js' });
  const updated = await registry.invoke('artifact.update', { id: created.id, content: 'let a = 2;' }, ctx);
  expect(updated).toEqual({ ok: true, id: created.id, version: 2, type: 'code', title: 'Util', language: 'js' });
  expect(store.get(SID, created.id).content).toBe('let a = 2;');
});

test('a run without a session cannot create artifacts', async () => {
  expect(await registry.invoke('artifact.create', { type: 'html', title: 't', content: 'c' }, {})).toEqual({ ok: false, error: 'no_session' });
  expect(await registry.invoke('artifact.update', { id: 'a_abcdef', content: 'c' }, { sessionId: 7 })).toEqual({ ok: false, error: 'no_session' });
  expect(fs.readdirSync(base)).toEqual([]);
});

test('store validation errors come back as structured tool errors', async () => {
  const ctx = { sessionId: SID };
  expect(await registry.invoke('artifact.create', { type: 'pdf', title: 't', content: 'c' }, ctx))
    .toEqual({ ok: false, error: 'invalid_type', allowed: ['html', 'markdown', 'mermaid', 'code', 'svg'] });
  expect(await registry.invoke('artifact.update', { id: 'a_nothere1', content: 'c' }, ctx)).toEqual({ ok: false, error: 'artifact_not_found' });
  expect(await registry.invoke('artifact.update', { id: '../../x', content: 'c' }, ctx)).toEqual({ ok: false, error: 'invalid_artifact_id' });
  expect(await registry.invoke('artifact.create', { type: 'html', title: 't', content: 'x'.repeat(512 * 1024 + 1) }, ctx))
    .toMatchObject({ ok: false, error: 'content_too_large' });
  expect(await registry.invoke('artifact.create', { type: 'html', title: 't' }, ctx)).toEqual({ ok: false, error: 'invalid_args', details: ['missing:content'] });
});

test('an invalid session id from the host is rejected by the store', async () => {
  expect(await registry.invoke('artifact.create', { type: 'html', title: 't', content: 'c' }, { sessionId: '../escape' }))
    .toEqual({ ok: false, error: 'invalid_session_id' });
});

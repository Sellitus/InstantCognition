// Chat-lane persistence: checkChatTurn validation and recordChatTurn writing
// the user/assistant nodes and promoting ```artifact blocks. Real session and
// artifact stores on a tmp dir.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionStore } = require('../../../../../main/agent/sessions/sessionStore');
const { createArtifactStore, MAX_CONTENT_BYTES } = require('../../../../../main/agent/artifacts/artifactStore');
const { checkChatTurn, recordChatTurn } = require('../../../../../main/agent/sessions/chatTurns');

const fence = (info, body) => `\`\`\`${info}\n${body}\n\`\`\``;

describe('chatTurns', () => {
  let dir;
  let store;
  let artifactStore;
  let events;
  let deps;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-chatturns-'));
    store = createSessionStore({ baseDir: path.join(dir, 'sessions') });
    artifactStore = createArtifactStore({ baseDir: path.join(dir, 'sessions') });
    events = [];
    deps = { store, artifactStore, onEvent: (sessionId, channel, payload) => events.push({ sessionId, channel, payload }) };
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('a completed answer persists both turns and promotes artifact blocks with derived titles', () => {
    const s = store.create();
    const turn = checkChatTurn(store, { sessionId: s.id, messages: [{ role: 'user', content: 'draw it' }] });
    const answer = [
      'Here you go.',
      fence('artifact:svg', '<svg></svg>'),
      fence('artifact:markdown Release notes', '# v1'),
      fence('js', 'not an artifact'),
    ].join('\n');
    const out = recordChatTurn(deps, turn, answer, { ok: true });

    expect(store.getPath(s.id).map((n) => [n.role, n.content])).toEqual([['user', 'draw it'], ['assistant', answer]]);
    expect(out).toMatchObject({ sessionId: s.id, userNodeId: expect.any(String), assistantNodeId: expect.any(String), artifactErrors: [] });
    expect(out.artifacts.map((a) => [a.type, a.title, a.version])).toEqual([['svg', 'svg artifact 1', 1], ['markdown', 'Release notes', 1]]);
    expect(artifactStore.get(s.id, out.artifacts[0].id).content).toBe('<svg></svg>');
    expect(events).toEqual([]);

    const again = recordChatTurn(deps, checkChatTurn(store, { sessionId: s.id, messages: [{ role: 'user', content: 'more' }] }), fence('artifact:code:py', 'print(1)'), { ok: true });
    expect(again.artifacts[0].title).toBe('code artifact 3');
  });

  test('an artifact that fails to save is surfaced; the turn and other artifacts still persist', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const s = store.create();
      const turn = checkChatTurn(store, { sessionId: s.id, messages: [{ role: 'user', content: 'two' }] });
      const answer = `${fence('artifact:html', 'x'.repeat(MAX_CONTENT_BYTES + 1))}\n${fence('artifact:mermaid', 'graph TD; A-->B')}`;
      const out = recordChatTurn(deps, turn, answer, { ok: true });
      expect(out.artifactErrors).toEqual([{ index: 0, error: 'content_too_large' }]);
      expect(out.artifacts.map((a) => a.type)).toEqual(['mermaid']);
      expect(events).toEqual([{ sessionId: s.id, channel: 'artifact-failed', payload: { errors: out.artifactErrors } }]);
      expect(store.getPath(s.id)).toHaveLength(2);
      expect(errSpy).toHaveBeenCalled();
    } finally { errSpy.mockRestore(); }
  });

  test('a request that never reached the model writes nothing; a failed answer is stored as an error node', () => {
    const s = store.create();
    const turn = checkChatTurn(store, { sessionId: s.id, messages: [{ role: 'user', content: 'hi' }] });
    expect(recordChatTurn(deps, turn, '', { ok: false, error: 'engine_busy' })).toEqual({});
    expect(store.getPath(s.id)).toEqual([]);
    const out = recordChatTurn(deps, turn, 'partial', { ok: false, error: 'cancelled' });
    const last = store.getPath(s.id).pop();
    expect(last).toMatchObject({ id: out.assistantNodeId, kind: 'error', content: 'partial\n\n[cancelled]' });
    expect(out.artifacts).toBeUndefined();
  });

  test('regenerating an existing user node answers it instead of appending a new user turn', () => {
    const s = store.create();
    const u = store.append(s.id, { role: 'user', content: 'original' });
    store.append(s.id, { role: 'assistant', content: 'first answer' });
    const turn = checkChatTurn(store, { sessionId: s.id, userNodeId: u.id });
    expect(turn.userText).toBe('original');
    const out = recordChatTurn(deps, turn, 'second answer', { ok: true });
    expect(out.userNodeId).toBe(u.id);
    expect(store.getPath(s.id).map((n) => n.content)).toEqual(['original', 'second answer']);
  });

  test('userText is persisted as the user node instead of the grounded prompt', () => {
    const s = store.create();
    const grounded = '--- Active page ---\nPage body\n\nwhat is this?';
    const turn = checkChatTurn(store, { sessionId: s.id, userText: 'what is this?', messages: [{ role: 'user', content: grounded }] });
    recordChatTurn(deps, turn, 'An answer', { ok: true });
    const [user] = store.getPath(s.id);
    expect(user).toMatchObject({ role: 'user', content: 'what is this?', data: { lane: 'chat' } });
    expect(user.data.attachments).toBeUndefined();
    expect(store.get(s.id).meta.title).toBe('what is this?');
  });

  test('without userText the last user message is persisted as before', () => {
    const s = store.create();
    const turn = checkChatTurn(store, { sessionId: s.id, messages: [{ role: 'user', content: 'plain question' }] });
    recordChatTurn(deps, turn, 'ok', { ok: true });
    expect(store.getPath(s.id)[0].content).toBe('plain question');
  });

  test('an image turn persists its text and an attachments note, never the image data', () => {
    const s = store.create();
    const dataUrl = `data:image/png;base64,${'A'.repeat(4000)}`;
    const content = [
      { type: 'text', text: '--- Project ---\nnotes\n\ndescribe these' },
      { type: 'image_url', image_url: { url: dataUrl } },
      { type: 'image_url', image_url: { url: dataUrl } },
    ];
    const turn = checkChatTurn(store, { sessionId: s.id, userText: 'describe these', messages: [{ role: 'user', content }] });
    const out = recordChatTurn(deps, turn, 'Two charts.', { ok: true });
    const [user, answer] = store.getPath(s.id);
    expect(user).toMatchObject({ id: out.userNodeId, role: 'user', content: 'describe these', data: { lane: 'chat', attachments: { images: 2 } } });
    expect(answer.content).toBe('Two charts.');
    const raw = fs.readFileSync(path.join(dir, 'sessions', s.id, 'nodes.jsonl'), 'utf8');
    expect(raw).not.toContain('base64');
  });

  test('an image turn without userText takes the text parts of the message', () => {
    const s = store.create();
    const turn = checkChatTurn(store, { sessionId: s.id, messages: [{ role: 'user', content: [{ type: 'text', text: 'what is shown' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }] });
    expect(turn).toEqual({ sessionId: s.id, userNode: null, userText: 'what is shown', attachments: { images: 1 } });
  });

  test('an images-only turn persists with empty text; an empty text-only turn is refused', () => {
    const s = store.create();
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } };
    const turn = checkChatTurn(store, { sessionId: s.id, userText: '', messages: [{ role: 'user', content: [image] }] });
    expect(turn).toMatchObject({ userText: '', attachments: { images: 1 } });
    expect(() => checkChatTurn(store, { sessionId: s.id, userText: '  ', messages: [{ role: 'user', content: 'grounded' }] })).toThrow('no_user_message');
    expect(() => checkChatTurn(store, { sessionId: s.id, messages: [{ role: 'user', content: [{ type: 'text', text: ' ' }] }] })).toThrow('no_user_message');
  });

  test('a malformed userText is refused before anything is written', () => {
    const s = store.create();
    const messages = [{ role: 'user', content: 'q' }];
    expect(() => checkChatTurn(store, { sessionId: s.id, userText: 42, messages })).toThrow('invalid_user_text');
    expect(() => checkChatTurn(store, { sessionId: s.id, userText: { text: 'q' }, messages })).toThrow('invalid_user_text');
    expect(() => checkChatTurn(store, { sessionId: s.id, userText: 'x'.repeat(100001), messages })).toThrow('invalid_user_text');
    expect(() => checkChatTurn(store, { sessionId: s.id, userText: 'q', messages: [] })).toThrow('no_user_message');
    expect(store.getPath(s.id)).toEqual([]);
  });

  test('checkChatTurn refuses malformed and unknown requests', () => {
    const s = store.create();
    const a = store.append(s.id, { role: 'assistant', content: 'x' });
    expect(checkChatTurn(store, { messages: [] })).toBeNull();
    expect(() => checkChatTurn(store, { sessionId: '../x' })).toThrow('invalid_session_id');
    expect(() => checkChatTurn(store, { sessionId: 's_missing1' })).toThrow('session_not_found');
    expect(() => checkChatTurn(store, { sessionId: s.id, messages: [{ role: 'assistant', content: 'x' }] })).toThrow('no_user_message');
    expect(() => checkChatTurn(store, { sessionId: s.id, userNodeId: a.id })).toThrow('not_a_user_message');
    expect(() => checkChatTurn(store, { sessionId: s.id, userNodeId: 'bad' })).toThrow('invalid_node_id');
  });
});

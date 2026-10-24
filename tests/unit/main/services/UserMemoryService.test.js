const { UserMemoryService } = require('../../../../main/services/UserMemoryService');

function fakeCs(initial = {}) {
  let data = { settings: { userMemory: { ...initial } } };
  return {
    get: (path, fb) => {
      const ks = path.split('.');
      let c = data;
      for (const k of ks) c = (c && typeof c === 'object') ? c[k] : undefined;
      return c === undefined ? fb : c;
    },
    set: (path, v) => {
      const ks = path.split('.');
      let c = data;
      for (let i = 0; i < ks.length - 1; i++) { if (!c[ks[i]] || typeof c[ks[i]] !== 'object') c[ks[i]] = {}; c = c[ks[i]]; }
      c[ks[ks.length - 1]] = v;
    },
    _data: data,
  };
}

function makeSvc(initial = {}) {
  const svc = new UserMemoryService();
  svc.bindConfig(fakeCs(initial));
  return svc;
}

describe('UserMemoryService — basic CRUD', () => {
  test('add returns a fact with id, text, timestamps', () => {
    const svc = makeSvc({ enabled: true, facts: [] });
    const f = svc.add('I am a Go developer.');
    expect(f).toBeTruthy();
    expect(f.text).toBe('I am a Go developer.');
    expect(typeof f.id).toBe('string');
    expect(typeof f.createdAt).toBe('number');
    expect(svc.list()).toHaveLength(1);
  });

  test('rejects empty text', () => {
    const svc = makeSvc({ facts: [] });
    expect(svc.add('   ')).toBeNull();
    expect(svc.list()).toHaveLength(0);
  });

  test('clamps overlong text', () => {
    const svc = makeSvc({ facts: [] });
    const f = svc.add('a'.repeat(500));
    expect(f.text.length).toBe(300);
  });

  test('edit updates text and editedAt', () => {
    const svc = makeSvc({ facts: [] });
    const f = svc.add('original');
    const before = f.editedAt;
    const updated = svc.edit(f.id, { text: 'edited' });
    expect(updated.text).toBe('edited');
    expect(updated.editedAt).toBeGreaterThanOrEqual(before);
  });

  test('remove returns true on hit, false on miss', () => {
    const svc = makeSvc({ facts: [] });
    const f = svc.add('hi');
    expect(svc.remove(f.id)).toBe(true);
    expect(svc.remove('nope')).toBe(false);
    expect(svc.list()).toHaveLength(0);
  });

  test('archive hides from list (without includeArchived)', () => {
    const svc = makeSvc({ facts: [] });
    const f = svc.add('test');
    svc.archive(f.id);
    expect(svc.list()).toHaveLength(0);
    expect(svc.list({ includeArchived: true })).toHaveLength(1);
  });

  test('pin marks the fact', () => {
    const svc = makeSvc({ facts: [] });
    const f = svc.add('important');
    svc.pin(f.id, true);
    expect(svc.list()[0].pinned).toBe(true);
    svc.pin(f.id, false);
    expect(svc.list()[0].pinned).toBe(false);
  });

  test('clearAll empties everything', () => {
    const svc = makeSvc({ facts: [] });
    svc.add('a'); svc.add('b'); svc.add('c');
    svc.clearAll();
    expect(svc.list({ includeArchived: true })).toHaveLength(0);
  });
});

describe('UserMemoryService — enable toggle', () => {
  test('isEnabled reflects config', () => {
    const svc = makeSvc({ enabled: true });
    expect(svc.isEnabled()).toBe(true);
    svc.enable(false);
    expect(svc.isEnabled()).toBe(false);
  });

  test('default-enabled when no explicit setting', () => {
    const svc = makeSvc({ facts: [] });
    expect(svc.isEnabled()).toBe(true);
  });
});

describe('UserMemoryService — buildPromptBlock', () => {
  test('returns empty string when disabled', () => {
    const svc = makeSvc({ enabled: false });
    svc.add('a fact');
    expect(svc.buildPromptBlock()).toBe('');
  });

  test('returns empty string when no facts', () => {
    const svc = makeSvc({ enabled: true, facts: [] });
    expect(svc.buildPromptBlock()).toBe('');
  });

  test('returns empty string when all facts archived', () => {
    const svc = makeSvc({ facts: [] });
    const f = svc.add('a fact'); svc.archive(f.id);
    expect(svc.buildPromptBlock()).toBe('');
  });

  test('lists pinned first then chronological', () => {
    const svc = makeSvc({ facts: [] });
    const a = svc.add('A');
    svc.add('B');
    const c = svc.add('C');
    svc.pin(a.id, true);
    const block = svc.buildPromptBlock();
    expect(block).toContain('A');
    expect(block).toContain('B');
    expect(block).toContain('C');
    expect(block.indexOf('A')).toBeLessThan(block.indexOf('C'));
  });

  test('skips archived facts', () => {
    const svc = makeSvc({ facts: [] });
    const a = svc.add('keep me');
    const b = svc.add('hide me');
    svc.archive(b.id);
    const block = svc.buildPromptBlock();
    expect(block).toContain('keep me');
    expect(block).not.toContain('hide me');
  });
});

describe('UserMemoryService — capacity', () => {
  test('exceeding maxFacts archives oldest non-pinned', () => {
    const svc = makeSvc({ enabled: true, facts: [], maxFacts: 3 });
    svc.add('a');
    svc.add('b');
    svc.add('c');
    svc.add('d'); // forces archive of oldest
    const live = svc.list();
    expect(live).toHaveLength(3);
    const all = svc.list({ includeArchived: true });
    expect(all).toHaveLength(4);
    expect(all.some((f) => f.archived)).toBe(true);
  });
});

describe('UserMemoryService — replaceAll (import)', () => {
  test('sanitizes and replaces', () => {
    const svc = makeSvc({ facts: [{ id: 'old', text: 'old', createdAt: 1, editedAt: 1 }] });
    svc.replaceAll([
      { text: 'new fact 1', pinned: true },
      { text: 'new fact 2' },
      { text: '' }, // skipped
      null, // skipped
    ]);
    const facts = svc.list({ includeArchived: true });
    expect(facts.map((f) => f.text)).toEqual(['new fact 1', 'new fact 2']);
    expect(facts[0].pinned).toBe(true);
  });
});

describe('UserMemoryService — autoCapture', () => {
  function fakeLLM(facts) {
    return {
      chatCompletionJson: jest.fn().mockResolvedValue({
        ok: true,
        value: { facts },
        usage: null,
        tokens: 0,
        retryUsed: false,
      }),
    };
  }

  test('extracts durable facts from a turn and persists them with source:auto', async () => {
    const svc = makeSvc({ enabled: true, autoCapture: true, facts: [] });
    svc.setLLMClient(fakeLLM([
      { text: 'user is a React developer', category: 'identity' },
      { text: 'user prefers TypeScript', category: 'preference' },
    ]));
    const added = await svc.capture({ messages: [
      { role: 'user', content: 'I am a React developer and I prefer TypeScript' },
      { role: 'assistant', content: 'Got it, TypeScript it is.' },
    ] });
    expect(added.length).toBe(2);
    expect(added.every((f) => f.source === 'auto')).toBe(true);
    const facts = svc.list();
    // add() prepends (newest first), so the second fact lands on top.
    expect(facts.map((f) => f.text).sort()).toEqual(['user is a React developer', 'user prefers TypeScript']);
  });

  test('captures nothing when autoCapture is false', async () => {
    const llm = fakeLLM([{ text: 'user is vegan', category: 'identity' }]);
    const svc = makeSvc({ enabled: true, autoCapture: false, facts: [] });
    svc.setLLMClient(llm);
    const added = await svc.capture({ messages: [{ role: 'user', content: 'I am vegan' }] });
    expect(added).toEqual([]);
    expect(llm.chatCompletionJson).not.toHaveBeenCalled();
    expect(svc.list()).toEqual([]);
  });

  test('dedupes against an existing fact by substring containment', async () => {
    const svc = makeSvc({
      enabled: true, autoCapture: true,
      facts: [{ id: 'f1', text: 'user is a vegan', createdAt: 1, editedAt: 1 }],
    });
    svc.setLLMClient(fakeLLM([
      { text: 'user is vegan', category: 'identity' },        // exact dupe
      { text: 'user is a vegan', category: 'identity' },       // substring dupe (existing contains)
      { text: 'user works on a Mac', category: 'environment' }, // new
    ]));
    const added = await svc.capture({ messages: [{ role: 'user', content: 'I am a vegan' }] });
    expect(added.map((f) => f.text)).toEqual(['user works on a Mac']);
  });

  test('returns [] when no LLM client is wired', async () => {
    const svc = makeSvc({ enabled: true, autoCapture: true, facts: [] });
    svc.setLLMClient(null);
    const added = await svc.capture({ messages: [{ role: 'user', content: 'I love Rust' }] });
    expect(added).toEqual([]);
  });

  test('swallows LLM errors and captures nothing', async () => {
    const llm = { chatCompletionJson: jest.fn().mockRejectedValue(new Error('endpoint down')) };
    const svc = makeSvc({ enabled: true, autoCapture: true, facts: [] });
    svc.setLLMClient(llm);
    const added = await svc.capture({ messages: [{ role: 'user', content: 'x' }] });
    expect(added).toEqual([]);
    expect(svc.list()).toEqual([]);
  });

  test('reports the capture request in flight until it settles, failures included', async () => {
    let settle;
    const llm = { chatCompletionJson: jest.fn(() => new Promise((_res, rej) => { settle = rej; })) };
    const svc = makeSvc({ enabled: true, autoCapture: true, facts: [] });
    svc.setLLMClient(llm);
    expect(svc.isCapturing()).toBe(false);

    const p = svc.capture({ messages: [{ role: 'user', content: 'I use a Mac' }] });
    // Claimed synchronously, before the caller's own busy flag drops.
    expect(svc.isCapturing()).toBe(true);
    settle(new Error('engine restarted'));
    await p;

    expect(svc.isCapturing()).toBe(false);
  });

  test('a capture that is switched off never claims the engine', async () => {
    const svc = makeSvc({ enabled: true, autoCapture: false, facts: [] });
    svc.setLLMClient(fakeLLM([]));
    const p = svc.capture({ messages: [{ role: 'user', content: 'x' }] });
    expect(svc.isCapturing()).toBe(false);
    await p;
  });

  test('accepts prompt/answer form and skips empty input', async () => {
    const llm = fakeLLM([{ text: 'user likes hiking', category: 'goal' }]);
    const svc = makeSvc({ enabled: true, autoCapture: true, facts: [] });
    svc.setLLMClient(llm);
    const added = await svc.capture({ prompt: 'I like hiking', answer: 'Nice!' });
    expect(added.length).toBe(1);
    expect(added[0].text).toBe('user likes hiking');
    // Empty input short-circuits before calling the model.
    const llm2 = fakeLLM([{ text: 'x' }]);
    const svc2 = makeSvc({ enabled: true, autoCapture: true, facts: [] });
    svc2.setLLMClient(llm2);
    const empty = await svc2.capture({});
    expect(empty).toEqual([]);
    expect(llm2.chatCompletionJson).not.toHaveBeenCalled();
  });
});

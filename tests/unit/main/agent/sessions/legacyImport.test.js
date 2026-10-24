const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionStore } = require('../../../../../main/agent/sessions/sessionStore');
const { importLegacyRuns, legacySessionId, MARKER } = require('../../../../../main/agent/sessions/legacyImport');
const { AgentHistoryService } = require('../../../../../main/services/AgentHistoryService');

describe('legacyImport', () => {
  let root;
  let runsDir;
  let store;
  let history;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-legacy-'));
    runsDir = path.join(root, 'runs');
    store = createSessionStore({ baseDir: path.join(root, 'sessions') });
    history = new AgentHistoryService();
    history.initialize({ baseDir: runsDir, skipOrphanSweep: true });
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const writeRun = (id, events) => fs.writeFileSync(path.join(runsDir, `${id}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  test('copies each run into a session with the task and summary, then is a no-op', () => {
    writeRun('run-1', [
      { kind: 'task-start', description: 'Find flights', ts: 5000 },
      { kind: 'task-end', ok: true, summary: 'Found 3 flights', ts: 6000 },
    ]);
    writeRun('run-2', [{ kind: 'task-start', description: 'Unfinished', ts: 7000 }]);
    const first = importLegacyRuns(store, history);
    expect(first).toEqual({ skipped: false, imported: 2, existing: 0, failed: [] });
    const s1 = store.get(legacySessionId('run-1'));
    expect(s1.meta).toMatchObject({ source: 'legacy', legacyRunId: 'run-1', createdAt: 5000 });
    expect(s1.nodes.map((n) => [n.role, n.kind, n.content])).toEqual([
      ['user', 'message', 'Find flights'], ['assistant', 'message', 'Found 3 flights'],
    ]);
    const s2 = store.get(legacySessionId('run-2'));
    expect(s2.nodes[1]).toMatchObject({ role: 'assistant', kind: 'error' });
    expect(fs.existsSync(path.join(root, 'sessions', MARKER))).toBe(true);

    writeRun('run-3', [{ kind: 'task-start', description: 'later', ts: 1 }]);
    expect(importLegacyRuns(store, history)).toEqual({ skipped: true, imported: 0, existing: 0, failed: [] });
    expect(store.exists(legacySessionId('run-3'))).toBe(false);
  });

  test('an interrupted import (no marker) skips runs already copied', () => {
    writeRun('run-1', [{ kind: 'task-start', description: 'a', ts: 1 }, { kind: 'task-end', ok: true, summary: 's', ts: 2 }]);
    importLegacyRuns(store, history);
    fs.rmSync(path.join(root, 'sessions', MARKER));
    writeRun('run-2', [{ kind: 'task-start', description: 'b', ts: 3 }, { kind: 'task-end', ok: true, summary: 't', ts: 4 }]);
    const again = importLegacyRuns(store, history);
    expect(again).toMatchObject({ imported: 1, existing: 1, failed: [] });
    expect(store.get(legacySessionId('run-1')).nodes).toHaveLength(2);
  });

  test('a run that fails to read is reported and leaves no half-written session', () => {
    writeRun('run-ok', [{ kind: 'task-start', description: 'a', ts: 1 }]);
    writeRun('run-bad', [{ kind: 'task-start', description: 'b', ts: 1 }]);
    const mockHistory = {
      getBaseDir: () => runsDir,
      open: (id) => { if (id === 'run-bad') throw new Error('unreadable'); return history.open(id); },
    };
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = importLegacyRuns(store, mockHistory);
      expect(res.imported).toBe(1);
      expect(res.failed).toEqual([{ runId: 'run-bad', error: 'unreadable' }]);
      expect(store.exists(legacySessionId('run-bad'))).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(root, 'sessions', MARKER), 'utf8')).failed).toHaveLength(1);
      expect(errSpy).toHaveBeenCalled();
    } finally { errSpy.mockRestore(); }
  });

  test('a missing runs directory imports nothing and still writes the marker', () => {
    fs.rmSync(runsDir, { recursive: true });
    expect(importLegacyRuns(store, history)).toEqual({ skipped: false, imported: 0, existing: 0, failed: [] });
    expect(fs.existsSync(path.join(root, 'sessions', MARKER))).toBe(true);
  });
});

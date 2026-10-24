const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentHistoryService } = require('../../../../main/services/AgentHistoryService');

function writeJsonl(file, entries) {
  const text = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(file, text);
}

describe('AgentHistoryService', () => {
  let baseDir;
  let svc;
  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-history-'));
    svc = new AgentHistoryService();
    svc.initialize({ baseDir });
  });
  afterEach(() => {
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('running task (no task-end) WRITTEN AFTER initialize reports status running', () => {
    // Initialize already ran in beforeEach (and saw an empty dir). Writing
    // a still-running file after that point bypasses the sweep — so the row
    // genuinely IS in flight and rightly reports 'running'.
    writeJsonl(path.join(baseDir, 'task_9.jsonl'), [
      { kind: 'task-start', ts: 100, description: 'in progress', title: 'in progress' },
      { kind: 'step', ts: 150, step: 0, tools: [], results: [] },
    ]);
    expect(svc.open('task_9').status).toBe('running');
  });

  describe('sweepOrphans (orphaned-task recovery)', () => {
    test('initialize sweeps pre-existing task-start without task-end', () => {
      // Simulate a previous-session crash: write the file BEFORE initialize.
      const newDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-history-sweep-'));
      writeJsonl(path.join(newDir, 'task_orphan.jsonl'), [
        { kind: 'task-start', ts: 100, description: 'crashed run', title: 'crashed run' },
        { kind: 'step', ts: 150, step: 0, tools: [], results: [] },
      ]);
      const fresh = new AgentHistoryService();
      fresh.initialize({ baseDir: newDir });
      // Status now reads as 'failed' — task-end was synthesized with reason='orphaned'.
      expect(fresh.open('task_orphan').status).toBe('failed');
      // Verify the synthetic end event was actually appended on disk.
      const text = fs.readFileSync(path.join(newDir, 'task_orphan.jsonl'), 'utf8');
      expect(text).toMatch(/"kind":"task-end"/);
      expect(text).toMatch(/"reason":"orphaned"/);
      try { fs.rmSync(newDir, { recursive: true, force: true }); } catch (_) {}
    });

    test('sweepOrphans is idempotent — already-ended files are untouched', () => {
      const file = path.join(baseDir, 'task_done.jsonl');
      writeJsonl(file, [
        { kind: 'task-start', ts: 100, description: 'normal', title: 'normal' },
        { kind: 'task-end', ts: 200, ok: true, summary: 'done' },
      ]);
      const before = fs.readFileSync(file, 'utf8');
      const swept = svc.sweepOrphans();
      const after = fs.readFileSync(file, 'utf8');
      expect(swept).toBe(0);
      expect(after).toBe(before);
      expect(svc.open('task_done').status).toBe('ok');
    });

    test('sweepOrphans honors activeFilePaths so a live in-flight task is NOT swept', () => {
      const file = path.join(baseDir, 'task_live.jsonl');
      writeJsonl(file, [
        { kind: 'task-start', ts: 100, description: 'live', title: 'live' },
        { kind: 'step', ts: 150, step: 0, tools: [], results: [] },
      ]);
      const swept = svc.sweepOrphans({ activeFilePaths: [file] });
      expect(swept).toBe(0);
      const text = fs.readFileSync(file, 'utf8');
      expect(text).not.toMatch(/"kind":"task-end"/);
    });

    test('sweepOrphans returns count and only touches orphans', () => {
      writeJsonl(path.join(baseDir, 'a_done.jsonl'), [
        { kind: 'task-start', ts: 100 }, { kind: 'task-end', ts: 200, ok: true },
      ]);
      writeJsonl(path.join(baseDir, 'b_orphan.jsonl'), [
        { kind: 'task-start', ts: 300 }, { kind: 'step', ts: 400, step: 0 },
      ]);
      writeJsonl(path.join(baseDir, 'c_orphan.jsonl'), [
        { kind: 'task-start', ts: 500 },
      ]);
      const swept = svc.sweepOrphans();
      expect(swept).toBe(2);
      expect(svc.open('a_done').status).toBe('ok');
      expect(svc.open('b_orphan').status).toBe('failed');
      expect(svc.open('c_orphan').status).toBe('failed');
    });

    test('skipOrphanSweep:true bypasses the sweep (test escape hatch)', () => {
      const newDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-history-skip-'));
      writeJsonl(path.join(newDir, 'task_orphan.jsonl'), [
        { kind: 'task-start', ts: 100, description: 'orphan', title: 'orphan' },
      ]);
      const fresh = new AgentHistoryService();
      fresh.initialize({ baseDir: newDir, skipOrphanSweep: true });
      // Sweep didn't run → still appears as running.
      expect(fresh.open('task_orphan').status).toBe('running');
      try { fs.rmSync(newDir, { recursive: true, force: true }); } catch (_) {}
    });
  });

  test('open returns events and parsed metadata', () => {
    const file = path.join(baseDir, 'task_x.jsonl');
    writeJsonl(file, [
      { kind: 'task-start', ts: 1, description: 'hi', title: 'hi' },
      { kind: 'step', ts: 2, step: 0, tools: [{ id: 'a', name: 'browser.read_tab' }], results: [{ id: 'a', ok: true }] },
      { kind: 'task-end', ts: 3, ok: true, summary: 'all good', tokensUsed: 12, elapsedMs: 2 },
    ]);
    const run = svc.open('task_x');
    expect(run.id).toBe('task_x');
    expect(run.summary).toBe('all good');
    expect(run.status).toBe('ok');
    expect(run.events.length).toBe(3);
  });

  test('open reads the title and pin from the sidecar written by writeMeta', () => {
    writeJsonl(path.join(baseDir, 'task_m.jsonl'), [{ kind: 'task-start', ts: 1, description: 'original' }]);
    expect(svc.open('task_m')).toMatchObject({ title: 'original', pinned: false });
    svc.writeMeta('task_m', { title: 'Custom Title', pinned: true });
    expect(svc.open('task_m')).toMatchObject({ title: 'Custom Title', pinned: true });
    expect(fs.readFileSync(path.join(baseDir, 'task_m.jsonl'), 'utf8')).toContain('original');
  });

  test('open throws for a run that does not exist', () => {
    expect(() => svc.open('task_missing')).toThrow(/run not found/);
  });
});

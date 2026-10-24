const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWriter } = require('../../../../main/agent/actionLog');

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'actionlog-test-'));
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((s) => JSON.parse(s));
}

describe('actionLog JSONL writer', () => {
  test('writes task-start / step / task-end entries', () => {
    const dir = makeDir();
    const w = createWriter({ taskId: 't1', baseDir: dir });
    w.logTaskStart({ description: 'go', mode: { name: 'balanced' }, budget: { maxSteps: 5 }, webContentsId: 7 });
    w.logStep({
      step: 0, url: 'https://a.com',
      toolCalls: [{ id: 'c1', name: 'browser.snapshot_ax', args: {} }],
      results: [{ id: 'c1', name: 'browser.snapshot_ax', result: { ok: true, elementCount: 3 } }],
      latencyMs: 120, tokens: 450,
    });
    w.logTaskEnd({ ok: true, summary: 'done' });

    const lines = readLines(w.filePath);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ kind: 'task-start', description: 'go', mode: 'balanced' });
    expect(lines[1]).toMatchObject({ kind: 'step', step: 0, url: 'https://a.com' });
    expect(lines[1].tools[0]).toMatchObject({ name: 'browser.snapshot_ax' });
    expect(lines[2]).toMatchObject({ kind: 'task-end', ok: true, tokensUsed: 450, steps: 1 });
  });

  test('counts navigations across steps', () => {
    const w = createWriter({ taskId: 't-nav', baseDir: makeDir() });
    w.logTaskStart({ description: 'nav', mode: { name: 'balanced' }, budget: {}, webContentsId: 1 });
    w.logStep({
      step: 0, url: 'u',
      toolCalls: [
        { id: 'a', name: 'browser.navigate', args: { url: 'https://a' } },
        { id: 'b', name: 'browser.open_tab', args: { url: 'https://b' } },
        { id: 'c', name: 'browser.click_idx', args: { idx: 0 } },
      ],
      results: [
        { id: 'a', name: 'browser.navigate', result: { ok: true } },
        { id: 'b', name: 'browser.open_tab', result: { ok: true, spaceId: 't' } },
        { id: 'c', name: 'browser.click_idx', result: { ok: true } },
      ],
      latencyMs: 10, tokens: 100,
    });
    expect(w.navigations).toBe(2);
    expect(w.tokensUsed).toBe(100);
    expect(w.stepsCompleted).toBe(1);
  });

  test('logApproval and logBudget write kind rows', () => {
    const w = createWriter({ taskId: 't-app', baseDir: makeDir() });
    w.logApproval({ call: { name: 'browser.close_tab' }, decision: 'reject', actionClass: 'destructive', origin: 'https://a', reason: 'user' });
    w.logBudget({ reason: 'maxSteps', usage: { steps: 30 }, budget: { maxSteps: 30 } });
    const lines = readLines(w.filePath);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ kind: 'approval', tool: 'browser.close_tab', decision: 'reject' });
    expect(lines[1]).toMatchObject({ kind: 'budget-breach', reason: 'maxSteps' });
  });

  test('logStep preview truncates large result payloads', () => {
    const w = createWriter({ taskId: 't-big', baseDir: makeDir() });
    const huge = 'x'.repeat(10000);
    w.logStep({
      step: 0, url: 'u',
      toolCalls: [{ id: '1', name: 't', args: {} }],
      results: [{ id: '1', name: 't', result: { ok: true, data: huge } }],
      latencyMs: 1, tokens: 0,
    });
    const [line] = readLines(w.filePath);
    expect(line.results[0].preview.length).toBeLessThan(huge.length);
    expect(line.results[0].preview).toContain('truncated');
  });

  test('logTaskEnd marks writer closed — subsequent writes are no-ops', () => {
    const w = createWriter({ taskId: 't-end', baseDir: makeDir() });
    w.logTaskEnd({ ok: false, reason: 'stopped' });
    w.logStep({ step: 1, url: 'u', toolCalls: [], results: [], latencyMs: 1, tokens: 0 });
    const lines = readLines(w.filePath);
    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe('task-end');
  });
});

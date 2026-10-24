// ToolStream — header status semantics.
//
// Locks in the "transient tool failures don't brand the whole conversation"
// contract: the stream-level "failed" pill and .has-failure CSS class apply
// ONLY when the overall task ended in failure (setOverallStatus('failed')).
// Mid-run or recovered failures are surfaced as "N step(s) with errors" — a
// neutral count, not a failure banner.

jest.mock('electron', () => ({}), { virtual: true });

const ToolStream = require('../../../../../renderer/components/agent/ToolStream');

function setup() {
  document.body.innerHTML = '';
  const root = document.createElement('ul');
  document.body.appendChild(root);
  return new ToolStream({ root });
}

function planAndAct(stream, step, calls, results, latencyMs = 100) {
  stream.addStepPlanned({ step, calls });
  stream.setStepResults({ step, calls, results, latencyMs });
}

const goodCall = { id: 'a', name: 'browser.read_tab', args: {} };
const goodResult = { id: 'a', name: 'browser.read_tab', result: { ok: true } };
const badCall = { id: 'b', name: 'browser.click', args: {} };
const badResult = { id: 'b', name: 'browser.click', result: { ok: false, error: 'not_found' } };

describe('ToolStream header — overall status semantics', () => {
  test('mid-run with all-OK calls shows neither failure flag nor recovered note', () => {
    const stream = setup();
    planAndAct(stream, 0, [goodCall], [goodResult]);
    stream.markAllFinished();
    const meta = document.querySelector('.agent-tool-stream-meta').textContent;
    expect(meta).not.toMatch(/failed|errors/);
    expect(document.querySelector('.agent-tool-stream').classList.contains('has-failure')).toBe(false);
  });

  test('task ended OK with intermediate tool failures: "with errors" note, NO has-failure flag', () => {
    const stream = setup();
    planAndAct(stream, 0, [badCall], [badResult]);    // step 1: tool failed
    planAndAct(stream, 1, [goodCall], [goodResult]); // step 2: agent recovered
    stream.markAllFinished();
    stream.setOverallStatus('ok'); // task itself completed via agent.done
    const meta = document.querySelector('.agent-tool-stream-meta').textContent;
    expect(meta).toMatch(/1 step with errors/);
    expect(meta).not.toMatch(/\bfailed\b/);
    // Whole-stream red flag is NOT set for recovered failures.
    expect(document.querySelector('.agent-tool-stream').classList.contains('has-failure')).toBe(false);
    // BUT the individual failed call AND the failing step retain their own flags.
    expect(document.querySelectorAll('.agent-tool-stream-step.has-failure').length).toBe(1);
    expect(document.querySelectorAll('.agent-tool-stream-call.is-err').length).toBe(1);
  });

  test('task ended FAILED: header says "failed" and stream gets has-failure flag', () => {
    const stream = setup();
    planAndAct(stream, 0, [badCall], [badResult]);
    stream.markAllFinished();
    stream.setOverallStatus('failed');
    const meta = document.querySelector('.agent-tool-stream-meta').textContent;
    expect(meta).toMatch(/\bfailed\b/);
    expect(document.querySelector('.agent-tool-stream').classList.contains('has-failure')).toBe(true);
  });

  test('counts steps-with-errors, not individual failed calls', () => {
    const stream = setup();
    // Step 0: two failed calls in the same step → ONE step-with-errors.
    planAndAct(stream, 0,
      [badCall, { id: 'c', name: 'browser.click', args: {} }],
      [badResult, { id: 'c', name: 'browser.click', result: { ok: false, error: 'oops' } }]);
    planAndAct(stream, 1, [goodCall], [goodResult]);
    stream.markAllFinished();
    stream.setOverallStatus('ok');
    expect(document.querySelector('.agent-tool-stream-meta').textContent).toMatch(/1 step with errors/);
  });

  test('multiple steps with errors pluralizes correctly', () => {
    const stream = setup();
    planAndAct(stream, 0, [badCall], [badResult]);
    planAndAct(stream, 1, [badCall], [badResult]);
    planAndAct(stream, 2, [goodCall], [goodResult]);
    stream.markAllFinished();
    stream.setOverallStatus('ok');
    expect(document.querySelector('.agent-tool-stream-meta').textContent).toMatch(/2 steps with errors/);
  });

  test('setOverallStatus is idempotent and re-renders', () => {
    const stream = setup();
    planAndAct(stream, 0, [badCall], [badResult]);
    stream.markAllFinished();
    stream.setOverallStatus('failed');
    expect(document.querySelector('.agent-tool-stream').classList.contains('has-failure')).toBe(true);
    // Caller corrects: it actually succeeded after recovery.
    stream.setOverallStatus('ok');
    expect(document.querySelector('.agent-tool-stream').classList.contains('has-failure')).toBe(false);
    expect(document.querySelector('.agent-tool-stream-meta').textContent).toMatch(/1 step with errors/);
  });

  test('scrollToBottom() re-arms tail-follow even if user scrolled up earlier', () => {
    const stream = setup();
    planAndAct(stream, 0, [goodCall], [goodResult]);
    const body = document.querySelector('.agent-tool-stream-body');
    // Simulate user scrolled up — would normally turn off tail-follow.
    Object.defineProperty(body, 'scrollHeight', { value: 1000, configurable: true });
    body.scrollTop = 0;
    body.dispatchEvent(new Event('scroll'));
    expect(stream._followBottom).toBe(false);
    // History reopen calls scrollToBottom — must re-arm the follow flag so
    // the user lands on the latest entry.
    stream.scrollToBottom();
    expect(stream._followBottom).toBe(true);
  });

  test('mid-run (no overall status set) shows failure count but never "failed"', () => {
    const stream = setup();
    planAndAct(stream, 0, [badCall], [badResult]);  // step 0 finished, failed
    stream.addStepPlanned({ step: 1, calls: [goodCall] }); // step 1 still running
    const meta = document.querySelector('.agent-tool-stream-meta').textContent;
    // running… because step 1 hasn't received results yet
    expect(meta).toMatch(/running…/);
    expect(meta).not.toMatch(/\bfailed\b/);
    // Step 0 had a failure → counted, but stream isn't branded failed.
    expect(meta).toMatch(/1 step with errors/);
    expect(document.querySelector('.agent-tool-stream').classList.contains('has-failure')).toBe(false);
  });
});

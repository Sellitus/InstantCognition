// ReindexScheduler — pure debounce timer bookkeeping. No Electron deps.
// Verifies coalescing, immediate flush preemption, cancel, and that a
// throwing reindex does not crash the timer callback (errors swallowed).

const { ReindexScheduler } = require('../../../../main/services/semanticReindexScheduler');

describe('ReindexScheduler', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('a burst of schedule() calls coalesces into one reindex', () => {
    const reindex = jest.fn(() => Promise.resolve({ ok: true }));
    const s = new ReindexScheduler(reindex, 30000);
    for (let i = 0; i < 5; i++) {
      s.schedule();
      jest.advanceTimersByTime(5000); // 4s apart, all within the 30s window
    }
    expect(reindex).not.toHaveBeenCalled();
    expect(s.isPending()).toBe(true);
    jest.advanceTimersByTime(30000);
    expect(reindex).toHaveBeenCalledTimes(1);
    expect(s.isPending()).toBe(false);
  });

  test('flush() runs immediately and preempts a pending debounce', () => {
    const reindex = jest.fn(() => Promise.resolve({ ok: true }));
    const s = new ReindexScheduler(reindex, 30000);
    s.schedule();
    expect(s.isPending()).toBe(true);
    jest.advanceTimersByTime(5000);
    // An explicit reindex mid-debounce should win and clear the timer.
    return s.flush().then(() => {
      expect(reindex).toHaveBeenCalledTimes(1);
      expect(s.isPending()).toBe(false);
      // Advancing past the original window must not fire a second reindex.
      jest.advanceTimersByTime(30000);
      expect(reindex).toHaveBeenCalledTimes(1);
    });
  });

  test('cancel() clears a pending debounce', () => {
    const reindex = jest.fn();
    const s = new ReindexScheduler(reindex, 30000);
    s.schedule();
    expect(s.isPending()).toBe(true);
    s.cancel();
    expect(s.isPending()).toBe(false);
    jest.advanceTimersByTime(60000);
    expect(reindex).not.toHaveBeenCalled();
  });

  test('a reindex that throws does not crash the timer callback', () => {
    const reindex = jest.fn(() => Promise.reject(new Error('boom')));
    const s = new ReindexScheduler(reindex, 1000);
    s.schedule();
    // Should not throw out of advanceTimers (the callback swallows rejections).
    expect(() => jest.advanceTimersByTime(1000)).not.toThrow();
    expect(reindex).toHaveBeenCalledTimes(1);
  });

  test('schedule() resets the debounce window on each call (latest-wins)', () => {
    const reindex = jest.fn(() => Promise.resolve({ ok: true }));
    const s = new ReindexScheduler(reindex, 30000);
    s.schedule();
    jest.advanceTimersByTime(20000); // 20s in — would fire at 30s
    s.schedule(); // resets: now fires 30s from here
    jest.advanceTimersByTime(25000); // 45s total — still not fired (would have at 30s without reset)
    expect(reindex).not.toHaveBeenCalled();
    jest.advanceTimersByTime(5000); // 50s total — 30s since the last schedule
    expect(reindex).toHaveBeenCalledTimes(1);
  });
});

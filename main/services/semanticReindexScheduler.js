// semanticReindexScheduler — debounce timer for SemanticIndexService auto-reindex.
// Extracted to keep the service under its line-count cap. Pure timer bookkeeping:
// schedule() resets the debounce on each call; flush() runs immediately and
// preempts a pending debounce; cancel() clears it. The caller supplies the
// async reindex action; this module never imports the service (avoids a cycle).

class ReindexScheduler {
  constructor(reindexFn, delayMs = 30000) {
    this._reindex = reindexFn;
    this._delay = delayMs;
    this._timer = null;
    this._pending = false;
  }

  // Debounce: a burst of calls coalesces into one reindex after delayMs of quiet.
  // No-op when already pending — the timer just resets.
  schedule() {
    if (this._timer) clearTimeout(this._timer);
    this._pending = true;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._pending = false;
      Promise.resolve(this._reindex()).catch((err) => {
        // Logged, not re-thrown: the auto-reindex runs on a detached timer
        // with no caller to surface the error; the explicit browsing:reindex
        // path returns errors to the caller for real diagnosis.
        console.error('[SemanticIndexService] auto-reindex failed:', (err instanceof Error && err.message) || err);
      });
    }, this._delay);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
  }

  // Run immediately and clear any pending debounce. Used by explicit reindex.
  async flush() {
    this.cancel();
    return this._reindex();
  }

  cancel() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._pending = false;
  }

  isPending() { return this._pending; }
}

module.exports = { ReindexScheduler };

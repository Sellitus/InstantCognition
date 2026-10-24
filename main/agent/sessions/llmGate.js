// llmGate — counting semaphore over the chatCompletion* family, shared by
// every LLM consumer (foreground agent, background sessions, chat lane) so
// concurrent sessions never push more requests at the engine than it has
// slots. A local server with one slot otherwise evicts its prompt cache on
// every interleaved request.
//
// wrap(client) returns a view of the client whose chatCompletion,
// chatCompletionRouted and chatCompletionStream hold a slot for the request's
// lifetime (a stream holds it until the consumer stops iterating). Methods the
// client lacks stay absent, so feature checks like
// `typeof llm.chatCompletionStream === 'function'` still see the truth.
// A wait for a slot honors opts.signal.
//
// The limit is read on every acquire, so a settings change applies to the
// next request. 'auto' = 4 for a remote endpoint, else 1: the local engines
// are launched without an explicit slot count, so one slot is the only
// figure that is known to hold.

const GATED = new Set(['chatCompletion', 'chatCompletionRouted', 'chatCompletionStream']);
const MAX_LIMIT = 16;
const REMOTE_AUTO_LIMIT = 4;

function abortError(signal) {
  const reason = signal && signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/** @param {any} setting settings.llm.agent.sessions.llmConcurrency @param {boolean} isRemote */
function resolveLimit(setting, isRemote) {
  const n = Number(setting);
  if (setting !== 'auto' && Number.isFinite(n) && n >= 1) return Math.min(MAX_LIMIT, Math.floor(n));
  return isRemote ? REMOTE_AUTO_LIMIT : 1;
}

function createGate(opts = {}) {
  let limitFn = typeof opts.limit === 'function' ? opts.limit : () => 1;
  let active = 0;
  /** @type {Array<{ grant: () => void }>} */
  const waiters = [];

  function limit() {
    const n = Number(limitFn());
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  }

  function makeRelease() {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      active--;
      pump();
    };
  }

  function pump() {
    while (waiters.length && active < limit()) {
      const w = waiters.shift();
      active++;
      w.grant();
    }
  }

  /** Non-blocking: a release function, or null when every slot is taken. */
  function tryAcquire() {
    if (active >= limit()) return null;
    active++;
    return makeRelease();
  }

  /** @param {AbortSignal} [signal] @returns {Promise<() => void>} */
  function acquire(signal) {
    if (signal && signal.aborted) return Promise.reject(abortError(signal));
    const now = tryAcquire();
    if (now) return Promise.resolve(now);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
        reject(abortError(signal));
      };
      const waiter = {
        grant: () => {
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve(makeRelease());
        },
      };
      waiters.push(waiter);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function isSaturated() { return active >= limit(); }

  function stats() { return { active, waiting: waiters.length, limit: limit() }; }

  function configure(next = {}) {
    if (typeof next.limit === 'function') limitFn = next.limit;
    pump();
  }

  function gatedMethod(target, name) {
    if (name === 'chatCompletionStream') {
      return async function* gatedStream(messages, o) {
        const release = await acquire(o && o.signal);
        try { yield* target.chatCompletionStream(messages, o); } finally { release(); }
      };
    }
    return async (...args) => {
      const o = args[1];
      const release = await acquire(o && o.signal);
      try { return await target[name](...args); } finally { release(); }
    };
  }

  function wrap(client) {
    if (!client || typeof client !== 'object') throw new Error('client required');
    return new Proxy(client, {
      get(target, prop) {
        const v = target[prop];
        if (typeof prop === 'string' && GATED.has(prop) && typeof v === 'function') return gatedMethod(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  }

  return { acquire, tryAcquire, isSaturated, stats, configure, wrap };
}

// Process-wide gate: every LLM consumer must share one instance.
const gate = createGate();

module.exports = { createGate, gate, resolveLimit, REMOTE_AUTO_LIMIT };

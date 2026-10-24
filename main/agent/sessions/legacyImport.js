// legacyImport — one-time copy of pre-session agent runs (AgentHistoryService
// .jsonl logs) into the session store, so earlier work shows up in the
// session list. Each run becomes a session holding the task and its final
// summary.
//
// Idempotent twice over: a marker file records the completed import, and each
// run maps to a deterministic session id, so an interrupted import that runs
// again skips the runs it already copied. Per-run failures are returned (and
// recorded in the marker), never dropped.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MARKER = '.legacy-import.json';

function legacySessionId(runId) {
  return `s_${crypto.createHash('sha1').update(String(runId)).digest('hex').slice(0, 20)}`;
}

/**
 * @param {import('./sessionStore').SessionStore} store
 * @param {{ getBaseDir: () => string, open: (id: string) => any }} history AgentHistoryService
 * @returns {{ skipped: boolean, imported: number, existing: number, failed: Array<{ runId: string, error: string }> }}
 */
function importLegacyRuns(store, history) {
  const marker = path.join(store.getBaseDir(), MARKER);
  if (fs.existsSync(marker)) return { skipped: true, imported: 0, existing: 0, failed: [] };
  const runsDir = history.getBaseDir();
  let files = [];
  try { files = fs.readdirSync(runsDir).filter((f) => f.endsWith('.jsonl')); } catch (err) {
    if (/** @type {any} */ (err).code !== 'ENOENT') throw err;
  }
  let imported = 0;
  let existing = 0;
  const failed = [];
  for (const file of files) {
    const runId = path.basename(file, '.jsonl');
    const id = legacySessionId(runId);
    if (store.exists(id)) { existing++; continue; }
    try {
      const run = history.open(runId);
      store.create({
        id, title: String(run.title || run.description || runId).slice(0, 120), source: 'legacy',
        legacyRunId: runId, pinned: !!run.pinned, createdAt: Number.isFinite(run.startedAt) ? run.startedAt : undefined,
      });
      if (run.description) store.append(id, { role: 'user', content: String(run.description), data: { legacyRunId: runId } });
      if (run.summary) store.append(id, { role: 'assistant', content: String(run.summary), data: { legacyRunId: runId, status: run.status } });
      else store.append(id, { role: 'assistant', kind: 'error', content: `Run ended without a summary (${run.status || 'unknown'}).`, data: { legacyRunId: runId, status: run.status } });
      imported++;
    } catch (err) {
      // A half-written session would read as "already imported" on the next run.
      if (store.exists(id)) store.delete(id);
      failed.push({ runId, error: (err instanceof Error && err.message) || String(err) });
    }
  }
  fs.mkdirSync(store.getBaseDir(), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ importedAt: Date.now(), imported, existing, failed }));
  if (failed.length) console.error(`[legacyImport] ${failed.length} legacy run(s) failed to import`);
  return { skipped: false, imported, existing, failed };
}

module.exports = { importLegacyRuns, legacySessionId, MARKER };

// Routine schema — the JSON shape of a scheduled agent Routine.
//
// A Routine is a saved agent task prompt plus a recurrence schedule. The
// scheduler re-runs the task (fresh, in the isolated agent workspace) when it
// comes due — e.g. "every morning, open these sites and build a digest".
//
// Schedules are deliberately limited to interval (every N minutes) and daily
// (at HH:MM local) — full cron is a maintenance liability for a desktop app
// and unnecessary for the real use cases. All time functions are pure and
// take `nowMs` so they unit-test without timers.

const REQUIRED_FIELDS = ['name', 'task'];
const MIN_INTERVAL_MIN = 5;

function validateRoutine(r) {
  const errors = [];
  if (!r || typeof r !== 'object') return { ok: false, errors: ['not_object'] };
  for (const f of REQUIRED_FIELDS) {
    if (typeof r[f] !== 'string' || !r[f].trim()) errors.push(`missing:${f}`);
  }
  const s = r.schedule;
  if (!s || typeof s !== 'object') {
    errors.push('missing:schedule');
  } else if (!['interval', 'daily'].includes(s.kind)) {
    errors.push('enum:schedule.kind');
  } else if (s.kind === 'interval') {
    if (!Number.isFinite(s.everyMinutes) || s.everyMinutes < MIN_INTERVAL_MIN) errors.push('range:everyMinutes');
  } else if (s.kind === 'daily') {
    if (!Number.isInteger(s.atHour) || s.atHour < 0 || s.atHour > 23) errors.push('range:atHour');
    if (!Number.isInteger(s.atMinute) || s.atMinute < 0 || s.atMinute > 59) errors.push('range:atMinute');
  }
  return { ok: errors.length === 0, errors };
}

function slug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'routine';
}

function normalizeRoutine(r) {
  const src = r || {};
  const s = src.schedule || {};
  const kind = s.kind === 'daily' ? 'daily' : 'interval';
  const schedule = kind === 'daily'
    ? { kind: 'daily', atHour: clampInt(s.atHour, 0, 23, 8), atMinute: clampInt(s.atMinute, 0, 59, 0) }
    : { kind: 'interval', everyMinutes: Math.max(MIN_INTERVAL_MIN, Math.round(Number(s.everyMinutes) || 60)) };
  return {
    id: String(src.id || '').trim() || slug(src.name),
    name: String(src.name || '').trim(),
    task: String(src.task || '').trim(),
    schedule,
    enabled: src.enabled !== false,
    lastRunAt: Number.isFinite(src.lastRunAt) ? src.lastRunAt : null,
    createdAt: Number.isFinite(src.createdAt) ? src.createdAt : 0,
    version: src.version || 1,
  };
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

// Local-time timestamp (ms) for today's HH:MM relative to nowMs.
function dailyTargetMs(nowMs, atHour, atMinute) {
  const d = new Date(nowMs);
  d.setHours(atHour, atMinute, 0, 0);
  return d.getTime();
}

// Is this routine due to run at nowMs? Pure — caller supplies the clock.
function isDue(routine, nowMs) {
  const r = normalizeRoutine(routine);
  if (!r.enabled) return false;
  if (r.schedule.kind === 'interval') {
    if (r.lastRunAt == null) return true; // first run fires on the next tick
    return (nowMs - r.lastRunAt) >= r.schedule.everyMinutes * 60000;
  }
  // daily: due once the scheduled minute has passed today and we haven't run
  // since that moment (covers the "app was closed at 8:00, opened at 9:15"
  // missed-digest case — it still fires on launch).
  const target = dailyTargetMs(nowMs, r.schedule.atHour, r.schedule.atMinute);
  if (nowMs < target) return false;
  return r.lastRunAt == null || r.lastRunAt < target;
}

// Next scheduled run timestamp (ms) — informational, for the settings UI.
function computeNextRun(routine, nowMs) {
  const r = normalizeRoutine(routine);
  if (r.schedule.kind === 'interval') {
    const base = r.lastRunAt == null ? nowMs : r.lastRunAt;
    return base + r.schedule.everyMinutes * 60000;
  }
  const target = dailyTargetMs(nowMs, r.schedule.atHour, r.schedule.atMinute);
  return nowMs < target ? target : target + 86400000;
}

function describeSchedule(routine) {
  const r = normalizeRoutine(routine);
  if (r.schedule.kind === 'interval') {
    const m = r.schedule.everyMinutes;
    if (m % 60 === 0) { const h = m / 60; return `Every ${h} hour${h === 1 ? '' : 's'}`; }
    return `Every ${m} minutes`;
  }
  const hh = String(r.schedule.atHour).padStart(2, '0');
  const mm = String(r.schedule.atMinute).padStart(2, '0');
  return `Daily at ${hh}:${mm}`;
}

module.exports = {
  validateRoutine,
  normalizeRoutine,
  isDue,
  computeNextRun,
  describeSchedule,
  REQUIRED_FIELDS,
  MIN_INTERVAL_MIN,
};

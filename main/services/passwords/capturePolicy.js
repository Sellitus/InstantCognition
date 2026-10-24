// capturePolicy — decides whether a login submit reported by a guest page
// becomes a save offer. The origin is the one main read from the sender
// frame; nothing in the page's payload can choose it.

const { detectPrivateIpRange, stripIpv6Brackets } = require('../../../shared/privateIp');
const { errMsg } = require('../../../shared/errMsg');

const MAX_USERNAME = 512;
const MAX_PASSWORD = 4096;

function isLoopbackHost(hostname) {
  const host = stripIpv6Brackets(String(hostname || '')).toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const range = detectPrivateIpRange(host);
  return range === 'loopback' || range === 'ipv6Loopback';
}

/**
 * The origin when logins may be saved for it: https anywhere, http only on
 * loopback. Returns null for anything else, including a full URL.
 * @param {unknown} origin
 * @returns {string|null}
 */
function loginOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return null;
  let u;
  try {
    u = new URL(origin);
  } catch (_) {
    return null; // new URL() throwing is the "not an origin" answer.
  }
  if (u.origin !== origin) return null;
  if (u.protocol === 'https:') return origin;
  if (u.protocol === 'http:' && isLoopbackHost(u.hostname)) return origin;
  return null;
}

// One undecryptable entry must not block every capture on the origin; it is
// reported and counted as differing, so the user is offered to replace it.
function sameSecret(store, id, password) {
  try {
    return store.matches(id, password);
  } catch (err) {
    console.error(`[PasswordService] could not decrypt saved login ${id}; treating it as changed:`, errMsg(err));
    return false;
  }
}

// A submit with no username is usually the password step of a two-step
// sign-in, so it may belong to any account on the origin. It only updates the
// unnamed login when that is the origin's sole login; otherwise it is a new
// entry and can never overwrite another account.
/** @returns {{ action: 'skip', reason: string } | { action: 'save' } | { action: 'update', existingId: string }} */
function decideUnnamed(origin, password, store) {
  const logins = store.forOrigin(origin);
  if (logins.some((l) => sameSecret(store, l.id, password))) return { action: 'skip', reason: 'unchanged' };
  if (logins.length === 1 && logins[0].username === '') return { action: 'update', existingId: logins[0].id };
  return { action: 'save' };
}

/**
 * @param {{ origin: string, persistent: boolean, offerEnabled: boolean, certificateError?: boolean, username: unknown, password: unknown }} input
 * @param {typeof import('./passwordStore')} store
 * @returns {{ action: 'skip', reason: string } | { action: 'unavailable', reason: string } | { action: 'save' } | { action: 'update', existingId: string }}
 */
function decideCapture(input, store) {
  if (!input.offerEnabled) return { action: 'skip', reason: 'disabled' };
  if (!input.persistent) return { action: 'skip', reason: 'private' };
  if (input.certificateError) return { action: 'skip', reason: 'certificate-error' };
  const origin = loginOrigin(input.origin);
  if (!origin) return { action: 'skip', reason: 'insecure-origin' };
  const { username, password } = input;
  if (typeof username !== 'string' || typeof password !== 'string' || !password
    || username.length > MAX_USERNAME || password.length > MAX_PASSWORD) {
    return { action: 'skip', reason: 'invalid' };
  }
  if (store.isNeverSave(origin)) return { action: 'skip', reason: 'never-save' };
  const status = store.status();
  if (!status.available) return { action: 'unavailable', reason: status.reason };
  if (!username) return decideUnnamed(origin, password, store);
  const existing = store.findLogin(origin, username);
  if (!existing) return { action: 'save' };
  if (sameSecret(store, existing.id, password)) return { action: 'skip', reason: 'unchanged' };
  return { action: 'update', existingId: existing.id };
}

module.exports = { decideCapture, loginOrigin, isLoopbackHost };

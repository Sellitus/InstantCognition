/**
 * @fileoverview Update check against GitHub Releases.
 *
 * Reachable from Settings via the `updater:check-now` IPC channel. It only
 * reports whether a newer release exists; installing one is a manual download,
 * so nothing here mutates the installed app.
 *
 * @module updater
 */

const { errMsg } = require('./shared/errMsg');

const RELEASES_REPO = 'daemon-summoner/InstantCognition';

// Parse a release tag ("v1.6.3" / "1.6.3-beta.2") into comparable parts.
function parseVersion(tag) {
  const m = String(tag || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

// >0 if a is newer than b, <0 if older, 0 if equal. A final release outranks
// the same x.y.z carrying a prerelease tag (1.0.0 > 1.0.0-beta), matching semver.
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] - pb[k];
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

// Query GitHub Releases for a build newer than currentVersion. channel 'beta'
// includes pre-releases; 'stable' considers only full releases (the real effect
// of the Update channel setting). Network/parse failures return { ok:false } so
// the caller surfaces a visible error rather than silently doing nothing.
/**
 * @param {{ channel?: string, currentVersion?: string, fetchImpl?: typeof fetch }} [opts]
 */
async function checkForUpdates({ channel = 'stable', currentVersion, fetchImpl } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { ok: false, error: 'Network is unavailable in this build.' };
  if (!currentVersion) return { ok: false, error: 'Current app version is unknown.' };
  let releases;
  try {
    const res = await doFetch(`https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=30`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'InstantCognition' },
    });
    if (!res.ok) return { ok: false, error: `GitHub responded ${res.status}.` };
    releases = await res.json();
  } catch (err) {
    return { ok: false, error: errMsg(err) || 'Could not reach the update server.' };
  }
  if (!Array.isArray(releases)) return { ok: false, error: 'Unexpected response from the update server.' };
  const allowPrerelease = channel === 'beta';
  const candidates = releases
    .filter((r) => r && !r.draft && (allowPrerelease || !r.prerelease))
    .map((r) => ({ version: String(r.tag_name || '').replace(/^v/i, ''), url: r.html_url, prerelease: !!r.prerelease }))
    .filter((r) => parseVersion(r.version));
  if (!candidates.length) return { ok: true, status: 'up-to-date', currentVersion, channel };
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  const latest = candidates[0];
  if (compareVersions(latest.version, currentVersion) > 0) {
    return { ok: true, status: 'update-available', currentVersion, channel, version: latest.version, url: latest.url, prerelease: latest.prerelease };
  }
  return { ok: true, status: 'up-to-date', currentVersion, channel };
}

module.exports = { checkForUpdates, parseVersion, compareVersions };

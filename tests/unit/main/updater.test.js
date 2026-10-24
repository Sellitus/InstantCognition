// updater.checkForUpdates — the real behavior behind the "Update channel"
// setting + "Check for updates" button. Mocks only the network boundary
// (fetchImpl); version comparison and channel filtering run for real.

const { checkForUpdates, parseVersion, compareVersions } = require('../../../updater');

function fetchReturning(body, { ok = true, status = 200 } = {}) {
  return jest.fn(async () => ({ ok, status, json: async () => body }));
}

const rel = (tag, prerelease = false, draft = false) => ({
  tag_name: tag, prerelease, draft, html_url: `https://github.com/x/releases/${tag}`,
});

describe('updater version helpers', () => {
  test('parseVersion strips a leading v and splits prerelease', () => {
    expect(parseVersion('v1.6.3')).toEqual({ major: 1, minor: 6, patch: 3, pre: '' });
    expect(parseVersion('1.6.3-beta.2')).toEqual({ major: 1, minor: 6, patch: 3, pre: 'beta.2' });
    expect(parseVersion('not-a-version')).toBeNull();
  });

  test('compareVersions orders by major/minor/patch then prerelease rank', () => {
    expect(compareVersions('1.6.3', '1.6.2')).toBeGreaterThan(0);
    expect(compareVersions('1.6.2', '1.7.0')).toBeLessThan(0);
    expect(compareVersions('1.6.3', '1.6.3')).toBe(0);
    // A final release outranks the same x.y.z carrying a prerelease tag.
    expect(compareVersions('1.6.3', '1.6.3-beta.1')).toBeGreaterThan(0);
    expect(compareVersions('1.6.3-beta.1', '1.6.3')).toBeLessThan(0);
  });
});

describe('updater.checkForUpdates', () => {
  test('stable channel ignores pre-releases and reports a newer full release', async () => {
    const fetchImpl = fetchReturning([rel('v1.7.0-beta.1', true), rel('v1.6.3'), rel('v1.6.2')]);
    const r = await checkForUpdates({ channel: 'stable', currentVersion: '1.6.2', fetchImpl });
    expect(r).toMatchObject({ ok: true, status: 'update-available', version: '1.6.3', prerelease: false });
    expect(r.url).toContain('1.6.3');
  });

  test('beta channel offers the pre-release when it is the newest build', async () => {
    const fetchImpl = fetchReturning([rel('v1.7.0-beta.1', true), rel('v1.6.3'), rel('v1.6.2')]);
    const r = await checkForUpdates({ channel: 'beta', currentVersion: '1.6.3', fetchImpl });
    expect(r).toMatchObject({ ok: true, status: 'update-available', version: '1.7.0-beta.1', prerelease: true });
  });

  test('stable channel is up-to-date when only newer builds are pre-releases', async () => {
    const fetchImpl = fetchReturning([rel('v1.7.0-beta.1', true), rel('v1.6.2')]);
    const r = await checkForUpdates({ channel: 'stable', currentVersion: '1.6.2', fetchImpl });
    expect(r).toMatchObject({ ok: true, status: 'up-to-date', currentVersion: '1.6.2' });
  });

  test('draft releases are never offered', async () => {
    const fetchImpl = fetchReturning([rel('v2.0.0', false, true), rel('v1.6.2')]);
    const r = await checkForUpdates({ channel: 'beta', currentVersion: '1.6.2', fetchImpl });
    expect(r.status).toBe('up-to-date');
  });

  test('a non-2xx GitHub response surfaces a visible error (no silent no-op)', async () => {
    const fetchImpl = fetchReturning([], { ok: false, status: 403 });
    const r = await checkForUpdates({ channel: 'stable', currentVersion: '1.6.2', fetchImpl });
    expect(r).toEqual({ ok: false, error: 'GitHub responded 403.' });
  });

  test('a network throw surfaces a visible error', async () => {
    const fetchImpl = jest.fn(async () => { throw new Error('ENOTFOUND'); });
    const r = await checkForUpdates({ channel: 'stable', currentVersion: '1.6.2', fetchImpl });
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toContain('ENOTFOUND');
  });

  test('a missing current version fails loud rather than guessing', async () => {
    const fetchImpl = fetchReturning([rel('v1.6.3')]);
    const r = await checkForUpdates({ channel: 'stable', currentVersion: '', fetchImpl });
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('updater release source', () => {
  // electron-updater reads the feed from package.json build.publish and the
  // release workflow publishes there; this check must ask the same repo.
  test('queries the repository the build publishes releases to', async () => {
    const { owner, repo } = require('../../../package.json').build.publish[0];
    const fetchImpl = fetchReturning([]);
    await checkForUpdates({ channel: 'stable', currentVersion: '1.0.0', fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=30`);
  });
});

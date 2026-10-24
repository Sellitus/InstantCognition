// engineRelease — release-metadata logic shared by the build-time fetch script
// and the runtime engine updater. Both pick assets and compare versions from
// this module, so a bug here either bundles the wrong binary or hides an update.

const {
  llamaBinaryName, pickLlamaAsset, parseBuildNumber, parseNightlyTag,
  isNewerLlamaBuild, compareVersionStrings, isStableTag, newestStableRelease,
} = require('../../../shared/engineRelease');

const ASSETS = [
  { name: 'llama-b10831-bin-macos-arm64.zip' },
  { name: 'llama-b10831-bin-macos-x64.zip' },
  { name: 'llama-b10831-bin-ubuntu-x64.zip' },
  { name: 'llama-b10831-bin-ubuntu-arm64.zip' },
  { name: 'llama-b10831-bin-win-cpu-x64.zip' },
  { name: 'llama-b10831-bin-win-cpu-arm64.zip' },
  { name: 'llama-b10831-bin-win-cuda-12.4-x64.zip' },
];

describe('llamaBinaryName', () => {
  test('windows gets the .exe name', () => {
    expect(llamaBinaryName('win32')).toBe('llama-server.exe');
    expect(llamaBinaryName('darwin')).toBe('llama-server');
  });
});

describe('pickLlamaAsset', () => {
  test.each([
    ['darwin', 'arm64', 'llama-b10831-bin-macos-arm64.zip'],
    ['darwin', 'x64', 'llama-b10831-bin-macos-x64.zip'],
    ['linux', 'x64', 'llama-b10831-bin-ubuntu-x64.zip'],
    ['linux', 'arm64', 'llama-b10831-bin-ubuntu-arm64.zip'],
    ['win32', 'x64', 'llama-b10831-bin-win-cpu-x64.zip'],
    ['win32', 'arm64', 'llama-b10831-bin-win-cpu-arm64.zip'],
  ])('%s-%s picks %s', (platform, arch, expected) => {
    expect(pickLlamaAsset(ASSETS, platform, arch).name).toBe(expected);
  });

  test('never picks a CUDA build for a plain x64 target', () => {
    const cudaOnly = [{ name: 'llama-b10831-bin-win-cuda-12.4-x64.zip' }];
    expect(pickLlamaAsset(cudaOnly, 'win32', 'x64')).toBeNull();
  });

  test('returns null when the release carries no matching asset', () => {
    expect(pickLlamaAsset([{ name: 'nightly-tag.txt' }], 'darwin', 'arm64')).toBeNull();
    expect(pickLlamaAsset(null, 'darwin', 'arm64')).toBeNull();
    expect(pickLlamaAsset(ASSETS, 'aix', 'ppc64')).toBeNull();
  });
});

describe('parseBuildNumber', () => {
  test('reads the number llama-server --version prints', () => {
    expect(parseBuildNumber('version: 8772 (bafae2765)')).toBe(8772);
  });

  test('reads the build out of the semver-first line current builds print', () => {
    // Reading `version:` first would take the 0 of 0.4.0-dev and call every
    // build older than itself.
    expect(parseBuildNumber('version: 0.4.0-dev (build 10809, commit 5266f24da)')).toBe(10809);
  });

  test('reads a build tag and an asset name', () => {
    expect(parseBuildNumber('b10831')).toBe(10831);
    expect(parseBuildNumber('llama-b10809-bin-macos-arm64.zip')).toBe(10809);
  });

  test('returns null for text carrying no build', () => {
    expect(parseBuildNumber('')).toBeNull();
    expect(parseBuildNumber('unknown')).toBeNull();
    expect(parseBuildNumber(null)).toBeNull();
  });
});

describe('parseNightlyTag', () => {
  test('accepts only a bare build tag', () => {
    expect(parseNightlyTag('b10809\n')).toBe('b10809');
    expect(parseNightlyTag('v0.4.0')).toBeNull();
    expect(parseNightlyTag('b10809 extra')).toBeNull();
    expect(parseNightlyTag('')).toBeNull();
  });
});

describe('isNewerLlamaBuild', () => {
  test('compares numerically, not lexically', () => {
    expect(isNewerLlamaBuild('b10831', 'version: 8772 (bafae2765)')).toBe(true);
    expect(isNewerLlamaBuild('b8772', 'version: 8772 (bafae2765)')).toBe(false);
    expect(isNewerLlamaBuild('b8771', 'version: 8772 (bafae2765)')).toBe(false);
  });

  test('an unreadable local version counts as out of date', () => {
    expect(isNewerLlamaBuild('b10831', '')).toBe(true);
    expect(isNewerLlamaBuild('b10831', 'unknown')).toBe(true);
  });

  test('compares the current --version line shape correctly', () => {
    expect(isNewerLlamaBuild('b10809', 'version: 0.4.0-dev (build 10809, commit 5266f24da)')).toBe(false);
    expect(isNewerLlamaBuild('b10831', 'version: 0.4.0-dev (build 10809, commit 5266f24da)')).toBe(true);
  });

  test('an unparseable remote tag never triggers an update', () => {
    expect(isNewerLlamaBuild('v0.4.0', 'version: 8772')).toBe(false);
    expect(isNewerLlamaBuild('', 'version: 8772')).toBe(false);
  });
});

describe('compareVersionStrings', () => {
  test('orders by numeric segment, so 0.31.10 beats 0.31.3', () => {
    expect(compareVersionStrings('0.31.10', '0.31.3')).toBe(1);
    expect(compareVersionStrings('0.31.3', '0.31.10')).toBe(-1);
    expect(compareVersionStrings('1.8.1', '1.8.1')).toBe(0);
  });

  test('treats a missing trailing segment as zero', () => {
    expect(compareVersionStrings('1.8', '1.8.0')).toBe(0);
    expect(compareVersionStrings('1.8.1', '1.8')).toBe(1);
  });

  test('a release beats its own pre-release', () => {
    expect(compareVersionStrings('1.8.1', '1.8.1rc1')).toBe(1);
    expect(compareVersionStrings('1.8.1rc1', '1.8.1')).toBe(-1);
  });
});

// oMLX publishes rc/dev builds as ordinary releases (prerelease: false), so the
// tag itself is the only thing that separates them from a stable release.
describe('isStableTag', () => {
  test.each(['v1.2.3', '1.2.3', 'v0.7.10', ' v0.7.0\n'])('%j is stable', (tag) => {
    expect(isStableTag(tag)).toBe(true);
  });

  test.each(['v0.7.1rc1', 'v1.2.3-rc1', 'v0.8.0.dev2', 'v0.8.0-dev', 'v1.2', 'b10831', '', null])('%j is not stable', (tag) => {
    expect(isStableTag(tag)).toBe(false);
  });
});

describe('newestStableRelease', () => {
  test('skips rc/dev tags even when GitHub does not flag them as prereleases', () => {
    const releases = [
      { tag_name: 'v0.8.0rc1', prerelease: false, draft: false },
      { tag_name: 'v0.8.0.dev2', prerelease: false, draft: false },
      { tag_name: 'v0.7.0', prerelease: false, draft: false },
      { tag_name: 'v0.7.10', prerelease: false, draft: false },
      { tag_name: 'v0.7.9', prerelease: false, draft: false },
    ];
    expect(newestStableRelease(releases).tag_name).toBe('v0.7.10');
  });

  test('skips flagged prereleases and drafts', () => {
    const releases = [
      { tag_name: 'v0.9.0', prerelease: true, draft: false },
      { tag_name: 'v1.0.0', prerelease: false, draft: true },
      { tag_name: 'v0.7.0', prerelease: false, draft: false },
    ];
    expect(newestStableRelease(releases).tag_name).toBe('v0.7.0');
  });

  test('returns null when nothing stable is published', () => {
    expect(newestStableRelease([{ tag_name: 'v0.8.0rc1', prerelease: false, draft: false }])).toBeNull();
    expect(newestStableRelease([])).toBeNull();
    expect(newestStableRelease(null)).toBeNull();
  });
});

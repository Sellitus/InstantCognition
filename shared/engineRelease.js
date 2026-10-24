// engineRelease — pure release-metadata logic for the inference runtimes.
//
// Shared by the scripts/fetch-*.js build steps and main/services/llm/engines/
// (run time) so the two can never drift on which asset belongs to which
// platform.
//
// llama.cpp publishes two kinds of release: a versioned one (`v0.4.0`) whose
// only asset is `nightly-tag.txt` naming the build it was cut from, and one
// build release per CI run (`b10831`, flagged prerelease) carrying the actual
// binaries. `releases/latest` returns the versioned one, so resolving a
// download always goes through the nightly tag it points at.

const LLAMA_REPO = 'ggml-org/llama.cpp';
const NIGHTLY_TAG_ASSET = 'nightly-tag.txt';
const MLX_PACKAGES = ['mlx-lm', 'mlx-openai-server'];
// oMLX is not on PyPI: it ships wheels on its GitHub releases. It also tags
// rc/dev builds as regular (non-prerelease) releases, so `releases/latest` can
// name a release candidate; only plain vX.Y.Z tags count as stable.
const OMLX_REPO = 'jundot/omlx';
const VLLM_PACKAGE = 'vllm';

/** @param {string} platform */
function llamaBinaryName(platform) {
  return platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}

/**
 * Pick the prebuilt archive for a platform/arch out of a release's asset list.
 * CPU builds only: the CUDA/ROCm/SYCL/Vulkan variants need a matching runtime
 * on the user's machine, which the app cannot assume.
 * @param {any[]} assets release assets as GitHub returns them
 * @param {string} platform
 * @param {string} arch
 * @returns {any|null}
 */
function pickLlamaAsset(assets, platform, arch) {
  const list = Array.isArray(assets) ? assets : [];
  const lc = (s) => String(s || '').toLowerCase();
  const match = (needle) => list.find((a) => lc(a.name).includes(needle));
  if (platform === 'darwin') {
    if (arch === 'arm64') return match('macos-arm64') || match('macos-arm') || null;
    return match('macos-x64') || match('macos-x86_64') || null;
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return match('ubuntu-arm64') || match('linux-arm64') || null;
    return match('ubuntu-x64') || match('linux-x64') || null;
  }
  if (platform === 'win32') {
    if (arch === 'arm64') return match('win-cpu-arm64') || match('win-arm64') || match('windows-arm64') || null;
    return match('win-cpu-x64') || match('win-avx2-x64') || match('win-x64') || match('windows-x64') || null;
  }
  return null;
}

/**
 * Build number out of anything that carries one: a `b10831` tag, an asset name,
 * or either shape `llama-server --version` prints — the current
 * `version: 0.4.0-dev (build 10809, commit 5266f24da)` and the older
 * `version: 10831 (abc1234)`. Order matters: the newer line leads with a
 * semantic version, so `build N` has to be read before `version: N`.
 * @param {string} text
 * @returns {number|null}
 */
function parseBuildNumber(text) {
  const s = String(text || '');
  const build = s.match(/\bbuild\s+(\d{3,})/i);
  if (build) return Number(build[1]);
  const tag = s.match(/\bb(\d{3,})\b/);
  if (tag) return Number(tag[1]);
  // Guarded against a semantic version: `version: 0.4.0-dev` is not build 0.
  const version = s.match(/version:\s*(\d{3,})(?![\d.])/i);
  if (version) return Number(version[1]);
  const bare = s.trim().match(/^(\d{3,})$/);
  if (bare) return Number(bare[1]);
  return null;
}

/**
 * The `nightly-tag.txt` body names the build release a versioned release was
 * cut from. Anything else is a malformed pointer and must not become a URL.
 * @param {string} text
 * @returns {string|null}
 */
function parseNightlyTag(text) {
  const trimmed = String(text || '').trim();
  return /^b\d{3,}$/.test(trimmed) ? trimmed : null;
}

/**
 * @param {string} latestTag build tag, e.g. 'b10831'
 * @param {string} currentVersionText output of `llama-server --version`, or a tag
 */
function isNewerLlamaBuild(latestTag, currentVersionText) {
  const latest = parseBuildNumber(latestTag);
  if (latest === null) return false;
  const current = parseBuildNumber(currentVersionText);
  // No parseable local build (missing binary, unreadable output) counts as
  // out of date: installing is the recovery.
  if (current === null) return true;
  return latest > current;
}

/**
 * Numeric-segment comparison for PyPI versions ('0.31.3' vs '0.31.10').
 * Suffixes ('1.8.1rc1') compare after the numeric segments they follow.
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1}
 */
function compareVersionStrings(a, b) {
  const parts = (v) => String(v || '').split('.').map((seg) => {
    const m = seg.match(/^(\d+)(.*)$/);
    return m ? { num: Number(m[1]), rest: m[2] } : { num: -1, rest: seg };
  });
  const pa = parts(a);
  const pb = parts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || { num: 0, rest: '' };
    const y = pb[i] || { num: 0, rest: '' };
    if (x.num !== y.num) return x.num > y.num ? 1 : -1;
    if (x.rest !== y.rest) {
      // A bare segment ('1') is the final release; a suffixed one ('1rc1') precedes it.
      if (!x.rest) return 1;
      if (!y.rest) return -1;
      return x.rest > y.rest ? 1 : -1;
    }
  }
  return 0;
}

/**
 * @param {string} tag a release tag, e.g. 'v0.7.0' or 'v0.7.1rc1'
 * @returns {boolean} whether it names a stable release
 */
function isStableTag(tag) {
  return /^v?\d+\.\d+\.\d+$/.test(String(tag || '').trim());
}

/**
 * The newest stable release out of a GitHub releases list.
 * @param {any[]} releases
 * @returns {any|null}
 */
function newestStableRelease(releases) {
  const stable = (Array.isArray(releases) ? releases : [])
    .filter((r) => r && !r.draft && !r.prerelease && isStableTag(r.tag_name));
  stable.sort((a, b) => compareVersionStrings(stripV(b.tag_name), stripV(a.tag_name)));
  return stable[0] || null;
}

/** @param {string} tag */
function stripV(tag) {
  return String(tag || '').trim().replace(/^v/, '');
}

/**
 * The wheel built for one CPython tag ('cp311') out of a release's assets.
 * @param {any[]} assets
 * @param {string} pyTag
 * @returns {any|null}
 */
function pickWheelAsset(assets, pyTag) {
  const list = Array.isArray(assets) ? assets : [];
  return list.find((a) => a && /\.whl$/i.test(a.name) && String(a.name).includes(`-${pyTag}-`)) || null;
}

module.exports = {
  LLAMA_REPO,
  NIGHTLY_TAG_ASSET,
  MLX_PACKAGES,
  OMLX_REPO,
  VLLM_PACKAGE,
  isStableTag,
  newestStableRelease,
  stripV,
  pickWheelAsset,
  llamaBinaryName,
  pickLlamaAsset,
  parseBuildNumber,
  parseNightlyTag,
  isNewerLlamaBuild,
  compareVersionStrings,
};

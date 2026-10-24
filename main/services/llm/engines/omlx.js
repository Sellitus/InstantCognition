// oMLX runtime adapter for EngineUpdateService: the newest stable GitHub
// release against `omlx --version`, installed from the release wheel into the
// managed omlx-venv.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { errMsg } = require('../../../../shared/errMsg');
const { OMLX_REPO, newestStableRelease, pickWheelAsset, stripV, compareVersionStrings } = require('../../../../shared/engineRelease');
const fetcher = require('../engineFetch');
const enginePaths = require('../enginePaths');
const discovery = require('../../EngineDiscoveryService');
const { bundledOmlxPythonCandidates } = require('../omlxDiscovery');

const GITHUB_API = 'https://api.github.com';
// oMLX wheels are built for these CPython versions only.
const SUPPORTED_PY = ['311', '312', '313'];

async function latestStableRelease() {
  const releases = await fetcher.getJson(`${GITHUB_API}/repos/${OMLX_REPO}/releases?per_page=30`);
  const release = newestStableRelease(releases);
  if (!release) throw new Error('No stable oMLX release was found.');
  return release;
}

/** @param {string} python @returns {Promise<string>} e.g. '311' */
async function pythonTag(python) {
  const { stdout } = await fetcher.run(python, ['-c', 'import sys; print("%d%d" % sys.version_info[:2])'], { timeoutMs: 30000 });
  return stdout.trim();
}

// oMLX pins its mlx-lm / mlx-vlm dependencies to git commits, so pip needs a
// working git — on macOS that comes with the Command Line Tools.
async function requireGit() {
  try {
    await fetcher.run('xcode-select', ['-p'], { timeoutMs: 15000 });
    await fetcher.run('git', ['--version'], { timeoutMs: 15000 });
  } catch (err) {
    throw new Error(`oMLX installs its dependencies with git, which is not available (${errMsg(err)}). Install the Xcode Command Line Tools with: xcode-select --install`);
  }
}

async function baseInterpreter() {
  const bundled = bundledOmlxPythonCandidates().find((p) => fs.existsSync(p));
  const python = bundled || await discovery.findPythonInterpreter();
  if (!python) throw new Error('No python runtime was found to create the oMLX environment.');
  const tag = await pythonTag(python);
  if (!SUPPORTED_PY.includes(tag)) {
    throw new Error(`oMLX needs Python 3.11–3.13; the available interpreter (${python}) is ${tag.slice(0, 1)}.${tag.slice(1)}.`);
  }
  return python;
}

module.exports = {
  id: 'omlx',
  name: 'oMLX',
  supported: (platform) => platform === 'darwin',

  /** @param {{latest: Record<string, any>}} ctx */
  async check(ctx) {
    const det = await discovery.detectOmlx();
    if (!det.available && !det.pythonPath && det.reason !== 'oMLX not installed') {
      // Intel Macs cannot run oMLX — not an error, and nothing to offer.
      return { engine: 'omlx', ok: true, name: 'oMLX', current: 'unavailable', latest: null, updateAvailable: false, reason: det.reason };
    }
    const release = await latestStableRelease();
    ctx.latest.omlx = release;
    const latest = stripV(release.tag_name);
    const current = det.available ? det.version : null;
    return {
      engine: 'omlx',
      ok: true,
      name: 'oMLX',
      current: current || 'not installed',
      latest,
      updateAvailable: !current || compareVersionStrings(latest, current) > 0,
    };
  },

  /** @param {{latest: Record<string, any>, send: (payload: object) => void}} ctx */
  async install(ctx) {
    if (process.arch !== 'arm64') throw new Error('oMLX requires Apple Silicon.');
    const venv = enginePaths.managedOmlxVenv();
    if (!venv) throw new Error('No writable engines directory is available.');
    await requireGit();
    const release = ctx.latest.omlx || await latestStableRelease();
    const version = stripV(release.tag_name);

    let python = enginePaths.managedOmlxPython();
    if (!python) {
      const base = await baseInterpreter();
      ctx.send({ ok: true, status: 'installing', engine: 'omlx', version, step: 'creating environment' });
      // --system-site-packages keeps the bundled runtime's already-installed
      // dependencies reachable, so pip only fetches what changed.
      await fetcher.run(base, ['-m', 'venv', '--system-site-packages', venv], { timeoutMs: 300000 });
      python = enginePaths.venvPython(venv);
    }
    const tag = await pythonTag(python);
    const asset = pickWheelAsset(release.assets, `cp${tag}`);
    if (!asset) throw new Error(`oMLX ${version} has no wheel for Python ${tag.slice(0, 1)}.${tag.slice(1)}.`);
    if (!asset.digest) throw new Error(`oMLX ${version} published no checksum for ${asset.name}.`);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-omlx-'));
    try {
      // pip reads the version and tags from the wheel's file name, so it keeps it.
      const wheel = path.join(tmpDir, asset.name);
      ctx.send({ ok: true, status: 'downloading', engine: 'omlx', version, percent: 0 });
      await fetcher.downloadVerified(asset.browser_download_url, wheel, {
        digest: asset.digest,
        onProgress: (percent) => ctx.send({ ok: true, status: 'downloading', engine: 'omlx', version, percent }),
      });
      ctx.send({ ok: true, status: 'installing', engine: 'omlx', version, step: 'installing packages' });
      await fetcher.run(python, ['-m', 'pip', 'install', '--no-cache-dir', '--upgrade', wheel], { timeoutMs: 1800000 });
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (err) { console.warn('[engine-update] temp cleanup failed:', errMsg(err)); }
    }

    discovery.clearCache();
    const det = await discovery.detectOmlx();
    if (!det.available || det.version !== version) {
      throw new Error(`oMLX ${version} was installed but does not run: ${det.reason || `reports ${det.version}`}`);
    }
    return version;
  },
};

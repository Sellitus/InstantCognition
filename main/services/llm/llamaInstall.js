// llamaInstall — installs a llama.cpp build for EngineUpdateService.
//
// Each build lands in its own `b<build>` directory under the managed root
// (enginePaths.js), staged and proven runnable before discovery can see it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { errMsg } = require('../../../shared/errMsg');
const { LLAMA_REPO, llamaBinaryName, pickLlamaAsset, parseBuildNumber } = require('../../../shared/engineRelease');
const fetcher = require('./engineFetch');
const enginePaths = require('./enginePaths');

const GITHUB_API = 'https://api.github.com';

/**
 * Download, verify and install one llama.cpp build into the managed root.
 * @param {string} tag a `b<build>` release tag
 * @param {(payload: object) => void} send progress sink for the renderer
 * @returns {Promise<string>} the installed tag
 */
async function installLlamaBuild(tag, send) {
  const root = enginePaths.managedLlamaRoot();
  if (!root) throw new Error('No writable engines directory is available.');
  const release = await fetcher.getJson(`${GITHUB_API}/repos/${LLAMA_REPO}/releases/tags/${tag}`);
  const asset = pickLlamaAsset((release && release.assets) || [], process.platform, process.arch);
  if (!asset) throw new Error(`llama.cpp ${tag} has no prebuilt binary for ${process.platform}-${process.arch}.`);
  // GitHub publishes a sha256 for every release asset. Without one there is
  // nothing to check an executable against, so the install stops here rather
  // than running an unverified binary.
  if (!asset.digest) throw new Error(`llama.cpp ${tag} published no checksum for ${asset.name}.`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-engine-'));
  try {
    const archive = path.join(tmpDir, asset.name);
    send({ ok: true, status: 'downloading', engine: 'llamaCpp', version: tag, percent: 0 });
    await fetcher.downloadVerified(asset.browser_download_url, archive, {
      digest: asset.digest,
      onProgress: (percent) => send({ ok: true, status: 'downloading', engine: 'llamaCpp', version: tag, percent }),
    });
    send({ ok: true, status: 'installing', engine: 'llamaCpp', version: tag });

    const extractDir = path.join(tmpDir, 'extracted');
    await fetcher.extractArchive(archive, extractDir);
    const binaryName = llamaBinaryName(process.platform);
    const binPath = fetcher.findFile(extractDir, binaryName);
    if (!binPath) throw new Error(`${binaryName} was not found inside ${asset.name}.`);

    // Stage beside the final directory, prove the binary runs, then move it
    // into place — a half-copied build must never become the newest install
    // discovery picks up.
    const staging = path.join(root, `.staging-${tag}`);
    fs.rmSync(staging, { recursive: true, force: true });
    fetcher.copyDirContents(path.dirname(binPath), staging);
    await verifyLlamaBinary(path.join(staging, binaryName), tag);
    const final = path.join(root, tag);
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(staging, final);
    pruneOldLlamaInstalls(final);
    return tag;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (err) { console.warn('[engine-update] temp cleanup failed:', errMsg(err)); }
  }
}

async function verifyLlamaBinary(binaryPath, tag) {
  const { stdout, stderr } = await fetcher.run(binaryPath, ['--version'], { timeoutMs: 20000 });
  const out = `${stdout}${stderr}`;
  const build = parseBuildNumber(out);
  if (build === null) throw new Error('The downloaded llama-server did not report a version.');
  const expected = parseBuildNumber(tag);
  if (expected !== null && build !== expected) {
    throw new Error(`Downloaded llama-server reports build ${build}, expected ${expected}.`);
  }
}

// Keep the newest install plus the one it replaced: the previous build may
// still be running, and on Windows its files cannot be removed until it exits.
function pruneOldLlamaInstalls(keepDir) {
  const dirs = enginePaths.managedLlamaDirs().filter((d) => d !== keepDir);
  for (const dir of dirs.slice(1)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (err) { console.warn(`[engine-update] could not remove ${dir}:`, errMsg(err)); }
  }
}

module.exports = { installLlamaBuild };

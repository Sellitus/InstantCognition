#!/usr/bin/env node
// fetch-llama-server.js
//
// Downloads a prebuilt llama-server binary from the official llama.cpp GitHub
// releases and unpacks it into vendor/llama-server/<platform>-<arch>/ so that
// electron-builder can bundle it via the platform's extraResources entry.
//
// Usage:
//   node scripts/fetch-llama-server.js                # host platform/arch
//   LLAMA_PLATFORM=darwin LLAMA_ARCH=arm64 node scripts/fetch-llama-server.js
//   FORCE=1 node scripts/fetch-llama-server.js        # re-download even if present
//
// On failure (offline, rate-limit, no matching asset), exits 0 with a warning.
// The runtime falls back to PATH/system locations when the bundled dir is empty,
// so a missing fetch never breaks the build or the app.

const fs = require('fs');
const path = require('path');
const { downloadToFile, getText: httpGetText } = require('../main/utils/httpDownload');
const { execFileSync } = require('child_process');
const os = require('os');

const {
  LLAMA_REPO, NIGHTLY_TAG_ASSET, llamaBinaryName, pickLlamaAsset, parseNightlyTag,
} = require('../shared/engineRelease');
const { errMsg } = require('../shared/errMsg');

const REPO = LLAMA_REPO;
const ROOT = path.join(__dirname, '..');
const VERSION_MARKER = '.llama-server-version';
const targetPlatform = process.env.LLAMA_PLATFORM || process.platform;
const targetArch = process.env.LLAMA_ARCH || process.arch;
const FORCE = process.env.FORCE === '1' || process.env.FORCE === 'true';
const DEST_DIR = path.join(ROOT, 'vendor', 'llama-server', `${targetPlatform}-${targetArch}`);

function log(msg) { process.stdout.write(`[fetch-llama-server] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[fetch-llama-server] WARN: ${msg}\n`); }

const BINARY_NAME = llamaBinaryName(targetPlatform);

function pickAsset(assets) {
  return pickLlamaAsset(assets, targetPlatform, targetArch);
}

const TEXT_HEADERS = { 'User-Agent': 'instant-cognition-fetch-llama-server' };

function getText(url) {
  return httpGetText(url, { headers: TEXT_HEADERS });
}

// The versioned release `releases/latest` returns carries no binaries — only a
// nightly-tag.txt naming the build release that does. Resolving through it is
// the difference between bundling a llama-server and bundling nothing.
async function resolveBuildTag() {
  const latest = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  log(`Latest release: ${latest.tag_name}`);
  const pointer = (latest.assets || []).find((a) => a.name === NIGHTLY_TAG_ASSET);
  if (pointer) {
    const tag = parseNightlyTag(await getText(pointer.browser_download_url));
    if (tag) return tag;
    warn(`${NIGHTLY_TAG_ASSET} did not contain a build tag.`);
  }
  const direct = parseNightlyTag(String(latest.tag_name || ''));
  if (direct) return direct;
  throw new Error(`Release ${latest.tag_name} names no llama.cpp build to download.`);
}

async function getJson(url) {
  return JSON.parse(await httpGetText(url, {
    headers: {
      'User-Agent': 'instant-cognition-fetch-llama-server',
      Accept: 'application/vnd.github+json',
    },
  }));
}


function extractArchive(archivePath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const lower = archivePath.toLowerCase();
  if (lower.endsWith('.zip') && process.platform === 'win32') {
    // Windows host has no unzip: bsdtar first, PowerShell Expand-Archive fallback.
    const q = (p) => String(p).replace(/'/g, "''");
    const attempt = (bin, args) => { try { execFileSync(bin, args, { stdio: 'inherit' }); return null; } catch (e) { return e; } };
    const tarError = attempt('tar', ['-xf', archivePath, '-C', outDir]);
    if (!tarError) return;
    const psError = attempt('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${q(archivePath)}' -DestinationPath '${q(outDir)}' -Force`]);
    if (!psError) return;
    throw new Error(`zip extraction failed: tar: ${errMsg(tarError)}; Expand-Archive: ${errMsg(psError)}`);
  }
  if (lower.endsWith('.zip')) {
    // GNU tar on Linux/WSL cannot read zip; use system unzip. macOS/BSD tar
    // (libarchive) could, but unzip is what non-win32 hosts ship.
    execFileSync('unzip', ['-q', '-o', archivePath, '-d', outDir], { stdio: 'inherit' });
  } else {
    execFileSync('tar', ['-xf', archivePath, '-C', outDir], { stdio: 'inherit' });
  }
}

function findBinary(rootDir, name) {
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { stack.push(full); continue; }
      if (ent.name === name) return full;
    }
  }
  return null;
}

function copyDirContents(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const stack = [['', srcDir]];
  while (stack.length) {
    const [rel, dir] = stack.pop();
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const srcPath = path.join(dir, ent.name);
      const relPath = path.join(rel, ent.name);
      const destPath = path.join(destDir, relPath);
      if (ent.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        stack.push([relPath, srcPath]);
      } else {
        fs.copyFileSync(srcPath, destPath);
        // The shared libraries beside llama-server must stay loadable, so a
        // failed chmod is a broken bundle, not a cosmetic miss.
        try { fs.chmodSync(destPath, 0o755); } catch (err) { throw new Error(`chmod ${destPath} failed: ${errMsg(err)}`); }
      }
    }
  }
}

async function main() {
  log(`Target: ${targetPlatform}-${targetArch}`);
  log(`Destination: ${DEST_DIR}`);

  const existing = path.join(DEST_DIR, BINARY_NAME);
  const markerPath = path.join(DEST_DIR, VERSION_MARKER);
  const haveBinary = fs.existsSync(existing);
  let installed = null;
  if (haveBinary) {
    try { installed = fs.readFileSync(markerPath, 'utf8').trim(); } catch (_) { installed = null; }
  }

  log(`Querying GitHub for latest ${REPO} build…`);
  const tag = await resolveBuildTag();
  log(`Latest build: ${tag}`);

  // A stale bundled binary is the normal state: llama.cpp cuts builds daily.
  // Refresh whenever the marker does not match, so a rebuild ships current bits.
  if (!FORCE && haveBinary && installed === tag) {
    log(`${tag} already present at ${existing}. Use FORCE=1 to re-download.`);
    return;
  }
  if (haveBinary && installed !== tag) {
    log(`Bundled build ${installed || 'unknown'} is behind ${tag}; refreshing.`);
  }

  const release = await getJson(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`);

  const asset = pickAsset(release.assets || []);
  if (!asset) {
    warn(`No prebuilt asset found for ${targetPlatform}-${targetArch} in release ${release.tag_name}.`);
    warn('Available assets:');
    for (const a of (release.assets || [])) warn(`  - ${a.name}`);
    warn('Build will fall back to runtime PATH detection.');
    return;
  }

  log(`Asset: ${asset.name} (${(asset.size / (1024 * 1024)).toFixed(1)} MB)`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-fetch-'));
  const zipPath = path.join(tmpDir, asset.name);
  log(`Downloading…`);
  await downloadToFile(asset.browser_download_url, zipPath, { headers: TEXT_HEADERS });
  log(`Downloaded ${zipPath}`);

  log(`Extracting…`);
  const extractDir = path.join(tmpDir, 'extracted');
  extractArchive(zipPath, extractDir);

  const binPath = findBinary(extractDir, BINARY_NAME);
  if (!binPath) {
    warn(`${BINARY_NAME} not found inside ${asset.name}. Skipping bundle.`);
    return;
  }
  log(`Found binary at ${binPath}`);

  const binDir = path.dirname(binPath);
  fs.mkdirSync(DEST_DIR, { recursive: true });
  copyDirContents(binDir, DEST_DIR);
  fs.writeFileSync(markerPath, `${tag}\n`);
  log(`Bundled binary + dependencies into ${DEST_DIR} (${tag})`);

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) { warn(`temp cleanup failed: ${errMsg(err)}`); }

  log('Done.');
}

main().catch((err) => {
  warn(errMsg(err) || String(err));
  warn('Build will fall back to runtime PATH detection.');
  process.exit(0);
});

// checkpointFiles — filesystem primitives for checkpointStore: streaming
// sha256, content-addressed blob writes, atomic JSON, and restoring a blob over
// a workspace file. Reads open with O_NOFOLLOW where the platform has it so a
// path swapped for a symlink after the caller's lstat is refused, not followed.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { assertDirInside, errCode } = require('../workspace/pathGuard');

const ABSENT = 'absent';
const IRREGULAR = 'irregular';
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);

const tmpName = (prefix) => `${prefix}.ic-${crypto.randomBytes(6).toString('hex')}.tmp`;

async function lstatOrNull(p) {
  try { return await fsp.lstat(p); }
  catch (err) { if (errCode(err) === 'ENOENT' || errCode(err) === 'ENOTDIR') return null; throw err; }
}

/** Iterate a file's bytes without following a final symlink. */
async function* readChunks(abs) {
  const fh = await fsp.open(abs, READ_FLAGS);
  try {
    for await (const chunk of fh.createReadStream({ autoClose: false })) yield /** @type {Buffer} */ (chunk);
  } finally { await fh.close(); }
}

async function hashFile(abs) {
  const h = crypto.createHash('sha256');
  for await (const chunk of readChunks(abs)) h.update(chunk);
  return h.digest('hex');
}

/** 'absent', 'irregular' (directory, symlink, device…), or the sha256 of a regular file. */
async function fileState(abs) {
  const st = await lstatOrNull(abs);
  if (!st) return ABSENT;
  if (!st.isFile()) return IRREGULAR;
  return hashFile(abs);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Copy `abs` into blobDir under its sha256. An existing blob of that hash is
 * kept (same bytes), the fresh copy discarded.
 * @returns {Promise<{ hash: string, size: number }>}
 */
async function storeBlob(blobDir, abs) {
  await fsp.mkdir(blobDir, { recursive: true });
  const tmp = path.join(blobDir, tmpName('.blob'));
  const h = crypto.createHash('sha256');
  let size = 0;
  try {
    const out = await fsp.open(tmp, 'wx', 0o600);
    try {
      for await (const chunk of readChunks(abs)) {
        h.update(chunk);
        size += chunk.length;
        await out.write(chunk);
      }
    } finally { await out.close(); }
    const hash = h.digest('hex');
    const dest = path.join(blobDir, hash);
    if (await lstatOrNull(dest)) await fsp.rm(tmp, { force: true });
    else await fsp.rename(tmp, dest);
    return { hash, size };
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), tmpName('.manifest'));
  try {
    await fsp.writeFile(tmp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Write blob `hash` over `abs` (temp + rename in the re-verified parent) and
 * apply `mode`. The bytes are re-hashed on the way so a damaged blob never
 * lands in the workspace.
 */
async function restoreBlob({ blobPath, hash, abs, root, mode }) {
  if (!(await lstatOrNull(blobPath))) throw new Error('checkpoint_blob_missing');
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const realDir = assertDirInside(root, path.dirname(abs));
  const dest = path.join(realDir, path.basename(abs));
  const tmp = path.join(realDir, tmpName(`.${path.basename(abs)}`));
  const h = crypto.createHash('sha256');
  try {
    const out = await fsp.open(tmp, 'wx', 0o600);
    try {
      for await (const chunk of readChunks(blobPath)) {
        h.update(chunk);
        await out.write(chunk);
      }
      await out.chmod(mode);
    } finally { await out.close(); }
    if (h.digest('hex') !== hash) throw new Error('checkpoint_blob_corrupt');
    await fsp.rename(tmp, dest);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

module.exports = { ABSENT, IRREGULAR, lstatOrNull, hashFile, fileState, sha256, storeBlob, writeJsonAtomic, restoreBlob };

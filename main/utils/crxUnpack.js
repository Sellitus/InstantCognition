// crxUnpack — turn a Chrome .crx (or a plain .zip) into an unpacked extension
// directory. A .crx is a small signed header followed by a normal ZIP, so the
// job is: strip the header, then extract the embedded ZIP. extract-zip handles
// the ZIP itself (including zip-slip path-traversal rejection).

const fs = require('fs');
const os = require('os');
const path = require('path');
const extract = require('extract-zip');

const CRX_MAGIC = 0x34327243; // 'Cr24' as a little-endian uint32

// Return the inner ZIP bytes from a .crx buffer. If the buffer has no CRX
// magic it is already a plain ZIP and is returned unchanged. Throws on a
// recognized-but-unsupported CRX version or a truncated header.
function stripCrxHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) {
    throw new Error('Not a valid extension archive (too small)');
  }
  if (buf.readUInt32LE(0) !== CRX_MAGIC) {
    return buf; // plain .zip
  }
  const version = buf.readUInt32LE(4);
  let zipStart;
  if (version === 3) {
    const headerLen = buf.readUInt32LE(8);
    zipStart = 12 + headerLen;
  } else if (version === 2) {
    const pubKeyLen = buf.readUInt32LE(8);
    const sigLen = buf.readUInt32LE(12);
    zipStart = 16 + pubKeyLen + sigLen;
  } else {
    throw new Error(`Unsupported CRX version: ${version}`);
  }
  if (!Number.isFinite(zipStart) || zipStart <= 0 || zipStart >= buf.length) {
    throw new Error('Corrupt CRX header');
  }
  return buf.subarray(zipStart);
}

// Extract a .crx/.zip at srcPath into destDir (created if missing). The
// embedded ZIP is staged to a temp file only when a CRX header had to be
// stripped; a plain ZIP is extracted in place to avoid copying it.
async function unpackArchive(srcPath, destDir) {
  const absDest = path.resolve(destDir);
  fs.mkdirSync(absDest, { recursive: true });

  const raw = fs.readFileSync(srcPath);
  const zipBuf = stripCrxHeader(raw);

  if (zipBuf === raw) {
    await extract(path.resolve(srcPath), { dir: absDest });
    return absDest;
  }

  const tmpZip = path.join(
    os.tmpdir(),
    `ic-ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.zip`,
  );
  try {
    fs.writeFileSync(tmpZip, zipBuf);
    await extract(tmpZip, { dir: absDest });
  } finally {
    try { fs.unlinkSync(tmpZip); } catch (_) { /* temp already gone */ }
  }
  return absDest;
}

module.exports = { stripCrxHeader, unpackArchive };

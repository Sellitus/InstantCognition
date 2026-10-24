// atomicWrite — crash-safe persistence for the JSON stores under userData.
//
// writeFileAtomic writes a sibling temp file and renames it over the target, so
// a crash or ENOSPC mid-write leaves the previous file intact instead of a
// truncated one. readJsonOrQuarantine moves an unparseable file aside before the
// store starts empty, and reports an unreadable one as blocked, so the next save
// can never overwrite the user's data.

const path = require('path');
const { errMsg } = require('./errMsg');

let tmpSeq = 0;

/**
 * @param {any} fsImpl fs module (or a test double with mkdirSync/writeFileSync/renameSync/existsSync/unlinkSync)
 * @param {string} file
 * @param {string} data
 */
function writeFileAtomic(fsImpl, file, data) {
  const dir = path.dirname(file);
  if (!fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true });
  // Unique per process and call: two writers of one file sharing a temp path
  // would rename each other's half-written bytes into place.
  tmpSeq += 1;
  const tmp = `${file}.${process.pid}-${tmpSeq}.tmp`;
  try {
    fsImpl.writeFileSync(tmp, data);
    fsImpl.renameSync(tmp, file);
  } catch (err) {
    removeTemp(fsImpl, tmp);
    throw err;
  }
}

function removeTemp(fsImpl, tmp) {
  try {
    fsImpl.unlinkSync(tmp);
  } catch (err) {
    if (!err || /** @type {any} */ (err).code !== 'ENOENT') console.error(`[atomicWrite] could not remove ${tmp}:`, errMsg(err));
  }
}

/**
 * Read and parse a JSON file. A missing file yields `{ value: undefined }`.
 * An unparseable file is renamed to `<file>.corrupt-<ms>` and yields
 * `{ value: undefined, quarantined }`. A file that exists but cannot be read
 * (EBUSY, EACCES, EIO...) may still hold valid data, so it is left in place
 * and the result carries `blocked: true`, as it does when moving a corrupt
 * file aside fails: the caller must refuse to save, or it would overwrite the
 * only copy of the data.
 *
 * @param {any} fsImpl
 * @param {string} file
 * @param {string} label log prefix, e.g. 'BookmarkService'
 * @returns {{ value: any, quarantined?: string, blocked?: boolean }}
 */
function readJsonOrQuarantine(fsImpl, file, label) {
  if (!fsImpl.existsSync(file)) return { value: undefined };
  let text;
  try {
    text = fsImpl.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && /** @type {any} */ (err).code === 'ENOENT') return { value: undefined };
    console.error(`[${label}] could not read ${file}; saving is disabled to protect it:`, errMsg(err));
    return { value: undefined, blocked: true };
  }
  try {
    return { value: JSON.parse(text) };
  } catch (err) {
    const quarantined = `${file}.corrupt-${Date.now()}`;
    console.error(`[${label}] failed to parse ${file}:`, errMsg(err));
    try {
      fsImpl.renameSync(file, quarantined);
      console.error(`[${label}] moved unreadable file to ${quarantined}`);
      return { value: undefined, quarantined };
    } catch (renameErr) {
      console.error(`[${label}] could not move unreadable file aside; saving is disabled to protect it:`, errMsg(renameErr));
      return { value: undefined, blocked: true };
    }
  }
}

module.exports = { writeFileAtomic, readJsonOrQuarantine };

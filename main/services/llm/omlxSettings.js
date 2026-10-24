// omlxSettings — per-model settings oMLX reads once at startup.
//
// oMLX has no CLI flag for context length, pinning or the default model; it
// reads them from <base-path>/model_settings.json when the server starts. The
// app owns its base path (enginePaths.managedOmlxHome), so before each launch
// the selected model is made the one pinned default — pinned, so the server
// preloads it and /health stays 503 until it is ready — and every other model
// is unpinned so a model used earlier is not preloaded alongside it.

const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = 'model_settings.json';
const SETTINGS_VERSION = 1;

/** oMLX names a model served straight from --model-dir by that folder's name. */
function omlxModelId(modelPath) {
  return path.basename(String(modelPath || '').replace(/[\\/]+$/, ''));
}

/**
 * Pure update of the settings document.
 * @param {any} doc the parsed file, or null when there is none
 * @param {string} modelId
 * @param {{contextLength?: number|null}} opts 0/null leaves the model's own limit
 */
function applyModelSettings(doc, modelId, { contextLength = null } = {}) {
  const base = doc == null ? { version: SETTINGS_VERSION, models: {} } : doc;
  if (!base || typeof base !== 'object' || (base.version != null && base.version !== SETTINGS_VERSION)) {
    throw new Error(`${SETTINGS_FILE} has an unsupported format (version ${base && base.version}).`);
  }
  const models = base.models == null ? {} : base.models;
  if (typeof models !== 'object' || Array.isArray(models)) throw new Error(`${SETTINGS_FILE} has no valid "models" map.`);
  const out = {};
  for (const [id, entry] of Object.entries(models)) {
    if (!entry || typeof entry !== 'object') throw new Error(`${SETTINGS_FILE} has an invalid entry for ${id}.`);
    out[id] = id === modelId ? { ...entry } : { ...entry, is_pinned: false, is_default: false };
  }
  const own = out[modelId] || {};
  own.is_pinned = true;
  own.is_default = true;
  if (typeof contextLength === 'number' && contextLength > 0) own.max_context_window = contextLength;
  else delete own.max_context_window;
  out[modelId] = own;
  return { ...base, version: SETTINGS_VERSION, models: out };
}

/**
 * Write the selected model's settings under the base path, atomically.
 * @param {string} basePath
 * @param {string} modelPath
 * @param {{contextLength?: number|null}} opts
 * @returns {string} the model id oMLX will serve it under
 */
function writeModelSettings(basePath, modelPath, opts) {
  const modelId = omlxModelId(modelPath);
  if (!modelId) throw new Error('oMLX needs a model folder.');
  fs.mkdirSync(basePath, { recursive: true });
  const file = path.join(basePath, SETTINGS_FILE);
  let doc = null;
  if (fs.existsSync(file)) {
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
      throw new Error(`Could not read ${file}: ${(/** @type {any} */ (err)).message}`);
    }
  }
  const next = applyModelSettings(doc, modelId, opts);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  return modelId;
}

module.exports = { omlxModelId, applyModelSettings, writeModelSettings, SETTINGS_FILE };

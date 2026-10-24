const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { app } = require('electron');
const registry = require('./modelRegistry');
const {
  parseShard, mlxInfo, ggufInfo, findShardSiblings, shardGroupInfo,
} = require('../utils/modelDetection');
const modelScanner = require('../utils/modelScanner');
const { createModelWatcher } = require('../utils/modelWatcher');
const { errMsg } = require('../../shared/errMsg');

const TOKENIZER_NAMES = ['tokenizer.json', 'tokenizer.model', 'tokenizer_config.json'];
const WEIGHT_RE = /\.(safetensors|npz)$/i;

function isMlxDir(d) {
  try {
    if (!fs.existsSync(path.join(d, 'config.json'))) return false;
    if (!TOKENIZER_NAMES.some((n) => fs.existsSync(path.join(d, n)))) return false;
    return fs.readdirSync(d).some((f) => WEIGHT_RE.test(f));
  } catch (_) { return false; }
}

class ModelManagerService extends EventEmitter {
  constructor() {
    super();
    this._customModelsDir = null;
    this._registry = null;
    this._migrated = false;
    this._watcher = null;       // lazily created by startWatching
    this._lastWatchCfg = null;
  }

  setModelsDir(dir) {
    this._customModelsDir = dir || null;
    if (this._watcher) this._watcher.start(this._lastWatchCfg);
  }

  getModelsDir() {
    if (this._customModelsDir) return this._customModelsDir;
    try { return path.join(app.getPath('userData'), 'models'); }
    catch (_) { return path.join(process.cwd(), 'models'); }
  }

  ensureModelsDir() {
    const dir = this.getModelsDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  _reg() {
    if (!this._registry) this._registry = registry.load();
    return this._registry;
  }

  _saveReg() { registry.save(this._reg()); }

  _migrateLegacyOnce() {
    if (this._migrated) return;
    this._migrated = true;
    const dir = this.getModelsDir();
    if (!fs.existsSync(dir)) return;
    const reg = this._reg();
    let changed = false;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.gguf')) {
        const shard = parseShard(entry.name);
        if (shard && shard.index !== 1) continue;
        if (!reg.includes(full)) { reg.push(full); changed = true; }
      } else if (entry.isDirectory() && isMlxDir(full)) {
        if (!reg.includes(full)) { reg.push(full); changed = true; }
      }
    }
    if (changed) this._saveReg();
  }

  listModels() {
    this._migrateLegacyOnce();
    const models = [];
    const seen = new Set();
    const kept = [];
    let pruned = 0;
    for (const p of this._reg()) {
      if (seen.has(p)) { pruned += 1; continue; } // drop duplicates
      seen.add(p);
      const info = this._infoForPath(p);
      if (!info || info.missing || info.incomplete) { pruned += 1; continue; }
      kept.push(p);
      models.push(info);
    }
    if (pruned > 0) {
      this._registry = kept;
      this._saveReg();
      this.emit('models-changed');
    }
    return models;
  }

  _infoForPath(p) {
    if (!fs.existsSync(p)) {
      return { name: path.basename(p), path: p, size: 0, sizeHuman: '0 B', format: 'gguf', quantization: null, modifiedAt: 0, missing: true };
    }
    let stat;
    try { stat = fs.statSync(p); } catch (_) { return null; }
    if (stat.isDirectory()) return isMlxDir(p) ? mlxInfo(p) : null;
    if (!p.toLowerCase().endsWith('.gguf')) return null;
    const shard = parseShard(path.basename(p));
    if (shard) {
      const siblings = findShardSiblings(path.dirname(p), shard.base, shard.total);
      return shardGroupInfo(siblings, p);
    }
    return ggufInfo(p);
  }

  getModelInfo(p) { return ggufInfo(p); }
  // Resolve full info for any model path (GGUF, GGUF shard, or MLX dir).
  // llm:start uses this to pull mmprojPath / isMultimodal without listing all models.
  resolveModelInfo(p) { return this._infoForPath(p); }

  deleteModel(modelPath) {
    const reg = this._reg();
    const idx = reg.indexOf(modelPath);
    if (idx !== -1) { reg.splice(idx, 1); this._saveReg(); }

    const managed = path.resolve(this.getModelsDir());
    const resolved = path.resolve(modelPath);
    // Delete files only when modelPath is the managed models directory itself or
    // sits inside it. The trailing separator matters: a bare startsWith would also
    // match sibling paths and take tokenizer/config files down with the model.
    if ((resolved === managed || resolved.startsWith(managed + '/')) && fs.existsSync(resolved)) {
      try {
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
          fs.rmSync(resolved, { recursive: true, force: true });
        } else {
          const shard = parseShard(path.basename(resolved));
          if (shard) {
            const sibDir = path.dirname(resolved);
            for (const f of fs.readdirSync(sibDir)) {
              const s = parseShard(f);
              if (s && s.base === shard.base && s.total === shard.total) fs.unlinkSync(path.join(sibDir, f));
            }
          } else {
            fs.unlinkSync(resolved);
          }
        }
      } catch (err) {
        // The registry entry is already gone, so the caller must hear that the
        // files survived — otherwise the UI reports a delete that never happened.
        this.emit('models-changed');
        throw new Error(`Failed to delete ${resolved}: ${errMsg(err)}`);
      }
    }

    this.emit('models-changed');
    return true;
  }

  importModel(sourcePath) {
    if (!fs.existsSync(sourcePath)) throw new Error(`Source not found: ${sourcePath}`);
    const stat = fs.statSync(sourcePath);
    const abs = path.resolve(sourcePath);

    if (stat.isDirectory()) {
      if (!isMlxDir(abs)) {
        throw new Error(`Not a recognized model folder (needs config.json, a tokenizer and safetensors weights): ${abs}`);
      }
      this._register(abs);
      this.emit('models-changed');
      return mlxInfo(abs);
    }

    if (!abs.toLowerCase().endsWith('.gguf')) {
      throw new Error(`Unsupported file (expected a .gguf file or a model folder): ${abs}`);
    }

    const shard = parseShard(path.basename(abs));
    if (shard) {
      const shardDir = path.dirname(abs);
      const siblings = findShardSiblings(shardDir, shard.base, shard.total);
      if (siblings.length !== shard.total) {
        throw new Error(
          `Incomplete shard set: found ${siblings.length}/${shard.total} parts for ${shard.base} in ${shardDir}. ` +
          `All shards must live in the same folder for llama-server to auto-load them.`
        );
      }
      const first = siblings.find((s) => s.index === 1);
      const regPath = first ? first.path : abs;
      this._register(regPath);
      this.emit('models-changed');
      return shardGroupInfo(siblings, regPath);
    }

    this._register(abs);
    this.emit('models-changed');
    return ggufInfo(abs);
  }

  _register(abs) {
    const reg = this._reg();
    if (!reg.includes(abs)) { reg.push(abs); this._saveReg(); }
  }

  // Recursively scan user-configured roots for MLX dirs and GGUF files, register
  // each find (skipping duplicates), and return a summary. `dirs` matches the
  // shape of settings.llm.scanDirs: { combined, mlx, gguf }.
  scanDirs(dirs) {
    const { mlxRoots, ggufRoots } = modelScanner.resolveRoots(dirs);
    if (!mlxRoots.length && !ggufRoots.length) return { mlx: 0, gguf: 0, added: 0, skipped: 0, found: { mlx: [], gguf: [] } };
    const found = modelScanner.scan({ mlxRoots, ggufRoots });
    const reg = this._reg();
    let added = 0;
    let skipped = 0;
    for (const p of [...found.mlx, ...found.gguf]) {
      if (reg.includes(p)) { skipped += 1; continue; }
      reg.push(p);
      added += 1;
    }
    if (added) { this._saveReg(); this.emit('models-changed'); }
    return { mlx: found.mlx.length, gguf: found.gguf.length, added, skipped, found };
  }

  // Auto-detect new models dropped into modelsDir or scanDirs. Idempotent —
  // call again with a new scanDirsConfig to pick it up. See main/utils/modelWatcher.js.
  startWatching(scanDirsConfig) {
    if (!this._watcher) this._watcher = createModelWatcher(this);
    this._lastWatchCfg = scanDirsConfig || { combined: null, mlx: null, gguf: null };
    this._watcher.start(this._lastWatchCfg);
  }

  stopWatching() { if (this._watcher) this._watcher.stop(); }
}

module.exports = new ModelManagerService();

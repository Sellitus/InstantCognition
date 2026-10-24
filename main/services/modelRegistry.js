const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function registryPath() {
  try {
    return path.join(app.getPath('userData'), 'model_registry.json');
  } catch (_) {
    return path.join(process.cwd(), 'model_registry.json');
  }
}

function load() {
  const p = registryPath();
  try {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(raw.paths)) return raw.paths.filter((x) => typeof x === 'string');
    }
  } catch (_) { /* fall through */ }
  return [];
}

function save(paths) {
  const p = registryPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ paths }, null, 2));
  } catch (_) { /* best effort */ }
}

module.exports = { load, save, registryPath };

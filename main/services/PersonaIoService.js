// PersonaIoService — export/import of agent personas as JSON. Extracted from
// personaHandlers.js so the IPC layer stays under its 100-line cap. Format is
// versioned ("instantcognition.personas.v1") so future schema changes can
// migrate gracefully.

const fs = require('fs');

const FORMAT = 'instantcognition.personas.v1';
const VALID_KEYS = ['name', 'label', 'description', 'systemOverlay', 'qualityOverride', 'starterTabs', 'notes', 'followUps', 'enabled', 'builtin'];
const LABEL_MAX = 120;

// Imported labels are untrusted display text: a single line, bounded length.
function sanitizeLabel(label) {
  if (typeof label !== 'string') return '';
  return label.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, LABEL_MAX);
}

function sanitizePersona(p) {
  if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !p.name) return null;
  const out = {};
  for (const k of VALID_KEYS) if (p[k] !== undefined) out[k] = p[k];
  out.name = String(out.name).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!out.name) return null;
  out.label = sanitizeLabel(out.label) || out.name;
  if (typeof out.systemOverlay !== 'string') out.systemOverlay = '';
  if (!Array.isArray(out.starterTabs)) out.starterTabs = [];
  if (!Array.isArray(out.followUps)) out.followUps = [];
  out.builtin = false;
  return out;
}

function buildExportPayload(configService) {
  const cfg = configService.get('settings.agentPersonas', {}) || {};
  return {
    format: FORMAT,
    exportedAt: new Date().toISOString(),
    customPersonas: Array.isArray(cfg.customPersonas) ? cfg.customPersonas : [],
    builtinOverrides: cfg.builtinOverrides && typeof cfg.builtinOverrides === 'object' ? cfg.builtinOverrides : {},
  };
}

async function exportToPath(filePath, configService) {
  const payload = buildExportPayload(configService);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return { ok: true, path: filePath, count: payload.customPersonas.length };
}

function applyImport(data, configService) {
  if (!data || typeof data !== 'object' || data.format !== FORMAT) {
    return { ok: false, error: 'unrecognized_format' };
  }
  const cfg = configService.get('settings.agentPersonas', {}) || {};
  const customCur = Array.isArray(cfg.customPersonas) ? cfg.customPersonas.slice() : [];
  const overridesCur = cfg.builtinOverrides && typeof cfg.builtinOverrides === 'object' ? { ...cfg.builtinOverrides } : {};
  const enabledCur = Array.isArray(cfg.enabledPersonas) ? cfg.enabledPersonas.slice() : [];
  let added = 0; let skipped = 0;
  for (const p of (Array.isArray(data.customPersonas) ? data.customPersonas : [])) {
    const sane = sanitizePersona(p);
    if (!sane) { skipped += 1; continue; }
    if (customCur.some((c) => c && c.name === sane.name)) { skipped += 1; continue; }
    customCur.push(sane);
    if (!enabledCur.includes(sane.name)) enabledCur.push(sane.name);
    added += 1;
  }
  const overridesNext = { ...overridesCur };
  if (data.builtinOverrides && typeof data.builtinOverrides === 'object') {
    for (const k of Object.keys(data.builtinOverrides)) overridesNext[k] = data.builtinOverrides[k];
  }
  configService.set('settings.agentPersonas', { ...cfg, customPersonas: customCur, builtinOverrides: overridesNext, enabledPersonas: enabledCur });
  return { ok: true, added, skipped };
}

async function importFromPath(filePath, configService) {
  const raw = fs.readFileSync(filePath, 'utf8');
  let data;
  try { data = JSON.parse(raw); }
  catch (_err) { return { ok: false, error: 'invalid_json' }; }
  return applyImport(data, configService);
}

module.exports = {
  FORMAT,
  sanitizePersona,
  buildExportPayload,
  applyImport,
  exportToPath,
  importFromPath,
};

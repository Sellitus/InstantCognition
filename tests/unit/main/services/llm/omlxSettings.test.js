// omlxSettings — the model_settings.json oMLX reads at startup: the selected
// model becomes the one pinned default, the rest are unpinned, and the file
// is rewritten atomically under the app's base path (a temp dir here).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { omlxModelId, applyModelSettings, writeModelSettings, SETTINGS_FILE } = require('../../../../../main/services/llm/omlxSettings');

describe('omlxModelId', () => {
  test('is the folder name, trailing separators ignored', () => {
    expect(omlxModelId('/m/Qwen3-8B-4bit/')).toBe('Qwen3-8B-4bit');
    expect(omlxModelId('')).toBe('');
  });
});

describe('applyModelSettings', () => {
  test('creates a document pinning only the selected model', () => {
    expect(applyModelSettings(null, 'A', { contextLength: 8192 })).toEqual({
      version: 1, models: { A: { is_pinned: true, is_default: true, max_context_window: 8192 } },
    });
  });

  test('unpins other models but keeps their own keys; keeps unknown top-level keys', () => {
    const doc = { version: 1, extra: 'x', models: { A: { is_pinned: true, is_default: true, temperature: 0.2 }, B: { top_p: 0.9, max_context_window: 4096 } } };
    const out = applyModelSettings(doc, 'B', {});
    expect(out.extra).toBe('x');
    expect(out.models.A).toEqual({ is_pinned: false, is_default: false, temperature: 0.2 });
    expect(out.models.B).toEqual({ top_p: 0.9, is_pinned: true, is_default: true });
  });

  test('a 0/null context length removes an earlier limit', () => {
    const doc = { version: 1, models: { A: { max_context_window: 2048 } } };
    expect(applyModelSettings(doc, 'A', { contextLength: 0 }).models.A.max_context_window).toBeUndefined();
  });

  test('rejects an unknown version, a non-object models map, and invalid entries', () => {
    expect(() => applyModelSettings({ version: 2, models: {} }, 'A')).toThrow(/unsupported format \(version 2\)/);
    expect(() => applyModelSettings({ version: 1, models: [] }, 'A')).toThrow(/no valid "models" map/);
    expect(() => applyModelSettings({ version: 1, models: { B: 'x' } }, 'A')).toThrow(/invalid entry for B/);
  });
});

describe('writeModelSettings', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omlx-settings-test-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  test('creates the base path, writes the file and leaves no temp file', () => {
    const base = path.join(tmp, 'nested', 'home');
    expect(writeModelSettings(base, '/models/M1', { contextLength: 1024 })).toBe('M1');
    expect(fs.readdirSync(base)).toEqual([SETTINGS_FILE]);
    expect(JSON.parse(fs.readFileSync(path.join(base, SETTINGS_FILE), 'utf8')).models.M1.is_pinned).toBe(true);
  });

  test('merges into an existing file', () => {
    fs.writeFileSync(path.join(tmp, SETTINGS_FILE), JSON.stringify({ version: 1, models: { Old: { is_pinned: true } } }));
    writeModelSettings(tmp, '/m/New', {});
    const doc = JSON.parse(fs.readFileSync(path.join(tmp, SETTINGS_FILE), 'utf8'));
    expect(doc.models.Old.is_pinned).toBe(false);
    expect(doc.models.New.is_default).toBe(true);
  });

  test('a corrupt existing file is reported, not overwritten', () => {
    const file = path.join(tmp, SETTINGS_FILE);
    fs.writeFileSync(file, '{oops');
    expect(() => writeModelSettings(tmp, '/m/A', {})).toThrow(/Could not read/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{oops');
  });

  test('refuses an empty model path', () => {
    expect(() => writeModelSettings(tmp, '/', {})).toThrow(/needs a model folder/);
  });
});

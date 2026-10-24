// ExtensionService tests — mocks electron session + filesystem.

const mockState = { session: null };

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/tmp-mock') },
  session: {
    get defaultSession() { return mockState.session; },
  },
}));

jest.mock('fs', () => {
  const real = jest.requireActual('fs');
  return {
    ...real,
    existsSync: jest.fn(),
  };
});

// httpDownload + crxUnpack wrap the real external boundaries (https,
// extract-zip). For the install-from-URL/crx flow they are the boundary and
// are faked; ExtensionService's staging/preview/commit logic runs for real.
jest.mock('../../../../main/utils/httpDownload', () => ({ downloadToFile: jest.fn() }));
jest.mock('../../../../main/utils/crxUnpack', () => ({ unpackArchive: jest.fn() }));

let fs;
let svc;

function makeFakeSession() {
  return {
    loadExtension: jest.fn((p) => Promise.resolve({
      id: `id-${p}`,
      name: 'TestExt',
      version: '1.0.0',
    })),
    removeExtension: jest.fn(),
  };
}

function makeFakeConfig() {
  const store = {};
  return {
    get: jest.fn((key, def) => (key in store ? store[key] : def)),
    set: jest.fn((key, val) => { store[key] = val; }),
    _store: store,
  };
}

beforeEach(() => {
  jest.resetModules();
  mockState.session = makeFakeSession();
  fs = require('fs');
  fs.existsSync.mockImplementation(() => true);
  svc = require('../../../../main/services/ExtensionService');
  svc._fakeSess = mockState.session;
});

describe('ExtensionService', () => {
  test('load returns info and emits loaded event', async () => {
    const onLoaded = jest.fn();
    svc.on('loaded', onLoaded);
    const info = await svc.load('/tmp/my-ext');
    expect(info.id).toBe('id-/tmp/my-ext');
    expect(info.name).toBe('TestExt');
    expect(onLoaded).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-/tmp/my-ext' }));
  });

  test('load throws when path missing', async () => {
    fs.existsSync.mockImplementationOnce(() => false);
    await expect(svc.load('/nope')).rejects.toThrow(/Path not found/);
  });

  test('load throws when manifest missing', async () => {
    fs.existsSync.mockImplementation((p) => !p.endsWith('manifest.json'));
    await expect(svc.load('/tmp/no-manifest')).rejects.toThrow(/manifest\.json/);
  });

  test('list returns loaded extensions', async () => {
    await svc.load('/tmp/a');
    await svc.load('/tmp/b');
    const list = svc.list();
    expect(list.length).toBe(2);
    expect(list[0]).toEqual(expect.objectContaining({ name: 'TestExt' }));
  });

  test('remove returns false for unknown id', () => {
    expect(svc.remove('nope')).toBe(false);
  });

  test('remove unloads extension and emits removed', async () => {
    await svc.load('/tmp/a');
    const onRemoved = jest.fn();
    svc.on('removed', onRemoved);
    expect(svc.remove('id-/tmp/a')).toBe(true);
    expect(svc._fakeSess.removeExtension).toHaveBeenCalledWith('id-/tmp/a');
    expect(svc.list().length).toBe(0);
    expect(onRemoved).toHaveBeenCalledWith({ id: 'id-/tmp/a' });
  });

  test('initialize loads paths from config', async () => {
    const cfg = makeFakeConfig();
    cfg._store['settings.extensions.paths'] = ['/tmp/x'];
    cfg.get.mockImplementation((key, def) => (key in cfg._store ? cfg._store[key] : def));
    await svc.initialize(cfg);
    await new Promise((r) => setImmediate(r));
    expect(svc._fakeSess.loadExtension).toHaveBeenCalledWith('/tmp/x', expect.any(Object));
  });

  test('a configured extension that fails at startup stays in config through later installs', async () => {
    const cfg = makeFakeConfig();
    cfg._store['settings.extensions.paths'] = ['/tmp/good', '/tmp/offline'];
    svc._fakeSess.loadExtension.mockImplementation((p) => (p === '/tmp/offline'
      ? Promise.reject(new Error('drive not mounted'))
      : Promise.resolve({ id: `id-${p}`, name: 'TestExt', version: '1.0.0' })));
    svc.initialize(cfg);
    await new Promise((r) => setImmediate(r));
    expect(cfg.set).not.toHaveBeenCalled();
    await svc.load('/tmp/new');
    expect(cfg._store['settings.extensions.paths'].sort()).toEqual(['/tmp/good', '/tmp/new', '/tmp/offline']);
  });

  test('removing a loaded extension drops it from config', async () => {
    const cfg = makeFakeConfig();
    svc._configService = cfg;
    await svc.load('/tmp/a');
    await svc.load('/tmp/b');
    svc.remove('id-/tmp/a');
    expect(cfg._store['settings.extensions.paths']).toEqual(['/tmp/b']);
  });

  test('persists paths after load when configService set', async () => {
    const cfg = makeFakeConfig();
    svc._configService = cfg;
    await svc.load('/tmp/persisted');
    expect(cfg.set).toHaveBeenCalledWith('settings.extensions.paths', ['/tmp/persisted']);
  });
});

const path = require('path');
const os = require('os');
const realFs = jest.requireActual('fs');

describe('ExtensionService install flow', () => {
  test('parseWebStoreId accepts a bare id and Web Store URLs, rejects others', () => {
    const id = 'cjpalhdlnbpafiamejdnhcphjbkeiagm';
    expect(svc.parseWebStoreId(id)).toBe(id);
    expect(svc.parseWebStoreId(`https://chromewebstore.google.com/detail/ublock/${id}`)).toBe(id);
    expect(svc.parseWebStoreId(`https://chrome.google.com/webstore/detail/x/${id}`)).toBe(id);
    expect(svc.parseWebStoreId('https://example.com/whatever')).toBeNull();
    expect(svc.parseWebStoreId('not an id')).toBeNull();
    expect(svc.parseWebStoreId('')).toBeNull();
  });

  test('webStoreCrxUrl targets the CRX endpoint with the id and redirect format', () => {
    const url = svc.webStoreCrxUrl('cjpalhdlnbpafiamejdnhcphjbkeiagm');
    expect(url).toContain('https://clients2.google.com/service/update2/crx');
    expect(url).toContain('response=redirect');
    expect(url).toContain('id%3Dcjpalhdlnbpafiamejdnhcphjbkeiagm');
  });

  test('prepareInstall rejects an empty source', async () => {
    expect(await svc.prepareInstall('')).toEqual({ ok: false, error: 'No source provided' });
  });

  test('prepareInstall reports a missing local path', async () => {
    fs.existsSync.mockImplementation(() => false);
    const res = await svc.prepareInstall('/no/such/ext');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Path not found/);
  });

  test('prepareInstall previews an unpacked directory and splits MV2 host perms', async () => {
    const dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'ic-ext-test-'));
    realFs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      name: 'My Ext',
      version: '2.1',
      permissions: ['storage', 'tabs', 'https://*/*'],
      host_permissions: ['<all_urls>'],
    }));
    fs.existsSync.mockImplementation(() => true);
    const res = await svc.prepareInstall(dir);
    expect(res.ok).toBe(true);
    expect(res.isDirectory).toBe(true);
    expect(res.staging).toBe(path.resolve(dir));
    expect(res.name).toBe('My Ext');
    expect(res.version).toBe('2.1');
    expect(res.permissions).toEqual(['storage', 'tabs']);
    expect(res.hostPermissions).toEqual(expect.arrayContaining(['<all_urls>', 'https://*/*']));
    realFs.rmSync(dir, { recursive: true, force: true });
  });

  test('commitInstall(accept:false) discards a staged copy', async () => {
    const staging = realFs.mkdtempSync(path.join(os.tmpdir(), 'ic-ext-stage-'));
    const res = await svc.commitInstall({ staging, isDirectory: false, accept: false });
    expect(res).toEqual({ ok: false, cancelled: true });
    expect(realFs.existsSync(staging)).toBe(false);
  });

  test('commitInstall(accept:true, directory) loads it through the session', async () => {
    const res = await svc.commitInstall({ staging: '/tmp/dir-ext', isDirectory: true, accept: true });
    expect(res.ok).toBe(true);
    expect(svc._fakeSess.loadExtension).toHaveBeenCalledWith('/tmp/dir-ext', expect.any(Object));
  });
});

describe('ExtensionService — install-from-URL / crx flow', () => {
  let downloadToFile;
  let unpackArchive;

  function writeManifest(dir, manifest, locales) {
    realFs.mkdirSync(dir, { recursive: true });
    realFs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    if (locales) {
      for (const [loc, msgs] of Object.entries(locales)) {
        const ld = path.join(dir, '_locales', loc);
        realFs.mkdirSync(ld, { recursive: true });
        realFs.writeFileSync(path.join(ld, 'messages.json'), JSON.stringify(msgs));
      }
    }
  }

  beforeEach(() => {
    // Same module generation as the freshly-required svc (post resetModules).
    ({ downloadToFile } = require('../../../../main/utils/httpDownload'));
    ({ unpackArchive } = require('../../../../main/utils/crxUnpack'));
    // Real fs is used for staging dirs; existsSync must reflect the disk.
    fs.existsSync.mockImplementation((p) => realFs.existsSync(p));
  });

  test('prepareInstall from a Web Store id downloads the CRX, unpacks it, and returns the manifest preview without loading', async () => {
    downloadToFile.mockResolvedValue();
    unpackArchive.mockImplementation(async (_crx, dir) => {
      writeManifest(dir, {
        name: 'uBlock', version: '1.5', permissions: ['storage', 'https://*/*'],
        host_permissions: ['<all_urls>'],
      });
      return dir;
    });

    const id = 'cjpalhdlnbpafiamejdnhcphjbkeiagm';
    const res = await svc.prepareInstall(id);

    expect(downloadToFile).toHaveBeenCalledTimes(1);
    const dlUrl = downloadToFile.mock.calls[0][0];
    expect(dlUrl).toContain('https://clients2.google.com/service/update2/crx');
    expect(dlUrl).toContain(`id%3D${id}`);
    expect(unpackArchive).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    expect(res.isDirectory).toBe(false);
    expect(res.name).toBe('uBlock');
    expect(res.version).toBe('1.5');
    expect(res.permissions).toEqual(['storage']);
    expect(res.hostPermissions).toEqual(expect.arrayContaining(['<all_urls>', 'https://*/*']));
    // preview only — nothing loaded into the session yet
    expect(svc._fakeSess.loadExtension).not.toHaveBeenCalled();
  });

  test('prepareInstall from a direct https .zip URL takes the same download+unpack path', async () => {
    downloadToFile.mockResolvedValue();
    unpackArchive.mockImplementation(async (_src, dir) => {
      writeManifest(dir, { name: 'Direct', version: '9' });
      return dir;
    });
    const res = await svc.prepareInstall('https://example.com/ext.zip');
    expect(downloadToFile).toHaveBeenCalledWith('https://example.com/ext.zip', expect.stringMatching(/\.crx$/));
    expect(res).toEqual(expect.objectContaining({ ok: true, name: 'Direct', version: '9' }));
  });

  test('prepareInstall surfaces a download failure instead of swallowing it', async () => {
    downloadToFile.mockRejectedValue(new Error('Only HTTPS downloads are allowed'));
    const res = await svc.prepareInstall('https://insecure.example/ext.crx');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Only HTTPS downloads are allowed/);
    expect(unpackArchive).not.toHaveBeenCalled();
  });

  test('prepareInstall reports a missing manifest after unpacking and cleans up staging', async () => {
    downloadToFile.mockResolvedValue();
    let stagedDir;
    unpackArchive.mockImplementation(async (_crx, dir) => {
      stagedDir = dir; // unpack produced no manifest.json
      realFs.mkdirSync(dir, { recursive: true });
      return dir;
    });
    const res = await svc.prepareInstall('cjpalhdlnbpafiamejdnhcphjbkeiagm');
    expect(res).toEqual({ ok: false, error: 'No manifest.json found in the extension' });
    // staging copy must be removed, not left behind
    expect(realFs.existsSync(stagedDir)).toBe(false);
  });

  test('prepareInstall from a local .zip file unpacks to staging and previews it', async () => {
    const zipFile = realFs.mkdtempSync(path.join(os.tmpdir(), 'ic-zip-')) + '/ext.zip';
    realFs.writeFileSync(zipFile, 'PK');
    unpackArchive.mockImplementation(async (_src, dir) => {
      writeManifest(dir, { name: 'LocalZip', version: '2' });
      return dir;
    });
    const res = await svc.prepareInstall(zipFile);
    expect(downloadToFile).not.toHaveBeenCalled();
    expect(unpackArchive).toHaveBeenCalledWith(path.resolve(zipFile), expect.any(String));
    expect(res).toEqual(expect.objectContaining({ ok: true, name: 'LocalZip', isDirectory: false }));
  });

  test('prepareInstall resolves a __MSG_ localized extension name from _locales', async () => {
    const dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'ic-msg-'));
    writeManifest(dir, {
      name: '__MSG_extName__', version: '3', default_locale: 'en',
    }, { en: { extName: { message: 'Resolved Name' } } });
    const res = await svc.prepareInstall(dir);
    expect(res.ok).toBe(true);
    expect(res.isDirectory).toBe(true);
    expect(res.name).toBe('Resolved Name');
    realFs.rmSync(dir, { recursive: true, force: true });
  });

  test('commitInstall(accept:true) for a staged archive copies it into the extensions dir and loads it', async () => {
    const extRoot = realFs.mkdtempSync(path.join(os.tmpdir(), 'ic-extroot-'));
    require('electron').app.getPath.mockReturnValue(extRoot);

    const staging = realFs.mkdtempSync(path.join(os.tmpdir(), 'ic-staged-'));
    writeManifest(staging, { name: 'My Cool Ext!!', version: '4.2' });

    const res = await svc.commitInstall({ staging, isDirectory: false, accept: true });

    expect(res.ok).toBe(true);
    const loadedDir = svc._fakeSess.loadExtension.mock.calls[0][0];
    // copied under <userData>/extensions with a slugified name
    expect(loadedDir.startsWith(path.join(extRoot, 'extensions'))).toBe(true);
    expect(path.basename(loadedDir)).toMatch(/^my-cool-ext-[a-z0-9]+$/);
    expect(realFs.existsSync(path.join(loadedDir, 'manifest.json'))).toBe(true);
    // staging copy is removed after the commit
    expect(realFs.existsSync(staging)).toBe(false);

    realFs.rmSync(extRoot, { recursive: true, force: true });
  });

  test('commitInstall rejects when there is nothing staged', async () => {
    expect(await svc.commitInstall({})).toEqual({ ok: false, error: 'Nothing to install' });
  });
});

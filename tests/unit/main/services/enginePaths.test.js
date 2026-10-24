// enginePaths + the discovery preference it exists for: an engine the user
// updated lives in userData and must win over the copy frozen into the bundle.

jest.mock('electron', () => ({ app: { getPath: jest.fn(() => '/userdata'), isPackaged: false } }));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn(() => false),
    statSync: jest.fn(() => ({ isFile: () => true })),
    readdirSync: jest.fn(() => []),
  };
});

const path = require('path');

const dirent = (name) => ({ name, isDirectory: () => true });

/**
 * jest.resetModules gives each isolated registry its own `fs` mock instance, so
 * the stubs have to be installed inside the same scope that loads the module.
 * @param {(fs: any) => void} setup
 * @param {string} modulePath
 */
function loadWithFs(setup, modulePath) {
  let mod;
  jest.isolateModules(() => {
    setup(require('fs'));
    mod = require(modulePath);
  });
  return mod;
}

const ENGINE_PATHS = '../../../../main/services/llm/enginePaths';
const DISCOVERY = '../../../../main/services/EngineDiscoveryService';

describe('enginePaths', () => {
  test('managed llama installs come back newest build first', () => {
    const { managedLlamaDirs } = loadWithFs((fs) => {
      fs.readdirSync.mockReturnValue([dirent('b9000'), dirent('b10831'), dirent('b10809')]);
    }, ENGINE_PATHS);

    // Lexical order would put b9000 first and pin the app to the oldest build.
    expect(managedLlamaDirs().map((d) => path.basename(d))).toEqual(['b10831', 'b10809', 'b9000']);
  });

  test('ignores directories that are not build installs', () => {
    const { managedLlamaDirs } = loadWithFs((fs) => {
      fs.readdirSync.mockReturnValue([dirent('b10831'), dirent('.staging-b10900'), { name: 'notes.txt', isDirectory: () => false }]);
    }, ENGINE_PATHS);

    expect(managedLlamaDirs().map((d) => path.basename(d))).toEqual(['b10831']);
  });

  test('an unreadable engines directory is an empty list, not a throw', () => {
    const { managedLlamaDirs } = loadWithFs((fs) => {
      fs.readdirSync.mockImplementation(() => { throw new Error('ENOENT'); });
    }, ENGINE_PATHS);

    expect(managedLlamaDirs()).toEqual([]);
  });

  test('managedMlxPython resolves only when the venv interpreter exists', () => {
    const absent = loadWithFs((fs) => { fs.existsSync.mockReturnValue(false); }, ENGINE_PATHS);
    expect(absent.managedMlxPython()).toBeNull();

    const present = loadWithFs((fs) => { fs.existsSync.mockReturnValue(true); }, ENGINE_PATHS);
    expect(present.managedMlxPython()).toBe(path.join('/userdata', 'engines', 'mlx-venv', 'bin', 'python3'));
  });
});

describe('EngineDiscoveryService managed-install preference', () => {
  test('a managed llama-server is searched before the bundled one', async () => {
    let svc;
    jest.isolateModules(() => {
      const fs = require('fs');
      fs.existsSync.mockImplementation((p) => typeof p === 'string' && p.includes('llama-server') && !p.endsWith('.exe'));
      fs.statSync.mockReturnValue({ isFile: () => true });
      jest.doMock(ENGINE_PATHS, () => ({
        managedRoot: () => '/userdata/engines',
        managedLlamaRoot: () => '/userdata/engines/llama-server',
        managedLlamaDirs: () => ['/userdata/engines/llama-server/b10831'],
        managedMlxVenv: () => '/userdata/engines/mlx-venv',
        venvPython: (d) => `${d}/bin/python3`,
        managedMlxPython: () => null,
      }));
      svc = require(DISCOVERY);
    });

    expect(await svc.findLlamaServerBinary()).toBe(path.join('/userdata/engines/llama-server/b10831', 'llama-server'));
  });

  test('the managed MLX interpreter shadows the bundled runtime', () => {
    let svc;
    jest.isolateModules(() => {
      require('fs').existsSync.mockReturnValue(true);
      jest.doMock(ENGINE_PATHS, () => ({
        managedRoot: () => '/userdata/engines',
        managedLlamaRoot: () => '/userdata/engines/llama-server',
        managedLlamaDirs: () => [],
        managedMlxVenv: () => '/userdata/engines/mlx-venv',
        venvPython: (d) => `${d}/bin/python3`,
        managedMlxPython: () => '/userdata/engines/mlx-venv/bin/python3',
      }));
      svc = require(DISCOVERY);
    });

    expect(svc.getBundledMlxPython()).toBe('/userdata/engines/mlx-venv/bin/python3');
  });
});

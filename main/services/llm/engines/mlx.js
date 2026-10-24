// mlx-openai-server runtime adapter for EngineUpdateService: its PyPI packages
// against the bundled interpreter, upgraded into the managed mlx-venv.

const { MLX_PACKAGES, compareVersionStrings } = require('../../../../shared/engineRelease');
const fetcher = require('../engineFetch');
const enginePaths = require('../enginePaths');
const discovery = require('../../EngineDiscoveryService');

module.exports = {
  id: 'mlx',
  name: 'MLX',
  supported: (platform) => platform === 'darwin',

  /** @param {{latest: Record<string, any>}} ctx */
  async check(ctx) {
    const det = await discovery.detectMlx();
    if (!det || (!det.available && !det.pythonPath && det.reason)) {
      // Intel Macs cannot run MLX — not an error, and nothing to offer.
      return { engine: 'mlx', ok: true, name: 'MLX', current: 'unavailable', latest: null, updateAvailable: false, reason: det && det.reason };
    }
    const packages = (det && det.packages) || {};
    const rows = [];
    let updateAvailable = false;
    for (const pkg of MLX_PACKAGES) {
      const meta = await fetcher.getJson(`https://pypi.org/pypi/${pkg}/json`);
      const latest = (meta && meta.info && meta.info.version) || null;
      const current = packages[pkg] || null;
      if (!latest) throw new Error(`PyPI did not report a version for ${pkg}.`);
      const newer = !current || compareVersionStrings(latest, current) > 0;
      if (newer) updateAvailable = true;
      rows.push({ package: pkg, current: current || 'not installed', latest });
    }
    ctx.latest.mlx = rows;
    return {
      engine: 'mlx',
      ok: true,
      name: 'MLX',
      current: rows.map((r) => `${r.package} ${r.current}`).join(', '),
      latest: rows.map((r) => `${r.package} ${r.latest}`).join(', '),
      packages: rows,
      updateAvailable,
    };
  },

  /** @param {{send: (payload: object) => void}} ctx */
  async install(ctx) {
    const venv = enginePaths.managedMlxVenv();
    if (!venv) throw new Error('No writable engines directory is available.');
    let python = enginePaths.managedMlxPython();
    if (!python) {
      const base = discovery.getBundledMlxPython() || await discovery.findPythonInterpreter();
      if (!base) throw new Error('No python runtime was found to create the MLX environment.');
      ctx.send({ ok: true, status: 'installing', engine: 'mlx', step: 'creating environment' });
      // --system-site-packages keeps the bundled runtime's already-built mlx
      // wheels reachable, so the venv only has to carry what it upgrades.
      await fetcher.run(base, ['-m', 'venv', '--system-site-packages', venv], { timeoutMs: 300000 });
      python = enginePaths.venvPython(venv);
    }
    ctx.send({ ok: true, status: 'installing', engine: 'mlx', step: 'installing packages' });
    await fetcher.run(python, ['-m', 'pip', 'install', '--no-cache-dir', '--upgrade', ...MLX_PACKAGES], { timeoutMs: 900000 });
    const det = await discovery.detectMlx();
    const packages = (det && det.packages) || {};
    return MLX_PACKAGES.map((p) => `${p} ${packages[p] || 'unknown'}`).join(', ');
  },
};

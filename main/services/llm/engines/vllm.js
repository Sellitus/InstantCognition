// vLLM runtime adapter for EngineUpdateService: the newest PyPI release against
// the version in the app's vLLM venv (native on Linux, inside WSL on Windows).
// Updating reruns setup with upgrade on, so a half-finished install is
// completed by the same path. Machines that still need the guided setup (WSL,
// restart, distro) are reported, never set up from an update.

const { VLLM_PACKAGE, compareVersionStrings } = require('../../../../shared/engineRelease');
const fetcher = require('../engineFetch');
const discovery = require('../../EngineDiscoveryService');
const { runSetup } = require('../vllmSetup');

const UPDATABLE_STATES = ['ready', 'not-installed'];

module.exports = {
  id: 'vllm',
  name: 'vLLM',
  supported: (platform) => platform === 'linux' || platform === 'win32',

  /** @param {{latest: Record<string, any>}} ctx */
  async check(ctx) {
    const det = await discovery.detectVllm();
    if (!UPDATABLE_STATES.includes(det.setupState)) {
      return { engine: 'vllm', ok: true, name: 'vLLM', current: 'not set up', latest: null, updateAvailable: false, setupState: det.setupState, reason: det.reason };
    }
    const meta = await fetcher.getJson(`https://pypi.org/pypi/${VLLM_PACKAGE}/json`);
    const latest = (meta && meta.info && meta.info.version) || null;
    if (!latest) throw new Error(`PyPI did not report a version for ${VLLM_PACKAGE}.`);
    ctx.latest.vllm = latest;
    const current = det.available ? det.version : null;
    return {
      engine: 'vllm',
      ok: true,
      name: 'vLLM',
      current: current || 'not installed',
      latest,
      setupState: det.setupState,
      updateAvailable: !current || compareVersionStrings(latest, /** @type {string} */ (current)) > 0,
    };
  },

  /** @param {{send: (payload: object) => void}} ctx */
  async install(ctx) {
    const result = await runSetup({
      upgrade: true,
      send: (p) => ctx.send({ ok: true, status: 'installing', engine: 'vllm', ...p }),
    });
    if (result.state !== 'ready' || !result.version) {
      throw new Error(result.reason || `vLLM setup stopped at "${result.state}".`);
    }
    discovery.clearCache();
    return result.version;
  },
};

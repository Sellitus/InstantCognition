// llama.cpp runtime adapter for EngineUpdateService: the newest build tag from
// GitHub against `llama-server --version`, installed by llamaInstall.

const { LLAMA_REPO, NIGHTLY_TAG_ASSET, parseNightlyTag, isNewerLlamaBuild } = require('../../../../shared/engineRelease');
const fetcher = require('../engineFetch');
const discovery = require('../../EngineDiscoveryService');
const { installLlamaBuild } = require('../llamaInstall');

const GITHUB_API = 'https://api.github.com';

// `releases/latest` is a versioned release whose only asset names the build
// release carrying the binaries, so the tag always resolves through it.
async function latestLlamaTag() {
  const release = await fetcher.getJson(`${GITHUB_API}/repos/${LLAMA_REPO}/releases/latest`);
  const assets = (release && release.assets) || [];
  const pointer = assets.find((a) => a.name === NIGHTLY_TAG_ASSET);
  if (pointer) {
    const tag = parseNightlyTag(await fetcher.fetchText(pointer.browser_download_url));
    if (tag) return tag;
  }
  const direct = parseNightlyTag(String((release && release.tag_name) || ''));
  if (direct) return direct;
  throw new Error('Could not resolve the latest llama.cpp build tag.');
}

module.exports = {
  id: 'llamaCpp',
  name: 'llama.cpp',
  supported: () => true,

  /** @param {{latest: Record<string, any>}} ctx */
  async check(ctx) {
    const tag = await latestLlamaTag();
    ctx.latest.llamaCpp = tag;
    const installed = await discovery.detectLlamaCpp();
    const current = installed.available ? installed.version : null;
    return {
      engine: 'llamaCpp',
      ok: true,
      name: 'llama.cpp',
      current: current || 'not installed',
      latest: tag,
      updateAvailable: isNewerLlamaBuild(tag, current || ''),
    };
  },

  /** @param {{latest: Record<string, any>, send: (payload: object) => void}} ctx */
  async install(ctx) {
    const tag = ctx.latest.llamaCpp || await latestLlamaTag();
    return installLlamaBuild(tag, ctx.send);
  },
};

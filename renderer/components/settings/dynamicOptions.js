// dynamicOptions — option lists for registry rows whose choices depend on
// config (`dynamicOptions: 'spaces' | 'dohProviders' | 'searchEngines'`).
// resolveDynamicOptions() fills `setting.options` and appends the option
// labels to the row's search blob so typing a choice finds its select.

// Mirror of DnsService.PROVIDER_CATALOG (main process). Rendering is
// synchronous, so the small list is inlined rather than fetched over IPC.
const DOH_PROVIDERS = [
  { value: 'cloudflare', label: 'Cloudflare (1.1.1.1)' },
  { value: 'google', label: 'Google (8.8.8.8)' },
  { value: 'quad9', label: 'Quad9 (9.9.9.9)' },
  { value: 'nextdns', label: 'NextDNS' },
  { value: 'adguard', label: 'AdGuard DNS' },
  { value: 'opendns', label: 'OpenDNS' },
  { value: 'custom', label: 'Custom URL…' },
];

const BUILTIN_SEARCH_ENGINES = [
  { value: 'google', label: 'Google' },
  { value: 'duckduckgo', label: 'DuckDuckGo' },
  { value: 'bing', label: 'Bing' },
  { value: 'kagi', label: 'Kagi' },
  { value: 'startpage', label: 'Startpage' },
  { value: 'ecosia', label: 'Ecosia' },
  { value: 'brave', label: 'Brave Search' },
];

const SOURCES = {
  spaces: (config) => Object.entries((config && config.spaces) || {}).map(([id, sp]) => ({ value: id, label: (sp && sp.name) || id })),
  dohProviders: () => DOH_PROVIDERS.slice(),
  searchEngines: (config) => {
    const list = config && config.settings && config.settings.customSearchEngines;
    const custom = Array.isArray(list)
      ? list.filter((e) => e && e.id && e.url).map((e) => ({ value: e.id, label: e.name || e.id }))
      : [];
    return BUILTIN_SEARCH_ENGINES.concat(custom);
  },
};

/** Fill `setting.options` from config. Throws on an unknown source name. */
function resolveDynamicOptions(setting, config) {
  if (!setting.dynamicOptions) return;
  const source = SOURCES[setting.dynamicOptions];
  if (typeof source !== 'function') throw new Error(`Unknown dynamicOptions source "${setting.dynamicOptions}" on ${setting.id}`);
  setting.options = source(config);
  if (setting._baseSearch == null) setting._baseSearch = setting._search || '';
  setting._search = `${setting._baseSearch} ${setting.options.map((o) => String(o.label).toLowerCase()).join(' ')}`;
}

module.exports = { resolveDynamicOptions, DYNAMIC_OPTION_SOURCES: Object.freeze(Object.keys(SOURCES)) };

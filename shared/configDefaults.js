/**
 * Default configuration and migration logic.
 * Single source of truth for config shape, defaults, and version upgrades.
 */

const { DEFAULT_LLM_SETTINGS } = require('./llmDefaults');

const CURRENT_CONFIG_VERSION = 35;

const DEFAULT_SPACES = {
  custom1: { name: 'ChatGPT', url: 'https://chatgpt.com/', type: 'ai-service' },
  custom2: { name: 'Claude', url: 'https://claude.ai/new', type: 'ai-service' },
  custom3: { name: 'Gemini', url: 'https://gemini.google.com/', type: 'ai-service' },
  custom4: { name: 'Mistral', url: 'https://chat.mistral.ai/chat', type: 'ai-service' },
  custom5: { name: 'Copilot', url: 'https://copilot.microsoft.com/', type: 'ai-service' },
  custom6: { name: 'Perplexity', url: 'https://www.perplexity.ai/', type: 'ai-service' },
  custom7: { name: 'PoeCom', url: 'https://www.poe.com/', type: 'ai-service' },
  custom8: { name: 'YouCom', url: 'https://www.you.com/', type: 'ai-service' },
  custom9: { name: 'Perplexity Labs', url: 'https://labs.perplexity.ai/', type: 'ai-service' },
  custom10: { name: 'HuggingFace', url: 'https://huggingface.co/chat/', type: 'ai-service' },
  custom11: { name: 'OpenRouter', url: 'https://openrouter.ai/chat', type: 'ai-service' },
  custom13: { name: 'Scholar', url: 'https://scholar.google.com/', type: 'web-page' },
  custom14: { name: 'YoutubeMusic', url: 'https://music.youtube.com/', type: 'web-page' },
  custom15: { name: 'Google', url: 'https://www.google.com/', type: 'web-page' },
  browser: { name: 'Browser', url: 'https://www.google.com/', type: 'web-page' },
};

const DEFAULT_SETTINGS = {
  preventMenuExpansion: false,
  enableAdblocker: false,
  launchAtStartup: false,
  enableDefaultSpace: false,
  defaultSpace: 'custom1',
  openLinkExternal: false,
  browserHomeUrl: 'https://www.google.com/',
  multiSpace: false,
  persistZoomLevels: false,
  lastLayout: 'sideBySide',
  autoDenyCertErrors: false,
  // Auto-accept self-signed / invalid certs from LAN/private addresses, per range.
  // Each toggle is opt-in (false). Enabling 'loopback' means an invalid cert
  // from 127.0.0.0/8 is silently trusted (useful for local dev servers).
  autoAcceptCertsForPrivateIps: {
    loopback: false,
    rfc1918: false,
    linkLocal: false,
    cgnat: false,
    ipv6Loopback: false,
    ipv6Ula: false,
    ipv6LinkLocal: false,
  },
  // Hostnames added here are exempted from adblocker blocking. Populated by
  // the "site blocked" popup when the user clicks "Add to allowlist", or
  // managed via Privacy & Security settings.
  siteAllowlist: [],
  theme: 'dark',
  enableAnimations: true,
  enableRippleEffects: true,
  // Visual effects level: 'full' | 'subtle' | 'off' (renderer/fx).
  motionEffects: 'full',
  // Ambient background behind the tab chrome (renderer/fx/ambient.js).
  // scene: 'cycle' | 'aurora' | 'nebula' | 'flowlines' | 'drift' | 'off'
  chromeAmbient: { scene: 'cycle', intensity: 'soft' },
  sidebarExpandedWidth: 220,
  shortcuts: {},
  spacePresets: {},
  llm: { ...DEFAULT_LLM_SETTINGS },
  chromeLayout: 'left',
  notifications: {
    enabled: true,
    showToasts: true,
    maxInbox: 200,
    dedupWindowMs: 3000,
  },

  // ---- Startup ---------------------------------------------------------
  // 'restoreSession' = re-open whatever tabs were open last quit
  // 'defaultSpace'   = open the configured defaultSpace
  // 'url'            = open `startupUrl` in the browser space
  startupBehavior: 'restoreSession',
  startupUrl: '',
  startMinimizedToTray: false,

  // ---- Search & Address Bar -------------------------------------------
  defaultSearchEngine: 'google',
  customSearchEngines: [], // [{ id, name, url, suggest? }]
  searchSuggestionsEnabled: true,
  addressBarSearchHistory: true,

  // ---- Web search (agent's browser.web_search tool) -------------------
  // The agent had no way to search the web — it could only reach URLs the
  // user typed or read off a page. `search` configures the SearchService
  // backing the browser.web_search tool.
  //   provider:
  //     'inBrowser' (default) — drive a background agent tab against a
  //       scrape-tolerant SERP and harvest results via the page DOM. No
  //       API key, cross-platform, lowest block risk (real browser session).
  //     'searxng'   — query a user-supplied SearXNG instance (privacy
  //       aggregation; needs `searxngUrl`).
  //     'brave'/'tavily' — hosted search APIs (need the matching key).
  //   inBrowserEngine: which SERP the inBrowser provider scrapes.
  //   resultCount: max results handed back to the model (clamped 1–10).
  // NOTE: this is independent of `defaultSearchEngine` above, which only
  // governs the address bar's query→URL behavior for the human user.
  search: {
    provider: 'inBrowser',
    inBrowserEngine: 'duckduckgo', // 'duckduckgo' | 'bing' | 'startpage'
    searxngUrl: '',
    braveApiKey: '',
    tavilyApiKey: '',
    resultCount: 6,
  },

  // Ask-your-browsing: relevance search over history + bookmarks. Lexical
  // ranking is always on (no endpoint, no deps). Embeddings are an opt-in
  // overlay — set embeddingsEndpoint to a /v1/embeddings server (a dedicated
  // llama-server --embeddings, or a remote endpoint) to enable semantic
  // re-ranking; left blank, results stay keyword-ranked. `blend` is the
  // embedding weight (0 = pure lexical, 1 = pure cosine) used in hybrid mode.
  askBrowsing: {
    enabled: true,
    embeddingsEndpoint: '',
    embeddingsModel: '',
    blend: 0.5,
    maxResults: 8,
    indexContent: false, // opt-in: index visited pages' readable body text for content-aware Ask ranking
  },

  // Chat surface settings for the unified auto-routing composer (Settings → Chat).
  // Grounding is ON by default — plain questions get live web results and a
  // reasoning instruction without any per-message toggle. The rows are opt-out:
  // turning one off in Settings persists here and fillDefaults backfills this
  // block for pre-existing configs that lack the key (a user who explicitly set
  // a value keeps it).
  // mode:            'auto' | 'chat' | 'agent'. auto = per-message intent routing;
  //                  chat/agent force every manual send down one path. Programmatic
  //                  dispatch (routines, packs) is unaffected — it always runs the agent loop.
  // webSearch:       run a web search and inject results before answering.
  // readTopPage:     when webSearch is on, also read the top result's body text.
  // thinkStepByStep: prepend a "reason step by step" instruction to the model.
  chat: {
    mode: 'auto',
    features: {
      webSearch: true,
      readTopPage: true,
      thinkStepByStep: true,
    },
  },

  // ---- Appearance extensions ------------------------------------------
  pageZoomDefault: 1.0,           // 1.0 = 100%
  uiDensity: 'comfortable',       // 'compact' | 'comfortable'
  accentColor: null,              // null = use theme accent

  // ---- Privacy & Security ---------------------------------------------
  httpsOnly: false,
  blockThirdPartyCookies: false,
  clearCookiesOnQuit: false,
  doNotTrack: false,

  // ---- Saved passwords (PasswordService) --------------------------------
  // offerToSave shows the "Save password?" bar after a login submit.
  passwords: {
    offerToSave: true,
  },

  // ---- Downloads -------------------------------------------------------
  downloadLocation: null,         // null = OS default Downloads dir
  askBeforeDownload: false,
  openFileAfterDownload: false,
  downloadHistoryCap: 500,        // promotes hardcoded MAX_HISTORY in DownloadService

  // ---- Tabs / Spaces extensions ---------------------------------------
  tabSleepEnabled: false,
  tabSleepMinutes: 10,
  memorySaverThresholdMB: 800,    // promotes MemoryService.MEMORY_THRESHOLD
  memoryCriticalThresholdMB: 1200, // promotes MemoryService.CRITICAL_THRESHOLD

  // ---- Languages & Accessibility --------------------------------------
  spellCheck: {
    enabled: false,
    languages: ['en-US'],
  },
  acceptLanguages: ['en-US', 'en'],
  forceReducedMotion: false,
  highContrast: false,

  // ---- Advanced / System ----------------------------------------------
  // 'auto' preserves the legacy platform-conditional behavior
  // (off on Windows, on elsewhere). 'on' / 'off' are explicit overrides.
  hardwareAcceleration: 'auto',
  defaultBrowser: false,          // last-known status, refreshed at startup
  logLevel: 'info',               // 'error' | 'warn' | 'info' | 'debug'
  historyCap: 5000,               // promotes HistoryService.MAX_ENTRIES
  screenshotMaxDim: 1280,         // promotes ScreenshotService.DEFAULT_MAX_DIM
  llmClientTimeoutMs: 300000,     // promotes LLMClientService.DEFAULT_TIMEOUT_MS
  updateChannel: 'stable',        // 'stable' | 'beta'
  autoUpdate: true,               // background check + download; install on quit
  pendingUpdate: null,            // {version, since}: downloaded, not yet installed

  // ---- Sub-objects previously read at runtime but never declared ------
  extensions: {
    paths: [],
  },
  permissions: {
    overrides: {},
  },

  // ---- DNS resolver ---------------------------------------------------
  // mode='system' uses OS DNS only; 'automatic' prefers DoH with system
  // fallback; 'secure' is DoH-only (no fallback). provider is a catalog id
  // exported by DnsService, or 'custom' to use the customUrl below.
  // NOTE: Electron/Chromium expose only DoH and system DNS — DNS-over-TLS
  // and plain-IP custom DNS servers are not configurable via this API.
  dns: {
    mode: 'system',
    provider: 'cloudflare',
    customUrl: '',
  },

  // ---- Adblocker blocklists -------------------------------------------
  // builtinEnabled is an array of ids from AdblockerService.BUILTIN_LIST_CATALOG.
  // Default seeds the same 6 lists used by the legacy hardcoded FILTER_LISTS
  // so existing users see no change when they upgrade to v12.
  // customLists: [{ id, name, url, addedAt, lastValidated, filterCount }].
  adblocker: {
    builtinEnabled: [
      'hagezi-pro-plus',
      'oisd-big',
      'hagezi-tif',
      'hagezi-hoster',
      'hagezi-fake',
      'hagezi-spam-tlds',
    ],
    customLists: [],
  },

  // ---- Agent personas / auto-router -----------------------------------
  // Personas are system-prompt overlays the agent uses for specialized
  // behavior (shopping, research, code, etc.). The router auto-picks one
  // per task; user can lock a choice from the AgentPanel header.
  // - enabledPersonas: which built-in persona names are active in the picker
  // - routerEnabled: master toggle (off = always use 'default')
  // - routerLLMFallback: when regex pre-pass is ambiguous, ask the engine
  // - customPersonas: user-defined personas, full schema (see PersonaService)
  // - builtinOverrides: per-builtin partial override { enabled?, notes?,
  //   starterTabs?, qualityOverride? } — names of built-ins are reserved.
  agentPersonas: {
    enabledPersonas: ['default', 'explore', 'research', 'shop', 'code', 'reddit', 'news', 'quick'],
    routerEnabled: true,
    routerLLMFallback: true,
    customPersonas: [],
    builtinOverrides: {},
  },

  // ---- User memory ----------------------------------------------------
  // Persistent facts the agent should know about the user (e.g. "I'm a Go
  // developer learning React"). Each fact is injected into every agent
  // system prompt automatically. Enabled by default per UX choice — toggle
  // via the User Memory settings tab. Capped at maxFacts to bound prompt
  // overhead. Pinned facts float to the top of the prompt block.
  userMemory: {
    enabled: true,
    facts: [], // [{ id, text, createdAt, source, pinned, archived }]
    maxFacts: 50,
    autoCapture: false, // opt-in: extract durable facts from chat/agent turns
  },

  // ---- Voice input (May 2026 SOTA tiny ASR via Moonshine) -------------
  // Mic button + global hotkey for voice-to-text. Recording happens in the
  // renderer (Web Audio API), transcription in main via VoiceService. The
  // model is bundled as extraResources; isAvailable() returns false if the
  // model is missing (UI hides the mic button gracefully).
  voice: {
    enabled: true,
    provider: 'moonshine-tiny',  // 'moonshine-tiny' | 'moonshine-base'
    pressToTalk: true,           // false = tap-to-toggle mode
    autoStopOnSilenceMs: 700,    // VAD silence threshold (ms)
    sampleRate: 16000,           // PCM16 mono — what Moonshine expects
    insertMode: 'append-with-space', // 'replace' | 'append-with-space'
    showOverlay: true,
    maxRecordingMs: 30000,       // 30s cap; voice-input UX, not dictation
  },

  // ---- Text-to-speech (local, Web Speech API) ------------------------
  // "Listen to this page / this report." Runs entirely in the renderer via
  // window.speechSynthesis using the OS voices — offline, zero dependency,
  // cross-platform. Pairs with the Moonshine voice input above for full
  // voice I/O. voiceURI '' = OS default voice.
  tts: {
    enabled: true,
    rate: 1,            // 0.5–2.0 speaking speed
    voiceURI: '',       // '' = OS default; else a speechSynthesis voiceURI
  },

  // ---- Scheduled routines (RoutineService + shared/routineSchema) ----
  // A routine is a saved agent task prompt + a recurrence schedule. When due,
  // RoutineService asks the renderer to run it in the isolated agent
  // workspace. `enabled` is the master switch; `items` is the user's list
  // (managed in Settings → Routines). Empty by default — no behavior change.
  // runInBackground runs a due routine as a background session whose result
  // lands in the inbox, instead of driving the foreground agent panel.
  routines: {
    enabled: true,
    items: [],
    runInBackground: true,
  },

  // ---- Assistant shell (ShellStore) -----------------------------------
  // startMode 'last' restores lastMode on launch; 'browser'/'assistant' pin it.
  // Widths are px and are clamped by the renderer.
  assistant: {
    startMode: 'last',
    lastMode: 'browser',
    sidebarWidth: 420,
    dockWidth: 520,
    shiftTabCycles: true,
    launcher: { enabled: true, hotkey: 'Alt+Shift+Space' },
  },

  // ---- Projects (ProjectService) -------------------------------------
  // A project is a persistent collection of files/images the LLM can reach
  // via the project.search / project.read_file tools, and (per-project
  // alwaysInContext) via direct system-prompt injection. The project index
  // lives here; file blobs live under userData/projects/<id>/ (see
  // ProjectService). `defaultAlwaysInContext` is the default for new projects;
  // `autoSummarize` runs the local LLM over large uploads to build a semantic
  // search index. Empty by default — no behavior change until a project exists.
  projects: {
    enabled: true,
    defaultAlwaysInContext: false,
    autoSummarize: true,
    items: [],
  },

  // ---- Model Context Protocol (MCP) servers --------------------------
  // MCP servers extend the agent with external tools (filesystem, databases,
  // APIs, etc.). `enabled` is the master switch — when off, no MCP servers are
  // connected even if `servers` has entries. Each server entry:
  //   { id, name, transport: 'stdio'|'http', enabled, command?, args?, env?,
  //     url?, headers? }
  // stdio servers are spawned as child processes; http servers connect to a
  // running endpoint. McpService manages lifecycle and exposes each server's
  // tools to the agent via the existing toolRegistry. Empty by default.
  mcp: {
    enabled: false,
    servers: [],
  },
};

const DEFAULT_STATE = {
  activeSpaces: ['custom1'],
  lastActiveSpaces: [],
  openTabs: ['custom1'],
  hiddenTabs: [],
  pinnedTabs: [],
  adHocSpaces: {},
  windowBounds: { width: 1600, height: 900 },
  zoomLevels: {},
  notifications: {
    inbox: [],
  },
  hasSeenWelcome: false,
};

const DEFAULT_CONFIG = {
  _version: CURRENT_CONFIG_VERSION,
  settings: { ...DEFAULT_SETTINGS },
  state: { ...DEFAULT_STATE },
  spaces: { ...DEFAULT_SPACES },
};

/**
 * Get platform-specific default shortcuts.
 * @param {string} platform - process.platform value
 * @returns {{ toggle: string, lock: string }}
 */
function getDefaultShortcuts(platform) {
  const toggle = platform === 'darwin' ? 'Alt+Space' : 'CmdOrCtrl+Space';
  const lock = 'CmdOrCtrl+Alt+L';
  return { toggle, lock };
}

// Deep-clone a default value so backfilled config never shares a reference
// with the module-level DEFAULT_* constants. A one-level `{...}` copy would
// leave nested objects and arrays shared, letting a later in-place config
// mutation (e.g. set() into settings.chat.features) leak into the factory
// defaults and survive a reset.
function cloneValue(value) {
  if (typeof value !== 'object' || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Deep-merge missing keys from defaults into a config object.
 * Only adds keys that don't exist — never overwrites existing values.
 * @param {object} target - config to fill
 * @param {object} defaults - default values
 * @returns {object} target (mutated)
 */
function fillDefaults(target, defaults) {
  for (const key of Object.keys(defaults)) {
    if (target[key] === undefined) {
      target[key] = cloneValue(defaults[key]);
    } else if (
      typeof defaults[key] === 'object' &&
      defaults[key] !== null &&
      !Array.isArray(defaults[key]) &&
      typeof target[key] === 'object' &&
      target[key] !== null &&
      !Array.isArray(target[key])
    ) {
      fillDefaults(target[key], defaults[key]);
    }
  }
  return target;
}

/**
 * Migrate a config object to the current version.
 * Handles legacy formats, missing keys, and structural changes.
 * @param {object} config - loaded config (will be mutated)
 * @param {string} [platform] - process.platform for platform-specific migrations
 * @returns {object} the migrated config
 */
function migrateConfig(config, platform) {
  if (!config || typeof config !== 'object') {
    // Deep clone: a shallow `{ ...DEFAULT_CONFIG }` would share the nested
    // settings/state/spaces objects (and their arrays) with the module-level
    // defaults, so a later in-place write would pollute the factory constants.
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  const version = config._version || 0;

  // v3 is a breaking change — return fresh defaults
  if (version < 3) {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  // Ensure top-level structure
  if (!config.settings) config.settings = {};
  if (!config.state) config.state = {};
  if (!config.settings.shortcuts) config.settings.shortcuts = {};

  // v3 → v4: introduce openTabs/hiddenTabs derived from legacy activeSpaces array,
  // and default chromeLayout setting.
  if (version < 4) {
    const legacyActive = Array.isArray(config.state.activeSpaces) ? config.state.activeSpaces : [];
    if (!Array.isArray(config.state.openTabs)) {
      config.state.openTabs = legacyActive.length > 0 ? legacyActive.slice() : ['custom1'];
    }
    if (!Array.isArray(config.state.hiddenTabs)) {
      config.state.hiddenTabs = [];
    }
    if (typeof config.settings.chromeLayout !== 'string') {
      config.settings.chromeLayout = 'sidebar';
    }
  }

  // v9 → v10: chromeLayout enum extended from {sidebar, topBar} to four
  // positions {top, bottom, left, right}. Map legacy values to the closest
  // visual equivalent so existing users see no change.
  if (version < 10) {
    const cl = config.settings.chromeLayout;
    if (cl === 'sidebar') config.settings.chromeLayout = 'left';
    else if (cl === 'topBar') config.settings.chromeLayout = 'top';
    if (!['top', 'bottom', 'left', 'right'].includes(config.settings.chromeLayout)) {
      config.settings.chromeLayout = 'left';
    }
  }

  // v4 → v5: introduce pinnedTabs array and adHocSpaces map for browser-like tab model.
  if (version < 5) {
    if (!Array.isArray(config.state.pinnedTabs)) {
      config.state.pinnedTabs = [];
    }
    if (!config.state.adHocSpaces || typeof config.state.adHocSpaces !== 'object') {
      config.state.adHocSpaces = {};
    }
  }

  // v5 → v6: remove vLLM backend — never had a working start path.
  if (version < 6) {
    if (config.settings.llm && config.settings.llm.vllm) {
      delete config.settings.llm.vllm;
    }
    if (config.settings.llm && config.settings.llm.activeBackend === 'vllm') {
      config.settings.llm.activeBackend = null;
    }
  }

  // v6 → v7: add local/remote mode toggle + new inference tuning defaults.
  // Existing users whose llamaCpp.contextSize is still the OLD default get the
  // new one; if they customized it (anything != 4096), we respect their choice.
  if (version < 7) {
    const llm = config.settings.llm || (config.settings.llm = {});
    if (!llm.mode) {
      llm.mode = llm.activeBackend === 'remote' ? 'remote' : 'local';
    }
    if (llm.llamaCpp && llm.llamaCpp.contextSize === 4096) {
      llm.llamaCpp.contextSize = 65536;
    }
  }

  // v7 → v8: introduce web notifications schema (settings flags + persistent inbox).
  if (version < 8) {
    if (!config.settings.notifications || typeof config.settings.notifications !== 'object') {
      config.settings.notifications = { enabled: true, showToasts: true, maxInbox: 200 };
    }
    if (!config.state.notifications || typeof config.state.notifications !== 'object') {
      config.state.notifications = { inbox: [] };
    } else if (!Array.isArray(config.state.notifications.inbox)) {
      config.state.notifications.inbox = [];
    }
  }

  // v8 → v9: split the `mlx` backend into mlxOpenAi/mlxLm. The legacy
  // `mlx.serverImpl` field disambiguates which runtime the user had picked.
  if (version < 9) {
    const llm = config.settings.llm || (config.settings.llm = {});
    const legacyMlx = llm.mlx && typeof llm.mlx === 'object' ? llm.mlx : {};
    const sharedPython = legacyMlx.pythonPath || null;
    const forceTextOnly = !!legacyMlx.forceTextOnly;

    if (!llm.mlxOpenAi || typeof llm.mlxOpenAi !== 'object') llm.mlxOpenAi = {};
    if (!llm.mlxLm || typeof llm.mlxLm !== 'object') llm.mlxLm = {};

    if (llm.mlxOpenAi.pythonPath == null && sharedPython) llm.mlxOpenAi.pythonPath = sharedPython;
    if (llm.mlxOpenAi.contextLength == null && legacyMlx.contextLength != null) llm.mlxOpenAi.contextLength = legacyMlx.contextLength;
    if (llm.mlxOpenAi.enableAutoToolChoice == null && legacyMlx.enableAutoToolChoice != null) llm.mlxOpenAi.enableAutoToolChoice = legacyMlx.enableAutoToolChoice;
    if (llm.mlxOpenAi.forceTextOnly == null) llm.mlxOpenAi.forceTextOnly = forceTextOnly;

    if (llm.mlxLm.pythonPath == null && sharedPython) llm.mlxLm.pythonPath = sharedPython;
    if (llm.mlxLm.temperature == null && legacyMlx.temperature != null) llm.mlxLm.temperature = legacyMlx.temperature;
    if (llm.mlxLm.topP == null && legacyMlx.topP != null) llm.mlxLm.topP = legacyMlx.topP;
    if (llm.mlxLm.useDefaultChatTemplate == null && legacyMlx.useDefaultChatTemplate != null) llm.mlxLm.useDefaultChatTemplate = legacyMlx.useDefaultChatTemplate;
    if (llm.mlxLm.trustRemoteCode == null && legacyMlx.trustRemoteCode != null) llm.mlxLm.trustRemoteCode = legacyMlx.trustRemoteCode;
    if (llm.mlxLm.forceTextOnly == null) llm.mlxLm.forceTextOnly = forceTextOnly;

    if (llm.activeBackend === 'mlx') {
      llm.activeBackend = legacyMlx.serverImpl === 'legacy' ? 'mlxLm' : 'mlxOpenAi';
    }

    // Replace the legacy block with the new shared-MLX block.
    llm.mlx = { fallbackEnabled: legacyMlx.fallbackEnabled !== false };
  }

  // v10 → v11: declare keys that were either persisted-but-never-defaulted
  // (extensions.paths, permissions.overrides) or being promoted from
  // hardcoded constants (history/download/screenshot caps, memory thresholds,
  // LLM client timeout, log level), plus a batch of new browser-parity keys
  // (startup, search engines, downloads, accessibility, etc.). Since every
  // entry has a sane default, the unconditional `fillDefaults` call below
  // is sufficient — no per-key migration logic needed.

  // v11 → v12: surface DNS resolver config (`settings.dns`) and turn the
  // hardcoded adblocker filter list into a configurable catalog
  // (`settings.adblocker`). Defaults match prior behavior — existing users
  // see no functional change. Pure additive, fillDefaults handles it.

  // v12 → v13: introduce agent personas + auto-router (`settings.agentPersonas`).
  // Pure additive — fillDefaults backfills the block. Built-in persona content
  // (system overlays, default qualityOverrides, follow-ups) is hardcoded in
  // PersonaService; this config block carries only user-tunable bits.

  // v13 → v14: introduce user memory (`settings.userMemory`). Pure additive —
  // fillDefaults backfills the block. Empty `facts` array on first migration
  // so existing users see no behavior change until they add facts.

  // v14 → v15: add per-range private-IP cert auto-accept (`settings.auto-
  // AcceptCertsForPrivateIps`) and the site allowlist (`settings.site-
  // Allowlist`). Both are opt-in / start empty. Pure additive — fillDefaults
  // backfills the block, so existing users see no behavior change.

  // v15 → v16: scrub malformed shortcut entries left behind by a path-split
  // bug in the rebind UI. The recorder used `configBridge.set('settings.
  // shortcuts.<action>', ...)` with action names that contain dots (e.g.
  // 'window.toggle'), which both the renderer bridge and main ConfigService
  // walk segment-by-segment — landing the write at
  // `shortcuts.window.toggle` (nested) instead of `shortcuts['window.toggle']`
  // (flat). Drop any entry that is not (a) a string or (b) an object with a
  // string `.key`; the default-backfill block below re-seeds window.toggle /
  // window.lock so users return to a known-good state on the very next launch.
  if (version < 16) {
    const sc = config.settings.shortcuts;
    if (sc && typeof sc === 'object') {
      for (const action of Object.keys(sc)) {
        const v = sc[action];
        const valid = typeof v === 'string' || (v && typeof v === 'object' && typeof v.key === 'string');
        if (!valid) delete sc[action];
      }
    }
  }

  // v16 → v17: introduce web search (`settings.search`) backing the agent's
  // browser.web_search tool. Pure additive — fillDefaults backfills the block
  // with provider='inBrowser', so existing users get working web search with
  // no key and no behavior change to anything else.

  // v17 → v18: introduce agent egress control (`settings.llm.agent.egress`).
  // Pure additive — fillDefaults backfills mode='open', so existing users see
  // no behavior change until they opt into an allow/block list.

  // v18 → v19: introduce ask-your-browsing (`settings.askBrowsing`). Pure
  // additive — fillDefaults backfills it; lexical search works immediately,
  // embeddings stay off until an endpoint is configured.

  // v19 → v20: introduce local text-to-speech (`settings.tts`). Pure
  // additive — fillDefaults backfills it; speechSynthesis is renderer-only,
  // no main-process service, no behavior change until the user clicks Listen.

  // v20 → v21: introduce scheduled routines (`settings.routines`). Pure
  // additive — fillDefaults backfills { enabled:true, items:[] }; with an
  // empty list the scheduler ticks but never fires, so no behavior change.

  // v21 → v22: the built-in Local-LLM chat space (served from the now-removed
  // ic:// protocol) and the broadcast bar were folded into the unified chat
  // panel. Drop the dead ic:// spaces (the protocol no longer exists, so they
  // would 404), scrub them from every tab list, and remove the now-unused
  // broadcast settings. Real local-llm spaces (e.g. a localhost server) are
  // left untouched.
  if (version < 22) {
    const spaces = config.spaces && typeof config.spaces === 'object' ? config.spaces : {};
    const removed = Object.keys(spaces).filter((id) => {
      const sp = spaces[id] || {};
      return typeof sp.url === 'string' && sp.url.startsWith('ic://');
    });
    for (const id of removed) delete spaces[id];
    if (removed.length && config.state && typeof config.state === 'object') {
      const dead = new Set(removed);
      for (const key of ['activeSpaces', 'lastActiveSpaces', 'openTabs', 'hiddenTabs', 'pinnedTabs']) {
        if (Array.isArray(config.state[key])) {
          config.state[key] = config.state[key].filter((id) => !dead.has(id));
        }
      }
      // Never leave a tab list empty — the UI expects at least one open tab.
      if (Array.isArray(config.state.openTabs) && config.state.openTabs.length === 0) {
        config.state.openTabs = ['custom1'];
      }
    }
    if (config.settings && typeof config.settings === 'object') {
      if (removed.includes(config.settings.defaultSpace)) config.settings.defaultSpace = 'custom1';
      delete config.settings.broadcastAutoSubmit;
      delete config.settings.broadcastTemplates;
      delete config.settings.broadcastHistory;
    }
  }

  // v23: Ask-your-browsing content indexing (indexContent, default off) and
  // user-memory auto-capture (autoCapture, default off). Both are opt-in
  // storage features; fillDefaults backfills the keys, so no structural move.
  if (version < 23) { /* see comment above — keys backfilled by fillDefaults */ }

  // v23 → v24: per-model inference tuning overlay (settings.llm.perModelOverrides),
  // the CUDA vLLM backend block (settings.llm.vllm), and MCP server support
  // (settings.mcp). All additive with empty/structured defaults — fillDefaults
  // backfills them, so existing users see no behavior change until they tune
  // a model or add an MCP server.

  // v24 → v25: Projects (settings.projects) — persistent file/image
  // collections available to the LLM via tools and optional context injection.
  // Pure additive — fillDefaults backfills the block; empty items means no
  // behavior change until the user creates a project.

  // v25 → v26: first-run welcome overlay (state.hasSeenWelcome). An existing
  // config is by definition not a first run, so upgraders are marked seen and
  // only brand-new installs get the overlay.
  if (version < 26) {
    config.state.hasSeenWelcome = true;
  }

  // v26 → v27: background updates (settings.autoUpdate, default on). Additive —
  // fillDefaults backfills the key, and an upgrader that wants the old
  // check-only behavior turns it off in Settings → Updates.

  // v27 → v28: inference runtime updates (settings.llm.engineAutoCheck, default
  // on). Additive — fillDefaults backfills the key. Checking only reports; an
  // install still needs the user to press Update.

  // v28 → v29: visual effects level (settings.motionEffects, default 'full').
  // Additive — fillDefaults backfills the key.

  // v29 → v30: the expanded-sidebar default grew 150 → 220px so the longest
  // action label fits with padding. Upgraders still on the old default move
  // with it; any other width was picked by the user and is kept.
  if (version < 30 && config.settings && config.settings.sidebarExpandedWidth === 150) {
    config.settings.sidebarExpandedWidth = DEFAULT_SETTINGS.sidebarExpandedWidth;
  }

  // v30 → v31: ambient chrome background (settings.chromeAmbient, default
  // cycle/soft). Additive — fillDefaults backfills the key.

  // v31 → v32: settings.pendingUpdate (the downloaded app update awaiting a
  // restart) and settings.llm.engineUpdatePrompted (runtime versions already
  // offered). Additive — fillDefaults backfills both.

  // v32 → v33: oMLX replaces the mlx_lm.server backend. Selections and per-model
  // overrides pointing at mlxLm move to mlxOpenAi (the other runtime that loads
  // the same MLX folders); the dead mlxLm block is dropped because fillDefaults
  // never deletes keys. llm.omlx and engineUpdatePrompted.{omlx,vllm} are
  // backfilled by fillDefaults. vLLM's tool calling now follows llm.vllm.toolParser,
  // so its old on/off switch goes, and the GPU memory share moves with the
  // default (0.9 → 0.92) unless the user picked another value.
  if (version < 33 && config.settings && config.settings.llm && typeof config.settings.llm === 'object') {
    const llm = config.settings.llm;
    if (llm.vllm && typeof llm.vllm === 'object') {
      delete llm.vllm.enableAutoToolChoice;
      if (llm.vllm.gpuMemoryUtilization === 0.9) llm.vllm.gpuMemoryUtilization = 0.92;
    }
    if (llm.activeBackend === 'mlxLm') llm.activeBackend = 'mlxOpenAi';
    if (llm.perModelOverrides && typeof llm.perModelOverrides === 'object') {
      for (const entry of Object.values(llm.perModelOverrides)) {
        if (entry && typeof entry === 'object' && entry.backend === 'mlxLm') entry.backend = 'mlxOpenAi';
      }
    }
    delete llm.mlxLm;
  }

  // v33 → v34: assistant platform. settings.llm.agent gains permissions,
  // workspace, shell, checkpoints, subagents, sessions, skills, instructions,
  // harness, streamSteps and compaction; settings.assistant and
  // settings.routines.runInBackground are new. All backfilled by fillDefaults.
  // approval.deny feeds the permission engine's deny set, so repeated entries
  // collapse to one (first occurrence kept, order preserved).
  if (version < 34) {
    const approval = config.settings && config.settings.llm && config.settings.llm.agent
      && config.settings.llm.agent.approval;
    if (approval && Array.isArray(approval.deny)) {
      approval.deny = [...new Set(approval.deny)];
    }
  }

  // v34 → v35: the shipped protectedGlobs entry '.git/**' only covered the
  // root repository, so an agent could write sub/.git/hooks/*. That exact
  // entry becomes '**/.git' + '**/.git/**' in place; user-added globs stay.
  if (version < 35) {
    const ws = config.settings && config.settings.llm && config.settings.llm.agent
      && config.settings.llm.agent.workspace;
    if (ws && Array.isArray(ws.protectedGlobs) && ws.protectedGlobs.includes('.git/**')) {
      const next = ws.protectedGlobs.flatMap((g) => (g === '.git/**' ? ['**/.git', '**/.git/**'] : [g]));
      ws.protectedGlobs = [...new Set(next)];
    }
  }

  // Ensure shortcut defaults with platform awareness
  const platformShortcuts = getDefaultShortcuts(platform || 'linux');
  if (!config.settings.shortcuts['window.toggle']) {
    config.settings.shortcuts['window.toggle'] = { key: platformShortcuts.toggle, description: 'Toggle Window' };
  }
  if (!config.settings.shortcuts['window.lock']) {
    config.settings.shortcuts['window.lock'] = { key: platformShortcuts.lock, description: 'Lock Shortcuts' };
  }

  // Fill any missing settings/state with defaults
  fillDefaults(config.settings, DEFAULT_SETTINGS);
  fillDefaults(config.state, DEFAULT_STATE);

  if (!config.spaces) {
    // Deep clone so in-place space edits can't leak into the module constants.
    config.spaces = JSON.parse(JSON.stringify(DEFAULT_SPACES));
  }

  config._version = CURRENT_CONFIG_VERSION;
  return config;
}

module.exports = {
  CURRENT_CONFIG_VERSION,
  DEFAULT_CONFIG,
  DEFAULT_SPACES,
  DEFAULT_SETTINGS,
  DEFAULT_STATE,
  getDefaultShortcuts,
  migrateConfig,
  fillDefaults,
};

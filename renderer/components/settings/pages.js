// pages — information architecture for the settings UI.
//
// The registry (registry.js) owns every row's config path and control
// metadata; this file only decides where each row lives: nav group → page →
// card. buildRegistry() fails loudly if a row is placed twice, references an
// unknown id, or is left unplaced, so moving a row is a one-line edit here.
//
// Card fields:
//   rows         ordered row ids; rows flagged `advanced` go into the card's
//                collapsed "Advanced" disclosure
//   collapsible  the whole card is a disclosure (closed unless defaultOpen)
//   bare         render rows without card chrome (the module draws its own
//                cards, e.g. the Models page)
//   wide         span both columns of the page grid

const GROUPS = [
  { id: 'general', label: 'General', order: 0 },
  { id: 'appearance', label: 'Appearance', order: 10 },
  { id: 'ai', label: 'AI', order: 20 },
  { id: 'web', label: 'Web', order: 30 },
  { id: 'system', label: 'System', order: 40 },
];

const PAGES = [
  // -- General ---------------------------------------------------------------
  {
    id: 'general',
    title: 'Startup & window',
    icon: 'home',
    group: 'general',
    order: 10,
    description: 'What opens at launch and how the window behaves.',
    cards: [
      {
        id: 'launch',
        title: 'On launch',
        rows: [
          'startup.behavior',
          'startup.url',
          'general.enableDefaultSpace',
          'general.defaultSpace',
          'general.browserHomeUrl',
          'startup.launchAtStartup',
          'startup.minimizedToTray',
        ],
      },
      {
        id: 'window',
        title: 'Window & links',
        rows: ['general.preventMenuExpansion', 'general.openLinkExternal'],
      },
    ],
  },
  {
    id: 'spaces',
    title: 'Tabs & spaces',
    icon: 'grid',
    group: 'general',
    order: 20,
    description: 'Multi-space layout, tab sleeping, and your saved spaces.',
    cards: [
      { id: 'layout', title: 'Layout', rows: ['spaces.multiSpace', 'spaces.lastLayout', 'spaces.persistZoom'] },
      {
        id: 'performance',
        title: 'Performance',
        rows: ['spaces.tabSleepEnabled', 'spaces.tabSleepMinutes', 'spaces.memorySaverThresholdMB', 'spaces.memoryCriticalThresholdMB'],
      },
      { id: 'editor', title: 'Spaces', wide: true, rows: ['spaces.editor'] },
    ],
  },
  {
    id: 'downloads',
    title: 'Downloads',
    icon: 'download',
    group: 'general',
    order: 30,
    description: 'Where files go and what happens when they finish.',
    cards: [
      {
        id: 'downloads',
        title: 'Downloads',
        rows: ['downloads.location', 'downloads.askBeforeDownload', 'downloads.openFileAfterDownload', 'downloads.historyCap'],
      },
    ],
  },
  {
    id: 'notifications',
    title: 'Notifications',
    icon: 'bell',
    group: 'general',
    order: 40,
    description: 'Site notifications, toasts, and the inbox.',
    cards: [
      {
        id: 'notifications',
        title: 'Notifications',
        rows: ['notifications.enabled', 'notifications.showToasts', 'notifications.maxInbox', 'notifications.dedupWindowMs'],
      },
    ],
  },

  // -- Appearance ------------------------------------------------------------
  {
    id: 'appearance',
    title: 'Theme & color',
    icon: 'palette',
    group: 'appearance',
    order: 110,
    description: 'Light or dark, and the accent color used across the app.',
    cards: [{ id: 'theme', title: 'Theme', rows: ['appearance.theme', 'appearance.accentColor'] }],
  },
  {
    id: 'layout',
    title: 'Layout & density',
    icon: 'layout',
    group: 'appearance',
    order: 120,
    description: 'Toolbar placement, sidebar width, zoom, and spacing.',
    cards: [
      {
        id: 'chrome',
        title: 'Window layout',
        rows: ['appearance.chromeLayout', 'appearance.sidebarExpandedWidth', 'appearance.pageZoomDefault'],
      },
      { id: 'density', title: 'Density', rows: ['appearance.uiDensity'] },
    ],
  },
  {
    id: 'motion',
    title: 'Motion & effects',
    icon: 'zap',
    group: 'appearance',
    order: 130,
    description: 'Animation level and the ambient background behind the tab bar.',
    cards: [
      {
        id: 'motion',
        title: 'Motion',
        rows: ['appearance.motionEffects', 'appearance.enableAnimations', 'appearance.enableRippleEffects'],
      },
      { id: 'ambient', title: 'Ambient background', rows: ['appearance.chromeAmbient.scene', 'appearance.chromeAmbient.intensity'] },
    ],
  },
  {
    id: 'language',
    title: 'Language & accessibility',
    icon: 'globe',
    group: 'appearance',
    order: 140,
    description: 'Spell-check, preferred languages, and accessibility aids.',
    cards: [
      {
        id: 'spellcheck',
        title: 'Spell-check & languages',
        rows: ['language.spellCheckEnabled', 'language.spellCheckLanguages', 'language.acceptLanguages'],
      },
      { id: 'accessibility', title: 'Accessibility', rows: ['language.forceReducedMotion', 'language.highContrast'] },
    ],
  },
  {
    id: 'voice-reading',
    title: 'Voice & reading',
    icon: 'speaker',
    group: 'appearance',
    order: 150,
    description: 'Read-aloud voice and speed for Reader view.',
    cards: [{ id: 'voice', title: 'Read aloud', rows: ['voiceReading.enabled', 'voiceReading.rate', 'voiceReading.voice'] }],
  },

  // -- AI --------------------------------------------------------------------
  {
    id: 'llm',
    title: 'Models',
    icon: 'cpu',
    group: 'ai',
    order: 210,
    description: 'Local or remote inference engine, model, and server.',
    cards: [
      { id: 'models', title: 'Models', bare: true, rows: ['llm.tab'] },
      { id: 'model-overrides', title: 'Per-model overrides', collapsible: true, wide: true, rows: ['llm.perModelOverrides'] },
    ],
  },
  {
    id: 'assistant',
    title: 'Assistant',
    icon: 'agent',
    group: 'ai',
    order: 220,
    description: 'Chat behavior, agent limits, and where the agent may go.',
    cards: [
      { id: 'chat', title: 'Chat', rows: ['chat.mode', 'chat.webSearch', 'chat.readTopPage', 'chat.thinkStepByStep'] },
      {
        id: 'assistant',
        title: 'Assistant',
        rows: ['assistant.startMode', 'assistant.shiftTabCycles', 'assistant.launcherEnabled', 'assistant.launcherHotkey'],
      },
      { id: 'agent', title: 'Agent', rows: ['advanced.llmClientTimeoutMs', 'advanced.screenshotMaxDim'] },
      { id: 'agent-safety', title: 'Agent safety', wide: true, rows: ['agentSafety.egress'] },
      {
        id: 'agent-permissions',
        title: 'Permissions & workspace',
        wide: true,
        rows: ['agentPermissions.rules', 'agentPermissions.workspaceRoots', 'agentPermissions.instructions'],
      },
    ],
  },
  {
    id: 'projects',
    title: 'Projects & memory',
    icon: 'folder',
    group: 'ai',
    order: 230,
    description: 'File collections and remembered facts the assistant can use.',
    cards: [
      {
        id: 'projects',
        title: 'Projects',
        wide: true,
        rows: ['projects.defaultAlwaysInContext', 'projects.autoSummarize', 'projects.manager'],
      },
      { id: 'memory', title: 'Memory', wide: true, rows: ['userMemory.autoCapture', 'userMemory.editor'] },
    ],
  },
  {
    id: 'personas',
    title: 'Personas & packs',
    icon: 'user',
    group: 'ai',
    order: 240,
    description: 'Saved assistant personas and curated starter packs.',
    cards: [
      { id: 'personas', title: 'Personas', wide: true, rows: ['personas.editor'] },
      { id: 'packs', title: 'Persona packs', wide: true, rows: ['packs.catalog'] },
    ],
  },
  {
    id: 'skills',
    title: 'Skills',
    icon: 'library',
    group: 'ai',
    order: 245,
    description: 'Saved procedures the assistant can follow, in the Claude Code / Codex SKILL.md format.',
    cards: [{ id: 'skills', title: 'Skills', wide: true, rows: ['skills.autoTrigger', 'skills.matchThreshold', 'skills.gallery'] }],
  },
  {
    id: 'mcp-servers',
    title: 'Tools (MCP)',
    icon: 'tools',
    group: 'ai',
    order: 250,
    description: 'Model Context Protocol servers that give the assistant extra tools.',
    cards: [{ id: 'servers', title: 'MCP servers', wide: true, rows: ['mcp.servers'] }],
  },

  // -- Web -------------------------------------------------------------------
  {
    id: 'search',
    title: 'Search',
    icon: 'search',
    group: 'web',
    order: 310,
    description: 'Address-bar search, agent web search, and Ask-your-browsing.',
    cards: [
      {
        id: 'address-bar',
        title: 'Address bar',
        rows: ['search.defaultEngine', 'search.customEngines', 'search.suggestions', 'search.addressBarHistory'],
      },
      {
        id: 'agent-search',
        title: 'Agent web search',
        rows: ['search.provider', 'search.inBrowserEngine', 'search.searxngUrl', 'search.braveApiKey', 'search.tavilyApiKey', 'search.resultCount'],
      },
      {
        id: 'ask-browsing',
        title: 'Ask your browsing',
        wide: true,
        rows: [
          'askBrowsing.enabled',
          'askBrowsing.indexContent',
          'askBrowsing.maxResults',
          'askBrowsing.blend',
          'askBrowsing.embeddingsEndpoint',
          'askBrowsing.embeddingsModel',
        ],
      },
    ],
  },
  {
    id: 'privacy',
    title: 'Privacy & security',
    icon: 'shield',
    group: 'web',
    order: 320,
    description: 'Ad blocking, DNS, cookies, certificates, and site permissions.',
    cards: [
      {
        id: 'tracking',
        title: 'Tracking & ads',
        rows: ['privacy.enableAdblocker', 'privacy.adblockerLists', 'privacy.siteAllowlist', 'privacy.doNotTrack'],
      },
      { id: 'dns', title: 'DNS', rows: ['privacy.dnsMode', 'privacy.dnsProvider', 'privacy.dnsCustomUrl'] },
      {
        id: 'cookies',
        title: 'Cookies & data',
        rows: ['privacy.blockThirdPartyCookies', 'privacy.clearCookiesOnQuit', 'privacy.clearBrowsingData'],
      },
      {
        id: 'connections',
        title: 'Connections & certificates',
        rows: [
          'privacy.httpsOnly',
          'privacy.autoDenyCertErrors',
          'privacy.privateIpCerts.loopback',
          'privacy.privateIpCerts.rfc1918',
          'privacy.privateIpCerts.linkLocal',
          'privacy.privateIpCerts.cgnat',
          'privacy.privateIpCerts.ipv6Loopback',
          'privacy.privateIpCerts.ipv6Ula',
          'privacy.privateIpCerts.ipv6LinkLocal',
        ],
      },
      { id: 'permissions', title: 'Site permissions', wide: true, rows: ['privacy.permissions'] },
    ],
  },
  {
    id: 'passwords',
    title: 'Passwords',
    icon: 'key',
    group: 'web',
    order: 330,
    description: 'Save offers after you sign in, and the logins you have saved.',
    cards: [{ id: 'passwords', title: 'Saved passwords', wide: true, rows: ['passwords.offerToSave', 'passwords.saved'] }],
  },

  // -- System ----------------------------------------------------------------
  {
    id: 'routines',
    title: 'Routines',
    icon: 'clock',
    group: 'system',
    order: 410,
    description: 'Saved agent tasks that run on a schedule.',
    cards: [{ id: 'routines', title: 'Routines', wide: true, rows: ['routines.enabled', 'routines.runInBackground', 'routines.editor'] }],
  },
  {
    id: 'shortcuts',
    title: 'Shortcuts',
    icon: 'keyboard',
    group: 'system',
    order: 420,
    description: 'Keyboard shortcuts for every command.',
    cards: [{ id: 'shortcuts', title: 'Keyboard shortcuts', wide: true, rows: ['shortcuts.editor'] }],
  },
  {
    id: 'updates',
    title: 'Updates',
    icon: 'refresh',
    group: 'system',
    order: 430,
    description: 'App and inference-engine update checks.',
    cards: [
      { id: 'app', title: 'App updates', rows: ['advanced.autoUpdate', 'advanced.updateChannel', 'advanced.checkForUpdates'] },
      { id: 'engines', title: 'Engine updates', rows: ['advanced.engineAutoCheck', 'advanced.checkForEngineUpdates'] },
    ],
  },
  {
    id: 'advanced',
    title: 'Diagnostics & reset',
    icon: 'sliders',
    group: 'system',
    order: 440,
    description: 'Hardware acceleration, logging, config file, and reset.',
    cards: [
      { id: 'system', title: 'System', rows: ['advanced.hardwareAcceleration', 'advanced.defaultBrowser'] },
      { id: 'diagnostics', title: 'Diagnostics', rows: ['advanced.logLevel', 'advanced.historyCap'] },
      { id: 'reset', title: 'Reset', wide: true, rows: ['advanced.openConfig', 'general.restartApp', 'advanced.resetAll'] },
    ],
  },
  {
    id: 'about',
    title: 'About',
    icon: 'info',
    group: 'system',
    order: 450,
    description: 'Versions, license, and project links.',
    cards: [{ id: 'about', title: 'About InstantCognition', wide: true, rows: ['advanced.about'] }],
  },
];

// Legacy showTab() ids (callers in renderer.js and AgentPanel.js, plus saved
// command-palette entries) → the page, and optionally the card, that now
// holds that content. Ids that are still page ids need no entry.
const ALIASES = {
  startup: { page: 'general', card: 'launch' },
  chat: { page: 'assistant', card: 'chat' },
  'agent-safety': { page: 'assistant', card: 'agent-safety' },
  'user-memory': { page: 'projects', card: 'memory' },
  packs: { page: 'personas', card: 'packs' },
  'ask-browsing': { page: 'search', card: 'ask-browsing' },
  'model-overrides': { page: 'llm', card: 'model-overrides' },
};

module.exports = { GROUPS, PAGES, ALIASES };

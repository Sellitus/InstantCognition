// customModules — render functions for `type: 'custom'` registry rows, keyed
// by the row's `renderModule`.
//
// Each module receives `{ host, setting, value, ctx, configBridge, onChange }`,
// populates `host`, and may return a teardown function (SettingsView calls it
// before every rebuild). Modules live in ./modules/ by area; LLMTab and
// PermissionsTab are class-based and mounted here / in modules/privacy.js.
//
// Error contract: a module that loads data over IPC renders a visible error
// state (`.sv-empty-row--error` or an `.sv-validation-status.is-error` line)
// when the call fails — never an empty list that looks like "no data".

const workspace = require('./modules/workspace');
const language = require('./modules/language');
const appearance = require('./modules/appearance');
const search = require('./modules/search');
const privacy = require('./modules/privacy');
const memory = require('./modules/memory');
const personaModules = require('./modules/personas');
const agentSafetyModule = require('./modules/agentSafety');
const agentPermissionsModule = require('./modules/agentPermissions');
const routinesModule = require('./modules/routines');
const mcpServersModule = require('./modules/mcpServers');
const modelOverridesModule = require('./modules/modelOverrides');
const projectsModule = require('./modules/projects');
const skillsModule = require('./modules/skills');
const passwordsModule = require('./modules/passwords');

/**
 * LLMTab persists through save(key, value) with `key` relative to
 * settings.llm. Each change goes through the granular config:set IPC so a
 * single toggle never ships (or clobbers) the whole config tree.
 */
function buildSaveCallback(configBridge) {
  return (key, value) => {
    if (!key || typeof key !== 'string') throw new Error(`LLM settings save needs a key; got ${String(key)}`);
    configBridge.set('settings.llm.' + key, value);
  };
}

function llmTab({ host, configBridge }) {
  const LLMTab = require('./LLMTab');
  const tab = new LLMTab(configBridge.snapshot(), buildSaveCallback(configBridge));
  tab.render(host);
  return () => tab.destroy();
}

module.exports = {
  llmTab,
  buildSaveCallback,
  ...workspace,
  ...language,
  ...appearance,
  ...search,
  ...privacy,
  ...memory,
  ...personaModules,
  ...agentSafetyModule,
  ...agentPermissionsModule,
  ...routinesModule,
  ...mcpServersModule,
  ...modelOverridesModule,
  ...projectsModule,
  ...skillsModule,
  ...passwordsModule,
};

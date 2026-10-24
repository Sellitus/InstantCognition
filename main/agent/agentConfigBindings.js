// agentConfigBindings — wires AgentService's lazy config getters to a live
// ConfigService instance. Extracted from AgentService to keep that file
// inside the architecture-integrity line cap; the body is pure provider
// wiring and has no internal state.

function bindAgentConfig(service, configService) {
  service._getVisionConfig = () => configService.get('settings.llm.vision', {});
  service._getActiveModel = () => {
    const remote = configService.get('settings.llm.remote', {}) || {};
    return remote.model || configService.get('settings.llm.lastModel', '') || '';
  };
  service._getAgentConfig = () => configService.get('settings.llm.agent', {}) || {};
  service._qualityMode.bindConfig(configService);
  if (service._personaService && typeof service._personaService.bindConfig === 'function') {
    service._personaService.bindConfig(configService);
  }
  if (service._personaRouter && typeof service._personaRouter.bind === 'function') {
    service._personaRouter.bind({ personaService: service._personaService, llmClient: service._llm });
  }
  service._configService = configService;
}

module.exports = { bindAgentConfig };

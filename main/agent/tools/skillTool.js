// skillTool — agent.use_skill: load an installed skill's instructions into the
// run.
//
// The result carries the skill body plus `tools`: the names the model may use
// while following it (the skill's allowed-tools applied to what this run
// already offers, or null when the skill sets no restriction). The runtime
// narrows the offered tool list to `tools`; nothing here grants a permission,
// so every later call still goes through the permission engine.

const { NAME_RE } = require('../skills/skillFormat');

/**
 * @param {{ skillsService: { use: Function, toolFilterFor: Function }, listToolNames: () => string[], getTool?: (name: string) => any }} deps
 */
function createUseSkillTool({ skillsService, listToolNames, getTool }) {
  return {
    name: 'agent.use_skill',
    description: 'Load an installed skill (a saved, reusable procedure) by name and follow its instructions for the rest of the task. Returns {instructions, tools}; while the skill is active only `tools` are available (null = no restriction).',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Skill name, lowercase-hyphenated, e.g. "pdf-extract".' } },
      required: ['name'],
    },
    handler: async (args, _toolCtx, invCtx) => {
      const name = args && typeof args.name === 'string' ? args.name.trim() : '';
      if (!NAME_RE.test(name)) return { ok: false, error: 'invalid_skill_name' };
      const res = skillsService.use(name);
      if (!res || res.ok !== true) return { ok: false, error: (res && res.error) || 'skill_unavailable' };
      const skill = res.skill;
      const narrow = skillsService.toolFilterFor(skill);
      const current = invCtx && typeof invCtx.toolFilter === 'function' ? invCtx.toolFilter : null;
      const tools = narrow
        ? listToolNames().filter((n) => narrow(n) && (!current || current(n, getTool ? getTool(n) : null)))
        : null;
      return {
        ok: true,
        skill: skill.name,
        description: skill.description,
        instructions: skill.body,
        tools,
        warnings: skill.warnings,
      };
    },
  };
}

/**
 * Register agent.use_skill on a tool registry.
 * @param {{ register: Function, list: Function, get?: Function }} registry
 * @param {{ skillsService: any, listToolNames?: () => string[] }} deps
 */
function registerSkillTools(registry, deps) {
  if (!deps || !deps.skillsService) throw new Error('registerSkillTools: skillsService required');
  const listToolNames = deps.listToolNames || (() => registry.list().map((t) => t.function.name));
  const getTool = typeof registry.get === 'function' ? (n) => registry.get(n) : undefined;
  registry.register(createUseSkillTool({ skillsService: deps.skillsService, listToolNames, getTool }));
}

module.exports = { createUseSkillTool, registerSkillTools };

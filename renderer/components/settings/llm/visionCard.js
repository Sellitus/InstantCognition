// Vision card (collapsible): whether and how the agent sends page screenshots.

const { card, knobRow, toggleGrid, numberCtl, toggleCtl } = require('./cardKit');

function buildVisionCard(tab) {
  const c = card({ id: 'vision', title: 'Agent vision', collapsible: true });
  const vs = tab._llm().vision || {};
  c.body.append(
    toggleGrid([
      knobRow({
        id: 'vision.enabled', title: 'Enable vision', description: 'Let the agent look at page screenshots.',
        control: toggleCtl('vision-enabled', 'Enable vision', !!vs.enabled, (v) => tab._setLLM('vision.enabled', !!v)),
        toggle: true, search: 'vision screenshots images',
      }),
      knobRow({
        id: 'vision.autoDetect', title: 'Detect support', description: 'Infer from the model name whether it accepts images.',
        control: toggleCtl('vision-autodetect', 'Detect support', vs.autoDetect !== false, (v) => tab._setLLM('vision.autoDetect', !!v)),
        toggle: true, search: 'vision auto detect',
      }),
    ]),
    knobRow({
      id: 'vision.maxImages', title: 'Images per call',
      control: numberCtl('vision-max', 'Images per call', vs.maxImages || 3, (v) => tab._setLLM('vision.maxImages', v), { min: 1, max: 8, step: 1 }),
      search: 'vision max images',
    }),
    knobRow({
      id: 'vision.longEdgePx', title: 'Image size (px)', description: 'Long edge. Larger is sharper but slower.',
      control: numberCtl('vision-edge', 'Image size (px)', vs.longEdgePx || 1280, (v) => tab._setLLM('vision.longEdgePx', v), { min: 256, max: 2048, step: 64 }),
      search: 'vision resolution pixels long edge',
    }),
  );
  return c.root;
}

module.exports = { buildVisionCard };

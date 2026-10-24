// Source card: run a local engine or talk to a remote OpenAI-compatible API.

const { card, knobRow, pillsCtl } = require('./cardKit');

function buildSourceCard(tab) {
  const c = card({ id: 'source', title: 'Source', icon: 'server', description: 'Where completions come from.' });
  const control = pillsCtl('mode', 'Source', [
    { value: 'local', label: 'Local' },
    { value: 'remote', label: 'Remote API' },
  ], tab._mode, (v) => tab._onModeChange(v));
  control.classList.add('sv-segmented');
  c.body.appendChild(knobRow({
    id: 'mode',
    title: 'Run models',
    description: 'Local runs llama.cpp or MLX on this machine. Remote uses any OpenAI-compatible endpoint.',
    control,
    wide: true,
    search: 'local remote api openai mode source',
  }));
  return c.root;
}

module.exports = { buildSourceCard };

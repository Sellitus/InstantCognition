// Remote card: an OpenAI-compatible endpoint. Endpoint and key persist as
// soon as the field is committed (blur / Enter); Verify loads the model list
// and "Use remote" switches the app over through llm:set-remote.

const { el } = require('../controls');
const { enhanceSelect, syncSelect } = require('../../menu/Select');
const { isValidUrl } = require('../modules/kit');
const { card, advanced, knobRow, toggleGrid, textCtl, toggleCtl, pillsCtl, button, setLine } = require('./cardKit');

function buildRemoteCard(tab) {
  const c = card({
    id: 'remote',
    title: 'Remote API',
    icon: 'globe',
    description: 'Any OpenAI-compatible server: OpenAI, OpenRouter, Together, vLLM, Ollama, LM Studio. Paste the base URL with or without /v1.',
    wide: true,
  });
  const rm = tab._llm().remote || {};

  const urlInput = textCtl('remote-url', 'Endpoint URL', rm.endpoint || '', (v) => tab._onRemoteEndpointChange(v), { placeholder: 'https://api.openai.com' });
  const urlStatus = el('p', { class: 'sv-llm-inline-status', hidden: true });
  const keyInput = textCtl('remote-key', 'API key', rm.apiKey || '', (v) => tab._onRemoteKeyChange(v), { placeholder: 'sk-…', subtype: 'password' });
  keyInput.autocomplete = 'off';

  const verifyBtn = button({ label: 'Verify', icon: 'check', variant: 'primary', onClick: () => tab._verifyRemote(false) });
  const verifyStatus = el('span', { class: 'sv-llm-verify-status', 'data-state': 'idle', 'aria-live': 'polite' });

  const modelSelect = el('select', { class: 'sv-select', id: 'set-llm-remote-model', 'aria-label': 'Remote model' });
  if (rm.model) {
    modelSelect.appendChild(el('option', { value: rm.model, selected: true }, [`${rm.model} (saved; Verify to refresh)`]));
  } else {
    modelSelect.appendChild(el('option', { value: '' }, ['Verify to load models…']));
  }
  modelSelect.disabled = !rm.model;
  modelSelect.addEventListener('change', () => tab._setLLM('remote.model', modelSelect.value || ''));
  const refreshBtn = button({ label: 'Refresh models', icon: 'refresh', variant: 'ghost', iconOnly: true, onClick: () => tab._verifyRemote(true) });
  refreshBtn.disabled = !rm.endpoint;

  const useBtn = button({ label: 'Use remote', icon: 'zap', variant: 'primary', onClick: () => tab._activateRemote() });
  const clearBtn = button({ label: 'Clear remote', icon: 'trash', variant: 'ghost', onClick: () => tab._clearRemote() });

  c.body.append(
    el('div', { class: 'settings-v2-knob-grid' }, [
      knobRow({
        id: 'remote.endpoint', title: 'Endpoint URL', description: 'Base URL of the server. Saved when you leave the field.',
        control: el('div', { class: 'sv-llm-field' }, [urlInput, urlStatus]), search: 'endpoint url base openai server',
      }),
      knobRow({
        id: 'remote.apiKey', title: 'API key', description: 'Bearer token, stored in your local config.',
        control: keyInput, search: 'api key token bearer secret',
      }),
    ]),
    knobRow({
      id: 'remote.verify', title: 'Connection', description: 'Check the endpoint and load its model list.',
      control: el('div', { class: 'sv-llm-verify-line' }, [verifyBtn, verifyStatus]), wide: true, search: 'verify test connection',
    }),
    knobRow({
      id: 'remote.model', title: 'Model',
      control: el('div', { class: 'sv-llm-model-line' }, [enhanceSelect(modelSelect), refreshBtn]), wide: true, search: 'remote model',
    }),
    toggleGrid([knobRow({
      id: 'remote.visionCapable', title: 'Accepts images', description: 'Let the agent send screenshots to this model.',
      control: toggleCtl('remote-vision', 'Accepts images', !!rm.visionCapable, (v) => tab._setLLM('remote.visionCapable', !!v)),
      toggle: true, search: 'vision images screenshots',
    })]),
    knobRow({
      id: 'remote.activate', title: 'Activate', description: 'Switch the app to this endpoint, or clear it.',
      control: el('div', { class: 'sv-button-row' }, [useBtn, clearBtn]), wide: true, search: 'use remote activate clear',
    }),
  );

  const adv = advanced(c, 'remote');
  adv.body.appendChild(knobRow({
    id: 'remote.toolMode',
    title: 'Tool format',
    description: 'Native sends the OpenAI tools schema (OpenAI, Together, vLLM, SGLang, recent llama.cpp and LM Studio). Use JSON when the endpoint rejects a tools payload.',
    control: pillsCtl('remote-tool-mode', 'Tool format', [
      { value: 'native', label: 'Native tools' },
      { value: 'json', label: 'JSON' },
    ], rm.toolMode || 'native', (v) => tab._setLLM('remote.toolMode', v || 'native')),
    wide: true,
    search: 'tool format native json function calling',
  }));

  Object.assign(tab._refs, {
    remoteUrlInput: urlInput, remoteUrlStatus: urlStatus, remoteKeyInput: keyInput,
    verifyBtn, verifyStatusEl: verifyStatus, remoteModelSelect: modelSelect, remoteRefreshBtn: refreshBtn,
    remoteActivateDesc: c.root.querySelector('[data-setting-id="llm.remote.activate"] .settings-v2-row-description'), remoteAdvanced: adv,
  });
  return c.root;
}
function renderActivateCopy(tab) {
  const desc = tab._refs.remoteActivateDesc;
  if (!desc) return;
  let copy = desc.dataset.base || (desc.dataset.base = desc.textContent);
  if (tab._localServing()) copy += " Using remote switches the app to the remote endpoint's model, which is not locally hosted. The loaded local model keeps serving until you stop it.";
  else if (tab.status) copy += ' With no local model running, the remote becomes the active endpoint.';
  desc.textContent = desc.title = copy;
  // SettingsView._clearHighlight restores dataset.original verbatim; the
  // runtime copy just changed, so that snapshot is stale — drop it.
  delete desc.dataset.original;
}

/** Validate a committed endpoint. Returns the trimmed value, or null when invalid (status shown). */
function checkEndpoint(refs, raw) {
  const endpoint = String(raw || '').trim();
  refs.remoteUrlInput.value = endpoint;
  if (endpoint && !isValidUrl(endpoint)) {
    refs.remoteUrlInput.setAttribute('aria-invalid', 'true');
    refs.remoteUrlStatus.hidden = false;
    setLine(refs.remoteUrlStatus, 'error', 'Enter an http(s) URL, e.g. https://api.openai.com');
    return null;
  }
  refs.remoteUrlInput.removeAttribute('aria-invalid');
  refs.remoteUrlStatus.hidden = true;
  return endpoint;
}

/** Replace the remote model options with a verified list, keeping the previous pick. */
function populateRemoteModels(select, models, previous) {
  select.textContent = '';
  if (!models.length) {
    select.appendChild(el('option', { value: '' }, ['No models returned']));
    syncSelect(select);
    return;
  }
  select.appendChild(el('option', { value: '' }, ['Select a model…']));
  for (const id of models) {
    const opt = el('option', { value: id }, [id]);
    if (id === previous) opt.selected = true;
    select.appendChild(opt);
  }
  syncSelect(select);
}

module.exports = { buildRemoteCard, renderActivateCopy, checkEndpoint, populateRemoteModels };

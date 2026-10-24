// Custom settings modules for spell-check and Accept-Language lists and the
// text-to-speech voice picker.

const { ipcRenderer } = require('electron');
const { el } = require('../controls');
const tts = require('../../../utils/tts');

// -- Spell-check languages -------------------------------------------------

function spellCheckLanguages({ host, configBridge }) {
  const current = configBridge.get('settings.spellCheck.languages', ['en-US']) || [];
  const input = el('input', {
    type: 'text', class: 'sv-text',
    value: Array.isArray(current) ? current.join(', ') : String(current || ''),
    placeholder: 'en-US, en-GB, fr',
    'aria-label': 'Spell-check languages',
  });
  input.addEventListener('change', () => {
    const langs = input.value.split(',').map((s) => s.trim()).filter(Boolean);
    configBridge.set('settings.spellCheck.languages', langs);
    ipcRenderer.send('settings:apply-spellcheck');
  });
  host.appendChild(input);
}

// -- Accept-Language preferences -------------------------------------------

function acceptLanguages({ host, configBridge }) {
  const current = configBridge.get('settings.acceptLanguages', ['en-US', 'en']) || [];
  const input = el('input', {
    type: 'text', class: 'sv-text',
    value: Array.isArray(current) ? current.join(', ') : String(current || ''),
    placeholder: 'en-US, en, fr',
    'aria-label': 'Accept-Language preferences',
  });
  input.addEventListener('change', () => {
    const langs = input.value.split(',').map((s) => s.trim()).filter(Boolean);
    configBridge.set('settings.acceptLanguages', langs);
    ipcRenderer.send('settings:apply-accept-languages');
  });
  host.appendChild(input);
}

// -- Text-to-speech voice picker -------------------------------------------

// Well-formed BCP-47 subtags; Intl.DisplayNames.of() throws RangeError on
// anything else, so malformed tags are screened out before the lookup.
const SUBTAG_PATTERNS = {
  language: /^(?:[a-z]{2,3}|[a-z]{5,8})$/i,
  region: /^(?:[a-z]{2}|\d{3})$/i,
};

// Resolve a BCP-47 subtag to a human label ("en" -> "English", "US" ->
// "United States") via Intl.DisplayNames. Returns '' for a malformed or
// unknown subtag so the caller can fall back to the raw tag.
function makeDisplayNamer(type) {
  const loc = (typeof navigator !== 'undefined' && navigator.language) || 'en';
  const dn = new Intl.DisplayNames([loc], { type });
  const pattern = SUBTAG_PATTERNS[type];
  return (code) => (pattern.test(String(code || '')) ? dn.of(code) || '' : '');
}

// Group voices into language/region buckets keyed by a readable label, each
// bucket's voices sorted by name. Returns [{ label, voices }] sorted by label.
function groupVoices(voices) {
  const langName = makeDisplayNamer('language');
  const regionName = makeDisplayNamer('region');
  const groups = new Map();
  for (const v of voices) {
    const tag = String(v.lang || '').replace('_', '-');
    const [lng, reg] = tag.split('-');
    const lLabel = (lng && langName(lng)) || tag || 'Other';
    const rLabel = reg && regionName(reg.toUpperCase());
    const label = rLabel ? `${lLabel} (${rLabel})` : lLabel;
    if (!groups.has(label)) groups.set(label, { label, voices: [] });
    groups.get(label).voices.push(v);
  }
  return Array.from(groups.values())
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((g) => ({
      label: g.label,
      voices: g.voices.sort((a, b) => String(a.name).localeCompare(String(b.name))),
    }));
}

// `<select>` of the OS speechSynthesis voices, grouped by language/region so
// the menu is organized for picking. The list is populated async by the
// engine (voiceschanged), so we repopulate whenever it fires. '' = the OS
// default voice; a saved voiceURI that's no longer installed falls back to
// default rather than silently selecting the wrong voice.
function voiceReading({ host, configBridge }) {
  const wrap = el('div', { class: 'sv-row-stack' });
  const select = el('select', { class: 'sv-select', 'aria-label': 'Text-to-speech voice' });
  const status = el('span', { class: 'sv-section-intro' }, ['']);

  const repopulate = () => {
    const saved = configBridge.get('settings.tts.voiceURI', '') || '';
    const voices = tts.listVoices();
    while (select.firstChild) select.removeChild(select.firstChild);
    select.appendChild(el('option', { value: '' }, ['System default']));
    for (const group of groupVoices(voices)) {
      const og = el('optgroup', { label: group.label });
      for (const v of group.voices) {
        og.appendChild(el('option', { value: v.voiceURI }, [
          `${v.name}${v.default ? ' — default' : ''}`,
        ]));
      }
      select.appendChild(og);
    }
    select.value = saved;
    if (select.value !== saved) select.value = '';
    if (!tts.isSupported()) {
      status.textContent = 'Text-to-speech is not available in this environment.';
    } else if (!voices.length) {
      status.textContent = 'Loading system voices…';
    } else {
      status.textContent = `${voices.length} system voice${voices.length === 1 ? '' : 's'} available.`;
    }
  };

  select.addEventListener('change', () => configBridge.set('settings.tts.voiceURI', select.value || ''));
  // Voices load async; repopulate on every voiceschanged so a saved voiceURI
  // not yet installed at first paint is re-applied once it appears. The
  // returned teardown removes the global listener — this section re-mounts on
  // every Settings open, so without it the listeners would accumulate.
  const onVoices = () => repopulate();
  tts.onVoicesChanged(onVoices);
  repopulate();

  wrap.appendChild(select);
  wrap.appendChild(status);
  host.appendChild(wrap);
  return () => tts.offVoicesChanged(onVoices);
}

module.exports = { spellCheckLanguages, acceptLanguages, voiceReading, groupVoices };

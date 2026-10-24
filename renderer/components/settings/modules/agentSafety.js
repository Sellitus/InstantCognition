// Agent egress control (allow/block lists) and remembered site decisions.

const { el } = require('../controls');
const { setStatus } = require('./kit');

// approvalPolicy.hostMatches strips a scheme, a leading "*.", and any path
// before comparing; whatever remains must be a bare hostname (no port, no
// spaces) or the entry can never match a destination.
const HOSTNAME_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;
function _isDomainPattern(entry) {
  const host = entry.replace(/^https?:\/\//, '').replace(/^\*\./, '').replace(/\/.*$/, '').replace(/^\.+/, '');
  return HOSTNAME_RE.test(host);
}

// -- Agent safety: egress control + persisted-grant audit -------------------

function _linesToList(text) {
  const seen = new Set();
  const out = [];
  String(text || '').split(/[\n,]+/).forEach((raw) => {
    const v = raw.trim().toLowerCase();
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  });
  return out;
}

function agentSafety({ host, configBridge }) {
  const read = () => {
    const s = (configBridge.snapshot() || {}).settings || {};
    const agent = (s.llm && s.llm.agent) || {};
    return {
      egress: agent.egress || { mode: 'open', allow: [], block: [], onViolation: 'prompt' },
      perOrigin: (agent.approval && agent.approval.perOrigin) || {},
    };
  };

  host.appendChild(el('p', { class: 'sv-section-intro' }, [
    'Controls where the agent may navigate. By default the agent can open any '
    + 'site. Switch to an allow-list to confine it to domains you name, or a '
    + 'block-list to forbid specific ones. Blocked domains are always refused.',
  ]));

  const body = el('div', { class: 'sv-agent-egress' });
  host.appendChild(body);

  function render() {
    const { egress, perOrigin } = read();
    body.innerHTML = '';

    // Mode
    const modeSel = el('select', { class: 'sv-select' });
    [['open', 'Open — no destination gating'],
      ['allowlist', 'Allow-list — only the domains below'],
      ['blocklist', 'Block-list — everything except blocked domains']].forEach(([v, label]) => {
      const o = el('option', { value: v }, [label]);
      if (egress.mode === v) o.setAttribute('selected', '');
      modeSel.appendChild(o);
    });
    modeSel.addEventListener('change', () => {
      configBridge.set('settings.llm.agent.egress.mode', modeSel.value);
      render();
    });
    body.appendChild(el('div', { class: 'sv-row' }, [
      el('label', { class: 'sv-field-label' }, ['Egress mode']), modeSel,
    ]));

    // Allow / block textareas — one domain per line (covers subdomains)
    const mkArea = (key, label, value, ph) => {
      const ta = el('textarea', {
        class: 'sv-text', rows: '4', placeholder: ph,
      });
      ta.value = (Array.isArray(value) ? value : []).join('\n');
      const status = el('span', { class: 'sv-validation-status' });
      ta.addEventListener('change', () => {
        const entries = _linesToList(ta.value);
        const invalid = entries.filter((d) => !_isDomainPattern(d));
        if (invalid.length) {
          setStatus(status, 'error', `Not a domain: ${invalid.join(', ')}. Use bare hostnames like example.com.`);
          return;
        }
        configBridge.set(`settings.llm.agent.egress.${key}`, entries);
        render();
      });
      return el('div', { class: 'sv-row-stack' }, [
        el('label', { class: 'sv-field-label' }, [label]), ta, status,
      ]);
    };
    if (egress.mode === 'allowlist') {
      body.appendChild(mkArea('allow', 'Allowed domains', egress.allow,
        'example.com\ndocs.python.org\n(one per line; covers subdomains)'));
    }
    body.appendChild(mkArea('block', 'Blocked domains (always refused)', egress.block,
      'facebook.com\nads.example.com'));

    // What happens on a violation (allow-list miss)
    const onv = el('select', { class: 'sv-select' });
    [['prompt', 'Ask me (one-time / session / always-for-site)'],
      ['deny', 'Refuse silently to the agent']].forEach(([v, label]) => {
      const o = el('option', { value: v }, [label]);
      if ((egress.onViolation || 'prompt') === v) o.setAttribute('selected', '');
      onv.appendChild(o);
    });
    onv.addEventListener('change', () => configBridge.set('settings.llm.agent.egress.onViolation', onv.value));
    body.appendChild(el('div', { class: 'sv-row' }, [
      el('label', { class: 'sv-field-label' }, ['When a site is not allowed']), onv,
    ]));

    // Audit: persisted "always allow/deny on this site" egress grants
    const grants = Object.keys(perOrigin)
      .filter((o) => perOrigin[o] && perOrigin[o].egress)
      .map((o) => ({ origin: o, verdict: perOrigin[o].egress }));
    body.appendChild(el('h4', { class: 'sv-subhead' }, ['Remembered site decisions']));
    if (!grants.length) {
      body.appendChild(el('p', { class: 'sv-hint' }, ['None yet. Choosing "Always allow on this site" on an approval prompt records it here.']));
    } else {
      const list = el('div', { class: 'sv-grant-list' });
      grants.forEach(({ origin, verdict }) => {
        const revoke = el('button', { type: 'button', class: 'sv-button sv-button--danger' }, ['Revoke']);
        revoke.addEventListener('click', () => {
          const fresh = (configBridge.snapshot() || {}).settings || {};
          const ap = (fresh.llm && fresh.llm.agent && fresh.llm.agent.approval) || {};
          const po = { ...(ap.perOrigin || {}) };
          if (po[origin]) {
            const next = { ...po[origin] };
            delete next.egress;
            if (Object.keys(next).length) po[origin] = next; else delete po[origin];
          }
          configBridge.set('settings.llm.agent.approval.perOrigin', po);
          render();
        });
        list.appendChild(el('div', { class: 'sv-grant-row' }, [
          el('span', { class: 'sv-grant-origin' }, [origin]),
          el('span', { class: 'sv-grant-verdict' }, [verdict === 'deny' ? 'always blocked' : 'always allowed']),
          revoke,
        ]));
      });
      body.appendChild(list);
    }
  }

  render();
}

module.exports = { agentSafety };

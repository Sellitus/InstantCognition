// MCP tool-server editor.

const { ipcRenderer } = require('electron');
const { el } = require('../controls');
const { errMsg } = require('../../../../shared/errMsg');
const { actionButton, isValidUrl, setStatus } = require('./kit');

// MCP servers — Model Context Protocol. Each connected server exposes its
// tools to the agent (namespaced mcp.<serverId>.<tool>). Servers run as local
// stdio subprocesses or connect to an HTTP endpoint. A backend (McpService)
// owns the lifecycle; this editor only writes config + asks it to reload.
function mcpServers({ host, configBridge }) {
  const readConfig = () => {
    const s = (configBridge.snapshot() || {}).settings || {};
    const mcp = s.mcp || {};
    return {
      enabled: !!mcp.enabled,
      servers: Array.isArray(mcp.servers) ? mcp.servers.slice() : [],
    };
  };
  const writeServers = (servers) => configBridge.set('settings.mcp.servers', servers);
  // Resolves true when McpService reloaded; a failure is written to `statusEl`.
  const reload = (statusEl) => ipcRenderer.invoke('mcp:reload').then(
    () => true,
    (err) => {
      setStatus(statusEl, 'error', `Couldn't reload MCP servers: ${errMsg(err)}`);
      return false;
    },
  );

  host.appendChild(el('p', { class: 'sv-section-intro' }, [
    'Connect Model Context Protocol servers to expose their tools to the agent. ',
    'Each connected server\'s tools appear as ',
    el('code', {}, ['mcp.<server>.<tool>']),
    ' entries in the agent\'s tool list. Stdio servers run as local subprocesses; HTTP servers connect to a running endpoint.',
  ]));

  // SDK availability banner — the MCP SDK is required; if it is missing the
  // controls are inert and we say so plainly rather than failing silently.
  const banner = el('div', { class: 'sv-validation-status' }, ['']);
  host.appendChild(banner);
  ipcRenderer.invoke('mcp:available').then((r) => {
    if (r && r.ok && r.available) setStatus(banner, null, '');
    else setStatus(banner, 'error', 'MCP SDK not detected — servers will not connect. Install @modelcontextprotocol/sdk.');
  }, (err) => setStatus(banner, 'error', `Couldn't check MCP availability: ${errMsg(err)}`));

  // Master toggle — gates whether any enabled server is connected.
  const enableCb = el('input', { type: 'checkbox' });
  enableCb.checked = readConfig().enabled;
  enableCb.addEventListener('change', () => {
    configBridge.set('settings.mcp.enabled', enableCb.checked);
    reload(banner);
  });
  host.appendChild(el('div', { class: 'sv-row' }, [
    enableCb, el('label', { class: 'sv-field-label' }, ['Enable MCP tool servers']),
  ]));

  const listEl = el('div', { class: 'sv-spaces-list' });
  host.appendChild(listEl);

  let _nextId = 1;
  const allocId = (servers) => {
    const used = new Set(servers.map((s) => s && s.id).filter(Boolean));
    let n = _nextId;
    while (used.has(`mcp${n}`)) n += 1;
    _nextId = n + 1;
    return `mcp${n}`;
  };

  function rowFor(server, status) {
    const s = {
      id: (server && server.id) || allocId([]),
      name: (server && server.name) || '',
      transport: (server && server.transport) === 'http' ? 'http' : 'stdio',
      enabled: server ? server.enabled !== false : true,
      command: (server && server.command) || '',
      args: Array.isArray(server && server.args) ? server.args.join('\n') : '',
      url: (server && server.url) || '',
      envPairs: server && server.env
        ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join('\n')
        : '',
      headersPairs: server && server.headers
        ? Object.entries(server.headers).map(([k, v]) => `${k}: ${v}`).join('\n')
        : '',
    };
    const row = el('div', { class: 'sv-space-row' });

    const head = el('div', { class: 'sv-persona-row-head' });
    const enabledCb = el('input', { type: 'checkbox' });
    enabledCb.checked = s.enabled;
    enabledCb.addEventListener('change', () => {
      const items = readConfig().servers.map((x) => (x && x.id === s.id ? { ...x, enabled: enabledCb.checked } : x));
      writeServers(items);
      reload(statusEl).then((ok) => { if (ok) refreshStatus(s.id); });
    });
    const title = el('span', { class: 'sv-persona-title' }, [s.name || s.id]);
    const sub = el('span', { class: 'sv-persona-sub' }, [`${s.transport} · ${status ? status.status : 'disconnected'}`]);
    head.append(enabledCb, title, sub);
    row.appendChild(head);

    const nameInput = el('input', { type: 'text', class: 'sv-text', value: s.name, placeholder: 'Display name' });

    const transSel = el('select', { class: 'sv-select', 'aria-label': 'Transport' });
    [['stdio', 'Stdio (local subprocess)'], ['http', 'HTTP (remote endpoint)']].forEach(([v, label]) => {
      transSel.appendChild(el('option', { value: v }, [label]));
    });
    transSel.value = s.transport;

    // Stdio fields
    const cmdInput = el('input', { type: 'text', class: 'sv-text', value: s.command, placeholder: 'Command, e.g. npx' });
    const argsArea = el('textarea', { class: 'sv-text', rows: '2', placeholder: 'One arg per line, e.g.\n-y\n@modelcontextprotocol/server-filesystem' });
    argsArea.value = s.args;
    const envArea = el('textarea', { class: 'sv-text', rows: '2', placeholder: 'Env vars, one per line, KEY=value' });
    envArea.value = s.envPairs;

    // HTTP fields
    const urlInput = el('input', { type: 'text', class: 'sv-text', value: s.url, placeholder: 'https://host:port/mcp' });
    const headersArea = el('textarea', { class: 'sv-text', rows: '2', placeholder: 'Headers, one per line, Key: value' });
    headersArea.value = s.headersPairs;

    const stdioWrap = el('div', { class: 'sv-row' }, [cmdInput, argsArea, envArea]);
    const httpWrap = el('div', { class: 'sv-row' }, [urlInput, headersArea]);
    const syncFields = () => {
      const http = transSel.value === 'http';
      stdioWrap.style.display = http ? 'none' : '';
      httpWrap.style.display = http ? '' : 'none';
    };
    transSel.addEventListener('change', syncFields);
    syncFields();

    const statusEl = el('span', { class: 'sv-validation-status' }, ['']);
    const refreshStatus = async (id) => {
      try {
        const r = await ipcRenderer.invoke('mcp:status');
        const found = r && Array.isArray(r.servers) ? r.servers.find((x) => x && x.id === id) : null;
        const text = found ? `${found.status}${found.toolCount ? ` · ${found.toolCount} tool${found.toolCount === 1 ? '' : 's'}` : ''}${found.error ? ` · ${found.error}` : ''}` : 'disconnected';
        sub.textContent = `${transSel.value} · ${text}`;
        if (found && found.status === 'error') setStatus(statusEl, 'error', found.error || 'Server reported an error.');
        else setStatus(statusEl, null, '');
      } catch (err) {
        setStatus(statusEl, 'error', `Couldn't read server status: ${errMsg(err)}`);
      }
    };

    const _linesToList = (raw) => String(raw || '').split('\n').map((x) => x.trim()).filter(Boolean);
    const _pairsToObj = (raw, sep) => {
      const out = {};
      for (const line of _linesToList(raw)) {
        const idx = line.indexOf(sep);
        if (idx <= 0) continue;
        out[line.slice(0, idx).trim()] = line.slice(idx + sep.length).trim();
      }
      return out;
    };

    // Persist the row and reload McpService. Resolves true once the reload
    // succeeded; validation and reload failures are shown in statusEl.
    const save = async () => {
      const next = {
        id: s.id,
        name: nameInput.value.trim() || s.id,
        transport: transSel.value,
        enabled: enabledCb.checked,
      };
      if (transSel.value === 'http') {
        next.url = urlInput.value.trim();
        if (!isValidUrl(next.url)) {
          setStatus(statusEl, 'error', 'Enter a valid http(s) URL.');
          return false;
        }
        const headers = _pairsToObj(headersArea.value, ':');
        if (Object.keys(headers).length) next.headers = headers;
      } else {
        next.command = cmdInput.value.trim();
        if (!next.command) {
          setStatus(statusEl, 'error', 'Command is required for stdio servers.');
          return false;
        }
        const args = _linesToList(argsArea.value);
        if (args.length) next.args = args;
        const env = _pairsToObj(envArea.value, '=');
        if (Object.keys(env).length) next.env = env;
      }
      const exists = readConfig().servers.some((x) => x && x.id === s.id);
      const items = exists
        ? readConfig().servers.map((x) => (x && x.id === s.id ? next : x))
        : [...readConfig().servers, next];
      writeServers(items);
      if (!(await reload(statusEl))) return false;
      setStatus(statusEl, 'ok', 'Saved.');
      return true;
    };

    const saveBtn = actionButton('Save', 'sv-button sv-button--primary', 'check');
    saveBtn.addEventListener('click', async () => {
      if (await save()) setTimeout(() => refreshStatus(s.id), 400);
    });

    const removeBtn = actionButton('Remove', 'sv-button');
    removeBtn.addEventListener('click', () => {
      writeServers(readConfig().servers.filter((x) => !(x && x.id === s.id)));
      reload(banner);
      render();
    });

    const testBtn = actionButton('Test', 'sv-button');
    testBtn.addEventListener('click', async () => {
      setStatus(statusEl, 'pending', 'Connecting…');
      // Save first so the reload connects to the latest config, then give the
      // server a moment to finish its handshake before probing.
      if (!(await save())) return;
      await new Promise((res) => setTimeout(res, 600));
      await refreshStatus(s.id);
    });

    row.append(
      el('div', { class: 'sv-row' }, [nameInput, transSel]),
      stdioWrap,
      httpWrap,
      el('div', { class: 'sv-actions-row' }, [saveBtn, testBtn, removeBtn, statusEl]),
    );
    refreshStatus(s.id);
    return row;
  }

  function render() {
    const { servers } = readConfig();
    listEl.innerHTML = '';
    if (!servers.length) {
      listEl.appendChild(el('p', { class: 'sv-empty-hint' }, ['No MCP servers configured. Add one below.']));
    } else {
      servers.forEach((s) => listEl.appendChild(rowFor(s, null)));
    }
  }

  const addBtn = actionButton('Add server', 'sv-button sv-button--primary', 'plus');
  addBtn.addEventListener('click', () => {
    const { servers } = readConfig();
    const draft = { id: allocId(servers), name: '', transport: 'stdio', enabled: true, command: '', args: [] };
    writeServers([...servers, draft]);
    render();
  });
  host.appendChild(el('div', { class: 'sv-actions-row' }, [addBtn]));

  render();
}

module.exports = { mcpServers };

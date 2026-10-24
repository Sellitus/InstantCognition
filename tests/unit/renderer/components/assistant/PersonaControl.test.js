/**
 * @jest-environment jsdom
 */

jest.mock('electron', () => ({
  ipcRenderer: { invoke: jest.fn(), send: jest.fn() },
}));

const { ipcRenderer } = require('electron');
const PersonaControl = require('../../../../../renderer/components/assistant/PersonaControl');

function mountControl() {
  const content = document.createElement('div');
  content.innerHTML = '<select class="agent-panel-persona"></select>';
  document.body.appendChild(content);
  const host = {};
  const ctl = new PersonaControl(host);
  return { ctl, host, content };
}

describe('PersonaControl.load', () => {
  afterEach(() => { document.body.innerHTML = ''; jest.clearAllMocks(); });

  test('an imported persona label carrying markup renders as inert text, not elements', async () => {
    const hostile = '<img src=x onerror="window.__pwned = 1">';
    ipcRenderer.invoke.mockResolvedValue({
      enabled: [{ name: 'evil"><img src=y onerror=1>', label: hostile }],
      lock: null,
    });
    const { ctl, host, content } = mountControl();
    ctl.mount(content);
    await ctl.load();
    const select = host._personaSelect;
    expect(select.querySelector('img')).toBeNull();
    expect(select.options.length).toBe(2);
    expect(select.options[1].textContent).toBe(hostile);
    expect(select.options[1].value).toBe('evil"><img src=y onerror=1>');
  });

  test('Auto stays first and the locked persona is selected', async () => {
    ipcRenderer.invoke.mockResolvedValue({
      enabled: [{ name: 'coder', label: 'Coder' }, { name: 'writer' }],
      lock: 'writer',
    });
    const { ctl, host, content } = mountControl();
    ctl.mount(content);
    await ctl.load();
    const opts = Array.from(host._personaSelect.options).map((o) => [o.value, o.textContent]);
    expect(opts).toEqual([['', 'Auto'], ['coder', 'Coder'], ['writer', 'writer']]);
    expect(host._personaSelect.value).toBe('writer');
  });

  test('reloading replaces the options instead of appending', async () => {
    ipcRenderer.invoke.mockResolvedValue({ enabled: [{ name: 'coder', label: 'Coder' }], lock: null });
    const { ctl, host, content } = mountControl();
    ctl.mount(content);
    await ctl.load();
    await ctl.load();
    expect(host._personaSelect.options.length).toBe(2);
  });
});

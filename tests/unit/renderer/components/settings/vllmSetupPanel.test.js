// vllmSetupPanel — the Engine card's guided vLLM install. jsdom env.
//
// Mock only the boundary: electron ipcRenderer (setup runs in main). The
// ConfirmDialog and Toast siblings run for real and are driven through the DOM.
// The host tab is the panel's injected owner: only its _refs bag and the
// _fetchEngines callback the panel calls once setup succeeds.

jest.mock('electron', () => ({
  ipcRenderer: {
    on: jest.fn(),
    removeListener: jest.fn(),
    invoke: jest.fn(),
  },
}));

const { ipcRenderer } = require('electron');
const { buildVllmSetupPanel, renderVllmSetup, RUNNABLE } = require('../../../../../renderer/components/settings/llm/vllmSetupPanel');

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const label = (btn) => btn.getAttribute('aria-label');

function makePanel() {
  const tab = { _refs: {}, _fetchEngines: jest.fn(() => Promise.resolve()) };
  const root = buildVllmSetupPanel(tab);
  document.body.appendChild(root);
  return { tab, ui: tab._refs.vllmSetup };
}

function clickDialog(which) {
  const btn = document.querySelector(`.confirm-dialog-${which}`);
  expect(btn).not.toBeNull();
  btn.click();
}

describe('vllmSetupPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    ipcRenderer.on.mockReset();
    ipcRenderer.removeListener.mockReset();
    ipcRenderer.invoke.mockReset();
  });

  describe('renderVllmSetup', () => {
    test('a ready install shows its version and GPU and offers no action', () => {
      const { tab, ui } = makePanel();
      renderVllmSetup(tab._refs, { available: true, setupState: 'ready', version: '0.31.0', gpu: { name: 'RTX 4090' } });
      expect(ui.status.textContent).toBe('vLLM 0.31.0 is ready on RTX 4090.');
      expect(ui.status.dataset.state).toBe('ok');
      expect(ui.runBtn.hidden).toBe(true);
      expect(ui.restartBtn.hidden).toBe(true);
    });

    test.each([
      ['wsl-missing', 'Set up vLLM'],
      ['not-installed', 'Set up vLLM'],
      ['distro-missing', 'Continue setup'],
      ['error', 'Retry setup'],
    ])('runnable state %s shows the reason and a "%s" button', (setupState, text) => {
      const { tab, ui } = makePanel();
      renderVllmSetup(tab._refs, { available: false, setupState, reason: `why ${setupState}` });
      expect(ui.status.textContent).toBe(`why ${setupState}`);
      expect(ui.status.dataset.state).toBe('idle');
      expect(ui.runBtn.hidden).toBe(false);
      expect(label(ui.runBtn)).toBe(text);
      expect(ui.runBtn.textContent).toContain(text);
      expect(ui.restartBtn.hidden).toBe(true);
    });

    test('reboot-required offers Restart Windows instead of Run', () => {
      const { tab, ui } = makePanel();
      renderVllmSetup(tab._refs, { available: false, setupState: 'reboot-required', reason: 'Restart Windows to finish.' });
      expect(ui.runBtn.hidden).toBe(true);
      expect(ui.restartBtn.hidden).toBe(false);
      expect(ui.status.dataset.state).toBe('idle');
    });

    test.each(['no-gpu', 'driver-old', 'no-python', 'unsupported'])('%s needs the user: shows the reason as an error with no buttons', (setupState) => {
      const { tab, ui } = makePanel();
      renderVllmSetup(tab._refs, { available: false, setupState, reason: 'vLLM needs an NVIDIA GPU.' });
      expect(RUNNABLE).not.toContain(setupState);
      expect(ui.status.textContent).toBe('vLLM needs an NVIDIA GPU.');
      expect(ui.status.dataset.state).toBe('error');
      expect(ui.runBtn.hidden).toBe(true);
      expect(ui.restartBtn.hidden).toBe(true);
    });

    test('a missing vllm row is reported, not hidden', () => {
      const { tab, ui } = makePanel();
      renderVllmSetup(tab._refs, null);
      expect(ui.status.textContent).toBe('vLLM status was not reported.');
      expect(ui.status.getAttribute('role')).toBe('alert');
      expect(ui.runBtn.hidden).toBe(true);
    });

    test('a re-detect while setup runs does not overwrite the progress lines', () => {
      const { tab, ui } = makePanel();
      ui.busy = true;
      ui.status.textContent = 'Setting up vLLM.';
      renderVllmSetup(tab._refs, { available: false, setupState: 'no-gpu', reason: 'other' });
      expect(ui.status.textContent).toBe('Setting up vLLM.');
    });
  });

  describe('runSetup', () => {
    test('a failed run shows the error and a Retry button, and drops the progress listener', async () => {
      const { tab, ui } = makePanel();
      renderVllmSetup(tab._refs, { available: false, setupState: 'not-installed', reason: 'not installed' });
      let release;
      ipcRenderer.invoke.mockImplementation(() => new Promise((r) => { release = r; }));
      ui.runBtn.click();
      await flush();
      expect(ipcRenderer.invoke).toHaveBeenCalledWith('vllm-setup:run');
      expect(ui.runBtn.disabled).toBe(true);
      const [[channel, onProgress]] = ipcRenderer.on.mock.calls;
      expect(channel).toBe('vllm-setup:progress');
      onProgress(null, { step: 'Installing vLLM', percent: 40 });
      expect(ui.step.textContent).toBe('Installing vLLM (40%)');
      onProgress(null, { step: 'Checking the GPU' });
      expect(ui.step.textContent).toBe('Checking the GPU');

      release({ ok: false, error: 'pip exited 1' });
      await flush();
      expect(ui.status.textContent).toBe('Setup stopped: pip exited 1');
      expect(ui.status.dataset.state).toBe('error');
      expect(label(ui.runBtn)).toBe('Retry setup');
      expect(ui.runBtn.hidden).toBe(false);
      expect(ui.runBtn.disabled).toBe(false);
      expect(ui.busy).toBe(false);
      expect(ipcRenderer.removeListener).toHaveBeenCalledWith('vllm-setup:progress', onProgress);
      expect(tab._fetchEngines).not.toHaveBeenCalled();
    });

    test('a rejected invoke is reported like a failed run', async () => {
      const { tab, ui } = makePanel();
      renderVllmSetup(tab._refs, { available: false, setupState: 'error', reason: 'x' });
      ipcRenderer.invoke.mockRejectedValue(new Error('channel closed'));
      ui.runBtn.click();
      await flush();
      expect(ui.status.textContent).toBe('Setup stopped: channel closed');
      expect(ipcRenderer.removeListener).toHaveBeenCalledTimes(1);
    });

    test('reboot-required after the WSL install shows Restart Windows', async () => {
      const { tab, ui } = makePanel();
      renderVllmSetup(tab._refs, { available: false, setupState: 'distro-missing', reason: 'x' });
      ipcRenderer.invoke.mockResolvedValue({ ok: true, state: 'reboot-required', reason: 'Restart Windows to finish installing WSL.' });
      ui.runBtn.click();
      await flush();
      expect(ui.status.textContent).toBe('Restart Windows to finish installing WSL.');
      expect(ui.runBtn.hidden).toBe(true);
      expect(ui.restartBtn.hidden).toBe(false);
      expect(ui.state).toBe('reboot-required');
      expect(tab._fetchEngines).not.toHaveBeenCalled();
    });

    test('success toasts the version and forces a fresh engine detect', async () => {
      const { tab, ui } = makePanel();
      renderVllmSetup(tab._refs, { available: false, setupState: 'not-installed', reason: 'x' });
      ipcRenderer.invoke.mockResolvedValue({ ok: true, state: 'ready', version: '0.31.0' });
      ui.runBtn.click();
      await flush();
      expect(document.querySelector('.toast-stack').textContent).toContain('vLLM 0.31.0 is ready.');
      expect(tab._fetchEngines).toHaveBeenCalledWith(true);
      expect(ui.step.hidden).toBe(true);
    });

    test('wsl-missing asks before installing WSL, and Cancel runs nothing', async () => {
      const { tab, ui } = makePanel();
      renderVllmSetup(tab._refs, { available: false, setupState: 'wsl-missing', reason: 'x' });
      ui.runBtn.click();
      await flush();
      expect(document.querySelector('.confirm-dialog-confirm').textContent).toBe('Install');
      clickDialog('cancel');
      await flush();
      expect(ipcRenderer.invoke).not.toHaveBeenCalled();
      expect(ui.busy).toBe(false);
    });

    test('wsl-missing runs setup once the user confirms', async () => {
      const { tab, ui } = makePanel();
      renderVllmSetup(tab._refs, { available: false, setupState: 'wsl-missing', reason: 'x' });
      ipcRenderer.invoke.mockResolvedValue({ ok: true, state: 'reboot-required' });
      ui.runBtn.click();
      await flush();
      clickDialog('confirm');
      await flush();
      expect(ipcRenderer.invoke).toHaveBeenCalledWith('vllm-setup:run');
      expect(ui.restartBtn.hidden).toBe(false);
    });

    test('a second click while running does not start another run', async () => {
      const { tab, ui } = makePanel();
      renderVllmSetup(tab._refs, { available: false, setupState: 'not-installed', reason: 'x' });
      ipcRenderer.invoke.mockImplementation(() => new Promise(() => {}));
      ui.runBtn.click();
      await flush();
      ui.runBtn.disabled = false;
      ui.runBtn.click();
      await flush();
      expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
    });
  });

  describe('restart', () => {
    test('Restart asks first and only then invokes vllm-setup:restart', async () => {
      const { tab, ui } = makePanel();
      renderVllmSetup(tab._refs, { available: false, setupState: 'reboot-required', reason: 'x' });
      ipcRenderer.invoke.mockResolvedValue({ ok: true });
      ui.restartBtn.click();
      await flush();
      expect(ipcRenderer.invoke).not.toHaveBeenCalled();
      clickDialog('confirm');
      await flush();
      expect(ipcRenderer.invoke).toHaveBeenCalledWith('vllm-setup:restart');
    });

    test('a failed restart is shown as an error toast', async () => {
      const { tab, ui } = makePanel();
      renderVllmSetup(tab._refs, { available: false, setupState: 'reboot-required', reason: 'x' });
      ipcRenderer.invoke.mockResolvedValue({ ok: false, error: 'access denied' });
      ui.restartBtn.click();
      await flush();
      clickDialog('confirm');
      await flush();
      expect(document.querySelector('.toast-stack').textContent).toContain('Could not restart Windows: access denied');
    });

    test('cancelling the restart dialog does nothing', async () => {
      const { tab, ui } = makePanel();
      renderVllmSetup(tab._refs, { available: false, setupState: 'reboot-required', reason: 'x' });
      ui.restartBtn.click();
      await flush();
      clickDialog('cancel');
      await flush();
      expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    });
  });
});

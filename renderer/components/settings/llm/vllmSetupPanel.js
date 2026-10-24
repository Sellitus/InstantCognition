// vLLM setup panel: the engine card's guided install for vLLM on Linux, and
// on Windows through WSL2. The steps run in the main process
// (main/services/llm/vllmSetup.js); this panel shows where setup stands, runs
// it, streams each step, and offers the Windows restart the WSL install needs.
// Setup re-detects before every step, so "Continue setup" after the restart
// picks up where it left off.

const { ipcRenderer } = require('electron');
const { el } = require('../controls');
const { button, setLine } = require('./cardKit');
const { confirm } = require('../../ConfirmDialog');
const toast = require('../../Toast');
const { errMsg } = require('../../../../shared/errMsg');

// States the app can move forward itself; the rest need the user (GPU,
// driver, Linux packages) and only show the reason.
const RUNNABLE = ['wsl-missing', 'distro-missing', 'not-installed', 'error'];

function buildVllmSetupPanel(tab) {
  const status = el('p', { class: 'sv-llm-inline-status', 'aria-live': 'polite', 'data-state': 'busy' }, ['Checking…']);
  const step = el('p', { class: 'sv-llm-inline-status sv-llm-vllm-step', 'aria-live': 'polite', hidden: true });
  const runBtn = button({ label: 'Set up vLLM', icon: 'download', variant: 'primary', onClick: () => runSetup(tab) });
  const restartBtn = button({ label: 'Restart Windows', icon: 'refresh', variant: 'ghost', onClick: () => restartWindows() });
  runBtn.hidden = true;
  restartBtn.hidden = true;
  const root = el('div', { class: 'sv-llm-vllm-setup' }, [status, step, el('div', { class: 'sv-button-row' }, [runBtn, restartBtn])]);
  tab._refs.vllmSetup = { root, status, step, runBtn, restartBtn, state: null, busy: false };
  return root;
}

function setRunLabel(btn, text) {
  btn.querySelector('span').textContent = text;
  btn.title = text;
  btn.setAttribute('aria-label', text);
}

/** @param {any} refs LLMTab refs @param {any} det the `vllm` row of llm:detect-engines */
function renderVllmSetup(refs, det) {
  const ui = refs.vllmSetup;
  if (ui.busy) return;
  ui.state = det ? det.setupState : null;
  ui.step.hidden = true;
  if (!det) {
    setLine(ui.status, 'error', 'vLLM status was not reported.');
    ui.runBtn.hidden = true;
    ui.restartBtn.hidden = true;
    return;
  }
  if (det.available) {
    setLine(ui.status, 'ok', `vLLM ${det.version} is ready${det.gpu ? ` on ${det.gpu.name}` : ''}.`);
  } else {
    setLine(ui.status, RUNNABLE.includes(det.setupState) || det.setupState === 'reboot-required' ? 'idle' : 'error', det.reason || det.setupState);
  }
  ui.runBtn.hidden = !RUNNABLE.includes(det.setupState);
  const labels = { 'distro-missing': 'Continue setup', error: 'Retry setup' };
  setRunLabel(ui.runBtn, labels[det.setupState] || 'Set up vLLM');
  ui.restartBtn.hidden = det.setupState !== 'reboot-required';
}

async function runSetup(tab) {
  const ui = tab._refs.vllmSetup;
  if (ui.busy) return;
  if (ui.state === 'wsl-missing') {
    const ok = await confirm({
      title: 'Install the Windows Subsystem for Linux?',
      message: 'vLLM runs on Linux, so setup installs WSL2. Windows asks for administrator permission once, and a restart is needed before setup can finish. The rest (a private Ubuntu environment, Python and vLLM, several GB) is downloaded automatically.',
      confirmLabel: 'Install',
    });
    if (!ok) return;
  }
  ui.busy = true;
  ui.runBtn.disabled = true;
  ui.restartBtn.hidden = true;
  setLine(ui.status, 'busy', 'Setting up vLLM. Keep the app open; this can take a while.');
  ui.step.hidden = false;
  setLine(ui.step, 'busy', 'Starting…');
  const onProgress = (_e, p) => {
    if (!p || !p.step) return;
    setLine(ui.step, 'busy', typeof p.percent === 'number' ? `${p.step} (${p.percent}%)` : p.step);
  };
  ipcRenderer.on('vllm-setup:progress', onProgress);
  let result;
  try {
    result = await ipcRenderer.invoke('vllm-setup:run');
  } catch (err) {
    result = { ok: false, error: errMsg(err) };
  } finally {
    ipcRenderer.removeListener('vllm-setup:progress', onProgress);
    ui.busy = false;
    ui.runBtn.disabled = false;
  }
  ui.step.hidden = true;
  if (!result.ok) {
    setLine(ui.status, 'error', `Setup stopped: ${result.error}`);
    setRunLabel(ui.runBtn, 'Retry setup');
    ui.runBtn.hidden = false;
    return;
  }
  if (result.state === 'reboot-required') {
    ui.state = result.state;
    setLine(ui.status, 'idle', result.reason || 'Restart Windows to finish installing WSL, then choose Continue setup.');
    ui.runBtn.hidden = true;
    ui.restartBtn.hidden = false;
    return;
  }
  toast.success(`vLLM ${result.version} is ready.`, { title: 'vLLM' });
  await tab._fetchEngines(true);
}

async function restartWindows() {
  const ok = await confirm({
    title: 'Restart Windows now?',
    message: 'Save your work in other apps first. Windows restarts in about 10 seconds. Afterwards, open Settings → Models and choose Continue setup.',
    confirmLabel: 'Restart',
    confirmKind: 'danger',
  });
  if (!ok) return;
  let result;
  try {
    result = await ipcRenderer.invoke('vllm-setup:restart');
  } catch (err) {
    result = { ok: false, error: errMsg(err) };
  }
  if (!result.ok) toast.error(`Could not restart Windows: ${result.error}`, { title: 'vLLM setup' });
}

module.exports = { buildVllmSetupPanel, renderVllmSetup, RUNNABLE };

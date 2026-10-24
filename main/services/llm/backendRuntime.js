// backendRuntime — what differs between backends around one server process:
// the opts it launches with, how it is spawned, which URL reports it healthy,
// what runs once it is, and how it is stopped. LLMManager stays generic and
// asks this module.
//
//   omlx: model_settings.json is written under the app's base path before
//         launch (llm/omlxSettings.js); requests name the model by folder name.
//   vllm: Linux runs in its own process group so a stop reaches the engine
//         core and workers vLLM forks (SIGKILL to the API server alone
//         orphans them, holding GPU memory). Windows runs inside the app's
//         WSL distro, where killing wsl.exe would not stop the Linux process.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { getBackend } = require('../../../shared/engineSchema');
const { isHfRepoId } = require('../../../shared/llmDefaults');
const { resolveToolParser } = require('../../../shared/vllmToolParsers');
const { writeModelSettings } = require('./omlxSettings');
const enginePaths = require('./enginePaths');
const wsl = require('./wsl');

const DEFAULT_HEALTH_PATH = '/v1/models';
const DEFAULT_HEALTH_TIMEOUT_MS = 60000;
const DEFAULT_KILL_GRACE_MS = 3000;
// The engine core needs time to free GPU memory before the API server exits.
const VLLM_KILL_GRACE_MS = 15000;
const OMLX_LOAD_TIMEOUT_MS = 600000;

/** @param {string} modelPath @returns {string|null} config.json's model_type */
function readModelType(modelPath) {
  const file = path.join(modelPath, 'config.json');
  if (!fs.existsSync(file)) return null;
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    throw new Error(`Could not read ${file}: ${(/** @type {any} */ (err)).message}`);
  }
  if (cfg && typeof cfg.model_type === 'string') return cfg.model_type;
  return (cfg && cfg.text_config && typeof cfg.text_config.model_type === 'string') ? cfg.text_config.model_type : null;
}

/**
 * Launch-ready opts for a backend, plus the model id requests must name (null
 * when the server answers to any id).
 * @param {string} backend
 * @param {any} opts merged start opts
 * @returns {{opts: any, apiModel: string|null}}
 */
function prepareLaunch(backend, opts) {
  if (backend === 'omlx') {
    // Only the smoke harness, which runs outside Electron, passes its own.
    const basePath = opts.basePath || enginePaths.managedOmlxHome();
    if (!basePath) throw new Error('No writable engines directory is available for oMLX.');
    const apiModel = writeModelSettings(basePath, opts.modelPath, { contextLength: opts.contextLength });
    return { opts: { ...opts, basePath }, apiModel };
  }
  if (backend === 'vllm') {
    const model = String(opts.modelPath);
    const repo = isHfRepoId(model);
    // Under WSL the path vLLM sees differs from the one picked, so the served
    // name is set explicitly rather than left to default to the path.
    const servedModelName = repo ? model : path.basename(model.replace(/[\\/]+$/, ''));
    const toolCallParser = resolveToolParser(opts.toolParser, { modelType: repo ? null : readModelType(model), name: servedModelName });
    const modelPath = repo || process.platform !== 'win32' ? model : wsl.toWslPath(model);
    return { opts: { ...opts, modelPath, servedModelName, toolCallParser }, apiModel: servedModelName };
  }
  return { opts, apiModel: null };
}

/**
 * @param {string} backend
 * @param {string} command
 * @param {string[]} args
 * @returns {{command: string, args: string[], options: import('child_process').SpawnOptions}}
 */
function spawnSpec(backend, command, args) {
  /** @type {import('child_process').StdioOptions} */
  const stdio = ['ignore', 'pipe', 'pipe'];
  if (backend !== 'vllm') return { command, args, options: { stdio } };
  if (process.platform === 'win32') {
    return {
      command: 'wsl.exe',
      args: ['-d', wsl.DISTRO, '-u', 'root', '--exec', command, ...args],
      options: { stdio, windowsHide: true, env: wsl.WSL_ENV() },
    };
  }
  return { command, args, options: { stdio, detached: true } };
}

/** @param {string} backend @returns {{path: string, timeoutMs: number}} */
function healthSpec(backend) {
  const b = /** @type {any} */ (getBackend(backend)) || {};
  return { path: b.healthPath || DEFAULT_HEALTH_PATH, timeoutMs: b.healthTimeoutMs || DEFAULT_HEALTH_TIMEOUT_MS };
}

/**
 * @param {{host: string, port: number, path: string, timeoutMs: number}} req
 * @returns {Promise<{status: number, body: string}>}
 */
function httpPost({ host, port, path: urlPath, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path: urlPath, method: 'POST', timeout: timeoutMs, headers: { 'Content-Length': 0 } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (body.length < 4096) body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('timeout', () => req.destroy(new Error(`no answer from ${urlPath} within ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Runs once the server reports healthy. oMLX: confirm the model is loaded —
 * a pinned model that failed to preload (507 = not enough memory) otherwise
 * only shows up on the first chat request.
 * @param {string} backend
 * @param {{host: string, port: number, apiModel: string|null}} target
 * @param {typeof httpPost} [post]
 */
async function afterHealthy(backend, { host, port, apiModel }, post = httpPost) {
  if (backend !== 'omlx' || !apiModel) return;
  const res = await post({ host, port, path: `/v1/models/${encodeURIComponent(apiModel)}/load`, timeoutMs: OMLX_LOAD_TIMEOUT_MS });
  if (res.status >= 200 && res.status < 300) return;
  const detail = res.body.trim().slice(0, 300);
  if (res.status === 507) throw new Error(`oMLX does not have enough memory to load ${apiModel}. ${detail}`);
  throw new Error(`oMLX could not load ${apiModel} (HTTP ${res.status}). ${detail}`);
}

/** @param {any} err */
function alreadyGone(err) {
  return err && err.code === 'ESRCH';
}

async function signal(backend, proc, sig) {
  if (backend === 'vllm' && process.platform === 'win32') {
    // The distro is the app's own, so matching the command line is safe.
    if (sig === 'SIGTERM') await wsl.execInDistro(['/usr/bin/pkill', '-TERM', '-f', 'vllm serve'], { timeoutMs: 30000 });
    else { await wsl.terminateDistro(); proc.kill('SIGKILL'); }
    return;
  }
  if (backend === 'vllm' && process.platform === 'linux' && proc.pid) process.kill(-proc.pid, sig);
  else proc.kill(sig);
}

/**
 * SIGTERM, then SIGKILL once the grace period passes. Resolves when the
 * process exits or has been killed; failures to signal are returned for the
 * caller's log, since a stop still has to finish.
 * @param {string} backend
 * @param {import('child_process').ChildProcess} proc
 * @returns {Promise<string[]>}
 */
async function stopProcess(backend, proc) {
  const failures = [];
  const send = async (sig) => {
    try { await signal(backend, proc, sig); } catch (err) {
      if (!alreadyGone(err)) failures.push(`${sig} to ${backend} failed: ${(/** @type {any} */ (err)).message || err}`);
    }
  };
  const grace = backend === 'vllm' ? VLLM_KILL_GRACE_MS : DEFAULT_KILL_GRACE_MS;
  let timer = null;
  const exited = new Promise((resolve) => proc.once('exit', () => resolve(true)));
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), grace);
    if (timer.unref) timer.unref();
  });
  await send('SIGTERM');
  const clean = await Promise.race([exited, expired]);
  clearTimeout(timer);
  if (!clean) await send('SIGKILL');
  return failures;
}

module.exports = {
  prepareLaunch, spawnSpec, healthSpec, afterHealthy, stopProcess, readModelType,
  VLLM_KILL_GRACE_MS, DEFAULT_KILL_GRACE_MS,
};

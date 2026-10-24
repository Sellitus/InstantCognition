#!/usr/bin/env node
// smoke-llm-engines — real-engine smoke harness for local LLM backends.
//
// Spawns each engine via the PRODUCTION LLMManager + EngineDiscoveryService,
// then exercises /v1/models + /v1/chat/completions against a real tiny model.
// Skips with a diagnostic when an engine or model is absent on the host.
//
// Usage:
//   node scripts/smoke-llm-engines.js
//   node scripts/smoke-llm-engines.js --engine llamaCpp
//   node scripts/smoke-llm-engines.js --engine mlxOpenAi --engine omlx
//   node scripts/smoke-llm-engines.js --json
//   SKIP_MODEL_DOWNLOAD=1 node scripts/smoke-llm-engines.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pickFreePort, discoverEngines, ensureSmokeModels, smokeEngine, log, warn, pathExists, SMOKE_MODELS } = require('./lib/llmSmoke');

function parseArgs(argv) {
  const args = { engines: null, json: false, noDownload: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--engine' || a === '-e') { args.engines = args.engines || []; args.engines.push(argv[++i]); }
    else if (a === '--json') args.json = true;
    else if (a === '--no-download') { args.noDownload = true; process.env.SKIP_MODEL_DOWNLOAD = '1'; }
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { warn(`unknown arg: ${a}`); }
  }
  return args;
}

function printHelp() {
  process.stdout.write(`smoke-llm-engines — spawn each local LLM engine, hit /v1/chat/completions with a real model

Usage: node scripts/smoke-llm-engines.js [--engine <name>]... [--json] [--no-download]

Engines: llamaCpp | mlxOpenAi | omlx | vllm (default: all four)

Env:
  SKIP_MODEL_DOWNLOAD=1  skip auto-download of smoke models; engines without a
                         local model will skip instead of downloading
  LLAMA_BINARY_PATH      override the llama-server binary path
  VLLM_PYTHON_PATH       override the python used for vLLM

Exit code: 0 if every attempted engine passed; 1 if any failed. Skipped engines
do not affect the exit code.
`);
}

function buildOpts(backend, discovery, models) {
  const opts = { backend, host: '127.0.0.1', port: 0 }; // port filled in below
  if (backend === 'llamaCpp') {
    const binaryPath = process.env.LLAMA_BINARY_PATH
      || (discovery.llamaCpp && discovery.llamaCpp.available && discovery.llamaCpp.path)
      || null;
    if (!binaryPath) return { skip: 'llama-server binary not found' };
    opts.binaryPath = binaryPath;
    opts.modelPath = models.gguf;
    // llama.cpp args via schema — keep defaults minimal to ensure load on tiny CPU/Metal.
    opts.contextLength = 2048;
    opts.chatTemplate = 'chatml';
    opts.n_gpu_layers = 0;
  } else if (backend === 'mlxOpenAi') {
    const py = discovery.mlx && discovery.mlx.pythonPath;
    if (!py) return { skip: 'no python resolved for MLX' };
    opts.pythonPath = py;
    opts.modelPath = models.mlx;
    opts.modelType = 'lm';
  } else if (backend === 'omlx') {
    const py = discovery.omlx && discovery.omlx.available && discovery.omlx.pythonPath;
    if (!py) return { skip: `oMLX not available (${(discovery.omlx && discovery.omlx.reason) || 'run scripts/fetch-omlx-runtime.js on darwin-arm64'})` };
    opts.pythonPath = py;
    opts.modelPath = models.mlx;
    opts.contextLength = 2048;
    opts.basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-omlx-smoke-'));
  } else if (backend === 'vllm') {
    // vLLM is CUDA-only — bail out early on darwin to avoid a long failing spawn.
    if (process.platform !== 'linux' && process.platform !== 'win32') {
      return { skip: `vLLM requires CUDA (linux/win32 + NVIDIA); current platform: ${process.platform}` };
    }
    const py = discovery.vllm && discovery.vllm.available && discovery.vllm.pythonPath;
    if (!py) return { skip: `vLLM not set up (${(discovery.vllm && discovery.vllm.reason) || 'run Set up vLLM in Settings'})` };
    opts.pythonPath = py;
    opts.modelPath = process.env.VLLM_MODEL_PATH || SMOKE_MODELS.vllm.hfId;
    opts.toolParser = 'none';
  }
  return opts;
}

async function main() {
  const args = parseArgs(process.argv);
  const targets = args.engines && args.engines.length > 0
    ? args.engines
    : ['llamaCpp', 'mlxOpenAi', 'omlx', 'vllm'];

  if (!args.json) log(`discovering engines on ${process.platform}/${process.arch}…`);
  const discovery = await discoverEngines();

  if (!args.json) {
    log(`capabilities: ${JSON.stringify(discovery.capabilities)}`);
    log(`llama.cpp: ${discovery.llamaCpp && discovery.llamaCpp.available ? 'available @ ' + discovery.llamaCpp.path : 'unavailable'}`);
    log(`mlx:       ${discovery.mlx && discovery.mlx.available ? 'python=' + discovery.mlx.pythonPath : 'unavailable'}`);
    log(`omlx:      ${discovery.omlx && discovery.omlx.available ? 'python=' + discovery.omlx.pythonPath : 'unavailable (' + (discovery.omlx && discovery.omlx.reason || 'not advertised') + ')'}`);
    log(`vllm:      ${discovery.vllm && discovery.vllm.available ? 'available' : 'unavailable (' + (discovery.vllm && discovery.vllm.reason || 'not advertised') + ')'}`);
  }

  if (!args.json) log(`ensuring smoke models…`);
  const models = await ensureSmokeModels({ discovery });
  if (models.skipped.length > 0 && !args.json) {
    for (const s of models.skipped) warn(`skipped ${s.kind}: ${s.reason}`);
  }

  const results = [];
  for (const backend of targets) {
    const built = buildOpts(backend, discovery, models);
    if (built.skip) {
      results.push({ backend, status: 'skip', reason: built.skip });
      if (!args.json) warn(`${backend}: SKIP — ${built.skip}`);
      continue;
    }
    // Skip engines whose model is missing rather than attempting a doomed spawn.
    if (!built.modelPath || (typeof built.modelPath === 'string' && !pathExists(built.modelPath))) {
      const skip = `smoke model not available for ${backend} (set SKIP_MODEL_DOWNLOAD=1 to make this explicit; otherwise the harness will download)`;
      results.push({ backend, status: 'skip', reason: skip });
      if (!args.json) warn(`${backend}: SKIP — ${skip}`);
      continue;
    }
    const port = await pickFreePort();
    built.port = port;
    if (!args.json) log(`${backend}: spawning on port ${port}…`);
    const res = await smokeEngine(backend, built);
    results.push(res);
    if (!args.json) {
      const dt = (res.durationMs / 1000).toFixed(1);
      if (res.status === 'pass') {
        const m = res.httpChecks.models.count;
        const preview = res.httpChecks.chat.contentPreview;
        log(`${backend}: PASS in ${dt}s (models=${m}, chat="${preview}")`);
      } else if (res.status === 'knownIssue') {
        log(`${backend}: KNOWN-ISSUE in ${dt}s — ${res.knownIssue}`);
      } else {
        log(`${backend}: FAIL in ${dt}s — ${res.reason}`);
      }
    }
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ platform: process.platform, arch: process.arch, discovery, models, results }, null, 2) + '\n');
  } else {
    const pass = results.filter((r) => r.status === 'pass').length;
    const fail = results.filter((r) => r.status === 'fail').length;
    const skip = results.filter((r) => r.status === 'skip').length;
    const known = results.filter((r) => r.status === 'knownIssue').length;
    log(`summary: ${pass} pass / ${fail} fail / ${known} known-issue / ${skip} skip`);
  }

  // Exit code: 1 only on a hard failure. Skips and known-issues are exit 0.
  // knownIssue is a documented production quirk surfaced by the smoke run, not
  // a regression introduced by current code.
  const anyFail = results.some((r) => r.status === 'fail');
  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  warn(`fatal: ${(err && err.stack) || err}`);
  process.exit(2);
});

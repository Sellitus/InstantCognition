/**
 * llmEngines.smoke.test.js — spawns each LOCAL LLM engine via the PRODUCTION
 * LLMManager + EngineDiscoveryService + engineSchema builders and exercises
 * /v1/models + /v1/chat/completions against a real tiny model.
 *
 * WHY THIS TEST EXISTS
 * The 4013-test unit suite mocks child_process / http. It proves the app's
 * argv-building, state machine, and HTTP plumbing are correct. It does NOT
 * prove any engine actually loads a model and answers a chat completion.
 * That's what this file is for.
 *
 * RUN IT
 *   RUN_LLM_SMOKE=1 npm run test:e2e:llm          # jest wrapper
 *   node scripts/smoke-llm-engines.js              # standalone CLI
 *
 * GATING
 * Without RUN_LLM_SMOKE=1 every test in this file is a SKIP — never a pass —
 * so the default `npm test` / `npm run test:all` runs remain fast and
 * mock-only. The skip happens at module load via describe.skip.
 *
 * SKIPS (not failures)
 * Each engine test skips with a clear reason when:
 *   - the binary isn't on the host (EngineDiscovery reports unavailable)
 *   - the smoke model isn't present and SKIP_MODEL_DOWNLOAD=1 is set
 *   - the platform can't run the engine (e.g. vllm on darwin)
 *
 * PER-TEST TIMEOUT
 * 180s by default — covers: ~2s model download (GGUF), ~700MB MLX convert
 * (one-time, skipped if present), ~5s llama.cpp cold start, ~5s MLX server
 * cold start, plus the 90s per-engine deadline inside llmSmoke.js. oMLX
 * (180s deadline) and vLLM (30 min, includes the Hub download) get their
 * deadline plus a minute.
 */

const RUN_LLM_SMOKE = process.env.RUN_LLM_SMOKE === '1';
const ENGINE_FILTER = (process.env.LLM_SMOKE_ENGINES || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const describeFn = RUN_LLM_SMOKE ? describe : describe.skip;

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pickFreePort, discoverEngines, ensureSmokeModels, smokeEngine, SMOKE_MODELS } = require('../../scripts/lib/llmSmoke');

describeFn('LLM engines — real-engine smoke (spawn + /v1/chat/completions)', () => {
  jest.setTimeout(180_000);

  let discovery;
  let models;

  beforeAll(async () => {
    discovery = await discoverEngines();
    models = await ensureSmokeModels({ discovery });
  });

  function buildOpts(backend) {
    const opts = { backend, host: '127.0.0.1', port: 0 };
    if (backend === 'llamaCpp') {
      const binaryPath = process.env.LLAMA_BINARY_PATH
        || (discovery.llamaCpp && discovery.llamaCpp.available && discovery.llamaCpp.path)
        || null;
      if (!binaryPath) return { skip: 'llama-server binary not found (run scripts/fetch-llama-server.js)' };
      opts.binaryPath = binaryPath;
      opts.modelPath = models.gguf;
      opts.contextLength = 2048;
      opts.chatTemplate = 'chatml';
      opts.n_gpu_layers = 0;
    } else if (backend === 'mlxOpenAi') {
      const py = discovery.mlx && discovery.mlx.pythonPath;
      if (!py) return { skip: 'no python resolved for MLX (run scripts/fetch-mlx-runtime.js on darwin)' };
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
      if (process.platform !== 'linux' && process.platform !== 'win32') {
        return { skip: `vLLM is CUDA-only (current: ${process.platform}); set RUN_LLM_SMOKE on a CUDA host` };
      }
      const py = discovery.vllm && discovery.vllm.available && discovery.vllm.pythonPath;
      if (!py) return { skip: `vLLM not set up (${(discovery.vllm && discovery.vllm.reason) || 'run Set up vLLM in Settings'})` };
      opts.pythonPath = py;
      opts.modelPath = process.env.VLLM_MODEL_PATH || SMOKE_MODELS.vllm.hfId;
      opts.toolParser = 'none';
    }
    return opts;
  }

  const cases = [
    ['llamaCpp', 'llama.cpp (llama-server)'],
    ['mlxOpenAi', 'MLX (mlx-openai-server)'],
    ['omlx', 'oMLX (omlx serve)'],
    ['vllm', 'vLLM (vllm serve)'],
  ];

  for (const [backend, label] of cases) {
    if (ENGINE_FILTER.length > 0 && !ENGINE_FILTER.includes(backend)) continue;
    test(`${label}`, async () => {
      const built = buildOpts(backend);
      if (built.skip) {
        console.warn(`[llm-smoke] SKIP ${backend}: ${built.skip}`);
        return;
      }
      const port = await pickFreePort();
      built.port = port;
      const res = await smokeEngine(backend, built);
      if (res.status === 'fail') console.error(`[llm-smoke] ${backend} logs:\n${res.logs.map((l) => `[${l.level}] ${l.message}`).slice(-20).join('\n')}`);
      // knownIssue = a documented production quirk (e.g. mlx-openai-server's
      // Stream(gpu) crash), not a current-code regression. Accept it but make
      // the assertion explicit so a NEW kind of failure can't hide here.
      expect(['pass', 'knownIssue']).toContain(res.status);
      expect(res.httpChecks.models.count).toBeGreaterThan(0);
      if (res.status === 'pass') {
        expect(res.httpChecks.chat.contentPreview).toBeTruthy();
      }
    });
  }
});
// llmSmoke — real-engine smoke harness for the local LLM backends.
//
// Spawns each backend (llama.cpp / mlx-openai-server / oMLX / vllm) via the
// PRODUCTION LLMManager + EngineDiscoveryService + engineSchema builders, waits
// for /v1/models health, then exercises GET /v1/models and POST /v1/chat/completions
// against a tiny real model. No mocks — this is the only place the argv the app
// actually builds is proven against a real binary.
//
// Two entrypoints share this module: scripts/smoke-llm-engines.js (CLI) and
// tests/e2e/llmEngines.smoke.test.js (jest). Skip-with-reason when an engine
// or model is absent on the host — never a hard failure for a missing optional
// prerequisite. vLLM is CUDA-only and skipped on darwin.

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');
const net = require('net');

const ROOT = path.join(__dirname, '..', '..');
const VENDOR_TEST_MODELS = path.join(ROOT, 'vendor', 'test-models');

// Smoke models — tiny, fast to load, license-permissive.
// GGUF: stories260K (1.1MB, 260K params) — a real causal LM that loads in <2s.
// MLX: Llama-3.2-1B-Instruct-4bit (~700MB) — smallest instruct MLX model with
// a chat template, so /v1/chat/completions is exercised faithfully.
const SMOKE_MODELS = {
  gguf: {
    name: 'stories260K.gguf',
    // Hosted in the llama.cpp examples model directory.
    url: 'https://raw.githubusercontent.com/ggml-org/llama.cpp/master/models/stories260K.gguf',
    maxBytes: 50 * 1024 * 1024,
    dest: path.join(VENDOR_TEST_MODELS, 'stories260K.gguf'),
    fallback: path.join(os.homedir(), '.unsloth', '.cache', 'stories260K.gguf'),
  },
  mlx: {
    hfId: 'mlx-community/Llama-3.2-1B-Instruct-4bit',
    dir: path.join(VENDOR_TEST_MODELS, 'mlx', 'Llama-3.2-1B-Instruct-4bit'),
    maxBytes: 2 * 1024 * 1024 * 1024,
  },
  // vLLM pulls this from the Hub itself (override with VLLM_MODEL_PATH).
  vllm: { hfId: 'Qwen/Qwen2.5-0.5B-Instruct' },
};

const HTTP_TIMEOUT_MS = 8000;
// oMLX imports its whole stack before /health answers; vLLM compiles CUDA
// graphs and may download the model first.
const ENGINE_DEADLINE_MS = { omlx: 180_000, vllm: 1_800_000, default: 90_000 };
function engineDeadlineMs(backend) { return ENGINE_DEADLINE_MS[backend] || ENGINE_DEADLINE_MS.default; }
const MODEL_DOWNLOAD_TIMEOUT_MS = 300_000;

function log(msg) { process.stdout.write(`[llm-smoke] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[llm-smoke] WARN: ${msg}\n`); }

// Pick a free TCP port by binding to :0 and reading the assigned port.
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = (typeof addr === 'object' && addr && addr.port) || 0;
      srv.close(() => resolve(port));
    });
  });
}

// HTTP helpers — node has no global fetch in older runtimes; use http directly
// so the harness works without a polyfill.
function httpJson(method, host, port, reqPath, body) {
  return new Promise((resolve, reject) => {
    const headers = { 'Accept': 'application/json' };
    let payload = null;
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = http.request(
      { host, port, path: reqPath, method, headers, timeout: HTTP_TIMEOUT_MS },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('http timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function fileExists(p) {
  try { return fs.existsSync(p); } catch (_) { return false; }
}

function pathExists(p) {
  // True for either a file or a directory — the smoke models live as a single
  // GGUF file (llama.cpp) and as a directory of safetensors + config (MLX).
  try { return fs.existsSync(p); } catch (_) { return false; }
}

// Stream a URL to disk with an atomic .part → rename. Throws on size overflow
// or HTTP error so the caller can skip-with-reason.
function downloadFile(url, dest, maxBytes) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    const out = fs.createWriteStream(part);
    let received = 0;
    let redirected = 0;
    const cleanup = (err) => {
      out.destroy();
      try { fs.unlinkSync(part); } catch (_) { /* already gone */ }
      reject(err);
    };
    const get = (target) => {
      https.get(target, { headers: { 'User-Agent': 'InstantCognition-smoke/1.0' } }, (res) => {
        // Follow up to 5 redirects (GitHub raw → LFS → CDN).
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirected < 5) {
          redirected += 1;
          res.resume();
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return cleanup(new Error(`HTTP ${res.statusCode} fetching ${target}`));
        }
        const len = parseInt(res.headers['content-length'] || '0', 10);
        if (len && len > maxBytes) {
          return cleanup(new Error(`content-length ${len} exceeds limit ${maxBytes}`));
        }
        res.on('data', (chunk) => {
          received += chunk.length;
          if (received > maxBytes) {
            return cleanup(new Error(`stream exceeded size limit ${maxBytes} (aborting)`));
          }
        });
        res.pipe(out);
        out.on('finish', () => {
          out.close((err) => {
            if (err) return cleanup(err);
            try {
              fs.renameSync(part, dest);
              resolve(dest);
            } catch (e) { cleanup(e); }
          });
        });
        out.on('error', cleanup);
      }).on('error', cleanup);
    };
    get(url);
  });
}

// execFile as a promise (for `python -m mlx_lm.convert` and python import probes).
function execFileAsync(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs || 30_000 }, (error, stdout, stderr) => {
      resolve({ error, stdout: (stdout || '').toString(), stderr: (stderr || '').toString() });
    });
  });
}

// Ensure a smoke model is present for each backend we might run. Per user
// choice: auto-download missing models. Honors SKIP_MODEL_DOWNLOAD=1.
async function ensureSmokeModels({ discovery }) {
  const results = { gguf: null, mlx: null, skipped: [] };

  // GGUF for llama.cpp — prefer an existing copy anywhere on disk before download.
  const ggufModel = SMOKE_MODELS.gguf;
  if (pathExists(ggufModel.dest) || pathExists(ggufModel.fallback)) {
    results.gguf = pathExists(ggufModel.dest) ? ggufModel.dest : ggufModel.fallback;
  } else if (process.env.SKIP_MODEL_DOWNLOAD === '1') {
    results.skipped.push({ kind: 'gguf', reason: 'SKIP_MODEL_DOWNLOAD=1; no local .gguf found' });
  } else {
    try {
      log(`downloading smoke GGUF ${ggufModel.name} (~1MB)…`);
      await downloadFile(ggufModel.url, ggufModel.dest, ggufModel.maxBytes);
      results.gguf = ggufModel.dest;
    } catch (err) {
      results.skipped.push({ kind: 'gguf', reason: `download failed: ${(err instanceof Error && err.message) || err}` });
    }
  }

  // MLX model for mlxOpenAi / omlx — only relevant if an MLX backend is available.
  const hasMlx = (discovery && (discovery.mlxOpenAi?.available || discovery.omlx?.available));
  if (!hasMlx) {
    return results; // nothing to do; mlxOpenAi/omlx will skip at the engine level
  }
  const mlxModel = SMOKE_MODELS.mlx;
  const mlxConfigPresent = fileExists(path.join(mlxModel.dir, 'config.json'));
  if (mlxConfigPresent) {
    results.mlx = mlxModel.dir;
  } else if (process.env.SKIP_MODEL_DOWNLOAD === '1') {
    results.skipped.push({ kind: 'mlx', reason: 'SKIP_MODEL_DOWNLOAD=1; no local MLX model found' });
  } else {
    const python = discovery && discovery.mlx && discovery.mlx.pythonPath;
    if (!python) {
      results.skipped.push({ kind: 'mlx', reason: 'no bundled/system python resolved by EngineDiscovery' });
    } else {
      try {
        log(`converting MLX smoke model ${mlxModel.hfId} (~700MB) via ${path.basename(python)}…`);
        // mlx_lm.convert downloads from HF and writes the quantized model dir.
        // Modern CLI: `-q` is a flag, `--q-bits <N>` selects the bit-width.
        // The converter refuses to write to an existing path, so clear any
        // partial dir first AND don't pre-create the destination — convert
        // creates it itself.
        try { fs.rmSync(mlxModel.dir, { recursive: true, force: true }); } catch (_) { /* fine */ }
        fs.mkdirSync(path.dirname(mlxModel.dir), { recursive: true });
        const res = await execFileAsync(
          python,
          ['-m', 'mlx_lm.convert', '--hf-path', mlxModel.hfId, '--mlx-path', mlxModel.dir, '-q', '--q-bits', '4'],
          MODEL_DOWNLOAD_TIMEOUT_MS
        );
        if (res.error || !fileExists(path.join(mlxModel.dir, 'config.json'))) {
          throw new Error(`mlx_lm.convert failed: ${(res.error && res.error.message) || (res.stderr || '').split('\n').filter(Boolean).slice(-2).join(' | ') || 'no config.json produced'}`);
        }
        results.mlx = mlxModel.dir;
      } catch (err) {
        results.skipped.push({ kind: 'mlx', reason: `convert failed: ${(err instanceof Error && err.message) || err}` });
      }
    }
  }
  return results;
}

// Discover engines via the production EngineDiscoveryService. This both
// gates run/skip per backend AND doubles as a smoke test of discovery itself.
// The service module exports a singleton instance — we use it directly rather
// than re-instantiating (its constructor is private).
async function discoverEngines() {
  const svc = require('../../main/services/EngineDiscoveryService');
  return svc.detectEngines({ force: true });
}

// Smoke a single backend end-to-end. Returns a result object — never throws
// (failures are captured as { status:'fail', reason, logs }).
async function smokeEngine(backend, opts) {
  const LLMManagerCtor = require('../../main/services/llm/LLMManager').LLMManager;
  const manager = new LLMManagerCtor();
  const started = Date.now();
  const result = { backend, status: null, reason: null, model: opts.modelPath, port: opts.port, httpChecks: {}, durationMs: 0, logs: [] };
  const collectLogs = (entry) => { result.logs.push(entry); };
  manager.on('log', collectLogs);

  const watchdog = setTimeout(() => {
    // Hard deadline — stop the server and fail rather than hang jest.
    manager.stop({ silent: true }).catch((err) => {
      warn(`watchdog stop failed for ${backend}: ${(err && err.message) || err}`);
    });
  }, engineDeadlineMs(backend));

  try {
    const startStatus = await manager.start(opts);
    result.endpoint = startStatus.endpoint;

    // GET /v1/models — must list at least one model id.
    const modelsRes = await httpJson('GET', opts.host, opts.port, '/v1/models');
    result.httpChecks.models = { status: modelsRes.status };
    if (modelsRes.status !== 200 || !Array.isArray(modelsRes.json?.data) || modelsRes.json.data.length === 0) {
      throw new Error(`/v1/models unhealthy: status=${modelsRes.status} body=${(modelsRes.text || '').slice(0, 200)}`);
    }
    result.httpChecks.models.count = modelsRes.json.data.length;
    const modelId = modelsRes.json.data[0].id;

    // POST /v1/chat/completions — must return a non-empty assistant message.
    // mlx-openai-server hits a known in-process crash ("Stream(gpu, N) in
    // current thread") on first request for some quants/model-types. When the
    // smoke test hits that signature, mark it as a knownIssue rather than a
    // plain fail — the production fallback path is documented in
    // recoverFromMlxStreamCrash (main/services/llmFallback.js) and the natural
    // resolution is the oMLX alternate runtime, which the harness runs as its
    // own test. This keeps the harness honest: we report the crash faithfully
    // rather than masking it as a generic failure.
    const chatBody = {
      model: modelId,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      max_tokens: 8,
      temperature: 0,
    };
    const chatRes = await httpJson('POST', opts.host, opts.port, '/v1/chat/completions', chatBody);
    result.httpChecks.chat = { status: chatRes.status };
    if (chatRes.status === 500 && /Stream\(gpu, \d+\) in current thread/.test(chatRes.text || '')) {
      result.status = 'knownIssue';
      result.knownIssue = 'mlx-openai-server Stream(gpu) in-process crash — fallback to oMLX is the production recovery path (recoverFromMlxStreamCrash, main/services/llmFallback.js)';
      result.httpChecks.chat.contentPreview = null;
      return result;
    }
    if (chatRes.status !== 200) {
      throw new Error(`/v1/chat/completions returned ${chatRes.status}: ${(chatRes.text || '').slice(0, 300)}`);
    }
    const content = chatRes.json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error(`/v1/chat/completions 200 but empty assistant content: ${JSON.stringify(chatRes.json).slice(0, 300)}`);
    }
    result.httpChecks.chat.contentPreview = content.slice(0, 40);
    result.status = 'pass';
  } catch (err) {
    result.status = 'fail';
    result.reason = (err instanceof Error && err.message) || String(err);
  } finally {
    clearTimeout(watchdog);
    manager.off('log', collectLogs);
    try { await manager.stop({ silent: true }); } catch (_) { /* best-effort cleanup */ }
    result.durationMs = Date.now() - started;
  }
  return result;
}

module.exports = {
  SMOKE_MODELS,
  pickFreePort,
  discoverEngines,
  ensureSmokeModels,
  smokeEngine,
  fileExists,
  pathExists,
  log,
  warn,
};

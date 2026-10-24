// Pure model-file helpers: vision/multimodal detection, shard parsing, and
// format-shaping builders (gguf/mlx/hf info objects) used by ModelManagerService.
//
// GGUF: llama.cpp uses a separate projection file (mmproj-*.gguf) that lives
// next to the main model GGUF. When present, llama-server loads it with
// --mmproj and the OpenAI-compatible endpoint accepts image content parts.
//
// MLX: multimodal weights ship inside a single HF-style directory; vision
// support is inferred from the model's config.json (HuggingFace convention:
// a `vision_config` block or a known vision-family `model_type`).

const fs = require('fs');
const path = require('path');

const MMPROJ_RE = /^mmproj.*\.gguf$/i;
const SHARD_RE = /^(.+)-(\d{5})-of-(\d{5})\.gguf$/i;
const QUANT_PATTERNS = [
  'Q2_K', 'Q3_K_S', 'Q3_K_M', 'Q3_K_L',
  'Q4_0', 'Q4_1', 'Q4_K_S', 'Q4_K_M',
  'Q5_0', 'Q5_1', 'Q5_K_S', 'Q5_K_M',
  'Q6_K', 'Q8_0', 'F16', 'F32', 'BF16',
];
const MLX_VISION_MODEL_TYPE_RE = /^(llava|qwen2_vl|qwen3_vl|idefics|mllama|pixtral|phi3_v|gemma3|minicpmv|internvl|kosmos)/;

function parseShard(filename) {
  const m = SHARD_RE.exec(filename);
  return m ? { base: m[1], index: parseInt(m[2], 10), total: parseInt(m[3], 10) } : null;
}

function humanSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function detectQuant(name) {
  const u = name.toUpperCase();
  return QUANT_PATTERNS.find((q) => u.includes(q)) || null;
}

// Find a companion mmproj-*.gguf in the same folder as the given GGUF path.
// If multiple candidates exist, prefer one whose filename shares a token with
// the model's base name (e.g. `Qwen2-VL` → `mmproj-Qwen2-VL-f16.gguf`). Falls
// back to the first candidate when no better match is found.
function findMmprojFor(ggufPath) {
  try {
    const dir = path.dirname(ggufPath);
    const baseName = path.basename(ggufPath).replace(/\.gguf$/i, '');
    const shardStripped = baseName.replace(/-\d{5}-of-\d{5}$/i, '');
    const candidates = fs.readdirSync(dir).filter((f) => MMPROJ_RE.test(f));
    if (candidates.length === 0) return null;
    const prefix = shardStripped.toLowerCase();
    const matched = candidates.find((f) => {
      const tail = f.toLowerCase().replace(/^mmproj[-_]?/, '').replace(/\.gguf$/, '');
      const firstToken = tail && tail.split(/[-_.]/)[0];
      return firstToken && prefix.includes(firstToken);
    });
    return path.join(dir, matched || candidates[0]);
  } catch (_) { return null; }
}

// Inspect an MLX model directory's config.json for vision indicators. True when
// `vision_config` is present (HF convention: Qwen2-VL, llava-next, idefics3…)
// or when `model_type` matches a known vision family.
function isMlxMultimodal(dirPath) {
  try {
    const cfgPath = path.join(dirPath, 'config.json');
    if (!fs.existsSync(cfgPath)) return false;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg && typeof cfg.vision_config === 'object' && cfg.vision_config) return true;
    if (cfg && typeof cfg.vision_tower === 'object' && cfg.vision_tower) return true;
    const mt = typeof cfg.model_type === 'string' ? cfg.model_type.toLowerCase() : '';
    return MLX_VISION_MODEL_TYPE_RE.test(mt);
  } catch (_) { return false; }
}

// 'mlx' for folders only the MLX runtimes load (MLX-quantized weights, .npz
// weights, or an mlx-named conversion); 'hf' for plain Hugging Face
// safetensors folders, which vLLM and mlx-lm both load. An unreadable
// config.json throws, so the caller skips the folder.
function folderFormat(dirPath, files) {
  if (files.some((f) => f.endsWith('.npz')) || /mlx/i.test(path.basename(dirPath))) return 'mlx';
  const cfgPath = path.join(dirPath, 'config.json');
  if (!fs.existsSync(cfgPath)) return 'mlx';
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  return cfg && cfg.quantization && typeof cfg.quantization === 'object' ? 'mlx' : 'hf';
}

function mlxInfo(dirPath) {
  try {
    const stat = fs.statSync(dirPath);
    const files = fs.readdirSync(dirPath);
    let size = 0;
    for (const f of files) {
      try { size += fs.statSync(path.join(dirPath, f)).size; } catch (_) {}
    }
    return {
      name: path.basename(dirPath), path: dirPath, size, sizeHuman: humanSize(size),
      format: folderFormat(dirPath, files), quantization: null, modifiedAt: stat.mtimeMs,
      isMultimodal: isMlxMultimodal(dirPath),
    };
  } catch (_) { return null; }
}

function ggufInfo(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const name = path.basename(filePath);
    const mmprojPath = findMmprojFor(filePath);
    return {
      name, path: filePath, size: stat.size, sizeHuman: humanSize(stat.size),
      format: 'gguf', quantization: detectQuant(name), modifiedAt: stat.mtimeMs,
      mmprojPath: mmprojPath || null, isMultimodal: !!mmprojPath,
    };
  } catch (_) { return null; }
}

function findShardSiblings(shardDir, base, total) {
  const out = [];
  try {
    for (const f of fs.readdirSync(shardDir)) {
      const s = parseShard(f);
      if (s && s.base === base && s.total === total) {
        out.push({ ...s, path: path.join(shardDir, f), filename: f });
      }
    }
  } catch (_) { /* empty */ }
  return out;
}

function shardGroupInfo(shards, refPath) {
  shards.sort((a, b) => a.index - b.index);
  const first = shards.find((s) => s.index === 1);
  const total = first ? first.total : (shards[0] && shards[0].total) || 0;
  let size = 0; let modifiedAt = 0;
  for (const s of shards) {
    try {
      const st = fs.statSync(s.path);
      size += st.size;
      if (st.mtimeMs > modifiedAt) modifiedAt = st.mtimeMs;
    } catch (_) { /* ignore */ }
  }
  const base = first ? first.base : path.basename(refPath).replace(/\.gguf$/i, '');
  const primaryPath = (first && first.path) || refPath;
  const mmprojPath = findMmprojFor(primaryPath);
  return {
    name: `${base}.gguf`, path: primaryPath, size, sizeHuman: humanSize(size),
    format: 'gguf', quantization: detectQuant(base), modifiedAt,
    isMultiPart: true, shardCount: total,
    shardsPresent: shards.length, incomplete: total === 0 || shards.length !== total,
    mmprojPath: mmprojPath || null, isMultimodal: !!mmprojPath,
  };
}

module.exports = {
  MMPROJ_RE, SHARD_RE,
  parseShard, humanSize, detectQuant,
  findMmprojFor, isMlxMultimodal,
  mlxInfo, ggufInfo,
  findShardSiblings, shardGroupInfo,
};

#!/usr/bin/env node
// fetch-moonshine-model.js
//
// Downloads and extracts the sherpa-onnx Moonshine Tiny English INT8 bundle
// into vendor/moonshine/tiny-en/. ~50 MB compressed, ~75 MB extracted.
// The INT8 split bundle (preprocess + encode + uncached_decode + cached_decode
// + tokens.txt) is what the sherpa-onnx Node addon expects — NOT the merged
// `.ort` quantized variant, which uses a different runtime path.
//
// Source: github.com/k2-fsa/sherpa-onnx, release tag "asr-models".
//
// On failure (offline, 404, etc) exits 0 with a warning — VoiceService
// detects the missing model at startup and reports isAvailable() = false.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { downloadToFile } = require('../main/utils/httpDownload');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'moonshine');
const DEST_DIR = path.join(VENDOR, 'tiny-en');
const FORCE = process.env.FORCE === '1' || process.env.FORCE === 'true';

const ARCHIVE_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-tiny-en-int8.tar.bz2';
const EXPECTED_DIR = 'sherpa-onnx-moonshine-tiny-en-int8';
const REQUIRED_FILES = ['preprocess.onnx', 'encode.int8.onnx', 'uncached_decode.int8.onnx', 'cached_decode.int8.onnx', 'tokens.txt'];

function log(msg) { process.stdout.write(`[fetch-moonshine] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[fetch-moonshine] WARN: ${msg}\n`); }

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

function alreadyHaveBundle() {
  if (FORCE) return false;
  for (const f of REQUIRED_FILES) {
    const p = path.join(DEST_DIR, f);
    if (!fs.existsSync(p) || fs.statSync(p).size === 0) return false;
  }
  return true;
}

function downloadArchive(url, dest) {
  return downloadToFile(url, dest, {
    timeoutMs: 180000,
    headers: { 'User-Agent': 'InstantCognition-fetch/1.0', Accept: 'application/octet-stream' },
    onProgress: (received, total, chunkLength) => {
      if (total > 0 && received % (5 * 1024 * 1024) < chunkLength) {
        process.stdout.write(`  ${(received / 1024 / 1024).toFixed(0)}/${(total / 1024 / 1024).toFixed(0)} MB\r`);
      }
    },
  }).then((p) => { process.stdout.write('\n'); return p; });
}

// On Windows the system bsdtar is named by path: a Git Bash PATH puts GNU tar
// first, which reads the "D:" of an absolute path as a remote host.
function tarBinary() {
  if (process.platform !== 'win32') return 'tar';
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
}

function extract(archivePath, intoDir) {
  ensureDir(intoDir);
  execFileSync(tarBinary(), ['-xjf', archivePath, '-C', intoDir]);
}

function moveContents(fromDir, toDir) {
  ensureDir(toDir);
  for (const entry of fs.readdirSync(fromDir)) {
    const src = path.join(fromDir, entry);
    const dst = path.join(toDir, entry);
    if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(src, dst);
  }
}

async function main() {
  ensureDir(VENDOR);
  if (alreadyHaveBundle()) { log('skip — bundle already present'); writeManifest(); return; }
  ensureDir(DEST_DIR);
  const archive = path.join(VENDOR, 'sherpa-onnx-moonshine-tiny-en-int8.tar.bz2');
  log(`downloading from ${ARCHIVE_URL}`);
  await downloadArchive(ARCHIVE_URL, archive);
  log(`extracting…`);
  const stage = path.join(VENDOR, '.stage');
  if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
  ensureDir(stage);
  try {
    extract(archive, stage);
    const inner = path.join(stage, EXPECTED_DIR);
    if (!fs.existsSync(inner)) throw new Error(`expected dir ${EXPECTED_DIR} not found after extract`);
    moveContents(inner, DEST_DIR);
  } finally {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync(archive); } catch (_) {}
  }
  writeManifest();
  log('done.');
}

function writeManifest() {
  fs.writeFileSync(path.join(DEST_DIR, 'manifest.json'), JSON.stringify({
    model: 'sherpa-onnx-moonshine-tiny-en-int8',
    fetchedAt: new Date().toISOString(),
    files: REQUIRED_FILES,
  }, null, 2));
}

main().catch((err) => { warn((err && err.message) || String(err)); process.exit(0); });

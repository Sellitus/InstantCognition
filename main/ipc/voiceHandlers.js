// Voice IPC: drives the renderer's mic button + capture overlay. Audio is
// captured renderer-side via Web Audio API (single permission prompt), then
// shipped here as an ArrayBuffer of PCM16 for transcription via VoiceService.
const { ipcMain } = require('electron');

function register(_mainWindow, services) {
  const { voiceService } = services || {};
  if (!voiceService) return;

  // One in-flight transcription at a time (the UI has a single capture overlay).
  // voice:cancel aborts it so a cancelled cold-model-load / decode stops instead
  // of running to completion after the user dismissed the overlay.
  let active = null;

  ipcMain.handle('voice:available', () => ({
    ok: true,
    enabled: voiceService.isEnabled(),
    available: voiceService.isAvailable(),
    reason: voiceService.unavailableReason(),
    providers: voiceService.listProviders(),
  }));

  ipcMain.handle('voice:transcribe', async (_e, payload = {}) => {
    const audio = payload && payload.audio;
    if (!audio || !(audio instanceof ArrayBuffer)) return { ok: false, error: 'no_audio' };
    const controller = new AbortController();
    active = controller;
    try {
      const buf = Buffer.from(new Uint8Array(audio));
      const sampleRate = Number(payload.sampleRate) || 16000;
      return await voiceService.transcribe(buf, { sampleRate, signal: controller.signal });
    } catch (err) { return { ok: false, error: (err instanceof Error && err.message) || 'transcribe_failed' }; }
    finally { if (active === controller) active = null; }
  });

  ipcMain.on('voice:cancel', () => { if (active) active.abort(); });
}

module.exports = { register };

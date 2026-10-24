// ScreenshotService — captures a webContents (typically a Space's webview)
// and returns either a NativeImage, a PNG buffer, or a base64 data URL
// suitable for vision LLM input.
//
// Resolution limits keep payloads reasonable for context windows.

const sessionService = require('./SessionService');

const DEFAULT_MAX_DIM = 1280;

class ScreenshotService {
  constructor() {
    this._webContentsModule = null;
    this._configService = null;
  }

  // Test injection — pass a stand-in for electron.webContents
  _setWebContentsModule(mod) { this._webContentsModule = mod; }

  bindConfig(cs) { this._configService = cs; }

  _maxDim() {
    if (!this._configService || typeof this._configService.get !== 'function') return DEFAULT_MAX_DIM;
    const v = this._configService.get('settings.screenshotMaxDim', DEFAULT_MAX_DIM);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_MAX_DIM;
  }

  _resolveWebContentsModule() {
    if (this._webContentsModule) return this._webContentsModule;
    try {
      // Lazy require so the file can be loaded in tests without electron
      return require('electron').webContents;
    } catch (_) { return null; }
  }

  _getById(id) {
    const mod = this._resolveWebContentsModule();
    if (!mod || typeof mod.fromId !== 'function') return null;
    return mod.fromId(id);
  }

  async captureById(webContentsId, options = {}) {
    const wc = this._getById(webContentsId);
    if (!wc) throw new Error(`webContents not found: ${webContentsId}`);
    return this.capture(wc, options);
  }

  async capture(webContents, options = {}) {
    if (!webContents || typeof webContents.capturePage !== 'function') {
      throw new Error('webContents.capturePage unavailable');
    }
    if (sessionService.isPrivateContents(webContents)) throw new Error('Private tabs are never captured');
    const rect = options.rect; // optional clipping rect
    const image = rect ? await webContents.capturePage(rect) : await webContents.capturePage();
    if (!image) throw new Error('capturePage returned null');
    return this._postProcess(image, options);
  }

  _postProcess(image, options) {
    const maxDim = options.maxDim || this._maxDim();
    let out = image;
    try {
      if (typeof image.getSize === 'function' && typeof image.resize === 'function') {
        const size = image.getSize();
        const longest = Math.max(size.width || 0, size.height || 0);
        if (longest > maxDim) {
          const scale = maxDim / longest;
          out = image.resize({ width: Math.round((size.width || 0) * scale), height: Math.round((size.height || 0) * scale) });
        }
      }
    } catch (_) { /* ignore resize failure, fall through */ }

    const wantsBuffer = options.format === 'buffer';
    const wantsDataUrl = options.format === 'dataUrl' || !options.format;
    if (wantsBuffer) {
      return typeof out.toPNG === 'function' ? out.toPNG() : null;
    }
    if (wantsDataUrl && typeof out.toDataURL === 'function') {
      return out.toDataURL();
    }
    return out;
  }
}

module.exports = new ScreenshotService();

// ScreenshotService tests — inject a fake webContents.fromId.

const svc = require('../../../../main/services/ScreenshotService');

function makeImage({ width = 1600, height = 1200 } = {}) {
  return {
    getSize: () => ({ width, height }),
    resize: jest.fn((opts) => makeImage({ width: opts.width, height: opts.height })),
    toDataURL: jest.fn(() => `data:image/png;base64,FAKE${width}x${height}`),
    toPNG: jest.fn(() => Buffer.from(`png${width}x${height}`)),
  };
}

function makeWebContents(image) {
  return {
    capturePage: jest.fn(async () => image),
  };
}

describe('ScreenshotService', () => {
  test('captureById throws when webContents not found', async () => {
    svc._setWebContentsModule({ fromId: () => null });
    await expect(svc.captureById(42)).rejects.toThrow(/not found/);
  });

  test('capture returns dataURL by default', async () => {
    const img = makeImage({ width: 800, height: 600 });
    const wc = makeWebContents(img);
    const out = await svc.capture(wc);
    expect(typeof out).toBe('string');
    expect(out.startsWith('data:image/png;base64')).toBe(true);
  });

  test('capture downscales when longest dim exceeds maxDim', async () => {
    const img = makeImage({ width: 3200, height: 1600 });
    const wc = makeWebContents(img);
    await svc.capture(wc, { maxDim: 1280 });
    expect(img.resize).toHaveBeenCalled();
    const call = img.resize.mock.calls[0][0];
    expect(call.width).toBe(1280);
    expect(call.height).toBe(640);
  });

  test('capture with format=buffer returns PNG buffer', async () => {
    const img = makeImage({ width: 100, height: 100 });
    const wc = makeWebContents(img);
    const out = await svc.capture(wc, { format: 'buffer' });
    expect(Buffer.isBuffer(out)).toBe(true);
  });

  test('never captures a page in the private session', async () => {
    const sessionService = require('../../../../main/services/SessionService');
    const privateSession = { name: 'private' };
    sessionService._setSessionModule({ fromPartition: () => privateSession });
    sessionService.initialize({});
    const wc = { ...makeWebContents(makeImage()), session: privateSession };
    await expect(svc.capture(wc)).rejects.toThrow('Private tabs are never captured');
    svc._setWebContentsModule({ fromId: () => wc });
    await expect(svc.captureById(7)).rejects.toThrow('Private tabs are never captured');
    expect(wc.capturePage).not.toHaveBeenCalled();
    const publicWc = { ...makeWebContents(makeImage({ width: 10, height: 10 })), session: { name: 'default' } };
    await expect(svc.capture(publicWc)).resolves.toMatch(/^data:image\/png/);
  });

  test('captureById uses webContents.fromId', async () => {
    const img = makeImage({ width: 100, height: 100 });
    const wc = makeWebContents(img);
    svc._setWebContentsModule({ fromId: jest.fn(() => wc) });
    const out = await svc.captureById(7);
    expect(typeof out).toBe('string');
    expect(wc.capturePage).toHaveBeenCalled();
  });
});

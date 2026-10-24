// artifactFrameHandlers — wires the ic-artifact: scheme onto the shell's
// session and exposes stage/release to the renderer.

jest.mock('electron', () => {
  const handlers = {};
  return {
    ipcMain: { handle: jest.fn((channel, handler) => { handlers[channel] = handler; }), _handlers: handlers },
    session: { defaultSession: { protocol: { handle: jest.fn() } } },
  };
});

const { ipcMain, session } = require('electron');
const { register } = require('../../../../main/ipc/artifactFrameHandlers');

test('stage returns a URL the default session then serves; release withdraws it', async () => {
  register();
  expect(session.defaultSession.protocol.handle).toHaveBeenCalledWith('ic-artifact', expect.any(Function));
  const serve = session.defaultSession.protocol.handle.mock.calls[0][1];
  const url = await ipcMain._handlers['artifact-frame:stage']({}, '<p>doc</p>');
  expect(await serve({ url }).text()).toBe('<p>doc</p>');
  await ipcMain._handlers['artifact-frame:release']({}, url);
  expect(serve({ url }).status).toBe(404);
});

test('a bad document is rejected back to the renderer', () => {
  register();
  expect(() => ipcMain._handlers['artifact-frame:stage']({}, 42)).toThrow(TypeError);
});

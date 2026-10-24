// routineHandlers wires the renderer outcome report + manual run trigger to
// RoutineService. ipcMain is the external boundary (mocked); the captured
// handlers are invoked to assert they delegate correctly.

const handlers = {};
const invokeHandlers = {};

jest.mock('electron', () => ({
  ipcMain: {
    on: jest.fn((ch, fn) => { handlers[ch] = fn; }),
    handle: jest.fn((ch, fn) => { invokeHandlers[ch] = fn; }),
  },
}));

const routineHandlers = require('../../../../main/ipc/routineHandlers');

describe('routineHandlers.register', () => {
  beforeEach(() => {
    Object.keys(handlers).forEach((k) => delete handlers[k]);
    Object.keys(invokeHandlers).forEach((k) => delete invokeHandlers[k]);
  });

  test('no-op without a routineService', () => {
    expect(() => routineHandlers.register({}, {})).not.toThrow();
    expect(handlers['routine:ran']).toBeUndefined();
  });

  test("'routine:ran' forwards the renderer outcome to noteRan", () => {
    const routineService = { noteRan: jest.fn(), runNow: jest.fn() };
    routineHandlers.register({}, { routineService });
    handlers['routine:ran']({}, { id: 'r1', ok: true });
    expect(routineService.noteRan).toHaveBeenCalledWith({ id: 'r1', ok: true });
  });

  test("'routine:run-now' delegates to runNow and returns its result", async () => {
    const routineService = { noteRan: jest.fn(), runNow: jest.fn(() => ({ ok: true })) };
    routineHandlers.register({}, { routineService });
    const res = await invokeHandlers['routine:run-now']({}, { id: 'r1' });
    expect(routineService.runNow).toHaveBeenCalledWith('r1');
    expect(res).toEqual({ ok: true });
  });

  test("'routine:run-now' converts a thrown error into a failure result", async () => {
    const routineService = { noteRan: jest.fn(), runNow: jest.fn(() => { throw new Error('boom'); }) };
    routineHandlers.register({}, { routineService });
    const res = await invokeHandlers['routine:run-now']({}, { id: 'r1' });
    expect(res).toEqual({ ok: false, error: 'boom' });
  });
});

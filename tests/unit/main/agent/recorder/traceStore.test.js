// traceStore against a real temp directory.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TraceStore, isTraceId } = require('../../../../../main/agent/recorder/traceStore');

const trace = (id, startedAt, events = [{ t: 0, type: 'navigate', url: 'https://a.example/' }]) => ({
  version: 1, id, startedAt, endedAt: startedAt + 5, startUrl: 'https://a.example/', title: 'A', truncated: false, events,
});

describe('TraceStore', () => {
  let dir;
  let store;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-traces-'));
    store = new TraceStore({ baseDir: path.join(dir, 'recordings') });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('save, get, list newest first, delete', () => {
    expect(store.save(trace('rec_aaaaaa11', 100))).toMatchObject({ id: 'rec_aaaaaa11', eventCount: 1 });
    store.save(trace('rec_bbbbbb22', 200));
    expect(store.get('rec_aaaaaa11').events).toHaveLength(1);
    expect(store.list().recordings.map((r) => r.id)).toEqual(['rec_bbbbbb22', 'rec_aaaaaa11']);
    store.delete('rec_aaaaaa11');
    expect(() => store.get('rec_aaaaaa11')).toThrow('not_found');
    expect(fs.readdirSync(path.join(dir, 'recordings'))).toEqual(['rec_bbbbbb22.json']);
  });

  test.each(['../etc/passwd', 'rec_', 'rec_ABCDEF12', 'rec_aaaaaa11/../x', 42, null])('invalid id %p is refused before touching disk', (id) => {
    expect(isTraceId(id)).toBe(false);
    expect(() => store.get(id)).toThrow('invalid_id');
    expect(() => store.delete(id)).toThrow('invalid_id');
    expect(() => store.save(trace(id, 1))).toThrow('invalid_id');
  });

  test('a corrupt file is reported in errors, not dropped silently', () => {
    store.save(trace('rec_good0001', 1));
    fs.writeFileSync(path.join(dir, 'recordings', 'rec_bad00001.json'), '{not json');
    const { recordings, errors } = store.list();
    expect(recordings.map((r) => r.id)).toEqual(['rec_good0001']);
    expect(errors).toEqual([expect.objectContaining({ id: 'rec_bad00001' })]);
  });

  test('a file whose id does not match its name is corrupt', () => {
    fs.mkdirSync(path.join(dir, 'recordings'));
    fs.writeFileSync(path.join(dir, 'recordings', 'rec_swap0001.json'), JSON.stringify(trace('rec_other001', 1)));
    expect(() => store.get('rec_swap0001')).toThrow('corrupt_trace');
  });

  test('rejects malformed and oversized traces; list of a missing dir is empty', () => {
    expect(store.list()).toEqual({ recordings: [], errors: [] });
    expect(() => store.save({ id: 'rec_aaaaaa11' })).toThrow('invalid_trace');
    const huge = trace('rec_huge0001', 1, [{ t: 0, type: 'input', value: 'x'.repeat(1024 * 1024) }]);
    expect(() => store.save(huge)).toThrow('trace_too_large');
    expect(() => new TraceStore({})).toThrow(TypeError);
  });
});

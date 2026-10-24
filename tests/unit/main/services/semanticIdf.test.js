const { buildDfMap, idf } = require('../../../../main/services/semanticIdf');

describe('semanticIdf', () => {
  describe('buildDfMap', () => {
    test('counts how many documents contain each term at least once', () => {
      const docs = [
        new Set(['apple', 'banana']),
        new Set(['apple', 'cherry']),
        new Set(['apple']),
      ];
      const df = buildDfMap(docs);
      expect(df.get('apple')).toBe(3);
      expect(df.get('banana')).toBe(1);
      expect(df.get('cherry')).toBe(1);
    });

    test('a term repeated within one document is still counted once (Set semantics)', () => {
      const df = buildDfMap([new Set(['x', 'x', 'x'])]);
      expect(df.get('x')).toBe(1);
    });

    test('empty document list yields an empty map', () => {
      expect(buildDfMap([]).size).toBe(0);
    });

    test('documents with no terms contribute nothing', () => {
      const df = buildDfMap([new Set(), new Set(['a']), new Set()]);
      expect(df.get('a')).toBe(1);
      expect(df.size).toBe(1);
    });
  });

  describe('idf', () => {
    test('smoothed idf = log(1 + N/df) for a term in some docs', () => {
      const df = new Map([['rare', 1]]);
      // N=4 docs, df=1 → log(1 + 4/1)
      expect(idf('rare', df, 4)).toBeCloseTo(Math.log(1 + 4 / 1));
    });

    test('a term present in every doc still has a non-zero signal (smoothed)', () => {
      const df = new Map([['common', 3]]);
      expect(idf('common', df, 3)).toBeCloseTo(Math.log(1 + 3 / 3));
      expect(idf('common', df, 3)).toBeGreaterThan(0);
    });

    test('returns 1 when the term is absent from the corpus', () => {
      const df = new Map([['a', 1]]);
      expect(idf('missing', df, 5)).toBe(1);
    });

    test('returns 1 when docCount <= 1 (degenerate corpus)', () => {
      const df = new Map([['a', 1]]);
      expect(idf('a', df, 1)).toBe(1);
      expect(idf('a', df, 0)).toBe(1);
    });

    test('rarer terms score higher than common terms', () => {
      const df = new Map([['rare', 1], ['common', 10]]);
      const N = 10;
      expect(idf('rare', df, N)).toBeGreaterThan(idf('common', df, N));
    });
  });
});

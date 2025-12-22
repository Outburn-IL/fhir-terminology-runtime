import { describe, it, expect, vi } from 'vitest';

import {
  defaultPrethrow,
  customPrethrower,
  toSystemCodeMapFromContains,
  mergeSystemMaps,
  subtractSystemMaps,
  buildExpansionFromSystemMap,
  ImplicitCodeSystemRegistry
} from '../src/utils';

describe('utils/logger (unit)', () => {
  it('defaultPrethrow returns same Error instance', () => {
    const err = new Error('x');
    expect(defaultPrethrow(err)).toBe(err);
  });

  it('defaultPrethrow wraps non-Error into Error', () => {
    const err = defaultPrethrow('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('boom');
  });

  it('customPrethrower logs and returns Error', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const prethrow = customPrethrower(logger);

    const original = new Error('original');
    const e1 = prethrow(original);
    expect(e1).toBe(original);
    expect(logger.error).toHaveBeenCalledTimes(1);

    const e2 = prethrow('msg');
    expect(e2).toBeInstanceOf(Error);
    expect((e2 as Error).message).toBe('msg');
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});

describe('utils/terminology/systemMapHelpers (unit)', () => {
  it('toSystemCodeMapFromContains is defensive and builds map', () => {
    expect(toSystemCodeMapFromContains(undefined).size).toBe(0);
    expect(toSystemCodeMapFromContains(null as any).size).toBe(0);

    const map = toSystemCodeMapFromContains([
      null,
      1,
      { system: 's1' },
      { code: 'c1' },
      { system: 's1', code: 'c1', display: 'd1' },
      { system: 's1', code: 'c1', display: 'd1-ignored' }, // should not overwrite
      { system: 's1', code: 'c2' },
      { system: 's2', code: 'c1', display: undefined }
    ]);

    expect(map.get('s1')?.get('c1')).toBe('d1');
    expect(map.get('s1')?.get('c2')).toBeUndefined();
    expect(map.get('s2')?.get('c1')).toBeUndefined();
  });

  it('mergeSystemMaps merges without overwriting', () => {
    const a = new Map<string, Map<string, string | undefined>>([
      ['s1', new Map([['c1', 'd1']])]
    ]);
    const b = new Map<string, Map<string, string | undefined>>([
      ['s1', new Map([['c1', 'd1-new'], ['c2', 'd2']])],
      ['s2', new Map([['x', 'y']])]
    ]);

    mergeSystemMaps(a, b);

    expect(a.get('s1')?.get('c1')).toBe('d1');
    expect(a.get('s1')?.get('c2')).toBe('d2');
    expect(a.get('s2')?.get('x')).toBe('y');
  });

  it('subtractSystemMaps removes excluded codes', () => {
    const target = new Map<string, Map<string, string | undefined>>([
      ['s1', new Map([['c1', 'd1'], ['c2', 'd2']])],
      ['s2', new Map([['x', 'y']])]
    ]);
    const exclude = new Map<string, Map<string, string | undefined>>([
      ['s1', new Map([['c2', undefined], ['nope', undefined]])],
      ['missing-system', new Map([['z', undefined]])]
    ]);

    subtractSystemMaps(target, exclude);

    expect(target.get('s1')?.has('c1')).toBe(true);
    expect(target.get('s1')?.has('c2')).toBe(false);
    expect(target.get('s2')?.has('x')).toBe(true);
  });

  it('buildExpansionFromSystemMap emits contains with optional display', () => {
    const map = new Map<string, Map<string, string | undefined>>([
      ['s1', new Map([['c1', 'd1'], ['c2', undefined]])]
    ]);

    const { contains, total } = buildExpansionFromSystemMap(map);
    expect(total).toBe(2);
    expect(contains).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ system: 's1', code: 'c1', display: 'd1' }),
        expect.objectContaining({ system: 's1', code: 'c2' })
      ])
    );

    const c2 = contains.find((c) => c.code === 'c2');
    expect(c2).toBeTruthy();
    expect('display' in (c2 as any)).toBe(false);
  });
});

describe('utils/terminology/implicitCodeSystems (unit)', () => {
  it('provides supported systems and concepts', () => {
    const systems = ImplicitCodeSystemRegistry.getSupportedSystems();
    expect(systems).toEqual(expect.arrayContaining(['urn:iso:std:iso:3166', 'urn:ietf:bcp:47']));

    expect(ImplicitCodeSystemRegistry.isImplicitCodeSystem('urn:iso:std:iso:3166')).toBe(true);
    expect(ImplicitCodeSystemRegistry.isImplicitCodeSystem('urn:ietf:bcp:47')).toBe(true);
    expect(ImplicitCodeSystemRegistry.isImplicitCodeSystem('http://nope')).toBe(false);

    const iso = ImplicitCodeSystemRegistry.getConcepts('urn:iso:std:iso:3166');
    expect(iso).toBeInstanceOf(Map);
    expect(iso?.get('US')).toBeDefined();

    const bcp = ImplicitCodeSystemRegistry.getConcepts('urn:ietf:bcp:47');
    expect(bcp?.get('en')).toBe('English');
    expect(bcp?.get('en-US')).toBe('English (United States)');
    // underscore compatibility variant
    expect(bcp?.get('en_US')).toBe('English (United States)');
  });
});

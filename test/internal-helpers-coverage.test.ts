import { describe, it, expect, vi } from 'vitest';
import { FhirTerminologyRuntime } from '../src/index';

describe('internal helpers (coverage)', () => {
  const pkg = { id: 'test.pkg', version: '1.0.0' };

  function makeFtr(resolveMetaImpl: any) {
    const fpeStub: any = {
      getCachePath: () => './test/.test-cache',
      getContextPackages: () => [pkg],
      async lookupMeta() {
        return [];
      },
      resolveMeta: resolveMetaImpl,
      async resolve() {
        return undefined;
      }
    };

    return FhirTerminologyRuntime.create({ fpe: fpeStub, cacheMode: 'none', fhirVersion: '4.0.1' });
  }

  it('stableStringify handles primitives, arrays, undefined, and circular objects', async () => {
    const ftr = await makeFtr(async () => ({ ok: true }));

    const stableStringify: any = (ftr as any).stableStringify;

    expect(stableStringify(1)).toBe('1');
    expect(stableStringify('x')).toBe('"x"');
    expect(stableStringify([3, { b: 2, a: 1 }])).toBe('[3,{"a":1,"b":2}]');

    // undefined properties are omitted
    expect(stableStringify({ b: undefined, a: 1 })).toBe('{"a":1}');

    const obj: any = { a: 1 };
    obj.self = obj;
    expect(stableStringify(obj)).toContain('[Circular]');
  });

  it('resolveMetaCached caches successes and does not cache failures', async () => {
    const resolveMeta = vi
      .fn()
      .mockResolvedValueOnce({ ok: 1 })
      .mockRejectedValueOnce(new Error('nope'))
      .mockRejectedValueOnce(new Error('nope'));

    const ftr = await makeFtr(resolveMeta);
    const resolveMetaCached: any = (ftr as any).resolveMetaCached.bind(ftr);

    // success cached
    const q1 = { resourceType: 'ValueSet', id: 'x', package: { id: pkg.id, version: pkg.version }, extra: undefined };
    await resolveMetaCached(q1);
    await resolveMetaCached(q1);

    // failure not cached: called twice for same key
    const q2 = { resourceType: 'ValueSet', id: 'y', package: { id: pkg.id, version: pkg.version } };
    await expect(resolveMetaCached(q2)).rejects.toThrow('nope');
    await expect(resolveMetaCached(q2)).rejects.toThrow('nope');

    // resolveMeta call count: 1 for q1, 2 for q2
    expect(resolveMeta).toHaveBeenCalledTimes(3);
  });

  it('LruCache refreshes recency and evicts oldest', async () => {
    const ftr = await makeFtr(async () => ({ ok: true }));

    // Grab the class via an existing instance (not exported)
    const LruCacheCtor: any = (ftr as any).membershipResultLru.constructor;

    const lru = new LruCacheCtor(2);
    lru.set('a', 1);
    lru.set('b', 2);

    // refresh a
    expect(lru.get('a')).toBe(1);

    // inserting c should evict b (oldest)
    lru.set('c', 3);
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBe(1);
    expect(lru.get('c')).toBe(3);

    // overwrite existing key branch
    lru.set('c', 4);
    expect(lru.get('c')).toBe(4);
  });
});

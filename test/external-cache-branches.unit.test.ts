import { describe, it, expect, vi } from 'vitest';
import { FhirTerminologyRuntime } from '../src/index';

describe('external membership cache helpers (unit)', () => {
  const pkg = { id: 'test.pkg', version: '1.0.0' };

  async function makeFtr(membershipCache: any) {
    const fpeStub: any = {
      getCachePath: () => './test/.test-cache',
      getContextPackages: () => [pkg],
      async lookupMeta() {
        return [];
      },
      async resolveMeta() {
        return undefined;
      },
      async resolve() {
        return undefined;
      }
    };

    return FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'none',
      fhirVersion: '4.0.1',
      membershipCache
    });
  }

  it('syncExternalCacheForLookup persists member/not-member but not unknown', async () => {
    const setCode = vi.fn().mockResolvedValue(undefined);
    const ftr = await makeFtr({ setCode });

    const vsKey = { packageId: 'p', packageVersion: '1.0.0', filename: 'vs.json' };

    await (ftr as any).syncExternalCacheForLookup(vsKey, 'x', { status: 'unknown', reason: 'duplicate-code' });
    expect(setCode).not.toHaveBeenCalled();

    await (ftr as any).syncExternalCacheForLookup(vsKey, 'y', { status: 'not-member' });
    expect(setCode).toHaveBeenCalledWith(vsKey, 'y', { status: 'not-member' });

    const concept = { system: 'http://example.org/sys', code: 'z', display: 'Zed' };
    await (ftr as any).syncExternalCacheForLookup(vsKey, 'z', { status: 'member', concept });
    expect(setCode).toHaveBeenLastCalledWith(vsKey, 'z', {
      status: 'member',
      conceptsBySystem: { [concept.system]: concept }
    });
  });

  it('primeExternalCacheIfProvided uses per-code setCode when bulkSetCodes is not available', async () => {
    const getCode = vi.fn().mockResolvedValue(undefined);
    const setCode = vi.fn().mockResolvedValue(undefined);
    const ftr = await makeFtr({ getCode, setCode });

    const vsKey = { packageId: 'p', packageVersion: '1.0.0', filename: 'vs.json' };
    const vsKeyStr = 'p#1.0.0::vs.json';

    const index = {
      uniqueCodeCount: 1,
      byCode: new Map([
        [
          'A',
          new Map([
            ['s1', { system: 's1', code: 'A' }],
            ['s2', { system: 's2', code: 'A' }]
          ])
        ]
      ])
    };

    await (ftr as any).primeExternalCacheIfProvided(vsKey, vsKeyStr, index, true);

    // 1 membership entry + 1 sentinel primed marker
    expect(setCode).toHaveBeenCalledTimes(2);
    expect((ftr as any).externallyPrimedValueSets.has(vsKeyStr)).toBe(true);
  });

  it('primeExternalCacheIfProvided returns early when external reports ValueSet is already primed', async () => {
    const getCode = vi.fn().mockResolvedValue({ status: 'not-member' });
    const setCode = vi.fn().mockResolvedValue(undefined);
    const bulkSetCodes = vi.fn().mockResolvedValue(undefined);

    const ftr = await makeFtr({ getCode, setCode, bulkSetCodes });

    const vsKey = { packageId: 'p', packageVersion: '1.0.0', filename: 'vs.json' };
    const vsKeyStr = 'p#1.0.0::vs.json';

    const index = {
      uniqueCodeCount: 1,
      byCode: new Map([['A', new Map([['s1', { system: 's1', code: 'A' }]])]])
    };

    await (ftr as any).primeExternalCacheIfProvided(vsKey, vsKeyStr, index, true);

    expect(getCode).toHaveBeenCalledTimes(1);
    expect(bulkSetCodes).not.toHaveBeenCalled();
    expect(setCode).not.toHaveBeenCalled();
  });

  it('primeExternalCacheIfProvided calls bulkSetCodes and writes sentinel marker', async () => {
    const getCode = vi.fn().mockResolvedValue(undefined);
    const setCode = vi.fn().mockResolvedValue(undefined);
    const bulkSetCodes = vi.fn().mockResolvedValue(undefined);

    const ftr = await makeFtr({ getCode, setCode, bulkSetCodes });

    const vsKey = { packageId: 'p', packageVersion: '1.0.0', filename: 'vs.json' };
    const vsKeyStr = 'p#1.0.0::vs.json';

    const index = {
      uniqueCodeCount: 1,
      byCode: new Map([['A', new Map([['s1', { system: 's1', code: 'A' }]])]])
    };

    await (ftr as any).primeExternalCacheIfProvided(vsKey, vsKeyStr, index, true);

    expect(bulkSetCodes).toHaveBeenCalledTimes(1);
    expect(setCode).toHaveBeenCalledWith(vsKey, '__ftr__primed__', { status: 'not-member' });
    expect((ftr as any).externallyPrimedValueSets.has(vsKeyStr)).toBe(true);
  });

  it('primeExternalCacheIfProvided skips sentinel reads/writes when sentinel code collides with real code', async () => {
    const getCode = vi.fn().mockResolvedValue(undefined);
    const setCode = vi.fn().mockResolvedValue(undefined);
    const bulkSetCodes = vi.fn().mockResolvedValue(undefined);

    const ftr = await makeFtr({ getCode, setCode, bulkSetCodes });

    const vsKey = { packageId: 'p', packageVersion: '1.0.0', filename: 'vs.json' };
    const vsKeyStr = 'p#1.0.0::vs.json';

    const index = {
      uniqueCodeCount: 2,
      byCode: new Map([
        ['__ftr__primed__', new Map([['s1', { system: 's1', code: '__ftr__primed__' }]])],
        ['A', new Map([['s1', { system: 's1', code: 'A' }]])]
      ])
    };

    await (ftr as any).primeExternalCacheIfProvided(vsKey, vsKeyStr, index, true);

    // canUseSentinel=false -> should not consult external.getCode for sentinel
    expect(getCode).not.toHaveBeenCalled();
    expect(bulkSetCodes).toHaveBeenCalledTimes(1);
    // bulk path -> no per-code setCode and no sentinel marker write
    expect(setCode).not.toHaveBeenCalled();
  });

  it('primeExternalCacheIfProvided uses in-memory guard on subsequent calls', async () => {
    const getCode = vi.fn().mockResolvedValue(undefined);
    const setCode = vi.fn().mockResolvedValue(undefined);
    const bulkSetCodes = vi.fn().mockResolvedValue(undefined);

    const ftr = await makeFtr({ getCode, setCode, bulkSetCodes });

    const vsKey = { packageId: 'p', packageVersion: '1.0.0', filename: 'vs.json' };
    const vsKeyStr = 'p#1.0.0::vs.json';

    const index = {
      uniqueCodeCount: 1,
      byCode: new Map([['A', new Map([['s1', { system: 's1', code: 'A' }]])]])
    };

    await (ftr as any).primeExternalCacheIfProvided(vsKey, vsKeyStr, index, true);
    await (ftr as any).primeExternalCacheIfProvided(vsKey, vsKeyStr, index, true);

    // Second call should return early via externallyPrimedValueSets
    expect(bulkSetCodes).toHaveBeenCalledTimes(1);
  });
});

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
    const setCode = vi.fn().mockResolvedValue(undefined);
    const ftr = await makeFtr({ setCode });

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

    expect(setCode).toHaveBeenCalledTimes(1);
    expect((ftr as any).externallyPrimedValueSets.has(vsKeyStr)).toBe(true);
  });

  it('primeExternalCacheIfProvided returns early when external reports ValueSet is already primed', async () => {
    const setCode = vi.fn().mockResolvedValue(undefined);
    const bulkSetCodes = vi.fn().mockResolvedValue(undefined);
    const isValueSetPrimed = vi.fn().mockResolvedValue(true);

    const ftr = await makeFtr({ setCode, bulkSetCodes, isValueSetPrimed });

    const vsKey = { packageId: 'p', packageVersion: '1.0.0', filename: 'vs.json' };
    const vsKeyStr = 'p#1.0.0::vs.json';

    const index = {
      uniqueCodeCount: 1,
      byCode: new Map([['A', new Map([['s1', { system: 's1', code: 'A' }]])]])
    };

    await (ftr as any).primeExternalCacheIfProvided(vsKey, vsKeyStr, index, true);

    expect(isValueSetPrimed).toHaveBeenCalledWith(vsKey);
    expect(bulkSetCodes).not.toHaveBeenCalled();
    expect(setCode).not.toHaveBeenCalled();
  });

  it('primeExternalCacheIfProvided calls bulkSetCodes and markValueSetPrimed when available', async () => {
    const setCode = vi.fn().mockResolvedValue(undefined);
    const bulkSetCodes = vi.fn().mockResolvedValue(undefined);
    const isValueSetPrimed = vi.fn().mockResolvedValue(false);
    const markValueSetPrimed = vi.fn().mockResolvedValue(undefined);

    const ftr = await makeFtr({ setCode, bulkSetCodes, isValueSetPrimed, markValueSetPrimed });

    const vsKey = { packageId: 'p', packageVersion: '1.0.0', filename: 'vs.json' };
    const vsKeyStr = 'p#1.0.0::vs.json';

    const index = {
      uniqueCodeCount: 1,
      byCode: new Map([['A', new Map([['s1', { system: 's1', code: 'A' }]])]])
    };

    await (ftr as any).primeExternalCacheIfProvided(vsKey, vsKeyStr, index, true);

    expect(bulkSetCodes).toHaveBeenCalledTimes(1);
    expect(markValueSetPrimed).toHaveBeenCalledWith(vsKey);
    expect((ftr as any).externallyPrimedValueSets.has(vsKeyStr)).toBe(true);
  });
});

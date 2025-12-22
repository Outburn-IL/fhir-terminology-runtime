import { describe, it, expect } from 'vitest';
import { FhirTerminologyRuntime } from '../src/index';

describe('src/index.ts branch buffer (unit)', () => {
  const pkg = { id: 'test.pkg', version: '1.0.0' };

  async function makeFtr() {
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

    return FhirTerminologyRuntime.create({ fpe: fpeStub, cacheMode: 'none', fhirVersion: '4.0.1' });
  }

  it('membershipResultFromExternalEntry covers system/no-system branches', async () => {
    const ftr = await makeFtr();
    const fn: any = (ftr as any).membershipResultFromExternalEntry;

    expect(fn({ status: 'not-member' })).toEqual({ status: 'not-member' });

    // Missing conceptsBySystem -> treated as empty -> not-member
    expect(fn({ status: 'member' })).toEqual({ status: 'not-member' });

    // system specified but missing in map -> not-member
    expect(fn({ status: 'member', conceptsBySystem: { s1: { system: 's1', code: 'A' } } }, 's2')).toEqual({ status: 'not-member' });

    // system specified and present -> member
    expect(fn({ status: 'member', conceptsBySystem: { s1: { system: 's1', code: 'A', display: 'Alpha' } } }, 's1')).toEqual({
      status: 'member',
      concept: { system: 's1', code: 'A', display: 'Alpha' }
    });

    // no system, multiple systems -> unknown duplicate-code
    expect(fn({
      status: 'member',
      conceptsBySystem: {
        s1: { system: 's1', code: 'A' },
        s2: { system: 's2', code: 'A' }
      }
    })).toEqual({ status: 'unknown', reason: 'duplicate-code' });

    // no system, single system -> member
    expect(fn({ status: 'member', conceptsBySystem: { s1: { system: 's1', code: 'A' } } })).toEqual({
      status: 'member',
      concept: { system: 's1', code: 'A' }
    });
  });

  it('lookupInIndex covers not-found/ambiguous/undefined-concept branches', async () => {
    const ftr = await makeFtr();
    const fn: any = (ftr as any).lookupInIndex;

    const emptyIndex = { uniqueCodeCount: 0, byCode: new Map() };
    expect(fn(emptyIndex, 'X')).toEqual({ status: 'not-member' });

    // If system specified but not present -> not-member
    const oneCodeTwoSystems = {
      uniqueCodeCount: 1,
      byCode: new Map([
        [
          'DUP',
          new Map([
            ['s1', { system: 's1', code: 'DUP' }],
            ['s2', { system: 's2', code: 'DUP' }]
          ])
        ]
      ])
    };
    expect(fn(oneCodeTwoSystems, 'DUP', 's3')).toEqual({ status: 'not-member' });

    // If system specified and present -> member
    expect(fn(oneCodeTwoSystems, 'DUP', 's1')).toEqual({ status: 'member', concept: { system: 's1', code: 'DUP' } });

    // If system omitted and multiple systems -> unknown duplicate-code
    expect(fn(oneCodeTwoSystems, 'DUP')).toEqual({ status: 'unknown', reason: 'duplicate-code' });

    // If system omitted and only one system but concept is undefined -> not-member
    const undefinedConceptIndex = {
      uniqueCodeCount: 1,
      byCode: new Map([['A', new Map([['s1', undefined]])]])
    };
    expect(fn(undefinedConceptIndex, 'A')).toEqual({ status: 'not-member' });
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { FhirTerminologyRuntime } from '../src/index';

describe('inValueSet (unit)', () => {
  let ftr: FhirTerminologyRuntime;
  let externalPrimedCount = 0;
  let externalBulkCount = 0;
  let externalStore: Map<string, any>;

  const pkg = { id: 'test.pkg', version: '1.0.0' };

  const valueSets: Record<string, any> = {
    'vs-small.json': {
      resourceType: 'ValueSet',
      id: 'vs-small',
      url: 'http://example.org/ValueSet/vs-small',
      compose: {
        include: [
          {
            system: 'http://example.org/system/one',
            concept: [
              { code: 'A', display: 'Alpha' },
              { code: 'B', display: 'Beta' }
            ]
          }
        ]
      }
    },
    'vs-dup.json': {
      resourceType: 'ValueSet',
      id: 'vs-dup',
      url: 'http://example.org/ValueSet/vs-dup',
      compose: {
        include: [
          { system: 'http://example.org/system/one', concept: [{ code: 'DUP', display: 'Dup (one)' }] },
          { system: 'http://example.org/system/two', concept: [{ code: 'DUP', display: 'Dup (two)' }] }
        ]
      }
    },
    'vs-large.json': {
      resourceType: 'ValueSet',
      id: 'vs-large',
      url: 'http://example.org/ValueSet/vs-large',
      compose: {
        include: [
          {
            system: 'http://example.org/system/large',
            concept: Array.from({ length: 60 }).map((_, i) => ({
              code: `C${i}`,
              display: `Code ${i}`
            }))
          }
        ]
      }
    },
    // Has an unsupported filter so expansion generation fails and we fall back to the provided expansion.
    // The expansion contains nested contains to exercise flattenExpansionContains recursion.
    'vs-nested.json': {
      resourceType: 'ValueSet',
      id: 'vs-nested',
      url: 'http://example.org/ValueSet/vs-nested',
      compose: {
        include: [
          {
            system: 'http://example.org/system/nested',
            filter: [{ property: 'code', op: '=', value: 'ignored' }]
          }
        ]
      },
      expansion: {
        contains: [
          {
            system: 'http://example.org/system/nested',
            code: 'P',
            display: 'Parent',
            contains: [
              {
                system: 'http://example.org/system/nested',
                code: 'CH',
                display: 'Child',
                version: '1'
              }
            ]
          },
          {
            system: 'http://example.org/system/nested',
            code: 'SIB'
          }
        ]
      }
    }
  };

  const metaByIdentifier: Record<string, any> = {
    'vs-small': { resourceType: 'ValueSet', filename: 'vs-small.json', __packageId: pkg.id, __packageVersion: pkg.version },
    'http://example.org/ValueSet/vs-small': { resourceType: 'ValueSet', filename: 'vs-small.json', __packageId: pkg.id, __packageVersion: pkg.version },
    'vs-dup': { resourceType: 'ValueSet', filename: 'vs-dup.json', __packageId: pkg.id, __packageVersion: pkg.version },
    'vs-large': { resourceType: 'ValueSet', filename: 'vs-large.json', __packageId: pkg.id, __packageVersion: pkg.version },
    'vs-nested': { resourceType: 'ValueSet', filename: 'vs-nested.json', __packageId: pkg.id, __packageVersion: pkg.version }
  };

  beforeAll(async () => {
    // Minimal stub for FhirPackageExplorer used by FhirTerminologyRuntime.
    // We deliberately keep ValueSets expandable without CodeSystem resolution by including display in concepts.

    externalStore = new Map<string, any>();
    const externalPrimed = new Set<string>();

    const membershipCache = {
      async getCode(vs: any, code: string) {
        return externalStore.get(`${vs.packageId}#${vs.packageVersion}::${vs.filename}|${code}`);
      },
      async setCode(vs: any, code: string, entry: any) {
        externalStore.set(`${vs.packageId}#${vs.packageVersion}::${vs.filename}|${code}`, entry);
      },
      async bulkSetCodes(vs: any, entries: Array<[string, any]>) {
        externalBulkCount += 1;
        for (const [code, entry] of entries) {
          externalStore.set(`${vs.packageId}#${vs.packageVersion}::${vs.filename}|${code}`, entry);
        }
      },
      async isValueSetPrimed(vs: any) {
        return externalPrimed.has(`${vs.packageId}#${vs.packageVersion}::${vs.filename}`);
      },
      async markValueSetPrimed(vs: any) {
        externalPrimedCount += 1;
        externalPrimed.add(`${vs.packageId}#${vs.packageVersion}::${vs.filename}`);
      }
    };

    const fpeStub: any = {
      getCachePath: () => './test/.test-cache',
      getContextPackages: () => [pkg],
      async resolveMeta(query: any) {
        if (query.resourceType !== 'ValueSet') throw new Error('Only ValueSet supported in stub');
        const ident = query.url || query.id || query.name;
        const meta = metaByIdentifier[String(ident)];
        if (!meta) throw new Error(`ValueSet not found: ${ident}`);
        return meta;
      },
      async resolve(args: any) {
        const vs = valueSets[args.filename];
        if (!vs) throw new Error(`File not found: ${args.filename}`);
        return vs;
      },
      async lookupMeta() {
        return [];
      }
    };

    ftr = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'none',
      fhirVersion: '4.0.1',
      membershipCache
    });
  });

  it('returns member for code-only lookup in small ValueSet', async () => {
    const res = await ftr.inValueSet('A', 'vs-small');
    expect(res.status).toBe('member');
    if (res.status === 'member') {
      expect(res.concept.system).toBe('http://example.org/system/one');
      expect(res.concept.code).toBe('A');
      expect(res.concept.display).toBe('Alpha');
    }
  });

  it('returns not-member when absent', async () => {
    const res = await ftr.inValueSet('Z', 'vs-small');
    expect(res).toEqual({ status: 'not-member' });
  });

  it('uses cached small index on subsequent lookups', async () => {
    const first = await ftr.inValueSet('B', 'vs-small');
    expect(first.status).toBe('member');
    const second = await ftr.inValueSet('B', 'vs-small');
    expect(second.status).toBe('member');
  });

  it('returns unknown-valueset when ValueSet cannot be resolved', async () => {
    const res = await ftr.inValueSet('A', 'does-not-exist');
    expect(res).toEqual({ status: 'unknown', reason: 'unknown-valueset' });
  });

  it('returns duplicate-code for ambiguous code-only lookup', async () => {
    const res = await ftr.inValueSet('DUP', 'vs-dup');
    expect(res).toEqual({ status: 'unknown', reason: 'duplicate-code' });
  });

  it('disambiguates duplicates when system provided', async () => {
    const res = await ftr.inValueSet({ system: 'http://example.org/system/two', code: 'DUP' }, 'vs-dup');
    expect(res.status).toBe('member');
    if (res.status === 'member') {
      expect(res.concept.system).toBe('http://example.org/system/two');
      expect(res.concept.code).toBe('DUP');
      expect(res.concept.display).toBe('Dup (two)');
    }
  });

  it('primes external cache on first lookup for large ValueSet', async () => {
    const res = await ftr.inValueSet('C10', 'vs-large');
    expect(res.status).toBe('member');
    expect(externalBulkCount).toBeGreaterThanOrEqual(1);
    expect(externalPrimedCount).toBeGreaterThanOrEqual(1);
  });

  it('falls back to provided expansion and handles nested contains', async () => {
    const res = await ftr.inValueSet({ system: 'http://example.org/system/nested', code: 'CH' }, 'vs-nested');
    expect(res.status).toBe('member');
    if (res.status === 'member') {
      expect(res.concept.system).toBe('http://example.org/system/nested');
      expect(res.concept.code).toBe('CH');
      expect(res.concept.display).toBe('Child');
      expect(res.concept.version).toBe('1');
    }
  });
});

describe('inValueSet (unit) - cache and priming branches', () => {
  const pkg = { id: 'test.pkg', version: '1.0.0' };
  const valueSets: Record<string, any> = {
    'vs-large.json': {
      resourceType: 'ValueSet',
      id: 'vs-large',
      url: 'http://example.org/ValueSet/vs-large',
      compose: {
        include: [
          {
            system: 'http://example.org/system/large',
            concept: Array.from({ length: 60 }).map((_, i) => ({
              code: `C${i}`,
              display: `Code ${i}`
            }))
          }
        ]
      }
    }
  };
  const metaByIdentifier: Record<string, any> = {
    'vs-large': { resourceType: 'ValueSet', filename: 'vs-large.json', __packageId: pkg.id, __packageVersion: pkg.version }
  };

  function makeFpeStub(): any {
    return {
      getCachePath: () => './test/.test-cache',
      getContextPackages: () => [pkg],
      async resolveMeta(query: any) {
        if (query.resourceType !== 'ValueSet') throw new Error('Only ValueSet supported in stub');
        const ident = query.url || query.id || query.name;
        const meta = metaByIdentifier[String(ident)];
        if (!meta) throw new Error(`ValueSet not found: ${ident}`);
        return meta;
      },
      async resolve(args: any) {
        const vs = valueSets[args.filename];
        if (!vs) throw new Error(`File not found: ${args.filename}`);
        return vs;
      },
      async lookupMeta() {
        return [];
      }
    };
  }

  it('returns from external cache when present (no expansion required)', async () => {
    const externalStore = new Map<string, any>();
    let setCodeCalls = 0;

    externalStore.set(`${pkg.id}#${pkg.version}::vs-large.json|C10`, {
      status: 'member',
      conceptsBySystem: {
        'http://example.org/system/large': { system: 'http://example.org/system/large', code: 'C10', display: 'Code 10' }
      }
    });

    const membershipCache = {
      async getCode(vs: any, code: string) {
        return externalStore.get(`${vs.packageId}#${vs.packageVersion}::${vs.filename}|${code}`);
      },
      async setCode() {
        setCodeCalls += 1;
      }
    };

    const ftr = await FhirTerminologyRuntime.create({
      fpe: makeFpeStub(),
      cacheMode: 'none',
      fhirVersion: '4.0.1',
      membershipCache
    });

    const res = await ftr.inValueSet('C10', 'vs-large');
    expect(res.status).toBe('member');
    expect(setCodeCalls).toBe(0);
  });

  it('returns not-member from external cache when entry says not-member', async () => {
    const externalStore = new Map<string, any>();
    externalStore.set(`${pkg.id}#${pkg.version}::vs-large.json|C10`, { status: 'not-member' });

    const membershipCache = {
      async getCode(vs: any, code: string) {
        return externalStore.get(`${vs.packageId}#${vs.packageVersion}::${vs.filename}|${code}`);
      },
      async setCode() {
        // should not be called for external-hit path
      }
    };

    const ftr = await FhirTerminologyRuntime.create({
      fpe: makeFpeStub(),
      cacheMode: 'none',
      fhirVersion: '4.0.1',
      membershipCache
    });

    const res = await ftr.inValueSet('C10', 'vs-large');
    expect(res).toEqual({ status: 'not-member' });
  });

  it('returns duplicate-code when external entry has multiple systems and system is omitted', async () => {
    const externalStore = new Map<string, any>();
    externalStore.set(`${pkg.id}#${pkg.version}::vs-large.json|C10`, {
      status: 'member',
      conceptsBySystem: {
        'http://example.org/system/large': { system: 'http://example.org/system/large', code: 'C10' },
        'http://example.org/system/other': { system: 'http://example.org/system/other', code: 'C10' }
      }
    });

    const membershipCache = {
      async getCode(vs: any, code: string) {
        return externalStore.get(`${vs.packageId}#${vs.packageVersion}::${vs.filename}|${code}`);
      },
      async setCode() {
        // should not be called for external-hit path
      }
    };

    const ftr = await FhirTerminologyRuntime.create({
      fpe: makeFpeStub(),
      cacheMode: 'none',
      fhirVersion: '4.0.1',
      membershipCache
    });

    const res = await ftr.inValueSet('C10', 'vs-large');
    expect(res).toEqual({ status: 'unknown', reason: 'duplicate-code' });

    const disambiguated = await ftr.inValueSet({ system: 'http://example.org/system/other', code: 'C10' }, 'vs-large');
    expect(disambiguated.status).toBe('member');
  });

  it('uses membership LRU on repeated lookups for large ValueSets', async () => {
    const ftr = await FhirTerminologyRuntime.create({
      fpe: makeFpeStub(),
      cacheMode: 'none',
      fhirVersion: '4.0.1'
    });

    const first = await ftr.inValueSet('C10', 'vs-large');
    expect(first.status).toBe('member');
    const second = await ftr.inValueSet('C10', 'vs-large');
    expect(second.status).toBe('member');
  });

  it('primes external cache via per-code set when bulkSetCodes is unavailable and skips re-priming', async () => {
    let setCodeCalls = 0;

    const membershipCache = {
      async getCode() {
        return undefined;
      },
      async setCode() {
        setCodeCalls += 1;
      }
      // intentionally omit bulkSetCodes/isValueSetPrimed/markValueSetPrimed
    };

    const ftr = await FhirTerminologyRuntime.create({
      fpe: makeFpeStub(),
      cacheMode: 'none',
      fhirVersion: '4.0.1',
      membershipCache
    });

    const first = await ftr.inValueSet('C10', 'vs-large');
    expect(first.status).toBe('member');
    // 60 codes primed + 1 syncExternalCacheForLookup call
    expect(setCodeCalls).toBe(61);

    const secondDifferentCode = await ftr.inValueSet('C11', 'vs-large');
    expect(secondDifferentCode.status).toBe('member');
    // Should not re-prime all codes again; only sync the requested code.
    expect(setCodeCalls).toBe(62);
  });

  it('ignores external cache read failures and falls back to local evaluation', async () => {
    const membershipCache = {
      async getCode() {
        throw new Error('external down');
      },
      async setCode() {
        // no-op
      }
    };

    const ftr = await FhirTerminologyRuntime.create({
      fpe: makeFpeStub(),
      cacheMode: 'none',
      fhirVersion: '4.0.1',
      membershipCache
    });

    const res = await ftr.inValueSet('C10', 'vs-large');
    expect(res.status).toBe('member');
  });

  it('returns not-member when coding-like input is missing/invalid code', async () => {
    const ftr = await FhirTerminologyRuntime.create({
      fpe: makeFpeStub(),
      cacheMode: 'none',
      fhirVersion: '4.0.1'
    });

    const res = await ftr.inValueSet({ system: 'http://example.org/system/large', code: 123 as any }, 'vs-large');
    expect(res).toEqual({ status: 'not-member' });
  });
});

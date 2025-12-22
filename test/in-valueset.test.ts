import { describe, it, expect, beforeAll } from 'vitest';
import { FhirTerminologyRuntime } from '../src/index';

describe('inValueSet (unit)', () => {
  let ftr: FhirTerminologyRuntime;
  let externalPrimedCount = 0;
  let externalBulkCount = 0;

  beforeAll(async () => {
    // Minimal stub for FhirPackageExplorer used by FhirTerminologyRuntime.
    // We deliberately keep ValueSets expandable without CodeSystem resolution by including display in concepts.

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
      }
    };

    const metaByIdentifier: Record<string, any> = {
      'vs-small': { resourceType: 'ValueSet', filename: 'vs-small.json', __packageId: pkg.id, __packageVersion: pkg.version },
      'http://example.org/ValueSet/vs-small': { resourceType: 'ValueSet', filename: 'vs-small.json', __packageId: pkg.id, __packageVersion: pkg.version },
      'vs-dup': { resourceType: 'ValueSet', filename: 'vs-dup.json', __packageId: pkg.id, __packageVersion: pkg.version },
      'vs-large': { resourceType: 'ValueSet', filename: 'vs-large.json', __packageId: pkg.id, __packageVersion: pkg.version }
    };

    const externalStore = new Map<string, any>();
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
});

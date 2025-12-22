import { describe, it, expect, beforeEach, vi } from 'vitest';

// Important: avoid importing ../src/index at top-level from other tests’ module cache.
// This file doesn't mock modules, so a normal import is fine.
import { FhirTerminologyRuntime } from '../src/index';
import { ImplicitCodeSystemRegistry } from '../src/utils/terminology/implicitCodeSystems';

describe('expandValueSet / expandInclude branching (unit)', () => {
  const pkg = { id: 'test.pkg', version: '1.0.0' };

  let calls: any[];

  beforeEach(() => {
    calls = [];
  });

  function makeFpeStub(valueSets: Record<string, any>, metaBy: Record<string, any>) {
    return {
      getCachePath: () => './test/.test-cache',
      getContextPackages: () => [pkg],
      async lookupMeta() {
        return [];
      },
      async resolveMeta(query: any) {
        calls.push(query);
        if (query.resourceType !== 'ValueSet') throw new Error('Only ValueSet supported');

        const ident = query.url ?? query.id ?? query.name;
        const key = `${String(ident)}|pkg:${query.package?.id ?? ''}@${query.package?.version ?? ''}`;
        const meta = metaBy[key] ?? metaBy[String(ident)];
        if (!meta) throw new Error(`ValueSet not found: ${ident}`);
        return meta;
      },
      async resolve(args: any) {
        const vs = valueSets[args.filename];
        if (!vs) throw new Error(`File not found: ${args.filename}`);
        return vs;
      }
    };
  }

  it('handles referenced ValueSet: hasSystem=true -> intersects referenced union', async () => {
    const valueSets: Record<string, any> = {
      'vs-ref.json': {
        resourceType: 'ValueSet',
        id: 'vs-ref',
        url: 'http://example.org/ValueSet/vs-ref',
        compose: {
          include: [
            {
              system: 'http://example.org/system/one',
              concept: [
                { code: 'A', display: 'Alpha' },
                { code: 'X', display: 'Ex' }
              ],
              valueSet: ['http://example.org/ValueSet/vs-base']
            }
          ]
        }
      },
      'vs-base.json': {
        resourceType: 'ValueSet',
        id: 'vs-base',
        url: 'http://example.org/ValueSet/vs-base',
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
      }
    };

    const metaBy: Record<string, any> = {
      // vs-ref resolved by id
      'vs-ref': { resourceType: 'ValueSet', filename: 'vs-ref.json', __packageId: pkg.id, __packageVersion: pkg.version },
      // referenced VS: fail locally (pkg specified) and succeed globally (no package)
      'http://example.org/ValueSet/vs-base|pkg:test.pkg@1.0.0': undefined as any,
      'http://example.org/ValueSet/vs-base': { resourceType: 'ValueSet', filename: 'vs-base.json', __packageId: pkg.id, __packageVersion: pkg.version }
    };

    const fpe: any = makeFpeStub(valueSets, metaBy);
    const ftr = await FhirTerminologyRuntime.create({ fpe, cacheMode: 'none', fhirVersion: '4.0.1' });

    const expansion = await ftr.expandValueSet('vs-ref');
    expect(expansion.expansion.total).toBe(1);
    expect(expansion.expansion.contains).toEqual(
      expect.arrayContaining([expect.objectContaining({ system: 'http://example.org/system/one', code: 'A' })])
    );
    expect(expansion.expansion.contains.find((c: any) => c.code === 'X')).toBeFalsy();

    // Exercise resolveMetaCached cache key generation: same lookup repeated should not call resolveMeta again.
    const before = calls.length;
    await ftr.expandValueSet('vs-ref');
    expect(calls.length).toBe(before);
  });

  it('handles referenced ValueSet: hasSystem=false -> merges referenced union', async () => {
    const valueSets: Record<string, any> = {
      'vs-ref-nosys.json': {
        resourceType: 'ValueSet',
        id: 'vs-ref-nosys',
        url: 'http://example.org/ValueSet/vs-ref-nosys',
        compose: {
          include: [
            {
              valueSet: ['http://example.org/ValueSet/vs-base']
            }
          ]
        }
      },
      'vs-base.json': {
        resourceType: 'ValueSet',
        id: 'vs-base',
        url: 'http://example.org/ValueSet/vs-base',
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
      }
    };

    const metaBy: Record<string, any> = {
      'vs-ref-nosys': { resourceType: 'ValueSet', filename: 'vs-ref-nosys.json', __packageId: pkg.id, __packageVersion: pkg.version },
      'http://example.org/ValueSet/vs-base|pkg:test.pkg@1.0.0': { resourceType: 'ValueSet', filename: 'vs-base.json', __packageId: pkg.id, __packageVersion: pkg.version }
    };

    const fpe: any = makeFpeStub(valueSets, metaBy);
    const ftr = await FhirTerminologyRuntime.create({ fpe, cacheMode: 'none', fhirVersion: '4.0.1' });

    const expansion = await ftr.expandValueSet('vs-ref-nosys');
    expect(expansion.expansion.total).toBe(2);
    expect(expansion.expansion.contains).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ system: 'http://example.org/system/one', code: 'A' }),
        expect.objectContaining({ system: 'http://example.org/system/one', code: 'B' })
      ])
    );
  });

  it('detects cyclic ValueSet references', async () => {
    const valueSets: Record<string, any> = {
      'vs-cyc1.json': {
        resourceType: 'ValueSet',
        id: 'vs-cyc1',
        url: 'http://example.org/ValueSet/vs-cyc1',
        compose: { include: [{ valueSet: ['http://example.org/ValueSet/vs-cyc2'] }] }
      },
      'vs-cyc2.json': {
        resourceType: 'ValueSet',
        id: 'vs-cyc2',
        url: 'http://example.org/ValueSet/vs-cyc2',
        compose: { include: [{ valueSet: ['http://example.org/ValueSet/vs-cyc1'] }] }
      }
    };

    const metaBy: Record<string, any> = {
      'vs-cyc1': { resourceType: 'ValueSet', filename: 'vs-cyc1.json', __packageId: pkg.id, __packageVersion: pkg.version },
      'http://example.org/ValueSet/vs-cyc2|pkg:test.pkg@1.0.0': { resourceType: 'ValueSet', filename: 'vs-cyc2.json', __packageId: pkg.id, __packageVersion: pkg.version },
      'http://example.org/ValueSet/vs-cyc1|pkg:test.pkg@1.0.0': { resourceType: 'ValueSet', filename: 'vs-cyc1.json', __packageId: pkg.id, __packageVersion: pkg.version }
    };

    const fpe: any = makeFpeStub(valueSets, metaBy);
    const ftr = await FhirTerminologyRuntime.create({ fpe, cacheMode: 'none', fhirVersion: '4.0.1' });

    await expect(ftr.expandValueSet('vs-cyc1')).rejects.toThrow('Cyclic ValueSet reference detected');
  });

  it('falls back from URL lookup to ID/name lookups and logs resolution errors', async () => {
    const valueSets: Record<string, any> = {
      'vs-ok.json': {
        resourceType: 'ValueSet',
        id: 'urn:test:vs-ok',
        url: 'urn:test:vs-ok',
        compose: { include: [{ system: 'http://example.org/system/one', concept: [{ code: 'A', display: 'Alpha' }] }] }
      }
    };

    const metaBy: Record<string, any> = {
      // Make URL lookup fail (no entry for query.url), but ID lookup succeed.
      'urn:test:vs-ok': { resourceType: 'ValueSet', filename: 'vs-ok.json', __packageId: pkg.id, __packageVersion: pkg.version }
    };

    const errorLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const fpe: any = makeFpeStub(valueSets, metaBy);
    const ftr = await FhirTerminologyRuntime.create({ fpe, cacheMode: 'none', fhirVersion: '4.0.1', logger: errorLogger as any });

    const expansion = await ftr.expandValueSet('urn:test:vs-ok');
    expect(expansion.expansion.total).toBe(1);

    await expect(ftr.expandValueSet('urn:test:missing')).rejects.toThrow('Failed to resolve ValueSet');
    expect(errorLogger.error).toHaveBeenCalled();
  });

  it('uses implicit CodeSystem to backfill missing displays when CodeSystem lookup fails (hasConcepts)', async () => {
    const systemUrl = 'urn:iso:std:iso:3166';

    const valueSets: Record<string, any> = {
      'vs-missing-display.json': {
        resourceType: 'ValueSet',
        id: 'vs-missing-display',
        url: 'http://example.org/ValueSet/vs-missing-display',
        compose: {
          include: [
            {
              system: systemUrl,
              concept: [{ code: 'US' }] // missing display -> forces needsCsLookup
            }
          ]
        }
      }
    };

    const metaBy: Record<string, any> = {
      'vs-missing-display': {
        resourceType: 'ValueSet',
        filename: 'vs-missing-display.json',
        __packageId: pkg.id,
        __packageVersion: pkg.version
      }
    };

    const infoLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const fpe: any = makeFpeStub(valueSets, metaBy);
    const ftr = await FhirTerminologyRuntime.create({ fpe, cacheMode: 'none', fhirVersion: '4.0.1', logger: infoLogger as any });

    (ftr as any).resolveCompleteCodeSystem = async () => {
      throw new Error('boom');
    };

    const originalGetConcepts = ImplicitCodeSystemRegistry.getConcepts;
    (ImplicitCodeSystemRegistry as any).getConcepts = (canonicalUrl: string) => {
      if (canonicalUrl !== systemUrl) return undefined;
      return new Map<string, string | undefined>([['US', 'United States']]);
    };

    try {
      const expansion = await ftr.expandValueSet('vs-missing-display');
      expect(expansion.expansion.total).toBe(1);
      expect(expansion.expansion.contains).toEqual(
        expect.arrayContaining([expect.objectContaining({ system: systemUrl, code: 'US', display: 'United States' })])
      );
      expect(infoLogger.info).toHaveBeenCalled();
    } finally {
      (ImplicitCodeSystemRegistry as any).getConcepts = originalGetConcepts;
    }
  });

  it('backfills missing displays from a resolved complete CodeSystem (hasConcepts success path)', async () => {
    const systemUrl = 'http://example.org/system/complete';

    const valueSets: Record<string, any> = {
      'vs-backfill-display.json': {
        resourceType: 'ValueSet',
        id: 'vs-backfill-display',
        url: 'http://example.org/ValueSet/vs-backfill-display',
        compose: {
          include: [
            {
              system: systemUrl,
              concept: [{ code: 'US' }] // missing display -> forces needsCsLookup
            }
          ]
        }
      }
    };

    const metaBy: Record<string, any> = {
      'vs-backfill-display': {
        resourceType: 'ValueSet',
        filename: 'vs-backfill-display.json',
        __packageId: pkg.id,
        __packageVersion: pkg.version
      }
    };

    const fpe: any = makeFpeStub(valueSets, metaBy);
    const ftr = await FhirTerminologyRuntime.create({ fpe, cacheMode: 'none', fhirVersion: '4.0.1' });

    (ftr as any).resolveCompleteCodeSystem = async () => {
      return {
        resourceType: 'CodeSystem',
        url: systemUrl,
        content: 'complete',
        concept: [{ code: 'US', display: 'United States' }]
      };
    };

    const expansion = await ftr.expandValueSet('vs-backfill-display');
    expect(expansion.expansion.total).toBe(1);
    expect(expansion.expansion.contains).toEqual(
      expect.arrayContaining([expect.objectContaining({ system: systemUrl, code: 'US', display: 'United States' })])
    );
  });

  it('throws when referenced ValueSet cannot be resolved locally or globally', async () => {
    const valueSets: Record<string, any> = {
      'vs-ref-missing.json': {
        resourceType: 'ValueSet',
        id: 'vs-ref-missing',
        url: 'http://example.org/ValueSet/vs-ref-missing',
        compose: {
          include: [
            {
              valueSet: ['http://example.org/ValueSet/definitely-missing']
            }
          ]
        }
      }
    };

    const metaBy: Record<string, any> = {
      'vs-ref-missing': { resourceType: 'ValueSet', filename: 'vs-ref-missing.json', __packageId: pkg.id, __packageVersion: pkg.version }
      // NOTE: no entries for referenced VS (neither local nor global), so both resolveMetaCached calls fail.
    };

    const fpe: any = makeFpeStub(valueSets, metaBy);
    const ftr = await FhirTerminologyRuntime.create({ fpe, cacheMode: 'none', fhirVersion: '4.0.1' });

    await expect(ftr.expandValueSet('vs-ref-missing')).rejects.toThrow('Referenced ValueSet');
  });
});

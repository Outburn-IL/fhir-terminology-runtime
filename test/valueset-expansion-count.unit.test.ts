import { describe, it, expect, beforeAll } from 'vitest';
import { FhirTerminologyRuntime } from '../src/index';

describe('getValueSetExpansionCount (unit)', () => {
  let ftr: FhirTerminologyRuntime;

  const pkg = { id: 'test.pkg', version: '1.0.0' };

  const valueSets: Record<string, any> = {
    'vs-total.json': {
      resourceType: 'ValueSet',
      id: 'vs-total',
      url: 'http://example.org/ValueSet/vs-total',
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
    // Unsupported filter forces fallback to the provided expansion.
    // No expansion.total -> count should be derived from contains.length.
    'vs-contains-only.json': {
      resourceType: 'ValueSet',
      id: 'vs-contains-only',
      url: 'http://example.org/ValueSet/vs-contains-only',
      compose: {
        include: [{ system: 'http://example.org/system/x', filter: [{ property: 'code', op: '=', value: 'ignored' }] }]
      },
      expansion: {
        contains: [
          { system: 'http://example.org/system/x', code: 'X1' },
          { system: 'http://example.org/system/x', code: 'X2' },
          { system: 'http://example.org/system/x', code: 'X3' }
        ]
      }
    },
    // Expansion generation fails and there is no fallback expansion.contains.
    'vs-fails.json': {
      resourceType: 'ValueSet',
      id: 'vs-fails',
      url: 'http://example.org/ValueSet/vs-fails',
      compose: {
        include: [{ system: 'http://example.org/system/x', filter: [{ property: 'code', op: '=', value: 'ignored' }] }]
      }
    }
  };

  const metaByIdentifier: Record<string, any> = {
    'vs-total': { resourceType: 'ValueSet', filename: 'vs-total.json', __packageId: pkg.id, __packageVersion: pkg.version },
    'vs-contains-only': { resourceType: 'ValueSet', filename: 'vs-contains-only.json', __packageId: pkg.id, __packageVersion: pkg.version },
    'vs-fails': { resourceType: 'ValueSet', filename: 'vs-fails.json', __packageId: pkg.id, __packageVersion: pkg.version }
  };

  beforeAll(async () => {
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
      fhirVersion: '4.0.1'
    });
  });

  it('counts by expansion.total when available', async () => {
    const res = await ftr.getValueSetExpansionCount('vs-total');
    expect(res).toEqual({ status: 'ok', count: 2 });
  });

  it('counts by contains.length when total is not present', async () => {
    const res = await ftr.getValueSetExpansionCount('vs-contains-only');
    expect(res).toEqual({ status: 'ok', count: 3 });
  });

  it('caches results by identifier', async () => {
    const first = await ftr.getValueSetExpansionCount('vs-total');
    const second = await ftr.getValueSetExpansionCount('vs-total');
    expect(second).toEqual(first);
  });

  it('returns unknown-valueset when metadata object is missing', async () => {
    const res = await ftr.getValueSetExpansionCount(undefined as any);
    expect(res).toEqual({ status: 'unknown', reason: 'unknown-valueset' });
  });

  it('returns unexpandable-valueset when expansion generation fails', async () => {
    const res = await ftr.getValueSetExpansionCount('vs-fails');
    expect(res).toEqual({ status: 'unknown', reason: 'unexpandable-valueset' });
  });
});

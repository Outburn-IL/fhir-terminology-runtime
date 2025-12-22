import { describe, it, expect, beforeAll } from 'vitest';
import { FhirTerminologyRuntime } from '../src/index';

describe('expandValueSet (unit)', () => {
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
    }
  };

  const metaByIdentifier: Record<string, any> = {
    'vs-total': { resourceType: 'ValueSet', filename: 'vs-total.json', __packageId: pkg.id, __packageVersion: pkg.version }
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

  it('expands ValueSet by identifier string', async () => {
    const expansion = await ftr.expandValueSet('vs-total');
    expect(expansion.resourceType).toBe('ValueSet');
    expect(expansion.expansion?.total).toBe(2);
    expect(Array.isArray(expansion.expansion?.contains)).toBe(true);
  });

  it('expands ValueSet by metadata object', async () => {
    const expansion = await ftr.expandValueSet(metaByIdentifier['vs-total']);
    expect(expansion.resourceType).toBe('ValueSet');
    expect(expansion.expansion?.total).toBe(2);
  });

  it('throws when identifier cannot be resolved', async () => {
    await expect(ftr.expandValueSet('missing')).rejects.toThrow('ValueSet');
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { FhirTerminologyRuntime } from '../src/index';

describe('translateConceptMap (unit)', () => {
  let ftr: FhirTerminologyRuntime;
  let resolveCount = 0;

  const pkg = { id: 'test.pkg', version: '1.0.0' };

  const conceptMaps: Record<string, any> = {
    'cm-small.json': {
      resourceType: 'ConceptMap',
      id: 'cm-small',
      url: 'http://example.org/ConceptMap/cm-small',
      group: [
        {
          source: 'http://example.org/system/source',
          target: 'http://example.org/system/target',
          element: [
            {
              code: 'A',
              target: [
                { code: '1', display: 'One', equivalence: 'equal' }
              ]
            },
            {
              code: 'B',
              target: [
                { code: 'NOPE', equivalence: 'disjoint' }, // ignored
                { code: '3' } // equivalence missing (R3) => treated as 'equivalent'
              ]
            },
            {
              code: 'UNSUP',
              target: [
                { code: 'X', equivalence: 'disjoint' }
              ]
            }
          ]
        },
        {
          // second group exists, but grouping is ignored (flattened)
          source: 'http://example.org/system/source',
          element: [
            {
              code: 'A',
              target: [
                { system: 'http://example.org/system/alt-target', code: 'ALT', equivalence: 'wider' }
              ]
            }
          ]
        }
      ]
    },

    'cm-dup.json': {
      resourceType: 'ConceptMap',
      id: 'cm-dup',
      url: 'http://example.org/ConceptMap/cm-dup',
      group: [
        {
          source: 'http://example.org/system/source1',
          target: 'http://example.org/system/target',
          element: [
            { code: 'DUP', target: [{ code: 'X', equivalence: 'equivalent' }] }
          ]
        },
        {
          source: 'http://example.org/system/source2',
          target: 'http://example.org/system/target',
          element: [
            { code: 'DUP', target: [{ code: 'Y', equivalence: 'equivalent' }] }
          ]
        }
      ]
    },

    'cm-large.json': {
      resourceType: 'ConceptMap',
      id: 'cm-large',
      url: 'http://example.org/ConceptMap/cm-large',
      group: [
        {
          source: 'http://example.org/system/source',
          target: 'http://example.org/system/target',
          element: Array.from({ length: 60 }).map((_, i) => ({
            code: `C${i}`,
            target: [{ code: `T${i}`, equivalence: 'equivalent' }]
          }))
        }
      ]
    },

    'cm-has-sentinel.json': {
      resourceType: 'ConceptMap',
      id: 'cm-has-sentinel',
      url: 'http://example.org/ConceptMap/cm-has-sentinel',
      group: [
        {
          source: 'http://example.org/system/source',
          target: 'http://example.org/system/target',
          element: [
            {
              // exercise canUseSentinel === false
              code: '__ftr__primed__',
              target: [{ code: 'REAL', display: 'Real', version: '1', equivalence: 'equivalent' }]
            }
          ]
        }
      ]
    }
  };

  const metaByIdentifier: Record<string, any> = {
    'cm-small': { resourceType: 'ConceptMap', filename: 'cm-small.json', __packageId: pkg.id, __packageVersion: pkg.version },
    'http://example.org/ConceptMap/cm-small': { resourceType: 'ConceptMap', filename: 'cm-small.json', __packageId: pkg.id, __packageVersion: pkg.version },
    'cm-small-name': { resourceType: 'ConceptMap', filename: 'cm-small.json', __packageId: pkg.id, __packageVersion: pkg.version },
    'cm-dup': { resourceType: 'ConceptMap', filename: 'cm-dup.json', __packageId: pkg.id, __packageVersion: pkg.version },
    'cm-large': { resourceType: 'ConceptMap', filename: 'cm-large.json', __packageId: pkg.id, __packageVersion: pkg.version },
    'cm-has-sentinel': { resourceType: 'ConceptMap', filename: 'cm-has-sentinel.json', __packageId: pkg.id, __packageVersion: pkg.version }
  };

  beforeAll(async () => {
    const fpeStub: any = {
      getCachePath: () => 'C:/tmp/fhir-cache',
      getContextPackages: () => [],
      resolveMeta: async (query: any) => {
        const { resourceType } = query || {};
        if (resourceType !== 'ConceptMap') throw new Error('Unsupported resourceType');

        if (query.url && metaByIdentifier[query.url]) return metaByIdentifier[query.url];
        if (query.id && metaByIdentifier[query.id]) return metaByIdentifier[query.id];
        if (query.name && metaByIdentifier[query.name]) return metaByIdentifier[query.name];

        throw new Error('Not found');
      },
      resolve: async ({ filename }: any) => {
        resolveCount++;
        const cm = conceptMaps[filename];
        if (!cm) throw new Error('Not found');
        return cm;
      },
      lookupMeta: async () => []
    };

    ftr = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'lazy',
      fhirVersion: '4.0.1'
    });
  });

  it('translates by code-only when unambiguous and filters equivalence', async () => {
    const r1 = await ftr.translateConceptMap('A', 'cm-small');
    expect(r1.status).toBe('mapped');
    if (r1.status !== 'mapped') throw new Error('Expected mapped');
    expect(r1.targets.length).toBe(2);
    expect(r1.targets.find(t => t.code === '1')?.system).toBe('http://example.org/system/target');
    expect(r1.targets.find(t => t.code === 'ALT')?.system).toBe('http://example.org/system/alt-target');

    const r2 = await ftr.translateConceptMap('B', 'cm-small');
    expect(r2.status).toBe('mapped');
    if (r2.status !== 'mapped') throw new Error('Expected mapped');
    expect(r2.targets.map(t => t.code)).toEqual(['3']);
    expect(r2.targets[0].equivalence).toBe('equivalent');
  });

  it('returns duplicate-code for code-only when duplicated across source systems', async () => {
    const r = await ftr.translateConceptMap('DUP', 'cm-dup');
    expect(r).toEqual({ status: 'unmapped', reason: 'duplicate-code' });
  });

  it('returns unsupported-equivalence when source exists but only unsupported target equivalence values are present', async () => {
    const r = await ftr.translateConceptMap('UNSUP', 'cm-small');
    expect(r.status).toBe('unmapped');
    if (r.status !== 'unmapped') throw new Error('Expected unmapped');
    expect(r.reason).toBe('unsupported-equivalence');
    if (r.reason !== 'unsupported-equivalence') throw new Error('Expected unsupported-equivalence');
    expect(r.ignoredEquivalences).toContain('disjoint');
  });

  it('supports system-specific disambiguation', async () => {
    const r = await ftr.translateConceptMap({ system: 'http://example.org/system/source2', code: 'DUP' }, 'cm-dup');
    expect(r.status).toBe('mapped');
    if (r.status !== 'mapped') throw new Error('Expected mapped');
    expect(r.targets.map(t => t.code)).toEqual(['Y']);
  });

  it('primes external cache for large maps and allows cold-start external hits', async () => {
    const externalStore = new Map<string, any>();
    let bulkSetCount = 0;
    let setCount = 0;

    const conceptMapCache: any = {
      getCode: async (cmKey: any, code: string) => {
        const ns = `${cmKey.kind}:${cmKey.kind === 'package' ? `${cmKey.packageId}#${cmKey.packageVersion}::${cmKey.filename}` : `${cmKey.serverBaseUrl}::${cmKey.url}`}`;
        return externalStore.get(`${ns}|${code}`);
      },
      setCode: async (cmKey: any, code: string, entry: any) => {
        setCount++;
        const ns = `${cmKey.kind}:${cmKey.kind === 'package' ? `${cmKey.packageId}#${cmKey.packageVersion}::${cmKey.filename}` : `${cmKey.serverBaseUrl}::${cmKey.url}`}`;
        externalStore.set(`${ns}|${code}`, entry);
      },
      bulkSetCodes: async (cmKey: any, entries: Array<[string, any]>) => {
        bulkSetCount++;
        for (const [code, entry] of entries) {
          await conceptMapCache.setCode(cmKey, code, entry);
        }
      },
      clearNamespace: async (cmKey: any) => {
        const ns = `${cmKey.kind}:${cmKey.kind === 'package' ? `${cmKey.packageId}#${cmKey.packageVersion}::${cmKey.filename}` : `${cmKey.serverBaseUrl}::${cmKey.url}`}`;
        for (const k of Array.from(externalStore.keys())) {
          if (k.startsWith(`${ns}|`)) externalStore.delete(k);
        }
      }
    };

    resolveCount = 0;

    const fpeStub: any = {
      getCachePath: () => 'C:/tmp/fhir-cache',
      getContextPackages: () => [],
      resolveMeta: async (query: any) => {
        if (query.resourceType !== 'ConceptMap') throw new Error('Unsupported');
        if (query.id && metaByIdentifier[query.id]) return metaByIdentifier[query.id];
        throw new Error('Not found');
      },
      resolve: async ({ filename }: any) => {
        resolveCount++;
        const cm = conceptMaps[filename];
        if (!cm) throw new Error('Not found');
        return cm;
      },
      lookupMeta: async () => []
    };

    const ftr1 = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'lazy',
      fhirVersion: '4.0.1',
      conceptMapCache
    });

    const r1 = await ftr1.translateConceptMap('C5', 'cm-large');
    expect(r1.status).toBe('mapped');
    if (r1.status !== 'mapped') throw new Error('Expected mapped');
    expect(r1.targets.map(t => t.code)).toEqual(['T5']);
    expect(bulkSetCount).toBe(1);
    expect(resolveCount).toBe(1);

    // bulk priming writes 60 entries + sentinel, plus one extra setCode from per-lookup sync
    expect(setCount).toBeGreaterThan(61);

    // Ensure per-lookup sync stored a translated entry too
    const ns = `package:${pkg.id}#${pkg.version}::cm-large.json`;
    const entry = externalStore.get(`${ns}|C5`);
    expect(entry?.status).toBe('found');
    expect(entry?.bySourceSystem?.['http://example.org/system/source']?.targets?.[0]?.code).toBe('T5');

    // cold-start: new runtime instance should avoid resolving ConceptMap by using external cache
    resolveCount = 0;
    const ftr2 = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'lazy',
      fhirVersion: '4.0.1',
      conceptMapCache
    });

    const r2 = await ftr2.translateConceptMap('C9', 'cm-large');
    expect(r2.status).toBe('mapped');
    if (r2.status !== 'mapped') throw new Error('Expected mapped');
    expect(r2.targets.map(t => t.code)).toEqual(['T9']);
    expect(resolveCount).toBe(0);
  });

  it('primes external cache without bulkSetCodes (fallback to setCode loop)', async () => {
    const externalStore = new Map<string, any>();
    let setCount = 0;

    const conceptMapCache: any = {
      getCode: async (cmKey: any, code: string) => {
        const ns = `${cmKey.kind}:${cmKey.kind === 'package' ? `${cmKey.packageId}#${cmKey.packageVersion}::${cmKey.filename}` : `${cmKey.serverBaseUrl}::${cmKey.url}`}`;
        return externalStore.get(`${ns}|${code}`);
      },
      setCode: async (cmKey: any, code: string, entry: any) => {
        setCount++;
        const ns = `${cmKey.kind}:${cmKey.kind === 'package' ? `${cmKey.packageId}#${cmKey.packageVersion}::${cmKey.filename}` : `${cmKey.serverBaseUrl}::${cmKey.url}`}`;
        externalStore.set(`${ns}|${code}`, entry);
      },
      clearNamespace: async () => {
        // not used yet
      }
    };

    const fpeStub: any = {
      getCachePath: () => 'C:/tmp/fhir-cache',
      getContextPackages: () => [],
      resolveMeta: async (query: any) => {
        if (query.resourceType !== 'ConceptMap') throw new Error('Unsupported');
        if (query.id && metaByIdentifier[query.id]) return metaByIdentifier[query.id];
        throw new Error('Not found');
      },
      resolve: async ({ filename }: any) => conceptMaps[filename],
      lookupMeta: async () => []
    };

    const ftrLocal = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'lazy',
      fhirVersion: '4.0.1',
      conceptMapCache
    });

    const r = await ftrLocal.translateConceptMap('C1', 'cm-large');
    expect(r.status).toBe('mapped');
    if (r.status !== 'mapped') throw new Error('Expected mapped');
    expect(r.targets.map(t => t.code)).toEqual(['T1']);
    // priming writes a lot, but we just assert it used setCode at least once
    expect(setCount).toBeGreaterThan(1);
  });

  it('can prime external cache for small maps too (covers isSmall branch)', async () => {
    const externalStore = new Map<string, any>();
    let bulkSetCount = 0;

    const conceptMapCache: any = {
      getCode: async (cmKey: any, code: string) => {
        const ns = `${cmKey.kind}:${cmKey.packageId}#${cmKey.packageVersion}::${cmKey.filename}`;
        return externalStore.get(`${ns}|${code}`);
      },
      setCode: async (cmKey: any, code: string, entry: any) => {
        const ns = `${cmKey.kind}:${cmKey.packageId}#${cmKey.packageVersion}::${cmKey.filename}`;
        externalStore.set(`${ns}|${code}`, entry);
      },
      bulkSetCodes: async (cmKey: any, entries: Array<[string, any]>) => {
        bulkSetCount++;
        for (const [code, entry] of entries) {
          await conceptMapCache.setCode(cmKey, code, entry);
        }
      },
      clearNamespace: async () => {
        // not used yet
      }
    };

    const fpeStub: any = {
      getCachePath: () => 'C:/tmp/fhir-cache',
      getContextPackages: () => [],
      resolveMeta: async (query: any) => {
        if (query.resourceType !== 'ConceptMap') throw new Error('Unsupported');
        if (query.id && metaByIdentifier[query.id]) return metaByIdentifier[query.id];
        throw new Error('Not found');
      },
      resolve: async ({ filename }: any) => conceptMaps[filename],
      lookupMeta: async () => []
    };

    const ftrLocal = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'lazy',
      fhirVersion: '4.0.1',
      conceptMapCache
    });

    const r = await ftrLocal.translateConceptMap('A', 'cm-small');
    expect(r.status).toBe('mapped');
    if (r.status !== 'mapped') throw new Error('Expected mapped');
    expect(r.targets.length).toBe(2);
    expect(bulkSetCount).toBe(1);
  });

  it('skips external priming when sentinel already exists', async () => {
    const externalStore = new Map<string, any>();
    let bulkSetCount = 0;
    let setCount = 0;

    const conceptMapCache: any = {
      getCode: async (cmKey: any, code: string) => {
        const ns = `${cmKey.kind}:${cmKey.packageId}#${cmKey.packageVersion}::${cmKey.filename}`;
        return externalStore.get(`${ns}|${code}`);
      },
      setCode: async (cmKey: any, code: string, entry: any) => {
        setCount++;
        const ns = `${cmKey.kind}:${cmKey.packageId}#${cmKey.packageVersion}::${cmKey.filename}`;
        externalStore.set(`${ns}|${code}`, entry);
      },
      bulkSetCodes: async () => {
        bulkSetCount++;
      },
      clearNamespace: async () => {
        // not used yet
      }
    };

    // Pre-seed sentinel so priming short-circuits
    const sentinelNs = `package:${pkg.id}#${pkg.version}::cm-large.json`;
    externalStore.set(`${sentinelNs}|__ftr__primed__`, { status: 'not-found' });

    const fpeStub: any = {
      getCachePath: () => 'C:/tmp/fhir-cache',
      getContextPackages: () => [],
      resolveMeta: async (query: any) => {
        if (query.resourceType !== 'ConceptMap') throw new Error('Unsupported');
        if (query.id && metaByIdentifier[query.id]) return metaByIdentifier[query.id];
        throw new Error('Not found');
      },
      resolve: async ({ filename }: any) => conceptMaps[filename],
      lookupMeta: async () => []
    };

    const ftrLocal = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'lazy',
      fhirVersion: '4.0.1',
      conceptMapCache
    });

    const r = await ftrLocal.translateConceptMap('C2', 'cm-large');
    expect(r.status).toBe('mapped');
    if (r.status !== 'mapped') throw new Error('Expected mapped');
    expect(r.targets.map(t => t.code)).toEqual(['T2']);
    expect(bulkSetCount).toBe(0);

    // With priming skipped, we still expect a translated per-lookup write.
    const entry = externalStore.get(`${sentinelNs}|C2`);
    expect(entry?.status).toBe('found');
    expect(entry?.bySourceSystem?.['http://example.org/system/source']?.targets?.[0]?.code).toBe('T2');
    expect(setCount).toBeGreaterThan(0);
  });

  it('does not attempt sentinel operations when sentinel is a real source code (canUseSentinel=false)', async () => {
    const externalStore = new Map<string, any>();
    let getCount = 0;

    const conceptMapCache: any = {
      getCode: async (cmKey: any, code: string) => {
        getCount++;
        const ns = `${cmKey.kind}:${cmKey.packageId}#${cmKey.packageVersion}::${cmKey.filename}`;
        return externalStore.get(`${ns}|${code}`);
      },
      setCode: async (cmKey: any, code: string, entry: any) => {
        const ns = `${cmKey.kind}:${cmKey.packageId}#${cmKey.packageVersion}::${cmKey.filename}`;
        externalStore.set(`${ns}|${code}`, entry);
      },
      clearNamespace: async () => {
        // not used yet
      }
    };

    const fpeStub: any = {
      getCachePath: () => 'C:/tmp/fhir-cache',
      getContextPackages: () => [],
      resolveMeta: async (query: any) => {
        if (query.resourceType !== 'ConceptMap') throw new Error('Unsupported');
        if (query.id && metaByIdentifier[query.id]) return metaByIdentifier[query.id];
        throw new Error('Not found');
      },
      resolve: async ({ filename }: any) => conceptMaps[filename],
      lookupMeta: async () => []
    };

    const ftrLocal = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'lazy',
      fhirVersion: '4.0.1',
      conceptMapCache
    });

    const r = await ftrLocal.translateConceptMap('__ftr__primed__', 'cm-has-sentinel');
    expect(r.status).toBe('mapped');
    if (r.status !== 'mapped') throw new Error('Expected mapped');
    expect(r.targets.map(t => `${t.system}|${t.code}|${t.version}|${t.display}`)).toEqual([
      'http://example.org/system/target|REAL|1|Real'
    ]);

    // canUseSentinel=false means we should not do a sentinel getCode call,
    // but we will still perform normal external getCode for the real code.
    expect(getCount).toBe(1);
  });

  it('resolves ConceptMap by url and name, and falls back to id when url lookup fails', async () => {
    let urlAttempts = 0;

    const fpeStub: any = {
      getCachePath: () => 'C:/tmp/fhir-cache',
      getContextPackages: () => [],
      resolveMeta: async (query: any) => {
        if (query.resourceType !== 'ConceptMap') throw new Error('Unsupported');
        if (query.url) {
          urlAttempts++;
          // simulate url lookup failure so it falls back to id/name
          throw new Error('No matching resource found');
        }
        if (query.id && metaByIdentifier[query.id]) return metaByIdentifier[query.id];
        if (query.name && metaByIdentifier[query.name]) return metaByIdentifier[query.name];
        throw new Error('Not found');
      },
      resolve: async ({ filename }: any) => conceptMaps[filename],
      lookupMeta: async () => []
    };

    const ftrLocal = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'lazy',
      fhirVersion: '4.0.1'
    });

    // identifier contains ':' => tries url branch first, then id
    const byUrlThenId = await ftrLocal.translateConceptMap('A', 'http://example.org/ConceptMap/cm-small');
    expect(byUrlThenId.status).toBe('mapped');
    if (byUrlThenId.status !== 'mapped') throw new Error('Expected mapped');
    expect(byUrlThenId.targets.length).toBe(2);
    expect(urlAttempts).toBeGreaterThan(0);

    const byName = await ftrLocal.translateConceptMap('A', 'cm-small-name');
    expect(byName.status).toBe('mapped');
    if (byName.status !== 'mapped') throw new Error('Expected mapped');
    expect(byName.targets.length).toBe(2);
  });

  it('falls back to local evaluation when external cache getCode throws', async () => {
    let throws = 0;
    let resolveCalls = 0;

    const conceptMapCache: any = {
      getCode: async () => {
        throws++;
        throw new Error('boom');
      },
      setCode: async () => {
        // ignore
      },
      clearNamespace: async () => {
        // ignore
      }
    };

    const fpeStub: any = {
      getCachePath: () => 'C:/tmp/fhir-cache',
      getContextPackages: () => [],
      resolveMeta: async (query: any) => {
        if (query.resourceType !== 'ConceptMap') throw new Error('Unsupported');
        if (query.id && metaByIdentifier[query.id]) return metaByIdentifier[query.id];
        throw new Error('Not found');
      },
      resolve: async ({ filename }: any) => {
        resolveCalls++;
        return conceptMaps[filename];
      },
      lookupMeta: async () => []
    };

    const ftrLocal = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'lazy',
      fhirVersion: '4.0.1',
      conceptMapCache
    });

    const r = await ftrLocal.translateConceptMap('A', 'cm-small');
    expect(r.status).toBe('mapped');
    if (r.status !== 'mapped') throw new Error('Expected mapped');
    expect(r.targets.length).toBe(2);
    expect(throws).toBeGreaterThan(0);
    expect(resolveCalls).toBe(1);
  });

  it('can return from external cache without loading ConceptMap (including ambiguous code-only external entries)', async () => {
    const externalStore = new Map<string, any>();

    const conceptMapCache: any = {
      getCode: async (cmKey: any, code: string) => {
        const ns = `${cmKey.kind}:${cmKey.packageId}#${cmKey.packageVersion}::${cmKey.filename}`;
        return externalStore.get(`${ns}|${code}`);
      },
      setCode: async () => {
        // not needed
      },
      clearNamespace: async () => {
        // not used yet
      }
    };

    const ns = `package:${pkg.id}#${pkg.version}::cm-dup.json`;
    // External entry with two source systems => ambiguous for code-only
    externalStore.set(`${ns}|DUP`, {
      status: 'found',
      bySourceSystem: {
        'http://example.org/system/source1': { targets: [{ system: 'http://example.org/system/target', code: 'X', equivalence: 'equivalent' }] },
        'http://example.org/system/source2': { targets: [{ system: 'http://example.org/system/target', code: 'Y', equivalence: 'equivalent' }] }
      }
    });

    let resolveCalls = 0;
    const fpeStub: any = {
      getCachePath: () => 'C:/tmp/fhir-cache',
      getContextPackages: () => [],
      resolveMeta: async (query: any) => {
        if (query.resourceType !== 'ConceptMap') throw new Error('Unsupported');
        if (query.id && metaByIdentifier[query.id]) return metaByIdentifier[query.id];
        throw new Error('Not found');
      },
      resolve: async () => {
        resolveCalls++;
        throw new Error('Should not load');
      },
      lookupMeta: async () => []
    };

    const ftrExternalOnly = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'lazy',
      fhirVersion: '4.0.1',
      conceptMapCache
    });

    const r1 = await ftrExternalOnly.translateConceptMap('DUP', 'cm-dup');
    expect(r1).toEqual({ status: 'unmapped', reason: 'duplicate-code' });

    const r2 = await ftrExternalOnly.translateConceptMap({ system: 'http://example.org/system/source1', code: 'DUP' }, 'cm-dup');
    expect(r2.status).toBe('mapped');
    if (r2.status !== 'mapped') throw new Error('Expected mapped');
    expect(r2.targets.map(t => t.code)).toEqual(['X']);

    expect(resolveCalls).toBe(0);
  });

  it('returns unknown-conceptmap when resolved resource is not a ConceptMap', async () => {
    const fpeStub: any = {
      getCachePath: () => 'C:/tmp/fhir-cache',
      getContextPackages: () => [],
      resolveMeta: async (query: any) => {
        if (query.resourceType !== 'ConceptMap') throw new Error('Unsupported');
        if (query.id && metaByIdentifier[query.id]) return metaByIdentifier[query.id];
        throw new Error('Not found');
      },
      resolve: async () => ({ resourceType: 'ValueSet' }),
      lookupMeta: async () => []
    };

    const ftrLocal = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'lazy',
      fhirVersion: '4.0.1'
    });

    const r = await ftrLocal.translateConceptMap('A', 'cm-small');
    expect(r).toEqual({ status: 'unmapped', reason: 'unknown-conceptmap' });
  });

  it('returns unknown-conceptmap when ConceptMap resolve returns undefined', async () => {
    const fpeStub: any = {
      getCachePath: () => 'C:/tmp/fhir-cache',
      getContextPackages: () => [],
      resolveMeta: async (query: any) => {
        if (query.resourceType !== 'ConceptMap') throw new Error('Unsupported');
        if (query.id && metaByIdentifier[query.id]) return metaByIdentifier[query.id];
        throw new Error('Not found');
      },
      resolve: async () => undefined,
      lookupMeta: async () => []
    };

    const ftrLocal = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'lazy',
      fhirVersion: '4.0.1'
    });

    const r = await ftrLocal.translateConceptMap('A', 'cm-small');
    expect(r).toEqual({ status: 'unmapped', reason: 'unknown-conceptmap' });
  });

  it('returns unknown-conceptmap for unknown ConceptMap identifiers', async () => {
    const fpeStub: any = {
      getCachePath: () => 'C:/tmp/fhir-cache',
      getContextPackages: () => [],
      resolveMeta: async () => {
        throw new Error('Not found');
      },
      resolve: async () => {
        throw new Error('Should not load');
      },
      lookupMeta: async () => []
    };

    const ftrLocal = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'lazy',
      fhirVersion: '4.0.1'
    });

    const r = await ftrLocal.translateConceptMap('A', 'does-not-exist');
    expect(r).toEqual({ status: 'unmapped', reason: 'unknown-conceptmap' });
  });

  it('uses hot per-code LRU for large ConceptMaps', async () => {
    let getCount = 0;
    let resolveCalls = 0;

    const conceptMapCache: any = {
      getCode: async () => {
        getCount++;
        return undefined;
      },
      setCode: async () => {
        // ignore
      },
      clearNamespace: async () => {
        // ignore
      }
    };

    const fpeStub: any = {
      getCachePath: () => 'C:/tmp/fhir-cache',
      getContextPackages: () => [],
      resolveMeta: async (query: any) => {
        if (query.resourceType !== 'ConceptMap') throw new Error('Unsupported');
        if (query.id && metaByIdentifier[query.id]) return metaByIdentifier[query.id];
        throw new Error('Not found');
      },
      resolve: async ({ filename }: any) => {
        resolveCalls++;
        return conceptMaps[filename];
      },
      lookupMeta: async () => []
    };

    const ftrLocal = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'lazy',
      fhirVersion: '4.0.1',
      conceptMapCache
    });

    const r1 = await ftrLocal.translateConceptMap('C10', 'cm-large');
    const r2 = await ftrLocal.translateConceptMap('C10', 'cm-large');
    expect(r1.status).toBe('mapped');
    if (r1.status !== 'mapped') throw new Error('Expected mapped');
    expect(r1.targets.map(t => t.code)).toEqual(['T10']);
    expect(r2.status).toBe('mapped');
    if (r2.status !== 'mapped') throw new Error('Expected mapped');
    expect(r2.targets.map(t => t.code)).toEqual(['T10']);

    // second call should be served from in-memory hot LRU (no extra resolve)
    expect(resolveCalls).toBe(1);
    expect(getCount).toBeGreaterThan(0);
  });

  it('returns no-source-code from external cache when entry is not-found', async () => {
    const externalStore = new Map<string, any>();

    const conceptMapCache: any = {
      getCode: async (cmKey: any, code: string) => {
        const ns = `${cmKey.kind}:${cmKey.packageId}#${cmKey.packageVersion}::${cmKey.filename}`;
        return externalStore.get(`${ns}|${code}`);
      },
      setCode: async () => {
        // ignore
      },
      clearNamespace: async () => {
        // ignore
      }
    };

    const ns = `package:${pkg.id}#${pkg.version}::cm-small.json`;
    externalStore.set(`${ns}|Z`, { status: 'not-found' });

    const fpeStub: any = {
      getCachePath: () => 'C:/tmp/fhir-cache',
      getContextPackages: () => [],
      resolveMeta: async (query: any) => {
        if (query.resourceType !== 'ConceptMap') throw new Error('Unsupported');
        if (query.id && metaByIdentifier[query.id]) return metaByIdentifier[query.id];
        throw new Error('Not found');
      },
      resolve: async () => {
        throw new Error('Should not load');
      },
      lookupMeta: async () => []
    };

    const ftrExternalOnly = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'lazy',
      fhirVersion: '4.0.1',
      conceptMapCache
    });

    const r = await ftrExternalOnly.translateConceptMap('Z', 'cm-small');
    expect(r).toEqual({ status: 'unmapped', reason: 'no-source-code' });
  });
});

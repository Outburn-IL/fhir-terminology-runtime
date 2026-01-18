import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import fs from 'fs-extra';
import { FhirTerminologyRuntime } from '../src/index';
import { ImplicitCodeSystemRegistry } from '../src/utils/terminology/implicitCodeSystems';
import { version as ftrVersion } from '../package.json';

const FTR_VERSION_EXTENSION_URL = 'http://fhir.fume.health/StructureDefinition/ftr-version';
const FTR_EXPANSION_FAILED_EXTENSION_URL = 'http://fhir.fume.health/StructureDefinition/ftr-expansion-failed';

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

  it('writes a cached failure stub extension when expansion fails without fallback (cacheMode != none)', async () => {
    const tempCachePath = path.join(
      process.cwd(),
      'test',
      `.tmp-cache-failure-stub-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    await fs.remove(tempCachePath);

    const vsFilename = 'vs-unexpandable.json';
    const fpeStub: any = {
      getCachePath: () => tempCachePath,
      async resolve(args: any) {
        if (args.filename !== vsFilename) throw new Error(`File not found: ${args.filename}`);
        return {
          resourceType: 'ValueSet',
          id: 'vs-unexpandable',
          url: 'http://example.org/ValueSet/vs-unexpandable',
          compose: {
            include: [
              {
                system: 'http://example.org/system',
                // Triggers the unsupported filter path (no fallback expansion present)
                filter: [{ property: 'concept', op: 'is-a', value: 'X' }]
              }
            ]
          }
        };
      }
    };

    const ftrWithCache = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'lazy',
      fhirVersion: '4.0.1'
    });

    const meta: any = { resourceType: 'ValueSet', filename: vsFilename, __packageId: pkg.id, __packageVersion: pkg.version };

    await expect((ftrWithCache as any).expandValueSetByMeta(meta)).rejects.toThrow('Unsupported ValueSet.include.filter');

    const cacheFilePath = (ftrWithCache as any).getCacheFilePath(vsFilename, pkg.id, pkg.version);
    expect(await fs.pathExists(cacheFilePath)).toBe(true);

    const cached = await fs.readJSON(cacheFilePath);
    expect(cached?.expansion?.__failure).not.toBe(true);
    const exts = Array.isArray(cached?.expansion?.extension) ? cached.expansion.extension : [];
    expect(exts.some((e: any) => e?.url === FTR_VERSION_EXTENSION_URL && e?.valueCode === ftrVersion)).toBe(true);
    expect(exts.some((e: any) => e?.url === FTR_EXPANSION_FAILED_EXTENSION_URL && e?.valueBoolean === true)).toBe(true);

    await fs.remove(tempCachePath);
  });

  it('falls back to pre-existing expansion and caches it when generation fails (cacheMode != none)', async () => {
    const tempCachePath = path.join(
      process.cwd(),
      'test',
      `.tmp-cache-fallback-expansion-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    await fs.remove(tempCachePath);

    const vsFilename = 'vs-has-fallback-expansion.json';
    const originalVs = {
      resourceType: 'ValueSet',
      id: 'vs-has-fallback-expansion',
      url: 'http://example.org/ValueSet/vs-has-fallback-expansion',
      compose: {
        include: [
          {
            system: 'http://example.org/system',
            // Triggers the unsupported filter path in expansion generation.
            filter: [{ property: 'concept', op: 'is-a', value: 'X' }]
          }
        ]
      },
      // Pre-existing fallback expansion
      expansion: {
        timestamp: '2020-01-01T00:00:00.000Z',
        total: 1,
        contains: [{ system: 'http://example.org/system', code: 'A', display: 'Alpha' }]
      }
    };

    const fpeStub: any = {
      getCachePath: () => tempCachePath,
      async resolve(args: any) {
        if (args.filename !== vsFilename) throw new Error(`File not found: ${args.filename}`);
        return originalVs;
      }
    };

    const ftrWithCache = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'lazy',
      fhirVersion: '4.0.1'
    });

    const meta: any = { resourceType: 'ValueSet', filename: vsFilename, __packageId: pkg.id, __packageVersion: pkg.version };

    const expanded = await (ftrWithCache as any).expandValueSetByMeta(meta);
    expect(expanded).toBeDefined();
    expect(expanded.expansion?.contains?.length).toBe(1);
    expect(expanded.expansion.contains[0]?.code).toBe('A');

    const cacheFilePath = (ftrWithCache as any).getCacheFilePath(vsFilename, pkg.id, pkg.version);
    expect(await fs.pathExists(cacheFilePath)).toBe(true);

    const cached = await fs.readJSON(cacheFilePath);
    expect(cached?.expansion?.__failure).not.toBe(true);
    const exts = Array.isArray(cached?.expansion?.extension) ? cached.expansion.extension : [];
    expect(exts.some((e: any) => e?.url === FTR_EXPANSION_FAILED_EXTENSION_URL)).toBe(false);
    expect(cached?.expansion?.contains?.[0]?.code).toBe('A');

    await fs.remove(tempCachePath);
  });

  it('expands successfully and caches the generated expansion (cacheMode != none)', async () => {
    const tempCachePath = path.join(
      process.cwd(),
      'test',
      `.tmp-cache-success-expansion-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    await fs.remove(tempCachePath);

    const vsFilename = 'vs-expandable.json';
    const originalVs = {
      resourceType: 'ValueSet',
      id: 'vs-expandable',
      url: 'http://example.org/ValueSet/vs-expandable',
      compose: {
        include: [
          {
            system: 'http://example.org/system',
            concept: [
              { code: 'A', display: 'Alpha' },
              { code: 'B', display: 'Beta' }
            ]
          }
        ]
      }
    };

    const fpeStub: any = {
      getCachePath: () => tempCachePath,
      getContextPackages: () => [pkg],
      async resolve(args: any) {
        if (args.filename !== vsFilename) throw new Error(`File not found: ${args.filename}`);
        return originalVs;
      },
      async lookupMeta() {
        return [];
      }
    };

    const ftrWithCache = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'lazy',
      fhirVersion: '4.0.1'
    });

    const meta: any = { resourceType: 'ValueSet', filename: vsFilename, __packageId: pkg.id, __packageVersion: pkg.version };

    const expanded = await (ftrWithCache as any).expandValueSetByMeta(meta);
    expect(expanded?.expansion?.total).toBe(2);
    expect(Array.isArray(expanded?.expansion?.contains)).toBe(true);

    const cacheFilePath = (ftrWithCache as any).getCacheFilePath(vsFilename, pkg.id, pkg.version);
    expect(await fs.pathExists(cacheFilePath)).toBe(true);

    const cached = await fs.readJSON(cacheFilePath);
    expect(cached?.expansion?.__failure).not.toBe(true);
    const exts = Array.isArray(cached?.expansion?.extension) ? cached.expansion.extension : [];
    expect(exts.some((e: any) => e?.url === FTR_EXPANSION_FAILED_EXTENSION_URL)).toBe(false);
    expect(cached?.expansion?.total).toBe(2);

    await fs.remove(tempCachePath);
  });

  it('supports compose.exclude (removes excluded codes from expansion)', async () => {
    const tempCachePath = path.join(
      process.cwd(),
      'test',
      `.tmp-cache-include-exclude-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    await fs.remove(tempCachePath);

    const vsFilename = 'vs-include-exclude.json';
    const system = 'http://example.org/system';
    const originalVs = {
      resourceType: 'ValueSet',
      id: 'vs-include-exclude',
      url: 'http://example.org/ValueSet/vs-include-exclude',
      compose: {
        include: [
          {
            system,
            concept: [
              { code: 'A', display: 'Alpha' },
              { code: 'B', display: 'Beta' }
            ]
          }
        ],
        exclude: [
          {
            system,
            concept: [{ code: 'B', display: 'Beta' }]
          }
        ]
      }
    };

    const fpeStub: any = {
      getCachePath: () => tempCachePath,
      async resolve(args: any) {
        if (args.filename !== vsFilename) throw new Error(`File not found: ${args.filename}`);
        return originalVs;
      }
    };

    const ftrNoCache = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'none',
      fhirVersion: '4.0.1'
    });

    const meta: any = { resourceType: 'ValueSet', filename: vsFilename, __packageId: pkg.id, __packageVersion: pkg.version };
    const expanded = await (ftrNoCache as any).expandValueSetByMeta(meta);

    const contains = Array.isArray(expanded?.expansion?.contains) ? expanded.expansion.contains : [];
    const codes = contains.filter((c: any) => c?.system === system).map((c: any) => c.code);
    expect(codes).toContain('A');
    expect(codes).not.toContain('B');

    await fs.remove(tempCachePath);
  });

  it('throws when a cached expansion is a failure stub from the same runtime version (short-circuit)', async () => {
    const tempCachePath = path.join(
      process.cwd(),
      'test',
      `.tmp-cache-read-failure-stub-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    await fs.remove(tempCachePath);

    const vsFilename = 'vs-cached-failure.json';
    const fpeStub: any = {
      getCachePath: () => tempCachePath,
      async resolve(args: any) {
        if (args.filename !== vsFilename) throw new Error(`File not found: ${args.filename}`);
        return {
          resourceType: 'ValueSet',
          id: 'vs-cached-failure',
          url: 'http://example.org/ValueSet/vs-cached-failure'
        };
      }
    };

    const ftrWithCache = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'lazy',
      fhirVersion: '4.0.1'
    });

    const meta: any = { resourceType: 'ValueSet', filename: vsFilename, __packageId: pkg.id, __packageVersion: pkg.version };
    const cacheFilePath = (ftrWithCache as any).getCacheFilePath(vsFilename, pkg.id, pkg.version);
    await fs.ensureDir(path.dirname(cacheFilePath));
    await fs.writeJSON(cacheFilePath, {
      resourceType: 'ValueSet',
      id: 'vs-cached-failure',
      url: 'http://example.org/ValueSet/vs-cached-failure',
      expansion: {
        extension: [
          { url: FTR_VERSION_EXTENSION_URL, valueCode: ftrVersion },
          { url: FTR_EXPANSION_FAILED_EXTENSION_URL, valueBoolean: true }
        ]
      }
    });

    await expect((ftrWithCache as any).expandValueSetByMeta(meta)).rejects.toThrow('Previous expansion attempt failed');

    await fs.remove(tempCachePath);
  });

  it('re-attempts expansion when a cached failure stub is from a different runtime version', async () => {
    const tempCachePath = path.join(
      process.cwd(),
      'test',
      `.tmp-cache-read-failure-stub-version-mismatch-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    await fs.remove(tempCachePath);

    const vsFilename = 'vs-cached-failure-old-version.json';
    const originalVs = {
      resourceType: 'ValueSet',
      id: 'vs-cached-failure-old-version',
      url: 'http://example.org/ValueSet/vs-cached-failure-old-version',
      compose: {
        include: [
          {
            system: 'http://example.org/system',
            concept: [
              { code: 'A', display: 'Alpha' },
              { code: 'B', display: 'Beta' }
            ]
          }
        ]
      }
    };

    const fpeStub: any = {
      getCachePath: () => tempCachePath,
      getContextPackages: () => [pkg],
      async resolve(args: any) {
        if (args.filename !== vsFilename) throw new Error(`File not found: ${args.filename}`);
        return originalVs;
      },
      async lookupMeta() {
        return [];
      }
    };

    const ftrWithCache = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'lazy',
      fhirVersion: '4.0.1'
    });

    const meta: any = { resourceType: 'ValueSet', filename: vsFilename, __packageId: pkg.id, __packageVersion: pkg.version };
    const cacheFilePath = (ftrWithCache as any).getCacheFilePath(vsFilename, pkg.id, pkg.version);
    await fs.ensureDir(path.dirname(cacheFilePath));
    await fs.writeJSON(cacheFilePath, {
      resourceType: 'ValueSet',
      id: 'vs-cached-failure-old-version',
      url: 'http://example.org/ValueSet/vs-cached-failure-old-version',
      expansion: {
        extension: [
          { url: FTR_VERSION_EXTENSION_URL, valueCode: '0.0.0' },
          { url: FTR_EXPANSION_FAILED_EXTENSION_URL, valueBoolean: true }
        ]
      }
    });

    const expanded = await (ftrWithCache as any).expandValueSetByMeta(meta);
    expect(expanded?.expansion?.total).toBe(2);
    expect(Array.isArray(expanded?.expansion?.contains)).toBe(true);

    const cachedAfter = await fs.readJSON(cacheFilePath);
    const exts = Array.isArray(cachedAfter?.expansion?.extension) ? cachedAfter.expansion.extension : [];
    expect(exts.some((e: any) => e?.url === FTR_EXPANSION_FAILED_EXTENSION_URL)).toBe(false);
    expect(exts.some((e: any) => e?.url === FTR_VERSION_EXTENSION_URL && e?.valueCode === ftrVersion)).toBe(true);

    await fs.remove(tempCachePath);
  });

  it('falls back to implicit CodeSystem concepts when full CodeSystem resolution fails (all concepts)', async () => {
    const tempCachePath = path.join(
      process.cwd(),
      'test',
      `.tmp-cache-implicit-fallback-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    await fs.remove(tempCachePath);

    const systemUrl = 'urn:iso:std:iso:3166';
    const vsFilename = 'vs-implicit-fallback.json';
    const fpeStub: any = {
      getCachePath: () => tempCachePath,
      async resolve(args: any) {
        if (args.filename !== vsFilename) throw new Error(`File not found: ${args.filename}`);
        return {
          resourceType: 'ValueSet',
          id: 'vs-implicit-fallback',
          url: 'http://example.org/ValueSet/vs-implicit-fallback',
          compose: { include: [{ system: systemUrl }] }
        };
      }
    };

    const ftrLocal = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'none',
      fhirVersion: '4.0.1'
    });

    (ftrLocal as any).resolveCompleteCodeSystem = async () => {
      throw new Error('boom');
    };

    const originalGetConcepts = ImplicitCodeSystemRegistry.getConcepts;
    (ImplicitCodeSystemRegistry as any).getConcepts = (canonicalUrl: string) => {
      if (canonicalUrl !== systemUrl) return undefined;
      return new Map<string, string | undefined>([
        ['US', 'United States'],
        ['GB', 'United Kingdom']
      ]);
    };

    try {
      const meta: any = { resourceType: 'ValueSet', filename: vsFilename, __packageId: pkg.id, __packageVersion: pkg.version };
      const expanded = await (ftrLocal as any).expandValueSetByMeta(meta);
      expect(expanded?.expansion?.total).toBe(2);
      const contains = Array.isArray(expanded?.expansion?.contains) ? expanded.expansion.contains : [];
      const codes = contains.filter((c: any) => c?.system === systemUrl).map((c: any) => c.code);
      expect(codes).toContain('US');
      expect(codes).toContain('GB');
    } finally {
      (ImplicitCodeSystemRegistry as any).getConcepts = originalGetConcepts;
      await fs.remove(tempCachePath);
    }
  });

  it('rethrows when implicit CodeSystem fallback has no concepts (all concepts)', async () => {
    const tempCachePath = path.join(
      process.cwd(),
      'test',
      `.tmp-cache-implicit-no-concepts-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    await fs.remove(tempCachePath);

    const systemUrl = 'urn:iso:std:iso:3166';
    const vsFilename = 'vs-implicit-no-concepts.json';
    const fpeStub: any = {
      getCachePath: () => tempCachePath,
      async resolve(args: any) {
        if (args.filename !== vsFilename) throw new Error(`File not found: ${args.filename}`);
        return {
          resourceType: 'ValueSet',
          id: 'vs-implicit-no-concepts',
          url: 'http://example.org/ValueSet/vs-implicit-no-concepts',
          compose: { include: [{ system: systemUrl }] }
        };
      }
    };

    const ftrLocal = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'none',
      fhirVersion: '4.0.1'
    });

    (ftrLocal as any).resolveCompleteCodeSystem = async () => {
      throw new Error('boom');
    };

    const originalGetConcepts = ImplicitCodeSystemRegistry.getConcepts;
    (ImplicitCodeSystemRegistry as any).getConcepts = () => undefined;

    try {
      const meta: any = { resourceType: 'ValueSet', filename: vsFilename, __packageId: pkg.id, __packageVersion: pkg.version };
      await expect((ftrLocal as any).expandValueSetByMeta(meta)).rejects.toThrow('boom');
    } finally {
      (ImplicitCodeSystemRegistry as any).getConcepts = originalGetConcepts;
      await fs.remove(tempCachePath);
    }
  });

  it('rethrows when full CodeSystem resolution fails for non-implicit CodeSystems (all concepts)', async () => {
    const tempCachePath = path.join(
      process.cwd(),
      'test',
      `.tmp-cache-non-implicit-failure-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    await fs.remove(tempCachePath);

    const systemUrl = 'http://example.org/non-implicit';
    const vsFilename = 'vs-non-implicit-failure.json';
    const fpeStub: any = {
      getCachePath: () => tempCachePath,
      async resolve(args: any) {
        if (args.filename !== vsFilename) throw new Error(`File not found: ${args.filename}`);
        return {
          resourceType: 'ValueSet',
          id: 'vs-non-implicit-failure',
          url: 'http://example.org/ValueSet/vs-non-implicit-failure',
          compose: { include: [{ system: systemUrl }] }
        };
      }
    };

    const ftrLocal = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'none',
      fhirVersion: '4.0.1'
    });

    (ftrLocal as any).resolveCompleteCodeSystem = async () => {
      throw new Error('boom');
    };

    const meta: any = { resourceType: 'ValueSet', filename: vsFilename, __packageId: pkg.id, __packageVersion: pkg.version };
    await expect((ftrLocal as any).expandValueSetByMeta(meta)).rejects.toThrow('boom');

    await fs.remove(tempCachePath);
  });
});

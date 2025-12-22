import { describe, it, expect } from 'vitest';
import { FhirTerminologyRuntime } from '../src/index';

describe('resolveCompleteCodeSystem (unit)', () => {
  const pkg = { id: 'test.pkg', version: '1.0.0' };

  function makeFtrWithFpe(fpeStub: any) {
    return FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'none',
      fhirVersion: '4.0.1'
    });
  }

  it('returns a synthetic CodeSystem for implicit systems', async () => {
    const fpeStub: any = {
      getCachePath: () => './test/.test-cache',
      getContextPackages: () => [pkg],
      async resolveMeta() {
        throw new Error('should not be called for implicit systems');
      },
      async resolve() {
        throw new Error('should not be called for implicit systems');
      },
      async lookupMeta() {
        return [];
      }
    };

    const ftr = await makeFtrWithFpe(fpeStub);
    const cs = await ftr.resolveCompleteCodeSystem('urn:iso:std:iso:3166', pkg);

    expect(cs.resourceType).toBe('CodeSystem');
    expect(cs.url).toBe('urn:iso:std:iso:3166');
    expect(cs.content).toBe('complete');
    expect(Array.isArray(cs.concept)).toBe(true);
    expect(cs.concept.length).toBeGreaterThan(0);
  });

  it('throws when url is missing', async () => {
    const fpeStub: any = {
      getCachePath: () => './test/.test-cache',
      getContextPackages: () => [pkg],
      async resolveMeta() {
        return undefined;
      },
      async resolve() {
        return undefined;
      },
      async lookupMeta() {
        return [];
      }
    };

    const ftr = await makeFtrWithFpe(fpeStub);
    await expect(ftr.resolveCompleteCodeSystem('', pkg)).rejects.toThrow('CodeSystem canonical URL missing');
  });

  it('throws if CodeSystem metadata content is not complete', async () => {
    const fpeStub: any = {
      getCachePath: () => './test/.test-cache',
      getContextPackages: () => [pkg],
      async resolveMeta(query: any) {
        if (query.resourceType !== 'CodeSystem') throw new Error('unexpected');
        return {
          resourceType: 'CodeSystem',
          url: query.url,
          filename: 'cs.json',
          __packageId: pkg.id,
          __packageVersion: pkg.version,
          content: 'not-present'
        };
      },
      async resolve() {
        return undefined;
      },
      async lookupMeta() {
        return [];
      }
    };

    const ftr = await makeFtrWithFpe(fpeStub);
    await expect(ftr.resolveCompleteCodeSystem('http://example.org/cs', pkg)).rejects.toThrow('cannot be expanded');
  });

  it('throws if resolved resource is not a CodeSystem', async () => {
    const fpeStub: any = {
      getCachePath: () => './test/.test-cache',
      getContextPackages: () => [pkg],
      async resolveMeta(query: any) {
        if (query.resourceType !== 'CodeSystem') throw new Error('unexpected');
        return {
          resourceType: 'CodeSystem',
          url: query.url,
          filename: 'cs.json',
          __packageId: pkg.id,
          __packageVersion: pkg.version,
          content: 'complete'
        };
      },
      async resolve() {
        return { resourceType: 'ValueSet' };
      },
      async lookupMeta() {
        return [];
      }
    };

    const ftr = await makeFtrWithFpe(fpeStub);
    await expect(ftr.resolveCompleteCodeSystem('http://example.org/cs', pkg)).rejects.toThrow('is not a CodeSystem');
  });

  it('throws if resolved CodeSystem content is not complete', async () => {
    const fpeStub: any = {
      getCachePath: () => './test/.test-cache',
      getContextPackages: () => [pkg],
      async resolveMeta(query: any) {
        if (query.resourceType !== 'CodeSystem') throw new Error('unexpected');
        return {
          resourceType: 'CodeSystem',
          url: query.url,
          filename: 'cs.json',
          __packageId: pkg.id,
          __packageVersion: pkg.version,
          content: 'complete'
        };
      },
      async resolve() {
        return { resourceType: 'CodeSystem', content: 'not-present' };
      },
      async lookupMeta() {
        return [];
      }
    };

    const ftr = await makeFtrWithFpe(fpeStub);
    await expect(ftr.resolveCompleteCodeSystem('http://example.org/cs', pkg)).rejects.toThrow('cannot be expanded');
  });
});

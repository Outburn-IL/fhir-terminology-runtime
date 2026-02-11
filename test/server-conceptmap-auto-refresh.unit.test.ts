import { describe, test, expect, beforeAll, afterEach, vi } from 'vitest';
import { FhirTerminologyRuntime } from '../src/index';
import { FhirPackageExplorer } from 'fhir-package-explorer';
import path from 'path';

const cachePath = path.join(process.cwd(), 'test', '.test-cache');

const baseUrl = 'http://test.example';

function makeConceptMap(versionId: string, targetCode: string) {
  return {
    resourceType: 'ConceptMap',
    id: 'cm1',
    meta: { versionId },
    group: [
      {
        source: 'http://src',
        target: 'http://tgt',
        element: [
          {
            code: 'A',
            target: [
              {
                code: targetCode,
                equivalence: 'equivalent'
              }
            ]
          }
        ]
      }
    ]
  };
}

function makeLargeConceptMap(versionId: string, targetPrefix: string) {
  const elements = Array.from({ length: 51 }).map((_, i) => ({
    code: `C${i}`,
    target: [
      {
        code: `${targetPrefix}${i}`,
        equivalence: 'equivalent'
      }
    ]
  }));

  return {
    resourceType: 'ConceptMap',
    id: 'cm1',
    meta: { versionId },
    group: [
      {
        source: 'http://src',
        target: 'http://tgt',
        element: elements
      }
    ]
  };
}

describe('Server ConceptMap auto-refresh', () => {
  let fpe: FhirPackageExplorer;

  beforeAll(async () => {
    fpe = await FhirPackageExplorer.create({
      cachePath,
      context: ['il.core.fhir.r4#0.17.0'],
      skipExamples: true,
      fhirVersion: '4.0.1'
    });
  }, 120000);

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('polling evicts/refreshes caches only on real ConceptMap content changes', async () => {
    vi.useFakeTimers();

    const external = {
      getCode: vi.fn(async () => undefined),
      setCode: vi.fn(async () => undefined),
      bulkSetCodes: vi.fn(async () => undefined),
      clearNamespace: vi.fn(async () => undefined)
    };

    const cmV1 = makeConceptMap('1', 'B');
    const cmV2 = makeConceptMap('2', 'C');

    const conditionalQueue: Array<any> = [
      { status: 304, headers: {}, resource: undefined },
      { status: 200, headers: { etag: 'W/"2"' }, resource: cmV2 }
    ];

    const fhirClient = {
      getBaseUrl: () => baseUrl,
      resolve: vi.fn(async (resourceOrLiteral: string) => {
        if (resourceOrLiteral === 'ConceptMap/cm1') return cmV1;
        throw new Error(`unexpected resolve: ${resourceOrLiteral}`);
      }),
      conditionalRead: vi.fn(async () => {
        const next = conditionalQueue.shift();
        return next ?? { status: 304, headers: {}, resource: undefined };
      })
    };

    const ftr = await FhirTerminologyRuntime.create({
      fpe,
      fhirVersion: '4.0.1',
      cacheMode: 'lazy',
      fhirClient,
      conceptMapCache: external as any,
      serverConceptMapPollingIntervalMs: 50
    });

    // Initial load (starts tracking + timer)
    const r1 = await ftr.translateConceptMap('A', 'cm1');
    expect(r1.status).toBe('mapped');

    // First poll: 304 -> no eviction
    await vi.advanceTimersByTimeAsync(55);
    expect(fhirClient.conditionalRead).toHaveBeenCalledTimes(1);
    expect(external.clearNamespace).toHaveBeenCalledTimes(0);

    // Second poll: 200 with changed content -> eviction/clearNamespace
    await vi.advanceTimersByTimeAsync(55);
    expect(fhirClient.conditionalRead).toHaveBeenCalledTimes(2);

    const expectedPrefix = `server:${baseUrl}/ConceptMap/cm1`;
    expect(external.clearNamespace).toHaveBeenCalledWith(expectedPrefix);

    // Verify the runtime returns updated translation after refresh.
    const r2 = await ftr.translateConceptMap('A', 'cm1');
    expect(r2.status).toBe('mapped');
    if (r2.status === 'mapped') {
      expect(r2.targets[0].code).toBe('C');
    }
  }, 120000);

  test('falls back to 1-hour polling with warning when conditional reads appear unsupported', async () => {
    vi.useFakeTimers();

    const warn = vi.fn();

    const cmV1 = makeConceptMap('1', 'B');

    const fhirClient = {
      getBaseUrl: () => baseUrl,
      resolve: vi.fn(async (resourceOrLiteral: string) => {
        if (resourceOrLiteral === 'ConceptMap/cm1') return cmV1;
        throw new Error(`unexpected resolve: ${resourceOrLiteral}`);
      }),
      // Always returns full content even when unchanged
      conditionalRead: vi.fn(async () => ({ status: 200, headers: { etag: 'W/"1"' }, resource: cmV1 }))
    };

    const ftr = await FhirTerminologyRuntime.create({
      fpe,
      fhirVersion: '4.0.1',
      cacheMode: 'lazy',
      fhirClient,
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } as any,
      serverConceptMapPollingIntervalMs: 50
    });

    await ftr.translateConceptMap('A', 'cm1');

    // First poll triggers unsupported detection + warning + interval reduction.
    await vi.advanceTimersByTimeAsync(55);
    expect(fhirClient.conditionalRead).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);

    // After reduction to 1 hour, advancing a short time should not trigger more polls.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fhirClient.conditionalRead).toHaveBeenCalledTimes(1);
  }, 120000);

  test('evicts caches on 410 and stops polling that ConceptMap', async () => {
    vi.useFakeTimers();

    const external = {
      getCode: vi.fn(async () => undefined),
      setCode: vi.fn(async () => undefined),
      bulkSetCodes: vi.fn(async () => undefined),
      clearNamespace: vi.fn(async () => undefined)
    };

    const cmV1 = makeConceptMap('1', 'B');

    const fhirClient = {
      getBaseUrl: () => baseUrl,
      resolve: vi.fn(async (resourceOrLiteral: string) => {
        if (resourceOrLiteral === 'ConceptMap/cm1') return cmV1;
        throw new Error(`unexpected resolve: ${resourceOrLiteral}`);
      }),
      conditionalRead: vi.fn(async () => ({ status: 410, headers: {}, resource: undefined }))
    };

    const ftr = await FhirTerminologyRuntime.create({
      fpe,
      fhirVersion: '4.0.1',
      cacheMode: 'lazy',
      fhirClient,
      conceptMapCache: external as any,
      serverConceptMapPollingIntervalMs: 50
    });

    await ftr.translateConceptMap('A', 'cm1');

    await vi.advanceTimersByTimeAsync(55);
    expect(fhirClient.conditionalRead).toHaveBeenCalledTimes(1);

    const expectedPrefix = `server:${baseUrl}/ConceptMap/cm1`;
    expect(external.clearNamespace).toHaveBeenCalledWith(expectedPrefix);

    // If we advance again, the CM should have been removed from the refresh set.
    await vi.advanceTimersByTimeAsync(200);
    expect(fhirClient.conditionalRead).toHaveBeenCalledTimes(1);
  }, 120000);

  test('warns and reduces polling when no version signals are present', async () => {
    vi.useFakeTimers();

    const warn = vi.fn();
    const cmNoMeta = {
      resourceType: 'ConceptMap',
      id: 'cm1',
      group: [
        {
          source: 'http://src',
          target: 'http://tgt',
          element: [
            {
              code: 'A',
              target: [{ code: 'B', equivalence: 'equivalent' }]
            }
          ]
        }
      ]
    };

    const fhirClient = {
      getBaseUrl: () => baseUrl,
      resolve: vi.fn(async (resourceOrLiteral: string) => {
        if (resourceOrLiteral === 'ConceptMap/cm1') return cmNoMeta;
        throw new Error(`unexpected resolve: ${resourceOrLiteral}`);
      }),
      conditionalRead: vi.fn(async () => ({ status: 200, headers: {}, resource: cmNoMeta }))
    };

    const ftr = await FhirTerminologyRuntime.create({
      fpe,
      fhirVersion: '4.0.1',
      cacheMode: 'lazy',
      fhirClient,
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } as any,
      serverConceptMapPollingIntervalMs: 50
    });

    await ftr.translateConceptMap('A', 'cm1');
    await vi.advanceTimersByTimeAsync(55);

    expect(warn).toHaveBeenCalledTimes(1);
  }, 120000);

  test('refresh primes external cache for large ConceptMaps (isSmall=false path)', async () => {
    vi.useFakeTimers();

    const external = {
      getCode: vi.fn(async () => undefined),
      setCode: vi.fn(async () => undefined),
      bulkSetCodes: vi.fn(async () => undefined),
      clearNamespace: vi.fn(async () => undefined)
    };

    const cmV1 = makeLargeConceptMap('1', 'T');
    const cmV2 = makeLargeConceptMap('2', 'U');

    const conditionalQueue: Array<any> = [
      { status: 200, headers: { etag: 'W/"2"' }, resource: cmV2 }
    ];

    const fhirClient = {
      getBaseUrl: () => baseUrl,
      resolve: vi.fn(async (resourceOrLiteral: string) => {
        if (resourceOrLiteral === 'ConceptMap/cm1') return cmV1;
        throw new Error(`unexpected resolve: ${resourceOrLiteral}`);
      }),
      conditionalRead: vi.fn(async () => conditionalQueue.shift() ?? { status: 304, headers: {}, resource: undefined })
    };

    const ftr = await FhirTerminologyRuntime.create({
      fpe,
      fhirVersion: '4.0.1',
      cacheMode: 'lazy',
      fhirClient,
      conceptMapCache: external as any,
      serverConceptMapPollingIntervalMs: 50
    });

    // Initial load primes external once.
    const r1 = await ftr.translateConceptMap('C0', 'cm1');
    expect(r1.status).toBe('mapped');
    expect(external.bulkSetCodes).toHaveBeenCalledTimes(1);

    // Poll triggers change refresh + primes external again for the new content.
    await vi.advanceTimersByTimeAsync(55);
    expect(external.clearNamespace).toHaveBeenCalledTimes(1);
    expect(external.bulkSetCodes).toHaveBeenCalledTimes(2);
  }, 120000);
});

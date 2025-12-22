import { describe, it, expect, beforeAll } from 'vitest';
import { FhirTerminologyRuntime } from '../src/index';

describe('ValueSet expansion count (integration)', () => {
  const cachePath = './test/.test-cache';
  const context = ['il.core.fhir.r4#0.17.0'];
  let ftr: FhirTerminologyRuntime;

  beforeAll(async () => {
    const { FhirPackageExplorer } = await import('fhir-package-explorer');
    const fpe = await FhirPackageExplorer.create({ cachePath, context, skipExamples: true, fhirVersion: '4.0.1' });
    ftr = await FhirTerminologyRuntime.create({ fpe, cacheMode: 'none', fhirVersion: '4.0.1' });
  }, 120000);

  it('administrative-gender: should return correct count', async () => {
    const result = await ftr.getValueSetExpansionCount('administrative-gender');
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.count).toBe(4);
    }
  });

  it('unknown-valueset: should return unknown status', async () => {
    const result = await ftr.getValueSetExpansionCount('non-existent-valueset');
    expect(result.status).toBe('unknown');
    if (result.status === 'unknown') {
      expect(result.reason).toBe('unknown-valueset');
    }
  });

  it('example-intensional: should return unexpandable status', async () => {
    // This ValueSet has a filter which is currently unsupported, so expansion throws
    const result = await ftr.getValueSetExpansionCount('example-intensional');
    expect(result.status).toBe('unknown');
    if (result.status === 'unknown') {
      expect(result.reason).toBe('unexpandable-valueset');
    }
  });

  it('should cache results', async () => {
    const result1 = await ftr.getValueSetExpansionCount('administrative-gender');
    const result2 = await ftr.getValueSetExpansionCount('administrative-gender');
    expect(result1).toBe(result2); // Should be same object reference if cached
  });
});

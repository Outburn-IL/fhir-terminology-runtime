/**
 * Test for dependency injection pattern with FhirPackageExplorer
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { FhirTerminologyRuntime } from '../src/index';
import { FhirPackageExplorer } from 'fhir-package-explorer';
import path from 'path';

const cachePath = path.join(process.cwd(), 'test', '.test-cache');

describe('Dependency Injection Pattern', () => {
  let sharedFpe: FhirPackageExplorer;
  let ftr1: FhirTerminologyRuntime;
  let ftr2: FhirTerminologyRuntime;

  beforeAll(async () => {
    // Create a single FPE instance to be shared across multiple FTR instances
    sharedFpe = await FhirPackageExplorer.create({
      cachePath,
      context: ['il.core.fhir.r4#0.17.0'],
      skipExamples: true,
      fhirVersion: '4.0.1'
    });

    // Create two FTR instances sharing the same FPE
    ftr1 = await FhirTerminologyRuntime.create({
      fpe: sharedFpe,
      cacheMode: 'lazy',
      fhirVersion: '4.0.1'
    });

    ftr2 = await FhirTerminologyRuntime.create({
      fpe: sharedFpe,
      cacheMode: 'none',
      fhirVersion: '4.0.1'
    });
  }, 120000);

  test('both FTR instances share the same FPE', () => {
    expect(ftr1.getFpe()).toBe(sharedFpe);
    expect(ftr2.getFpe()).toBe(sharedFpe);
    expect(ftr1.getFpe()).toBe(ftr2.getFpe());
  });

  test('FTR instance using DI can expand ValueSets', async () => {
    const vs = await ftr1.expandValueSet('administrative-gender');
    expect(vs?.expansion?.contains).toBeTruthy();
    expect(vs.expansion.contains.length).toBeGreaterThan(0);
  });

  test('multiple FTR instances can use the same FPE with different cache modes', async () => {
    expect(ftr1.getCacheMode()).toBe('lazy');
    expect(ftr2.getCacheMode()).toBe('none');
    
    // Both should be able to expand the same ValueSet
    const vs1 = await ftr1.expandValueSet('administrative-gender');
    const vs2 = await ftr2.expandValueSet('administrative-gender');
    
    expect(vs1?.expansion?.contains).toBeTruthy();
    expect(vs2?.expansion?.contains).toBeTruthy();
  });

  test('FTR with DI can resolve CodeSystems', async () => {
    const cs = await ftr1.resolveCompleteCodeSystem(
      'http://hl7.org/fhir/administrative-gender',
      { id: 'hl7.fhir.r4.core', version: '4.0.1' }
    );
    
    expect(cs).toBeDefined();
    expect(cs.resourceType).toBe('CodeSystem');
    expect(cs.content).toBe('complete');
  });
});

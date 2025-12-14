/* eslint-disable no-unused-vars */
/**
 * © Copyright Outburn Ltd. 2022-2025 All Rights Reserved
 *   Project name: fhir-terminology-runtime
 */

import { FhirPackageExplorer } from 'fhir-package-explorer';
import { FhirVersion, Logger } from '@outburn/types';

export type Prethrower = (msg: Error | any) => Error;

/**
 * Terminology caching strategy.
 *
 * - `'lazy'`: Default. Generate each expansion on demand and cache it afterward.
 * - `'ensure'`: Proactively generate and cache all **missing** expansions.
 * - `'rebuild'`: Regenerate **all** expansions and overwrite existing cache entries.
 * - `'none'`: Fully bypass the cache. Always regenerate expansions and do not write to cache.
 */
export type TerminologyCacheMode = 'lazy' | 'ensure' | 'rebuild' | 'none';

/**
 * Configuration for FhirTerminologyRuntime.
 * Requires a pre-configured FhirPackageExplorer instance via dependency injection.
 * This allows sharing a single FPE instance across multiple modules (e.g., FSG and FTR).
 */
export type TerminologyRuntimeConfig = {
  /**
   * Pre-configured FhirPackageExplorer instance to use for package operations.
   * This allows sharing a single FPE instance across multiple modules (e.g., FSG and FTR).
   */
  fpe: FhirPackageExplorer;
  /**
   * Determines how terminology expansion caching is handled.
   * Defaults to `'lazy'` if not specified.
   */
  cacheMode?: TerminologyCacheMode;
  /**
   * The FHIR version to use for the terminology runtime.
   * This is used to determine the FHIR core package to use when resolving CodeSystems and ValueSets.
   * Defaults to 4.0.1 if not specified.
   */
  fhirVersion?: FhirVersion;
  /**
   * Optional logger for logging messages.
   */
  logger?: Logger;
};
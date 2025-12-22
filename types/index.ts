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

  /**
   * Optional external cache for ValueSet membership checks.
   * Used by FhirTerminologyRuntime.inValueSet for high-performance lookups.
   */
  membershipCache?: TerminologyMembershipCache;
};

export type UnknownReason =
  | 'unexpandable-valueset'
  | 'unknown-valueset'
  | 'duplicate-code';

/**
 * Minimal shape for Coding-like inputs.
 */
export type CodingLike = {
  system: string;
  code: string;
};

export type ConceptProps = {
  system: string;
  code: string;
  display?: string;
  version?: string;
};

export type MembershipResult =
  | { status: 'member'; concept: ConceptProps }
  | { status: 'not-member' }
  | { status: 'unknown'; reason: UnknownReason };

export type ValueSetDeterministicKey = {
  packageId: string;
  packageVersion: string;
  filename: string;
};

export type MembershipCacheEntry =
  | { status: 'member'; conceptsBySystem: Record<string, ConceptProps> }
  | { status: 'not-member' };

/**
 * External (injectable) async cache for ValueSet membership lookups.
 *
 * - Stores/returns individual code entries (no full ValueSet blobs).
 * - Can optionally support bulk priming of a whole ValueSet (recommended for large ValueSets).
 */
export interface TerminologyMembershipCache {
  getCode(vs: ValueSetDeterministicKey, code: string): Promise<MembershipCacheEntry | undefined>;
  setCode(vs: ValueSetDeterministicKey, code: string, entry: MembershipCacheEntry): Promise<void>;

  bulkSetCodes?(vs: ValueSetDeterministicKey, entries: Array<[string, MembershipCacheEntry]>): Promise<void>;
}

export type CountResult =
  | { status: 'ok'; count: number }
  | { status: 'unknown'; reason: UnknownReason };

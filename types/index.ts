/* eslint-disable no-unused-vars */
/**
 * © Copyright Outburn Ltd. 2022-2025 All Rights Reserved
 *   Project name: fhir-terminology-runtime
 */

import { FhirPackageExplorer } from 'fhir-package-explorer';
import { FhirVersion, Logger } from '@outburn/types';

/**
 * Minimal interface for an injected FHIR client used by FhirTerminologyRuntime.
 *
 * This runtime only uses it for resolving ConceptMap resources from a server.
 * The shape matches @outburn/fhir-client's resolve/getBaseUrl surface.
 */
export type TerminologyFhirClient = {
  /**
   * Resolve a single resource.
   *
   * Examples:
   * - resolve('ConceptMap/123')
   * - resolve('ConceptMap', { url: 'http://...' })
   */
  resolve: (resourceOrLiteral: string, searchParams?: Record<string, any>, options?: Record<string, any>) => Promise<any>;
  /** Returns the configured server base URL. */
  getBaseUrl: () => string;
};

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

  /**
   * Optional external cache for ConceptMap translations.
   * Used by FhirTerminologyRuntime.translateConceptMap for high-performance lookups.
   */
  conceptMapCache?: TerminologyConceptMapCache;

  /**
   * Optional injected FHIR client.
   *
   * When provided (and when packageFilter is NOT provided), translateConceptMap
   * will prefer resolving ConceptMaps from the server before falling back to packages.
   */
  fhirClient?: TerminologyFhirClient;
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

/**
 * Supported ConceptMap.target.equivalence values for translation.
 *
 * - If missing (valid in FHIR R3), the default is treated as 'equivalent'.
 * - Any other equivalence value is ignored by translateConceptMap.
 */
export type SupportedConceptMapEquivalence =
  | 'equivalent'
  | 'equal'
  | 'wider'
  | 'subsumes';

/**
 * A translation target Coding plus metadata.
 */
export type ConceptMapTranslation = ConceptProps & {
  equivalence: SupportedConceptMapEquivalence;
};

export type ConceptMapUnmappedReason =
  | 'unknown-conceptmap'
  | 'duplicate-code'
  | 'code-not-in-conceptmap'
  | 'no-translation'
  | 'unsupported-equivalence'
  | 'invalid-code';

export type ConceptMapTranslationResult =
  | { status: 'mapped'; targets: ConceptMapTranslation[] }
  | { status: 'unmapped'; reason: Exclude<ConceptMapUnmappedReason, 'unsupported-equivalence'> }
  | { status: 'unmapped'; reason: 'unsupported-equivalence'; ignoredEquivalences: string[] };

export type MembershipResult =
  | { status: 'member'; concept: ConceptProps }
  | { status: 'not-member' }
  | { status: 'unknown'; reason: UnknownReason };

export type ValueSetDeterministicKey = {
  packageId: string;
  packageVersion: string;
  filename: string;
};

/**
 * Deterministic key for a ConceptMap "namespace".
 *
 * - package: stable and immutable (packageId+version+filename)
 * - server: reserved for future server-fetched ConceptMaps (keyed by server + canonical url)
 */
export type ConceptMapDeterministicKey =
  | {
      kind: 'package';
      packageId: string;
      packageVersion: string;
      filename: string;
    }
  | {
      kind: 'server';
      serverBaseUrl: string;
      url: string;
    };

export type ConceptMapCacheEntry =
  | {
      status: 'found';
      bySourceSystem: Record<string, { targets: ConceptMapTranslation[]; ignoredEquivalences?: string[] }>;
    }
  | { status: 'not-found' };

/**
 * External (injectable) async cache for ConceptMap translations.
 *
 * - Stores/returns per-source-code entries (no full ConceptMap blobs).
 * - Supports namespace eviction via clearNamespace (needed for future server reloading).
 */
export interface TerminologyConceptMapCache {
  getCode(cm: ConceptMapDeterministicKey, code: string): Promise<ConceptMapCacheEntry | undefined>;
  setCode(cm: ConceptMapDeterministicKey, code: string, entry: ConceptMapCacheEntry): Promise<void>;

  bulkSetCodes?(cm: ConceptMapDeterministicKey, entries: Array<[string, ConceptMapCacheEntry]>): Promise<void>;
  /**
   * Clears all cached entries under a namespace prefix.
   *
   * The runtime uses deterministic, prefix-friendly namespaces, e.g.:
   * - server: `server:${baseUrl}/ConceptMap/`
   * - package: `package:${packageId}#${packageVersion}::${filename}`
   */
  clearNamespace(namespacePrefix: string): Promise<void>;
}

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

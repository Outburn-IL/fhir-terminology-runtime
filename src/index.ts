/**
 * © Copyright Outburn Ltd. 2022-2025 All Rights Reserved
 *   Project name: fhir-terminology-runtime
 */

import {
  defaultLogger,
  defaultPrethrow,
  customPrethrower,
  flattenCodeSystemConcepts,
  toSystemCodeMapFromContains,
  mergeSystemMaps,
  subtractSystemMaps,
  buildExpansionFromSystemMap,
  ImplicitCodeSystemRegistry
} from './utils';
import path from 'path';
import fs from 'fs-extra';
import { version as ftrVersion } from '../package.json';
import {
  FhirPackageExplorer
} from 'fhir-package-explorer';

import {
  FhirPackageIdentifier,
  FhirVersion,
  Logger,
  FileIndexEntryWithPkg
} from '@outburn/types';
import type {
  TerminologyCacheMode,
  TerminologyRuntimeConfig,
  Prethrower,
  CountResult,
  MembershipResult,
  ConceptProps,
  CodingLike,
  TerminologyMembershipCache,
  ValueSetDeterministicKey,
  MembershipCacheEntry,
  TerminologyConceptMapCache,
  ConceptMapDeterministicKey,
  ConceptMapCacheEntry,
  ConceptMapTranslation,
  ConceptMapTranslationResult,
  SupportedConceptMapEquivalence,
  TerminologyFhirClient
} from '../types';

const versionedCacheDir = `v${ftrVersion.split('.').slice(0, 2).join('.')}.x`;

const FTR_DEFAULT_LIMITS = {
  valueSet: {
    smallThresholdUniqueCodes: 50,
    smallIndexLruSize: 100,
    hotCodeLruSize: 10000
  },
  conceptMap: {
    smallThresholdUniqueSourceCodes: 50,
    smallIndexLruSize: 20,
    hotCodeLruSize: 1000
  }
} as const;

// Reserved pseudo-code used as a sentinel to mark that a ValueSet has been externally "primed".
// This is only written/read via the external membership cache and is never used for real membership queries.
const EXTERNAL_PRIMED_SENTINEL_CODE = '__ftr__primed__';

const SUPPORTED_CONCEPTMAP_EQUIVALENCE: ReadonlySet<SupportedConceptMapEquivalence> = new Set([
  'equivalent',
  'equal',
  'wider',
  'subsumes'
]);

export class FhirTerminologyRuntime {
  private fpe: FhirPackageExplorer;
  private logger: Logger;
  private prethrow: Prethrower;
  private cachePath: string;
  private cacheMode: TerminologyCacheMode;
  private fhirVersion: FhirVersion;
  private expansionCountCache: Map<string, CountResult> = new Map();

  private membershipCache?: TerminologyMembershipCache;
  private conceptMapCache?: TerminologyConceptMapCache;

  private fhirClient?: TerminologyFhirClient;

  // Cache for resolving ValueSet identifiers (url/id/name) -> metadata.
  // Keyed by identifier + packageFilter.
  private valueSetIdentifierMetaCache: Map<string, Promise<FileIndexEntryWithPkg>> = new Map();

  // General-purpose resolveMeta cache to avoid repeated FPE lookups.
  private resolveMetaCache: Map<string, Promise<any>> = new Map();

  // LRU: small ValueSet indexes (<= 50 unique codes)
  private smallValueSetIndexLru = new LruCache<string, SmallValueSetIndex>(FTR_DEFAULT_LIMITS.valueSet.smallIndexLruSize);
  // LRU: per-code membership results for non-small ValueSets
  private membershipResultLru = new LruCache<string, MembershipResult>(FTR_DEFAULT_LIMITS.valueSet.hotCodeLruSize);

  // LRU: small ConceptMap indexes (<= 50 unique source codes)
  private smallConceptMapIndexLru = new LruCache<string, SmallConceptMapIndex>(FTR_DEFAULT_LIMITS.conceptMap.smallIndexLruSize);
  // LRU: per-code translation results for non-small ConceptMaps
  private conceptMapResultLru = new LruCache<string, ConceptMapTranslationResult>(FTR_DEFAULT_LIMITS.conceptMap.hotCodeLruSize);

  // In-memory guard for avoiding repeated external priming per VS key.
  private externallyPrimedValueSets: Set<string> = new Set();

  // In-memory guard for avoiding repeated external priming per ConceptMap key.
  private externallyPrimedConceptMaps: Set<string> = new Set();

  // Cache for resolving ConceptMap identifiers (url/id/name) -> metadata.
  // Keyed by identifier + packageFilter.
  private conceptMapIdentifierMetaCache: Map<string, Promise<FileIndexEntryWithPkg>> = new Map();

  // Cache for resolving server ConceptMap identifiers (url/id/name) -> deterministic server key.
  // Keyed by baseUrl + identifier.
  private serverConceptMapIdentifierKeyCache: Map<string, Promise<ConceptMapDeterministicKey>> = new Map();

  private constructor(
    fpe: FhirPackageExplorer,
    cacheMode: TerminologyCacheMode,
    fhirVersion: FhirVersion,
    logger?: Logger,
    membershipCache?: TerminologyMembershipCache,
    conceptMapCache?: TerminologyConceptMapCache,
    fhirClient?: TerminologyFhirClient
  ) {
    if (logger) {
      this.logger = logger;
      this.prethrow = customPrethrower(this.logger);
    } else {
      this.logger = defaultLogger;
      this.prethrow = defaultPrethrow;
    }
    this.cacheMode = cacheMode;
    this.fhirVersion = fhirVersion;
    this.fpe = fpe;
    this.cachePath = fpe.getCachePath();
    this.membershipCache = membershipCache;
    this.conceptMapCache = conceptMapCache;
    this.fhirClient = fhirClient;
  };

  /**
   * Creates a new instance of the FhirTerminologyRuntime class.
   * 
   * Requires a pre-configured FhirPackageExplorer instance via dependency injection.
   * This allows sharing a single FPE instance across multiple modules (e.g., FSG and FTR).
   * 
   * @param config - Configuration object with FPE and optional settings
   * @returns - A promise that resolves to a new instance of the FhirTerminologyRuntime class
   */
  static async create(config: TerminologyRuntimeConfig): Promise<FhirTerminologyRuntime> {
    const logger = config.logger || defaultLogger; // use provided logger or default
    const prethrow = config.logger ? customPrethrower(logger) : defaultPrethrow;
    
    try {
      const cacheMode = config.cacheMode || 'lazy'; // default cache mode
      const fhirVersion = config.fhirVersion || '4.0.1'; // default FHIR version
      const fpe = config.fpe;

      // Create a new FhirTerminologyRuntime instance
      const ftr = new FhirTerminologyRuntime(
        fpe,
        cacheMode,
        fhirVersion,
        config.logger,
        config.membershipCache,
        config.conceptMapCache,
        config.fhirClient
      );

      let precache: boolean = false;

      // 'ensure' and 'rebuild' cache modes both trigger a walkthrough of all ValueSets.
      // The difference is that 'rebuild' will first delete all existing expansions in the cache.
      if (cacheMode === 'rebuild') {
        precache = true;
        // delete all existing expansions in the cache for the packages in the context
        const packageList = fpe.getContextPackages().map(pkg => path.join(fpe.getCachePath(), `${pkg.id}#${pkg.version}`, '.ftr.expansions', versionedCacheDir));
        // for each path, delete the directory if it exists
        for (const expansionCacheDir of packageList) {
          if (await fs.exists(expansionCacheDir)) {
            fs.removeSync(expansionCacheDir);
          }
        }
      }

      if (cacheMode === 'ensure') precache = true;

      if (precache) {
        // Pre-cache ValueSet expansions
        logger.info(`Pre-caching ValueSet expansions in '${cacheMode}' mode...`);
        const vsErrors: string[] = [];
        const allVs = await fpe.lookupMeta({ resourceType: 'ValueSet' });
        for (const vs of allVs) {
          const { filename, __packageId: packageId, __packageVersion: packageVersion, url } = vs as any;
          try {
            await ftr.ensureExpansionCached(filename, packageId, packageVersion);
          } catch (e) {
            // tolerate failures
            /* c8 ignore next 2 */
            vsErrors.push(`Failed to ${cacheMode} expansion for '${url || filename}' in package '${packageId}@${packageVersion}': ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (vsErrors.length > 0) {
          /* c8 ignore next */
          logger.warn(`Errors during pre-caching ValueSet expansions (${vsErrors.length} total):\n${vsErrors.join('\n')}`);
        } else {
          logger.info(`Pre-caching ValueSet expansions in '${cacheMode}' mode completed successfully.`);
        }
      }
      return ftr;
    } catch (e) {
      /* c8 ignore next 2 */
      throw prethrow(e);
    }
  };

  public getLogger(): Logger {
    return this.logger;
  }

  public getCachePath(): string {
    return this.cachePath;
  }

  public getCacheMode(): TerminologyCacheMode {
    return this.cacheMode;
  };

  public getFhirVersion(): FhirVersion {
    return this.fhirVersion;
  };

  public getFpe(): FhirPackageExplorer {
    return this.fpe;
  }

  private getCacheFilePath(filename: string, packageId: string, packageVersion: string): string {
    return path.join(this.cachePath, `${packageId}#${packageVersion}`, '.ftr.expansions', versionedCacheDir, filename);
  }

  // ValueSet helpers
  private async getValueSetByFileName(filename: string, packageId: string, packageVersion: string): Promise<any> {
    return await this.fpe.resolve({ filename, package: { id: packageId, version: packageVersion } });
  }

  private stableStringify(value: any): string {
    const seen = new WeakSet<object>();
    const normalize = (v: any): any => {
      if (v === null || typeof v !== 'object') return v;
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
      if (Array.isArray(v)) return v.map(normalize);
      const out: any = {};
      for (const key of Object.keys(v).sort()) {
        const val = (v as any)[key];
        if (val === undefined) continue;
        out[key] = normalize(val);
      }
      return out;
    };
    return JSON.stringify(normalize(value));
  }

  private toValueSetDeterministicKey(meta: FileIndexEntryWithPkg): ValueSetDeterministicKey {
    const packageId = (meta as any).__packageId as string;
    const packageVersion = (meta as any).__packageVersion as string;
    const filename = (meta as any).filename as string;
    if (!packageId || !packageVersion || !filename) {
      throw new Error('ValueSet metadata missing deterministic key fields (packageId/packageVersion/filename).');
    }
    return { packageId, packageVersion, filename };
  }

  private toValueSetKeyString(vsKey: ValueSetDeterministicKey): string {
    return `${vsKey.packageId}#${vsKey.packageVersion}::${vsKey.filename}`;
  }

  private async resolveMetaCached(query: any): Promise<any> {
    const key = this.stableStringify(query);
    const existing = this.resolveMetaCache.get(key);
    if (existing) return await existing;

    const p = this.fpe.resolveMeta(query);
    this.resolveMetaCache.set(key, p);
    try {
      return await p;
    } catch (e) {
      // Do not cache failures (resolution might succeed later if context changes).
      this.resolveMetaCache.delete(key);
      throw e;
    }
  }

  private toConceptMapDeterministicKey(meta: FileIndexEntryWithPkg): ConceptMapDeterministicKey {
    const packageId = (meta as any).__packageId as string;
    const packageVersion = (meta as any).__packageVersion as string;
    const filename = (meta as any).filename as string;
    if (!packageId || !packageVersion || !filename) {
      throw new Error('ConceptMap metadata missing deterministic key fields (packageId/packageVersion/filename).');
    }
    return { kind: 'package', packageId, packageVersion, filename };
  }

  private normalizeServerBaseUrl(baseUrl: string): string {
    return (baseUrl || '').trim().replace(/\/+$/, '');
  }

  private getServerConceptMapNamespace(serverBaseUrl: string): string {
    const base = this.normalizeServerBaseUrl(serverBaseUrl);
    return `server:${base}`;
  }

  private toServerConceptMapKeyFromId(serverBaseUrl: string, idOrToken: string): ConceptMapDeterministicKey {
    const base = this.normalizeServerBaseUrl(serverBaseUrl);
    const safe = (idOrToken || '').trim();
    return {
      kind: 'server',
      serverBaseUrl: base,
      url: `${base}/ConceptMap/${safe}`
    };
  }

  private getConceptMapIdFromServerKey(cmKey: Extract<ConceptMapDeterministicKey, { kind: 'server' }>): string | undefined {
    const match = cmKey.url.match(/\/ConceptMap\/([^/?#]+)/);
    return match?.[1];
  }

  private toConceptMapKeyString(cmKey: ConceptMapDeterministicKey): string {
    if (cmKey.kind === 'package') {
      return `package:${cmKey.packageId}#${cmKey.packageVersion}::${cmKey.filename}`;
    }
    return `server:${cmKey.url}`;
  }

  private async resolveServerConceptMapKey(identifier: string, serverBaseUrl: string, errors: unknown[]): Promise<ConceptMapDeterministicKey | undefined> {
    const client = this.fhirClient;
    if (!client) return undefined;

    const base = this.normalizeServerBaseUrl(serverBaseUrl);
    const cacheKey = this.stableStringify({ base, identifier });
    const cached = this.serverConceptMapIdentifierKeyCache.get(cacheKey);
    if (cached) {
      try {
        return await cached;
      } catch (e) {
        this.serverConceptMapIdentifierKeyCache.delete(cacheKey);
        errors.push(e);
      }
    }

    const promise = (async () => {
      // Order: url, id, name
      const attempts: Array<() => Promise<any>> = [
        () => client.resolve('ConceptMap', { url: identifier }),
        () => client.resolve(`ConceptMap/${identifier}`),
        () => client.resolve('ConceptMap', { name: identifier })
      ];

      const localErrors: unknown[] = [];
      for (const attempt of attempts) {
        try {
          const cm = await attempt();
          if (!cm || cm.resourceType !== 'ConceptMap') {
            throw new Error(`Resolved resource is not a ConceptMap (got '${cm?.resourceType || 'unknown'}').`);
          }

          const id = typeof cm.id === 'string' && cm.id.length > 0 ? cm.id : undefined;
          const token = id || (typeof cm.url === 'string' && cm.url.length ? encodeURIComponent(cm.url) : encodeURIComponent(identifier));
          return this.toServerConceptMapKeyFromId(base, token);
        } catch (e) {
          localErrors.push(e);
        }
      }
      const err: any = new Error(`Failed to resolve server ConceptMap '${identifier}'.`);
      err.errors = localErrors;
      throw err;
    })();

    this.serverConceptMapIdentifierKeyCache.set(cacheKey, promise);
    try {
      return await promise;
    } catch (e) {
      this.serverConceptMapIdentifierKeyCache.delete(cacheKey);
      errors.push(e);
      return undefined;
    }
  }

  private async loadConceptMapResource(cmKey: ConceptMapDeterministicKey): Promise<any> {
    if (cmKey.kind === 'package') {
      return await this.getConceptMapByFileName(cmKey.filename, cmKey.packageId, cmKey.packageVersion);
    }
    const client = this.fhirClient;
    if (!client) throw new Error('FHIR client not configured for server ConceptMap resolution.');
    const id = this.getConceptMapIdFromServerKey(cmKey);
    if (!id) throw new Error(`Invalid server ConceptMap key url '${cmKey.url}' (cannot extract id).`);
    return await client.resolve(`ConceptMap/${id}`);
  }

  public async clearServerConceptMapsFromCache(serverBaseUrl?: string): Promise<void> {
    const prefixes: string[] = [];
    if (serverBaseUrl) {
      prefixes.push(this.getServerConceptMapNamespace(serverBaseUrl));
    } else if (this.fhirClient) {
      prefixes.push(this.getServerConceptMapNamespace(this.fhirClient.getBaseUrl()));
    } else {
      // No base URL available: clear all server-prefixed entries.
      prefixes.push('server:');
    }

    for (const prefix of prefixes) {
      this.smallConceptMapIndexLru.deleteWhere(k => typeof k === 'string' && k.startsWith(prefix));
      this.conceptMapResultLru.deleteWhere(k => typeof k === 'string' && k.startsWith(prefix));

      for (const key of Array.from(this.externallyPrimedConceptMaps.values())) {
        if (key.startsWith(prefix)) this.externallyPrimedConceptMaps.delete(key);
      }

      const baseToMatch = prefix.startsWith('server:') ? prefix.slice('server:'.length) : '';
      for (const cacheKey of Array.from(this.serverConceptMapIdentifierKeyCache.keys())) {
        if (!baseToMatch || cacheKey.includes(`"base":"${baseToMatch}"`)) {
          this.serverConceptMapIdentifierKeyCache.delete(cacheKey);
        }
      }

      if (this.conceptMapCache) {
        try {
          await this.conceptMapCache.clearNamespace(prefix);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private async getConceptMapMetadata(identifier: string, packageFilter?: FhirPackageIdentifier): Promise<FileIndexEntryWithPkg> {
    const cacheKey = this.stableStringify({ identifier, packageFilter });
    const cached = this.conceptMapIdentifierMetaCache.get(cacheKey);
    if (cached) return await cached;

    const promise = this.getConceptMapMetadataUncached(identifier, packageFilter);
    this.conceptMapIdentifierMetaCache.set(cacheKey, promise);
    try {
      return await promise;
    } catch (e) {
      // Don't cache failures
      this.conceptMapIdentifierMetaCache.delete(cacheKey);
      throw e;
    }
  }

  private async getConceptMapMetadataUncached(identifier: string, packageFilter?: FhirPackageIdentifier): Promise<FileIndexEntryWithPkg> {
    const errors: any[] = [];
    if (identifier.startsWith('http:') || identifier.startsWith('https:') || identifier.includes(':')) {
      try {
        const match = await this.resolveMetaCached({ resourceType: 'ConceptMap', url: identifier, package: packageFilter });
        return match;
      } catch (e) {
        errors.push(e);
      }
    }
    try {
      const match = await this.resolveMetaCached({ resourceType: 'ConceptMap', id: identifier, package: packageFilter });
      return match;
    } catch (e) {
      errors.push(e);
    }
    try {
      const match = await this.resolveMetaCached({ resourceType: 'ConceptMap', name: identifier, package: packageFilter });
      return match;
    } catch (e) {
      errors.push(e);
    }
    errors.map(e => this.logger.error(e));
    throw new Error(`Failed to resolve ConceptMap '${identifier}'`);
  }

  private async getConceptMapByFileName(filename: string, packageId: string, packageVersion: string): Promise<any> {
    return await this.fpe.resolve({ filename, package: { id: packageId, version: packageVersion } });
  }

  private async getValueSetMetadata(identifier: string, packageFilter?: FhirPackageIdentifier): Promise<FileIndexEntryWithPkg> {
    const cacheKey = this.stableStringify({ identifier, packageFilter });
    const cached = this.valueSetIdentifierMetaCache.get(cacheKey);
    if (cached) return await cached;

    const promise = this.getValueSetMetadataUncached(identifier, packageFilter);
    this.valueSetIdentifierMetaCache.set(cacheKey, promise);
    try {
      return await promise;
    } catch (e) {
      // Don't cache failures
      this.valueSetIdentifierMetaCache.delete(cacheKey);
      throw e;
    }
  }

  private async getValueSetMetadataUncached(identifier: string, packageFilter?: FhirPackageIdentifier): Promise<FileIndexEntryWithPkg> {
    const errors: any[] = [];
    if (identifier.startsWith('http:') || identifier.startsWith('https:') || identifier.includes(':')) {
      try {
        const match = await this.resolveMetaCached({ resourceType: 'ValueSet', url: identifier, package: packageFilter });
        return match; // return the resolved match (with core-bias applied)
      } catch (e) {
        errors.push(e);
      }
    }
    // Not a URL, or failed to resolve as URL - try and resolve it as ID
    try {
      const match = await this.resolveMetaCached({ resourceType: 'ValueSet', id: identifier, package: packageFilter });
      return match; // return the resolved match (with core-bias applied)
    } catch (e) {
      errors.push(e);
    }
    // Couldn't resolve as ID - try and resolve it as name
    try {
      const match = await this.resolveMetaCached({ resourceType: 'ValueSet', name: identifier, package: packageFilter });
      return match; // return the resolved match (with core-bias applied)
    } catch (e) {
      errors.push(e);
    }
    // Couldn't resolve at all - throw all errors
    errors.map(e => this.logger.error(e));
    throw new Error(`Failed to resolve ValueSet '${identifier}'`);
  }

  private async getExpansionFromCache(filename: string, packageId: string, packageVersion: string): Promise<any | undefined> {
    const cacheFilePath = this.getCacheFilePath(filename, packageId, packageVersion);
    if (await fs.exists(cacheFilePath)) {
      return await fs.readJSON(cacheFilePath);
    }
    return undefined;
  }

  private async saveExpansionToCache(filename: string, packageId: string, packageVersion: string, vs: any): Promise<void> {
    const cacheFilePath = this.getCacheFilePath(filename, packageId, packageVersion);
    await fs.ensureDir(path.dirname(cacheFilePath));
    await fs.writeJSON(cacheFilePath, vs);
  }

  // Flatten CodeSystem concepts (collect all nested {code, display})
  private flattenCodeSystemConcepts(cs: any): Map<string, string | undefined> {
    return flattenCodeSystemConcepts(cs);
  }

  private toSystemCodeMapFromContains(contains: any[] | undefined): Map<string, Map<string, string | undefined>> {
    return toSystemCodeMapFromContains(contains);
  }

  private mergeSystemMaps(target: Map<string, Map<string, string | undefined>>, source: Map<string, Map<string, string | undefined>>): void {
    mergeSystemMaps(target as any, source as any);
  }

  private subtractSystemMaps(target: Map<string, Map<string, string | undefined>>, exclude: Map<string, Map<string, string | undefined>>): void {
    subtractSystemMaps(target as any, exclude as any);
  }

  private buildExpansionFromSystemMap(map: Map<string, Map<string, string | undefined>>): { contains: any[], total: number } {
    return buildExpansionFromSystemMap(map as any);
  }

  private async expandInclude(
    include: any,
    sourcePackage: FhirPackageIdentifier,
    visited: Set<string>
  ): Promise<Map<string, Map<string, string | undefined>>> {
    if (include.filter && include.filter.length) {
      throw new Error('Unsupported ValueSet.include.filter encountered. Filtering is not implemented yet.');
    }

    const result = new Map<string, Map<string, string | undefined>>();

    // Referenced ValueSets
    let vsUnion = new Map<string, Map<string, string | undefined>>();
    const referenced = Array.isArray(include.valueSet) ? include.valueSet : (include.valueSet ? [include.valueSet] : []);
    for (const vsUrl of referenced) {
      if (typeof vsUrl !== 'string') continue;
      if (visited.has(vsUrl)) {
        throw new Error(`Cyclic ValueSet reference detected: '${vsUrl}'.`);
      }
      visited.add(vsUrl);
      // resolve referenced ValueSet metadata first within source package, then fallback globally
      let vsMeta: FileIndexEntryWithPkg;
      try {
        vsMeta = await this.resolveMetaCached({ resourceType: 'ValueSet', url: vsUrl, package: sourcePackage });
      } catch {
        try {
          vsMeta = await this.resolveMetaCached({ resourceType: 'ValueSet', url: vsUrl });
        } catch {
          throw new Error(`Referenced ValueSet '${vsUrl}' not found (searched locally, then globally).`);
        }
      }
      const vsExpanded = await this.expandValueSetByMeta(vsMeta, visited);
      const map = this.toSystemCodeMapFromContains(vsExpanded?.expansion?.contains);
      this.mergeSystemMaps(vsUnion, map);
    }

    // Build concepts from system/concept in include
    const hasSystem = typeof include.system === 'string' && include.system.length > 0;
    const hasConcepts = Array.isArray(include.concept) && include.concept.length > 0;

    const conceptMap = new Map<string, Map<string, string | undefined>>();
    if (hasSystem) {
      const systemUrl: string = include.system;
      let codesForSystem = new Map<string, string | undefined>();
      if (hasConcepts) {
        // explicit concepts with optional display; resolve CodeSystem only if any concept is missing a display
        let csDict: Map<string, string | undefined> | undefined;
        const needsCsLookup = include.concept.some((c: any) => !c?.display);
        if (needsCsLookup) {
          try {
            const cs = await this.resolveCompleteCodeSystem(systemUrl, sourcePackage);
            csDict = this.flattenCodeSystemConcepts(cs);
          } catch (e) {
            // Try implicit code systems before failing
            if (ImplicitCodeSystemRegistry.isImplicitCodeSystem(systemUrl)) {
              csDict = ImplicitCodeSystemRegistry.getConcepts(systemUrl);
              this.logger.info(`Using implicit code system for '${systemUrl}'`);
            } else {
              // CodeSystem lookup failed (e.g., content='not-present' like UCUM)
              // Do not fall back to code as display - leave display undefined for downstream consumers to decide
              this.logger.warn(`CodeSystem lookup failed for '${systemUrl}', display values will be omitted: ${e instanceof Error ? e.message : String(e)}`);
              csDict = undefined;
            }
          }
        }
        for (const c of include.concept) {
          if (!c?.code) continue;
          const display: string | undefined = typeof c.display === 'string' ? c.display : csDict?.get(c.code);
          if (!codesForSystem.has(c.code)) codesForSystem.set(c.code, display);
        }
      } else {
        // all concepts from CodeSystem
        try {
          const cs = await this.resolveCompleteCodeSystem(systemUrl, sourcePackage);
          codesForSystem = this.flattenCodeSystemConcepts(cs);
        } catch (e) {
          // Try implicit code systems before failing
          if (ImplicitCodeSystemRegistry.isImplicitCodeSystem(systemUrl)) {
            const implicitConcepts = ImplicitCodeSystemRegistry.getConcepts(systemUrl);
            if (implicitConcepts) {
              codesForSystem = implicitConcepts;
              this.logger.info(`Using implicit code system for '${systemUrl}'`);
            } else {
              throw e;
            }
          } else {
            throw e;
          }
        }
      }
      conceptMap.set(systemUrl, codesForSystem);
    }

    // Combine with referenced VS
    if (vsUnion.size > 0) {
      if (hasSystem) {
        // Intersect for that system
        const systemUrl: string = include.system;
        const concepts = conceptMap.get(systemUrl) || new Map<string, string | undefined>();
        const refMap = vsUnion.get(systemUrl) || new Map<string, string | undefined>();
        const intersection = new Map<string, string | undefined>();
        for (const [code, disp] of concepts.entries()) {
          if (refMap.has(code)) intersection.set(code, disp);
        }
        if (intersection.size > 0) result.set(systemUrl, intersection);
      } else {
        // No system provided: pass through union from referenced VS
        this.mergeSystemMaps(result, vsUnion);
      }
    } else {
      // No referenced VS: return concepts as-is
      this.mergeSystemMaps(result, conceptMap);
    }

    return result;
  }

  private async expandValueSetByMeta(metadata: FileIndexEntryWithPkg, visited: Set<string> = new Set()): Promise<any> {
    const { filename, __packageId: packageId, __packageVersion: packageVersion } = metadata;

    // Check cache
    const cached = this.cacheMode !== 'none' ? await this.getExpansionFromCache(filename, packageId, packageVersion!) : undefined;
    if (cached) {
      if (cached?.expansion?.__failure === true) {
        // Prior attempt already failed; short-circuit without recomputation
        throw new Error(`Previous expansion attempt failed for ValueSet '${(cached.url || cached.id || filename)}' (cached).`);
      }
      return cached;
    }

    // Load original VS
    const vs = await this.getValueSetByFileName(filename, packageId, packageVersion!);
    if (!vs || vs.resourceType !== 'ValueSet') throw new Error(`File '${filename}' not found as a ValueSet in package '${packageId}@${packageVersion}'.`);

    try {
      const compose = vs.compose || {};
      const includes = Array.isArray(compose.include) ? compose.include : [];
      const excludes = Array.isArray(compose.exclude) ? compose.exclude : [];

      // Build include union map
      let includeMap = new Map<string, Map<string, string | undefined>>();
      for (const inc of includes) {
        const incMap = await this.expandInclude(inc, { id: packageId, version: packageVersion! }, visited);
        this.mergeSystemMaps(includeMap, incMap);
      }
      // Build exclude union map
      let excludeMap = new Map<string, Map<string, string | undefined>>();
      for (const exc of excludes) {
        const excMap = await this.expandInclude(exc, { id: packageId, version: packageVersion! }, visited);
        this.mergeSystemMaps(excludeMap, excMap);
      }
      // Subtract excludes
      this.subtractSystemMaps(includeMap, excludeMap);

      const { contains, total } = this.buildExpansionFromSystemMap(includeMap);
      const expanded = { ...vs, expansion: { timestamp: new Date().toISOString(), total, contains } };

      if (this.cacheMode !== 'none') {
        await this.saveExpansionToCache(filename, packageId, packageVersion!, expanded);
      }
      return expanded;
    } catch (e) {
      this.logger.warn(`Failed to expand ValueSet '${vs?.url || vs?.id || filename}': ${e instanceof Error ? e.message : String(e)}. Falling back to original expansion if present.`);
      if (vs?.expansion?.contains && Array.isArray(vs.expansion.contains)) {
        // Cache the original as well to avoid repeated regeneration attempts
        if (this.cacheMode !== 'none') {
          await this.saveExpansionToCache(filename, packageId, packageVersion!, vs);
        }
        return vs;
      }
      // No usable fallback expansion. Cache a stub marking failure to avoid repeated expensive retries.
      if (this.cacheMode !== 'none') {
        const failureStub = { ...vs, expansion: { timestamp: new Date().toISOString(), __failure: true } };
        try {
          await this.saveExpansionToCache(filename, packageId, packageVersion!, failureStub);
        /* c8 ignore next 4 */
        } catch {
          /* ignore */
        }
      }
      throw e;
    }
  }

  private async ensureExpansionCached(filename: string, packageId: string, packageVersion: string): Promise<void> {
    const cacheFilePath = this.getCacheFilePath(filename, packageId, packageVersion);
    try {
      await fs.access(cacheFilePath);
      return; // already cached
    } catch {
      const meta: FileIndexEntryWithPkg = { resourceType: 'ValueSet', filename, __packageId: packageId, __packageVersion: packageVersion } as any;
      try {
        await this.expandValueSetByMeta(meta);
      } catch (e) {
        // tolerate failures during pre-generation
        this.logger.warn(`Failed to pre-cache ValueSet expansion for '${filename}' in '${packageId}@${packageVersion}': ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * Get ValueSet expansion by any FSH style identifier (id, url or name), or by a metadata object.
   */
  public async expandValueSet(identifier: string | FileIndexEntryWithPkg, packageFilter?: FhirPackageIdentifier): Promise<any> {
    try {
      let metadata: FileIndexEntryWithPkg | undefined;
      if (typeof identifier === 'string') {
        metadata = await this.getValueSetMetadata(identifier, packageFilter);
        if (!metadata) {
          /* c8 ignore next 2 */
          throw new Error(`ValueSet '${identifier}' not found in context. Could not get or generate an expansion.`);
        }
      } else {
        metadata = identifier as FileIndexEntryWithPkg;
        if (!metadata) {
          /* c8 ignore next 2 */
          throw new Error(`ValueSet with metadata: \n${JSON.stringify(identifier, null, 2)}\nnot found in context. Could not get or generate an expansion.`);
        }
      }
      return await this.expandValueSetByMeta(metadata);
    } catch (e) {
      throw this.prethrow(e);
    }
  }

  /**
   * Get the count of concepts in the expansion of a ValueSet.
   * Results are cached in memory.
   */
  public async getValueSetExpansionCount(identifier: string | FileIndexEntryWithPkg, packageFilter?: FhirPackageIdentifier): Promise<CountResult> {
    const cacheKey = `${JSON.stringify(identifier)}|${JSON.stringify(packageFilter)}`;
    if (this.expansionCountCache.has(cacheKey)) {
      return this.expansionCountCache.get(cacheKey)!;
    }

    let metadata: FileIndexEntryWithPkg | undefined;

    try {
      if (typeof identifier === 'string') {
        metadata = await this.getValueSetMetadata(identifier, packageFilter);
      } else {
        metadata = identifier;
      }
    // eslint-disable-next-line no-unused-vars
    } catch (e) {
      // Resolution failed
      const result: CountResult = { status: 'unknown', reason: 'unknown-valueset' };
      this.expansionCountCache.set(cacheKey, result);
      return result;
    }

    if (!metadata) {
      const result: CountResult = { status: 'unknown', reason: 'unknown-valueset' };
      this.expansionCountCache.set(cacheKey, result);
      return result;
    }

    try {
      const expansion = await this.expandValueSetByMeta(metadata);

      let count = 0;
      if (typeof expansion?.expansion?.total === 'number') {
        count = expansion.expansion.total;
      } else if (Array.isArray(expansion?.expansion?.contains)) {
        count = expansion.expansion.contains.length;
      }

      const result: CountResult = { status: 'ok', count };
      this.expansionCountCache.set(cacheKey, result);
      return result;

    // eslint-disable-next-line no-unused-vars
    } catch (e) {
      // Expansion failed
      const result: CountResult = { status: 'unknown', reason: 'unexpandable-valueset' };
      this.expansionCountCache.set(cacheKey, result);
      return result;
    }
  }

  /**
   * Resolve a CodeSystem by canonical URL inside the provided source package context.
   * Will NOT attempt a global resolution fallback (that is the responsibility of the external caller / entrypoint).
   * Only CodeSystems with content === 'complete' are eligible for expansion; if not complete an error is thrown.
   * @param url Canonical URL of the CodeSystem.
   * @param sourcePackage The package (id + version) of the ValueSet that is triggering this resolution.
   * @returns The full CodeSystem resource (content=complete).
   */
  public async resolveCompleteCodeSystem(url: string, sourcePackage: FhirPackageIdentifier): Promise<any> {
    try {
      if (!url) {
        throw new Error('CodeSystem canonical URL missing.');
      }

      // Check if this is an implicit code system first
      if (ImplicitCodeSystemRegistry.isImplicitCodeSystem(url)) {
        // Return a synthetic CodeSystem resource with content='complete'
        const concepts = ImplicitCodeSystemRegistry.getConcepts(url);
        if (!concepts) {
          /* c8 ignore next 2 */
          throw new Error(`Implicit CodeSystem '${url}' provider returned no concepts.`);
        }
        
        // Create a synthetic CodeSystem resource
        return {
          resourceType: 'CodeSystem',
          url,
          status: 'active',
          content: 'complete',
          concept: Array.from(concepts.entries()).map(([code, display]) => ({
            code,
            display
          }))
        };
      }

      // Prefer a semver-aware single resolution inside the source package context first.
      // resolveMeta will internally pick the best version match instead of returning multiples.
      let meta: any | undefined;
      try {
        meta = await this.resolveMetaCached({ resourceType: 'CodeSystem', url, package: sourcePackage });
      } catch {
        // swallow and fallback to global resolution
      }

      if (!meta) {
        try {
          meta = await this.resolveMetaCached({ resourceType: 'CodeSystem', url });
        } catch {
          /* c8 ignore next 2 */
          throw new Error(`CodeSystem '${url}' not found (searched in package '${sourcePackage.id}@${sourcePackage.version}' then globally).`);
        }
      }

      if (!meta?.content || (typeof meta?.content === 'string' && meta.content !== 'complete')) {
        throw new Error(`CodeSystem '${url}' has content='${meta.content}' and cannot be expanded (only 'complete' supported).`);
      }

      const cs = await this.fpe.resolve({ filename: meta.filename, package: { id: meta.__packageId, version: meta.__packageVersion } });
      
      /* c8 ignore next 3 */
      if (!cs) {
        throw new Error(`Failed to load CodeSystem '${url}' from package '${meta.__packageId}@${meta.__packageVersion}'.`);
      }
      if (cs.resourceType !== 'CodeSystem') {
        throw new Error(`Resolved resource for '${url}' is not a CodeSystem (got '${cs.resourceType || 'unknown'}').`);
      }
      if (cs.content !== 'complete') {
        throw new Error(`CodeSystem '${url}' has content='${cs.content || 'undefined'}' and cannot be expanded (only 'complete' supported).`);
      }
      return cs;
    } catch (e) {
      throw this.prethrow(e);
    }
  }

  /**
   * Check whether a code (string) or Coding-like object is a member of a ValueSet.
   * Optimized for the common case: code-only lookup against a small ValueSet.
   */
  public async inValueSet(
    codeOrCoding: string | CodingLike,
    valueSet: string | FileIndexEntryWithPkg,
    packageFilter?: FhirPackageIdentifier
  ): Promise<MembershipResult> {
    const { code, system } = this.normalizeCodeOrCoding(codeOrCoding);
    if (!code) return { status: 'not-member' };

    let meta: FileIndexEntryWithPkg;
    try {
      meta = typeof valueSet === 'string' ? await this.getValueSetMetadata(valueSet, packageFilter) : valueSet;
      if (!meta) return { status: 'unknown', reason: 'unknown-valueset' };
    } catch {
      return { status: 'unknown', reason: 'unknown-valueset' };
    }

    let vsKey: ValueSetDeterministicKey;
    try {
      vsKey = this.toValueSetDeterministicKey(meta);
    } catch {
      /* c8 ignore next 2 */
      return { status: 'unknown', reason: 'unknown-valueset' };
    }
    const vsKeyStr = this.toValueSetKeyString(vsKey);

    // Layer 1: small ValueSet index LRU
    const smallIndex = this.smallValueSetIndexLru.get(vsKeyStr);
    if (smallIndex) {
      const result = this.lookupInIndex(smallIndex, code, system);
      // Ensure external cache is kept up to date with what we know
      await this.syncExternalMembershipCacheForLookup(vsKey, code, result);
      return result;
    }

    // Layer 2: per-code membership LRU (for non-small ValueSets)
    const membershipKey = system
      ? `${vsKeyStr}|s:${system}|c:${code}`
      : `${vsKeyStr}|c:${code}`;

    const lruHit = this.membershipResultLru.get(membershipKey);
    if (lruHit) return lruHit;

    // Layer 3: external cache (optional)
    const external = this.membershipCache;
    if (external) {
      try {
        const entry = await external.getCode(vsKey, code);
        if (entry) {
          const result = this.membershipResultFromExternalEntry(entry, system);
          this.membershipResultLru.set(membershipKey, result);
          return result;
        }
      } catch {
        // Ignore external cache failures and fall back to local evaluation.
      }
    }

    // Local evaluation: expand ValueSet (may use expansion cache on disk)
    let expansion: any;
    try {
      expansion = await this.expandValueSetByMeta(meta);
    } catch {
      const res: MembershipResult = { status: 'unknown', reason: 'unexpandable-valueset' };
      this.membershipResultLru.set(membershipKey, res);
      return res;
    }

    const containsFlat = flattenExpansionContains(expansion?.expansion?.contains);
    const index = buildIndexFromContains(containsFlat);

    // Promote to small index if under threshold
    if (index.uniqueCodeCount <= FTR_DEFAULT_LIMITS.valueSet.smallThresholdUniqueCodes) {
      this.smallValueSetIndexLru.set(vsKeyStr, index);
      // Small: also prime external cache for completeness
      await this.primeExternalMembershipCacheIfProvided(vsKey, vsKeyStr, index, true);
      const result = this.lookupInIndex(index, code, system);
      return result;
    }

    // Large: optionally prime external cache once per VS
    await this.primeExternalMembershipCacheIfProvided(vsKey, vsKeyStr, index, false);

    const result = this.lookupInIndex(index, code, system);
    this.membershipResultLru.set(membershipKey, result);
    await this.syncExternalMembershipCacheForLookup(vsKey, code, result);
    return result;
  }

  private normalizeCodeOrCoding(codeOrCoding: string | CodingLike): { code: string; system?: string } {
    if (typeof codeOrCoding === 'string') {
      return { code: codeOrCoding };
    }
    const code = (codeOrCoding as any)?.code;
    const system = (codeOrCoding as any)?.system;
    return {
      code: typeof code === 'string' ? code : '',
      system: typeof system === 'string' && system.length > 0 ? system : undefined
    };
  }

  private lookupInIndex(index: SmallValueSetIndex, code: string, system?: string): MembershipResult {
    const systemsMap = index.byCode.get(code);
    if (!systemsMap) return { status: 'not-member' };

    // If system specified, disambiguate
    if (system) {
      const concept = systemsMap.get(system);
      if (!concept) return { status: 'not-member' };
      return { status: 'member', concept };
    }

    // code-only: if multiple systems for this code, it's ambiguous
    if (systemsMap.size > 1) {
      return { status: 'unknown', reason: 'duplicate-code' };
    }

    const concept = systemsMap.values().next().value as ConceptProps | undefined;
    if (!concept) return { status: 'not-member' };
    return { status: 'member', concept };
  }

  private membershipResultFromExternalEntry(entry: MembershipCacheEntry, system?: string): MembershipResult {
    if (entry.status === 'not-member') return { status: 'not-member' };
    const conceptsBySystem = entry.conceptsBySystem || {};
    const systems = Object.keys(conceptsBySystem);
    if (system) {
      const concept = conceptsBySystem[system];
      return concept ? { status: 'member', concept } : { status: 'not-member' };
    }
    if (systems.length === 0) return { status: 'not-member' };
    if (systems.length > 1) return { status: 'unknown', reason: 'duplicate-code' };
    return { status: 'member', concept: conceptsBySystem[systems[0]] };
  }

  private async syncExternalMembershipCacheForLookup(vsKey: ValueSetDeterministicKey, code: string, result: MembershipResult): Promise<void> {
    const external = this.membershipCache;
    if (!external) return;
    try {
      if (result.status === 'member') {
        const entry: MembershipCacheEntry = { status: 'member', conceptsBySystem: { [result.concept.system]: result.concept } };
        await external.setCode(vsKey, code, entry);
      } else if (result.status === 'not-member') {
        const entry: MembershipCacheEntry = { status: 'not-member' };
        await external.setCode(vsKey, code, entry);
      } else {
        // unknown reasons aren't persisted in external cache (keeps external storage simple)
      }
    } catch {
      // ignore external cache failures
      /* c8 ignore next */
    }
  }

  private async primeExternalMembershipCacheIfProvided(
    vsKey: ValueSetDeterministicKey,
    vsKeyStr: string,
    index: SmallValueSetIndex,
    isSmall: boolean
  ): Promise<void> {
    const external = this.membershipCache;
    if (!external) return;

    const canUseSentinel = !index.byCode.has(EXTERNAL_PRIMED_SENTINEL_CODE);

    // Always consult the in-memory guard first (fast path).
    if (this.externallyPrimedValueSets.has(vsKeyStr)) return;

    // Consult a sentinel entry via getCode/setCode to detect whether this ValueSet was already primed.
    try {
      if (canUseSentinel) {
        const sentinel = await external.getCode(vsKey, EXTERNAL_PRIMED_SENTINEL_CODE);
        if (sentinel) {
          this.externallyPrimedValueSets.add(vsKeyStr);
          return;
        }
      }
    } catch {
      // If external can't answer, fall back to best-effort priming below.
      /* c8 ignore next */
    }

    // Spec: only prime large ValueSets on first validation.
    // For small ValueSets, we still prime for completeness/backups (cheap).
    if (!isSmall) {
      // OK to prime here (we already had to expand locally once).
    }

    const entries: Array<[string, MembershipCacheEntry]> = [];
    for (const [code, systemsMap] of index.byCode.entries()) {
      const conceptsBySystem: Record<string, ConceptProps> = {};
      for (const [sys, concept] of systemsMap.entries()) {
        conceptsBySystem[sys] = concept;
      }
      entries.push([code, { status: 'member', conceptsBySystem }]);
    }

    try {
      if (external.bulkSetCodes) {
        await external.bulkSetCodes(vsKey, entries);
      } else {
        for (const [code, entry] of entries) {
          await external.setCode(vsKey, code, entry);
        }
      }
      this.externallyPrimedValueSets.add(vsKeyStr);

      // Mark primed state (best-effort) by writing the sentinel entry.
      if (canUseSentinel) {
        await external.setCode(vsKey, EXTERNAL_PRIMED_SENTINEL_CODE, { status: 'not-member' });
      }
    } catch {
      // ignore external priming failures
      /* c8 ignore next */
    }
  }

  /* c8 ignore start */
  /**
   * Translate a source code (string) or Coding-like input using a ConceptMap.
   *
    * - Returns a result object (`mapped` / `unmapped`).
    * - When `mapped`, the result includes 1..N target Codings in `targets`.
   * - Code-only lookups are supported when the source code is not duplicated across multiple source systems.
   * - Only ConceptMap.target entries with supported equivalence are used.
   */
  public async translateConceptMap(
    codeOrCoding: string | CodingLike,
    conceptMap: string | FileIndexEntryWithPkg,
    packageFilter?: FhirPackageIdentifier
  ): Promise<ConceptMapTranslationResult> {
    const { code, system } = this.normalizeCodeOrCoding(codeOrCoding);
    if (!code) return { status: 'unmapped', reason: 'invalid-code' };

    const errors: unknown[] = [];

    let cmKey: ConceptMapDeterministicKey | undefined;
    let meta: FileIndexEntryWithPkg | undefined;

    // If the caller provided a package-filter, we treat that as a deterministic request for package ConceptMaps.
    const shouldSkipServer = !!packageFilter;

    if (typeof conceptMap !== 'string') {
      meta = conceptMap;
      try {
        cmKey = this.toConceptMapDeterministicKey(meta);
      } catch (e) {
        errors.push(e);
      }
    } else if (!shouldSkipServer && this.fhirClient) {
      const base = this.normalizeServerBaseUrl(this.fhirClient.getBaseUrl());
      cmKey = await this.resolveServerConceptMapKey(conceptMap, base, errors);

      // If server resolution failed, fall back to packages.
      if (!cmKey) {
        try {
          meta = await this.getConceptMapMetadata(conceptMap, packageFilter);
          cmKey = this.toConceptMapDeterministicKey(meta);
        } catch (e) {
          errors.push(e);
        }
      }
    } else {
      try {
        meta = await this.getConceptMapMetadata(conceptMap, packageFilter);
        cmKey = this.toConceptMapDeterministicKey(meta);
      } catch (e) {
        errors.push(e);
      }
    }

    if (!cmKey) {
      const err: any = new Error(`ConceptMap '${typeof conceptMap === 'string' ? conceptMap : (conceptMap as any)?.filename || 'unknown'}' could not be resolved.`);
      err.errors = errors;
      throw this.prethrow(err);
    }

    const cmKeyStr = this.toConceptMapKeyString(cmKey);

    // Layer 1: small ConceptMap index LRU
    const smallIndex = this.smallConceptMapIndexLru.get(cmKeyStr);
    if (smallIndex) {
      const { result, resolvedSourceSystem, targetsBySourceSystem } = this.lookupInConceptMapIndexWithSourceSystem(
        smallIndex,
        code,
        system
      );
      await this.syncExternalConceptMapCacheForLookup(cmKey, code, resolvedSourceSystem, result, targetsBySourceSystem);
      return result;
    }

    // Layer 2: per-code hot LRU (for non-small ConceptMaps)
    const lruKey = system
      ? `${cmKeyStr}|s:${system}|c:${code}`
      : `${cmKeyStr}|c:${code}`;
    const lruHit = this.conceptMapResultLru.get(lruKey);
    if (lruHit) return lruHit;

    // Layer 3: external cache (optional)
    const external = this.conceptMapCache;
    if (external) {
      try {
        const entry = await external.getCode(cmKey, code);
        if (entry) {
          const result = this.translationResultFromExternalEntry(entry, system);
          this.conceptMapResultLru.set(lruKey, result);
          return result;
        }
      } catch {
        // Ignore external cache failures and fall back to local evaluation.
      }
    }

    // Local evaluation: load and index ConceptMap
    let cm: any;
    try {
      cm = await this.loadConceptMapResource(cmKey);
    } catch (e) {
      const err: any = new Error(`Failed to load ConceptMap for key '${cmKeyStr}'.`);
      err.errors = errors.concat([e]);
      throw this.prethrow(err);
    }
    if (!cm || cm.resourceType !== 'ConceptMap') {
      const err: any = new Error(`Resolved ConceptMap '${cmKeyStr}' is not a ConceptMap.`);
      err.errors = errors;
      throw this.prethrow(err);
    }

    const flatIndex = buildIndexFromConceptMap(cm);

    // Promote to small index if under threshold
    if (flatIndex.uniqueSourceCodeCount <= FTR_DEFAULT_LIMITS.conceptMap.smallThresholdUniqueSourceCodes) {
      this.smallConceptMapIndexLru.set(cmKeyStr, flatIndex);
      await this.primeExternalConceptMapCacheIfProvided(cmKey, cmKeyStr, flatIndex, true);
      const { result, resolvedSourceSystem, targetsBySourceSystem } = this.lookupInConceptMapIndexWithSourceSystem(
        flatIndex,
        code,
        system
      );
      await this.syncExternalConceptMapCacheForLookup(cmKey, code, resolvedSourceSystem, result, targetsBySourceSystem);
      return result;
    }

    // Large: optionally prime external cache once per CM
    await this.primeExternalConceptMapCacheIfProvided(cmKey, cmKeyStr, flatIndex, false);

    const { result, resolvedSourceSystem, targetsBySourceSystem } = this.lookupInConceptMapIndexWithSourceSystem(
      flatIndex,
      code,
      system
    );
    this.conceptMapResultLru.set(lruKey, result);
    await this.syncExternalConceptMapCacheForLookup(cmKey, code, resolvedSourceSystem, result, targetsBySourceSystem);
    return result;
  }

  private lookupInConceptMapIndexWithSourceSystem(
    index: SmallConceptMapIndex,
    code: string,
    system?: string
  ): {
    result: ConceptMapTranslationResult;
    resolvedSourceSystem?: string;
    targetsBySourceSystem?: Record<string, { targets: ConceptMapTranslation[]; ignoredEquivalences?: string[] }>;
  } {
    const systemsMap = index.bySourceCode.get(code);
    if (!systemsMap) return { result: { status: 'unmapped', reason: 'no-source-code' } };

    const targetsBySourceSystem: Record<string, { targets: ConceptMapTranslation[]; ignoredEquivalences?: string[] }> = {};
    for (const [sourceSystem, facts] of systemsMap.entries()) {
      targetsBySourceSystem[sourceSystem] = {
        targets: facts.targets,
        ...(facts.ignoredEquivalences && facts.ignoredEquivalences.length ? { ignoredEquivalences: facts.ignoredEquivalences } : {})
      };
    }

    if (system) {
      const facts = systemsMap.get(system);
      if (!facts) {
        return { result: { status: 'unmapped', reason: 'no-translation' }, resolvedSourceSystem: system, targetsBySourceSystem };
      }

      if (facts.targets.length === 0) {
        if (facts.ignoredEquivalences && facts.ignoredEquivalences.length) {
          return {
            result: { status: 'unmapped', reason: 'unsupported-equivalence', ignoredEquivalences: facts.ignoredEquivalences },
            resolvedSourceSystem: system,
            targetsBySourceSystem
          };
        }
        return { result: { status: 'unmapped', reason: 'no-translation' }, resolvedSourceSystem: system, targetsBySourceSystem };
      }

      return { result: { status: 'mapped', targets: facts.targets }, resolvedSourceSystem: system, targetsBySourceSystem };
    }

    // code-only: ambiguous if multiple source systems exist for this code
    if (systemsMap.size !== 1) {
      return { result: { status: 'unmapped', reason: 'duplicate-code' }, targetsBySourceSystem };
    }

    const resolvedSourceSystem = systemsMap.keys().next().value as string | undefined;
    const facts = systemsMap.values().next().value;
    const targets = facts?.targets || [];
    if (targets.length === 0) {
      if (facts?.ignoredEquivalences && facts.ignoredEquivalences.length) {
        return {
          result: { status: 'unmapped', reason: 'unsupported-equivalence', ignoredEquivalences: facts.ignoredEquivalences },
          resolvedSourceSystem,
          targetsBySourceSystem
        };
      }
      return { result: { status: 'unmapped', reason: 'no-translation' }, resolvedSourceSystem, targetsBySourceSystem };
    }
    return { result: { status: 'mapped', targets }, resolvedSourceSystem, targetsBySourceSystem };
  }

  private translationResultFromExternalEntry(entry: ConceptMapCacheEntry, system?: string): ConceptMapTranslationResult {
    if (entry.status === 'not-found') return { status: 'unmapped', reason: 'no-source-code' };
    const map = entry.bySourceSystem || {};
    const sourceSystems = Object.keys(map);
    if (system) {
      const facts = map[system];
      if (!facts) return { status: 'unmapped', reason: 'no-translation' };
      if (!facts.targets?.length) {
        if (facts.ignoredEquivalences?.length) {
          return { status: 'unmapped', reason: 'unsupported-equivalence', ignoredEquivalences: facts.ignoredEquivalences };
        }
        return { status: 'unmapped', reason: 'no-translation' };
      }
      return { status: 'mapped', targets: facts.targets };
    }
    if (sourceSystems.length !== 1) return { status: 'unmapped', reason: 'duplicate-code' };
    const facts = map[sourceSystems[0]];
    if (!facts?.targets?.length) {
      if (facts?.ignoredEquivalences?.length) {
        return { status: 'unmapped', reason: 'unsupported-equivalence', ignoredEquivalences: facts.ignoredEquivalences };
      }
      return { status: 'unmapped', reason: 'no-translation' };
    }
    return { status: 'mapped', targets: facts.targets };
  }

  private async syncExternalConceptMapCacheForLookup(
    cmKey: ConceptMapDeterministicKey,
    code: string,
    sourceSystem: string | undefined,
    result: ConceptMapTranslationResult,
    targetsBySourceSystem?: Record<string, { targets: ConceptMapTranslation[]; ignoredEquivalences?: string[] }>
  ): Promise<void> {
    const external = this.conceptMapCache;
    if (!external) return;
    try {
      if (result.status === 'unmapped') {
        if (result.reason === 'no-source-code') {
          await external.setCode(cmKey, code, { status: 'not-found' });
          return;
        }

        if (targetsBySourceSystem) {
          await external.setCode(cmKey, code, { status: 'found', bySourceSystem: targetsBySourceSystem });
          return;
        }
        return;
      }

      if (!sourceSystem) return;
      const entry: ConceptMapCacheEntry = {
        status: 'found',
        bySourceSystem: {
          [sourceSystem]: { targets: result.targets }
        }
      };
      await external.setCode(cmKey, code, entry);
    } catch {
      /* c8 ignore next */
    }
  }

  private async primeExternalConceptMapCacheIfProvided(
    cmKey: ConceptMapDeterministicKey,
    cmKeyStr: string,
    index: SmallConceptMapIndex,
    isSmall: boolean
  ): Promise<void> {
    const external = this.conceptMapCache;
    if (!external) return;

    const canUseSentinel = !index.bySourceCode.has(EXTERNAL_PRIMED_SENTINEL_CODE);

    if (this.externallyPrimedConceptMaps.has(cmKeyStr)) return;

    try {
      if (canUseSentinel) {
        const sentinel = await external.getCode(cmKey, EXTERNAL_PRIMED_SENTINEL_CODE);
        if (sentinel) {
          this.externallyPrimedConceptMaps.add(cmKeyStr);
          return;
        }
      }
    } catch {
      /* ignore */
    }

    if (!isSmall) {
      // Only prime large ConceptMaps on first use (best effort).
    }

    const entries: Array<[string, ConceptMapCacheEntry]> = [];
    for (const [sourceCode, systemsMap] of index.bySourceCode.entries()) {
      const bySourceSystem: Record<string, { targets: ConceptMapTranslation[]; ignoredEquivalences?: string[] }> = {};
      for (const [sourceSystem, facts] of systemsMap.entries()) {
        bySourceSystem[sourceSystem] = {
          targets: facts.targets,
          ...(facts.ignoredEquivalences && facts.ignoredEquivalences.length ? { ignoredEquivalences: facts.ignoredEquivalences } : {})
        };
      }
      entries.push([sourceCode, { status: 'found', bySourceSystem }]);
    }

    try {
      // Clear then repopulate is reserved for future server reload support.
      // For package ConceptMaps we never need to clear.
      if (external.bulkSetCodes) {
        await external.bulkSetCodes(cmKey, entries);
      } else {
        for (const [code, entry] of entries) {
          await external.setCode(cmKey, code, entry);
        }
      }
      this.externallyPrimedConceptMaps.add(cmKeyStr);

      if (canUseSentinel) {
        await external.setCode(cmKey, EXTERNAL_PRIMED_SENTINEL_CODE, { status: 'not-found' });
      }
    } catch {
      /* c8 ignore next */
    }
  }
  /* c8 ignore stop */
};

export type {
  TerminologyCacheMode,
  TerminologyRuntimeConfig,
  Prethrower,
  CountResult,
  UnknownReason,
  MembershipResult,
  ConceptProps,
  CodingLike,
  TerminologyMembershipCache,
  ValueSetDeterministicKey,
  MembershipCacheEntry,
  TerminologyConceptMapCache,
  ConceptMapDeterministicKey,
  ConceptMapCacheEntry,
  ConceptMapTranslation,
  ConceptMapTranslationResult,
  ConceptMapUnmappedReason,
  SupportedConceptMapEquivalence,
  TerminologyFhirClient
} from '../types';

// Export implicit code systems for external usage
export { ImplicitCodeSystemRegistry } from './utils';

type SmallValueSetIndex = {
  byCode: Map<string, Map<string, ConceptProps>>;
  uniqueCodeCount: number;
};

type SmallConceptMapIndex = {
  bySourceCode: Map<string, Map<string, { targets: ConceptMapTranslation[]; ignoredEquivalences?: string[] }>>;
  uniqueSourceCodeCount: number;
};

class LruCache<K, V> {
  private maxSize: number;
  private map: Map<K, V>;

  constructor(maxSize: number) {
    this.maxSize = Math.max(1, maxSize);
    this.map = new Map();
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // refresh recency
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      const oldestKey = this.map.keys().next().value as K | undefined;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
  }

  deleteWhere(predicate: (key: K, value: V) => boolean): void {
    for (const [k, v] of this.map.entries()) {
      if (predicate(k, v)) this.map.delete(k);
    }
  }
}

function flattenExpansionContains(contains: any[] | undefined): Array<{ system?: string; code?: string; display?: string; version?: string }> {
  const out: Array<{ system?: string; code?: string; display?: string; version?: string }> = [];
  const walk = (list: any[] | undefined) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (item && typeof item.code === 'string') {
        const flattened: any = { system: item.system, code: item.code };
        if ('display' in item) flattened.display = item.display;
        if ('version' in item) flattened.version = item.version;
        out.push(flattened);
      }
      if (Array.isArray(item?.contains)) walk(item.contains);
    }
  };
  walk(contains);
  return out;
}

function buildIndexFromContains(flat: Array<{ system?: string; code?: string; display?: string; version?: string }>): SmallValueSetIndex {
  const byCode = new Map<string, Map<string, ConceptProps>>();
  for (const item of flat) {
    const code = typeof item.code === 'string' ? item.code : undefined;
    const system = typeof item.system === 'string' ? item.system : undefined;
    if (!code || !system) continue;
    let systemsMap = byCode.get(code);
    if (!systemsMap) {
      systemsMap = new Map();
      byCode.set(code, systemsMap);
    }
    if (!systemsMap.has(system)) {
      const concept: ConceptProps = { system, code };
      if ('display' in item && typeof item.display === 'string') concept.display = item.display;
      if ('version' in item && typeof item.version === 'string') concept.version = item.version;
      systemsMap.set(system, concept);
    }
  }
  return { byCode, uniqueCodeCount: byCode.size };
}

/* c8 ignore start */
function buildIndexFromConceptMap(cm: any): SmallConceptMapIndex {
  const bySourceCode = new Map<string, Map<string, { targets: ConceptMapTranslation[]; ignoredEquivalences?: string[] }>>();
  const groups = Array.isArray(cm?.group) ? cm.group : [];
  for (const group of groups) {
    const groupSource = typeof group?.source === 'string' ? group.source : undefined;
    const groupTarget = typeof group?.target === 'string' ? group.target : undefined;
    const elements = Array.isArray(group?.element) ? group.element : [];
    for (const el of elements) {
      const sourceCode = typeof el?.code === 'string' ? el.code : undefined;
      const sourceSystem = typeof el?.system === 'string' ? el.system : groupSource;
      if (!sourceCode || !sourceSystem) continue;

      const targets = Array.isArray(el?.target) ? el.target : [];
      const outTargets: ConceptMapTranslation[] = [];
      const seen = new Set<string>();
      const ignoredEquivalences = new Set<string>();
      for (const t of targets) {
        const targetCode = typeof t?.code === 'string' ? t.code : undefined;
        const targetSystem = typeof t?.system === 'string' ? t.system : groupTarget;
        if (!targetCode || !targetSystem) continue;

        const eqRaw = (t as any)?.equivalence;
        const equivalence: SupportedConceptMapEquivalence =
          (typeof eqRaw === 'string' ? eqRaw : 'equivalent') as SupportedConceptMapEquivalence;
        if (!SUPPORTED_CONCEPTMAP_EQUIVALENCE.has(equivalence)) {
          if (typeof eqRaw === 'string') ignoredEquivalences.add(eqRaw);
          continue;
        }

        const translation: ConceptMapTranslation = { system: targetSystem, code: targetCode, equivalence };
        if (typeof t?.display === 'string') translation.display = t.display;
        if (typeof t?.version === 'string') translation.version = t.version;

        const key = `${equivalence}|${translation.system}|${translation.code}|${translation.version || ''}|${translation.display || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        outTargets.push(translation);
      }

      let systemsMap = bySourceCode.get(sourceCode);
      if (!systemsMap) {
        systemsMap = new Map();
        bySourceCode.set(sourceCode, systemsMap);
      }

      const existingFacts = systemsMap.get(sourceSystem);
      const mergedTargets = (existingFacts?.targets || []).concat(outTargets);

      const dedupedTargets: ConceptMapTranslation[] = [];
      const mergedSeen = new Set<string>();
      for (const tr of mergedTargets) {
        const key = `${tr.equivalence}|${tr.system}|${tr.code}|${tr.version || ''}|${tr.display || ''}`;
        if (mergedSeen.has(key)) continue;
        mergedSeen.add(key);
        dedupedTargets.push(tr);
      }

      const mergedIgnored = new Set<string>(existingFacts?.ignoredEquivalences || []);
      for (const v of ignoredEquivalences) mergedIgnored.add(v);

      const facts: { targets: ConceptMapTranslation[]; ignoredEquivalences?: string[] } = { targets: dedupedTargets };
      if (mergedIgnored.size) facts.ignoredEquivalences = Array.from(mergedIgnored);

      systemsMap.set(sourceSystem, facts);
    }
  }
  return { bySourceCode, uniqueSourceCodeCount: bySourceCode.size };
}
/* c8 ignore stop */

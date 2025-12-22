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
  MembershipCacheEntry
} from '../types';

const versionedCacheDir = `v${ftrVersion.split('.').slice(0, 2).join('.')}.x`;

export class FhirTerminologyRuntime {
  private fpe: FhirPackageExplorer;
  private logger: Logger;
  private prethrow: Prethrower;
  private cachePath: string;
  private cacheMode: TerminologyCacheMode;
  private fhirVersion: FhirVersion;
  private expansionCountCache: Map<string, CountResult> = new Map();

  private membershipCache?: TerminologyMembershipCache;

  // Cache for resolving ValueSet identifiers (url/id/name) -> metadata.
  // Keyed by identifier + packageFilter.
  private valueSetIdentifierMetaCache: Map<string, Promise<FileIndexEntryWithPkg>> = new Map();

  // General-purpose resolveMeta cache to avoid repeated FPE lookups.
  private resolveMetaCache: Map<string, Promise<any>> = new Map();

  // LRU: small ValueSet indexes (<= 50 unique codes)
  private smallValueSetIndexLru = new LruCache<string, SmallValueSetIndex>(100);
  // LRU: per-code membership results for non-small ValueSets
  private membershipResultLru = new LruCache<string, MembershipResult>(10000);

  // In-memory guard for avoiding repeated external priming per VS key.
  private externallyPrimedValueSets: Set<string> = new Set();

  private constructor(
    fpe: FhirPackageExplorer,
    cacheMode: TerminologyCacheMode,
    fhirVersion: FhirVersion,
    logger?: Logger,
    membershipCache?: TerminologyMembershipCache
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
      const ftr = new FhirTerminologyRuntime(fpe, cacheMode, fhirVersion, config.logger, config.membershipCache);

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
            vsErrors.push(`Failed to ${cacheMode} expansion for '${url || filename}' in package '${packageId}@${packageVersion}': ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (vsErrors.length > 0) {
          logger.warn(`Errors during pre-caching ValueSet expansions (${vsErrors.length} total):\n${vsErrors.join('\n')}`);
        } else {
          logger.info(`Pre-caching ValueSet expansions in '${cacheMode}' mode completed successfully.`);
        }
      }
      return ftr;
    } catch (e) {
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
        try { await this.saveExpansionToCache(filename, packageId, packageVersion!, failureStub); } catch { /* ignore */ }
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
          throw new Error(`ValueSet '${identifier}' not found in context. Could not get or generate an expansion.`);
        }
      } else {
        metadata = identifier as FileIndexEntryWithPkg;
        if (!metadata) {
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

      // Check for failure stub
      if (expansion?.expansion?.__failure) {
        const result: CountResult = { status: 'unknown', reason: 'unexpandable-valueset' };
        this.expansionCountCache.set(cacheKey, result);
        return result;
      }

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
          throw new Error(`CodeSystem '${url}' not found (searched in package '${sourcePackage.id}@${sourcePackage.version}' then globally).`);
        }
      }

      if (!meta?.content || (typeof meta?.content === 'string' && meta.content !== 'complete')) {
        throw new Error(`CodeSystem '${url}' has content='${meta.content}' and cannot be expanded (only 'complete' supported).`);
      }

      const cs = await this.fpe.resolve({ filename: meta.filename, package: { id: meta.__packageId, version: meta.__packageVersion } });
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
      return { status: 'unknown', reason: 'unknown-valueset' };
    }
    const vsKeyStr = this.toValueSetKeyString(vsKey);

    // Layer 1: small ValueSet index LRU
    const smallIndex = this.smallValueSetIndexLru.get(vsKeyStr);
    if (smallIndex) {
      const result = this.lookupInIndex(smallIndex, code, system);
      // Ensure external cache is kept up to date with what we know
      await this.syncExternalCacheForLookup(vsKey, code, result);
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
      if (expansion?.expansion?.__failure) {
        const res: MembershipResult = { status: 'unknown', reason: 'unexpandable-valueset' };
        this.membershipResultLru.set(membershipKey, res);
        return res;
      }
    } catch {
      const res: MembershipResult = { status: 'unknown', reason: 'unexpandable-valueset' };
      this.membershipResultLru.set(membershipKey, res);
      return res;
    }

    const containsFlat = flattenExpansionContains(expansion?.expansion?.contains);
    const index = buildIndexFromContains(containsFlat);

    // Promote to small index if under threshold
    if (index.uniqueCodeCount < 50) {
      this.smallValueSetIndexLru.set(vsKeyStr, index);
      // Small: also prime external cache for completeness
      await this.primeExternalCacheIfProvided(vsKey, vsKeyStr, index, true);
      const result = this.lookupInIndex(index, code, system);
      return result;
    }

    // Large: optionally prime external cache once per VS
    await this.primeExternalCacheIfProvided(vsKey, vsKeyStr, index, false);

    const result = this.lookupInIndex(index, code, system);
    this.membershipResultLru.set(membershipKey, result);
    await this.syncExternalCacheForLookup(vsKey, code, result);
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

  private async syncExternalCacheForLookup(vsKey: ValueSetDeterministicKey, code: string, result: MembershipResult): Promise<void> {
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
      // ignore
    }
  }

  private async primeExternalCacheIfProvided(
    vsKey: ValueSetDeterministicKey,
    vsKeyStr: string,
    index: SmallValueSetIndex,
    isSmall: boolean
  ): Promise<void> {
    const external = this.membershipCache;
    if (!external) return;

    // If external cache can track priming state, consult it; otherwise use in-memory guard.
    try {
      if (external.isValueSetPrimed) {
        const primed = await external.isValueSetPrimed(vsKey);
        if (primed) return;
      } else {
        if (this.externallyPrimedValueSets.has(vsKeyStr)) return;
      }
    } catch {
      // If external can't answer, fall back to in-memory guard.
      if (this.externallyPrimedValueSets.has(vsKeyStr)) return;
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
      if (external.markValueSetPrimed) {
        await external.markValueSetPrimed(vsKey);
      }
      this.externallyPrimedValueSets.add(vsKeyStr);
    } catch {
      // ignore external priming failures
    }
  }
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
  MembershipCacheEntry
} from '../types';

// Export implicit code systems for external usage
export { ImplicitCodeSystemRegistry } from './utils';

type SmallValueSetIndex = {
  byCode: Map<string, Map<string, ConceptProps>>;
  uniqueCodeCount: number;
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

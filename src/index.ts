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
  FhirPackageExplorer,
  FileIndexEntryWithPkg
} from 'fhir-package-explorer';

import {
  FhirPackageIdentifier,
  FhirVersion,
  Logger
} from '@outburn/types';
import type {
  TerminologyCacheMode,
  TerminologyRuntimeConfig,
  Prethrower
} from '../types';

const versionedCacheDir = `v${ftrVersion.split('.').slice(0, 2).join('.')}.x`;

export class FhirTerminologyRuntime {
  private fpe: FhirPackageExplorer;
  private logger: Logger;
  private prethrow: Prethrower;
  private cachePath: string;
  private cacheMode: TerminologyCacheMode;
  private fhirVersion: FhirVersion;

  private constructor(fpe: FhirPackageExplorer, cacheMode: TerminologyCacheMode, fhirVersion: FhirVersion, logger?: Logger) {
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
      const ftr = new FhirTerminologyRuntime(fpe, cacheMode, fhirVersion, config.logger);

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

  private async getValueSetMetadata(identifier: string, packageFilter?: FhirPackageIdentifier): Promise<FileIndexEntryWithPkg> {
    const errors: any[] = [];
    if (identifier.startsWith('http:') || identifier.startsWith('https:') || identifier.includes(':')) {
      try {
        const match = await this.fpe.resolveMeta({ resourceType: 'ValueSet', url: identifier, package: packageFilter });
        return match; // return the resolved match (with core-bias applied)
      } catch (e) {
        errors.push(e);
      }
    }
    // Not a URL, or failed to resolve as URL - try and resolve it as ID
    try {
      const match = await this.fpe.resolveMeta({ resourceType: 'ValueSet', id: identifier, package: packageFilter });
      return match; // return the resolved match (with core-bias applied)
    } catch (e) {
      errors.push(e);
    }
    // Couldn't resolve as ID - try and resolve it as name
    try {
      const match = await this.fpe.resolveMeta({ resourceType: 'ValueSet', name: identifier, package: packageFilter });
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
        vsMeta = await this.fpe.resolveMeta({ resourceType: 'ValueSet', url: vsUrl, package: sourcePackage });
      } catch {
        try {
          vsMeta = await this.fpe.resolveMeta({ resourceType: 'ValueSet', url: vsUrl });
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

    // Combine with referenced VS per JSONata rules
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
        meta = await this.fpe.resolveMeta({ resourceType: 'CodeSystem', url, package: sourcePackage });
      } catch {
        // swallow and fallback to global resolution
      }

      if (!meta) {
        try {
          meta = await this.fpe.resolveMeta({ resourceType: 'CodeSystem', url });
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
};

export type {
  TerminologyCacheMode,
  TerminologyRuntimeConfig,
  Prethrower
} from '../types';

// Export implicit code systems for external usage
export { ImplicitCodeSystemRegistry } from './utils';

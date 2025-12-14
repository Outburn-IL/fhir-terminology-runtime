# FHIR Terminology Runtime

> Local FHIR terminology runtime for ValueSet expansion, CodeSystem resolution, and terminology operations  
> Part of the [FUME](https://github.com/Outburn-IL/fume-community) open-source initiative · Apache 2.0 License

## Overview

`fhir-terminology-runtime` (FTR):
- Expands ValueSets (compose.include / compose.exclude) using CodeSystems from FHIR packages.
- Resolves CodeSystems by canonical URL with package-context-aware versioning.
- Caches expanded ValueSets alongside source packages for performance.
- Supports implicit code systems (ISO 3166, BCP-47) without external dependencies.

## Why?

Many ValueSets in FHIR packages can be locally expanded given complete CodeSystems. Local expansion:
- Avoids round-trips to external terminology servers for static, package-defined terminology
- Provides deterministic, reproducible expansions
- Works offline and in constrained environments
- Enables fast terminology operations in data transformation pipelines

FTR supports multiple FHIR versions, package-context-aware resolution, lazy or full-cache modes, and works hand-in-hand with [`fhir-package-explorer`](https://github.com/Outburn-IL/fhir-package-explorer) and [`fhir-package-installer`](https://github.com/Outburn-IL/fhir-package-installer).

## Installation

```
npm install fhir-terminology-runtime
```

## Usage

### 1. Create an instance

FTR uses dependency injection - you provide a pre-configured `FhirPackageExplorer` instance. This allows sharing a single FPE instance across multiple modules (e.g., FSG and FTR):

```ts
import { FhirTerminologyRuntime } from 'fhir-terminology-runtime';
import { FhirPackageExplorer } from 'fhir-package-explorer';

// Create a single FPE instance
const fpe = await FhirPackageExplorer.create({
  context: ['hl7.fhir.us.core@6.1.0'],
  cachePath: './.fhir-cache',
  fhirVersion: '4.0.1',
  skipExamples: true
});

// Create FTR using the shared FPE
const ftr = await FhirTerminologyRuntime.create({
  fpe,
  cacheMode: 'lazy', // 'lazy' | 'ensure' | 'rebuild' | 'none'
  fhirVersion: '4.0.1'
});
```

Benefits of this approach:
- ✅ Share a single FPE instance across FSG, FTR, and other modules
- ✅ Single source of truth for FHIR package configuration
- ✅ Better resource management and configuration consistency
- ✅ Explicit dependency management

If a base FHIR package is missing from the package context and dependencies, FPE will add it automatically according to `fhirVersion`.

### 2. Expand a ValueSet

```ts
const expansion = await ftr.expandValueSet('administrative-gender'); // id | name | canonical URL
```

The `expandValueSet` method accepts any FSH-style identifier: canonical URL, id or name. It also accepts a resolved metadata object if you already have one.

## ValueSet Expansion Details

The expansion engine performs a deterministic local expansion when possible:
- Supports: `compose.include` (system + all codes, or explicit concept list), `compose.exclude`, and `include.valueSet` recursion (with cycle detection) plus JSON-style set semantics (union of includes, subtraction of excludes, intersection when combining explicit concepts with referenced ValueSets for the same system).
- Not supported yet: `include.filter` (expansion will throw an error). This intentionally surfaces intensional ValueSets so callers can fallback to an external terminology service if possible.
- Recursion: `include.valueSet` entries are resolved first in the source package; if not found there, a global context fallback is attempted.
- Fallback: If local generation fails but the original ValueSet resource contains an `expansion.contains`, that original expansion is returned and cached (no attempt is made to validate staleness).
- Displays: When an `include.concept` list supplies explicit codes with displays, the associated CodeSystem resource is not loaded (performance optimization).

### CodeSystem Resolution Rules

When expanding ValueSets the runtime resolves referenced CodeSystems by canonical URL (may be a versioned URL):
1. Attempt resolution within the originating ValueSet's package (exact version context).
2. If not found, fall back to global [`fhir-package-explorer`](https://github.com/Outburn-IL/fhir-package-explorer) context using semver-aware `resolveMeta` from FPE to pick a single best version (prevents duplicate version conflicts).
3. Only CodeSystems with `content = 'complete'` are eligible. Any other `content` will throw an expansion error.
4. CodeSystems themselves are NOT cached by FTR (they live in their package). Only the derived ValueSet expansion result is cached.

### Expansion Caching

Expanded (or fallback) ValueSets are cached in a dedicated `.ftr` directory alongside source packages. Repeated calls reuse the cached expansion unless `cacheMode` is `none`.

## Context
You must provide an array of FHIR packages in `context`. Any package or its dependencies missing in the local FHIR package cache will be downloaded and installed (by [`fhir-package-installer`](https://github.com/Outburn-IL/fhir-package-installer)).

Supports `<id>#<version>`, `<id>@<version>`, `<id>` (latest version) or a package identifier object e.g:
```
{
    id: 'hl7.fhir.us.core',
    version: '6.1.0'
}
```

## Cache Modes

| Mode      | Behavior                                                                                 |
|-----------|------------------------------------------------------------------------------------------|
| `lazy`    | *Default*. Generates and caches expansions on demand.                                    |
| `ensure`  | Ensures all ValueSets have cached expansions (missing ones are generated).               |
| `rebuild` | Clears cache and regenerates all expansions from scratch.                                |
| `none`    | Disables caching completely (expansions computed each call, nothing written).            |

Cached artifacts are stored under:

```
<cachePath>/<packageId>#<packageVersion>/.ftr/<FTR version>/
```
- Filenames mirror originals in `<cachePath>/<packageId>#<packageVersion>/package`.
- FTR Version directory uses major.minor.x (e.g. `0.1.x`).

**DEVELOPER NOTICE** – Any change that affects expansion generation output MUST increment the minor version so previously cached results are not silently reused.

## Cache Path
`cachePath` defines the FHIR package cache directory to be used. This is passed through to [`fhir-package-explorer`](https://github.com/Outburn-IL/fhir-package-explorer) and [`fhir-package-installer`](https://github.com/Outburn-IL/fhir-package-installer).  
If not provided, the default cache location will be used.  
See: [Package Cache Directory section](https://github.com/Outburn-IL/fhir-package-installer/blob/main/README.md#package-cache-directory) in FPI's readme for details.

## FHIR Version

Specify the default FHIR version with the `fhirVersion` option. This determines which base definitions are used when none are explicitly imported through dependencies.
If not specified, defaults to `4.0.1` (FHIR R4).

## Roadmap
- External terminology service support (fallback for intensional ValueSets)
- ConceptMap lookup and translation operations
- LMDB-based caching for improved performance
- `include.filter` support for local logical expansion
- Terminology validation operations
- Expansion parameterization (e.g. date constraints, designations)

## License

Apache License 2.0  
© Outburn Ltd. 2022–2025. All Rights Reserved.

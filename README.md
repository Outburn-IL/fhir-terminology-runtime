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

### 3. Get ValueSet Expansion Count

Get the count of concepts in a ValueSet expansion without loading the full expansion if possible. Results are cached in memory.

```ts
const result = await ftr.getValueSetExpansionCount('administrative-gender');

if (result.status === 'ok') {
  console.log(`Count: ${result.count}`);
} else {
  console.log(`Could not count: ${result.reason}`);
}
```

The result type is:
```ts
type CountResult =
  | { status: 'ok'; count: number }
  | { status: 'unknown'; reason: 'unexpandable-valueset' | 'unknown-valueset' | 'duplicate-code' };
```

### 4. Check membership (`inValueSet`)

For fast validation of whether a code is in a ValueSet, use `inValueSet`.

It accepts either:
- a plain code string (common case; system is implicit), OR
- a Coding-like object with `{ system, code }`.

```ts
const r1 = await ftr.inValueSet('A', 'administrative-gender');
//    ^ MembershipResult

const r2 = await ftr.inValueSet({ system: 'http://hl7.org/fhir/administrative-gender', code: 'male' }, 'administrative-gender');
```

Return type:
```ts
type ConceptProps = {
  system: string;
  code: string;
  display?: string;
  version?: string;
};

type MembershipResult =
  | { status: 'member'; concept: ConceptProps }
  | { status: 'not-member' }
  | { status: 'unknown'; reason: UnknownReason };
```

Unknown reasons:
- `unknown-valueset`: the ValueSet identifier could not be resolved.
- `unexpandable-valueset`: the ValueSet could not be expanded locally.
- `duplicate-code`: returned only for **code-only** lookups when the same code exists under **multiple systems** in the ValueSet (ambiguous without a system).

## Membership caching (`membershipCache`)

`inValueSet` is optimized for very fast repeated lookups and uses multiple caching layers:
- An in-memory LRU for **small** ValueSets (≤ 50 unique codes), holding up to 100 ValueSets.
- An in-memory LRU for **per-code** results for larger ValueSets, holding up to 10,000 code lookups.
- An optional **external async cache** (injectable) used as a fallback and for persistence/distributed caching.

### Configure an external membership cache

Provide a `membershipCache` in `FhirTerminologyRuntime.create(...)`:

```ts
const ftr = await FhirTerminologyRuntime.create({
  fpe,
  cacheMode: 'lazy',
  fhirVersion: '4.0.1',
  membershipCache
});
```

The external cache is keyed deterministically by ValueSet metadata: `(packageId, packageVersion, filename)`.

Interface (simplified):
```ts
type ValueSetDeterministicKey = {
  packageId: string;
  packageVersion: string;
  filename: string;
};

type MembershipCacheEntry =
  | { status: 'member'; conceptsBySystem: Record<string, ConceptProps> }
  | { status: 'not-member' };

interface TerminologyMembershipCache {
  getCode(vs: ValueSetDeterministicKey, code: string): Promise<MembershipCacheEntry | undefined>;
  setCode(vs: ValueSetDeterministicKey, code: string, entry: MembershipCacheEntry): Promise<void>;

  // Optional: more efficient priming for large ValueSets
  bulkSetCodes?(vs: ValueSetDeterministicKey, entries: Array<[string, MembershipCacheEntry]>): Promise<void>;
}
```

### What does “prime / priming” mean?

In this codebase, **priming** refers specifically to the optional *external membership cache* behavior.

When FTR says it will **prime** the external cache for a ValueSet, it means:
- FTR has already built a local membership index for that ValueSet (from its expansion).
- FTR then **bulk-populates the external cache** with *membership answers for many (often all) codes* in that ValueSet, so future `inValueSet(...)` calls can be answered without re-expanding/re-indexing.

This is different from the normal per-lookup caching that happens during `inValueSet`:
- **Per-lookup cache sync** (always small): after answering a single code lookup, FTR may write a single `(ValueSetKey, code) -> entry` into the external cache.
- **Priming** (larger write, optional): FTR writes *many* codes for the same ValueSet in one go (ideally via `bulkSetCodes`).

#### Why prime at all?

Priming is a performance / distribution optimization:
- Speeds up future lookups for the same ValueSet (especially in fresh processes/containers).
- Enables sharing membership knowledge across workers if the external cache is shared (Redis, DB, etc.).
- Reduces repeated “first time” cost where the runtime would otherwise need to expand and index again.

#### What exactly gets written during priming?

Priming writes entries shaped like `MembershipCacheEntry`:

- For each `code` in the ValueSet, FTR writes:
  - `{ status: 'member', conceptsBySystem: { [systemUrl]: { system, code, display?, version? }, ... } }`

Notes:
- The external cache entry can store **multiple systems** for the same `code`. This is important because `inValueSet('X', vs)` can be ambiguous when multiple systems contain the same code.
- FTR does **not** write "unknown" results to the external cache (for example `duplicate-code`), because unknown results often depend on whether the caller provided a system. Instead, FTR stores the raw “member by system(s)” facts.

#### When does priming happen?

Priming happens inside `inValueSet(...)` after FTR has built a local index for that ValueSet.

Current behavior:
- **Small ValueSets (≤ 50 unique codes)**:
  - FTR builds an in-memory “small index”.
  - FTR also primes the external cache “for completeness” because the write is cheap.
- **Large ValueSets (> 50 unique codes)**:
  - FTR uses a per-code LRU for in-memory caching.
  - FTR attempts a one-time priming for that ValueSet so subsequent lookups can hit the external cache.

Important: priming is **best-effort**.
- If the external cache is unavailable or throws, FTR continues and still answers the lookup from local evaluation.
- Priming failures do not make `inValueSet` fail.

#### What does “primed” mean?

“Primed” is a state meaning: *“we believe the external cache already contains the bulk membership entries for this ValueSet key.”*

---

## ConceptMap translation (`translateConceptMap`)

FTR can translate codes using `ConceptMap` resources from FHIR packages.

API:

```ts
const targets = await ftr.translateConceptMap('A', 'some-conceptmap');
// targets: Array<{ system, code, display?, version?, equivalence }>
```

Input:
- A code string (common case; source `system` is implicit), or
- A Coding-like object `{ system, code }`.

Output:
- Always returns an array of **full target Codings** (never just a string code).
- Returns `[]` when there is no translation (or when a code-only lookup is ambiguous).

### Equivalence handling

Only these `ConceptMap.group.element.target[].equivalence` values are used for translation:

```txt
equivalent
equal
wider
subsumes
relatedto
```

If `equivalence` is missing (allowed in FHIR R3), it is treated as `equivalent`.
Any other equivalence value is ignored.

### Group flattening

All `ConceptMap.group[]` entries are treated as a single flattened mapping.
Group boundaries have no semantic meaning for translation in this runtime.

### Translation caching (`conceptMapCache`)

`translateConceptMap` uses multiple caching layers similar to `inValueSet`:

- In-memory LRU for **small** ConceptMaps (≤ 50 unique source codes), holding up to 20 ConceptMaps.
- In-memory LRU for **hot per-code** translation results, holding up to 1,000 lookups.
- Optional **external async cache** (injectable) used for cold-start / distributed caching.

Provide a `conceptMapCache` in `FhirTerminologyRuntime.create(...)`:

```ts
const ftr = await FhirTerminologyRuntime.create({
  fpe,
  cacheMode: 'lazy',
  fhirVersion: '4.0.1',
  conceptMapCache
});
```

The external ConceptMap cache is keyed by a deterministic ConceptMap namespace:

- Package ConceptMaps: `(packageId, packageVersion, filename)`
- Server ConceptMaps: reserved for future support (keyed by server base URL + ConceptMap canonical URL)

Interface (simplified):

```ts
type ConceptMapDeterministicKey =
  | { kind: 'package'; packageId: string; packageVersion: string; filename: string }
  | { kind: 'server'; serverBaseUrl: string; url: string };

type ConceptMapTranslation = {
  system: string;
  code: string;
  display?: string;
  version?: string;
  equivalence: 'equivalent' | 'equal' | 'wider' | 'subsumes' | 'relatedto';
};

type ConceptMapCacheEntry =
  | { status: 'translated'; targetsBySourceSystem: Record<string, ConceptMapTranslation[]> }
  | { status: 'no-translation' };

interface TerminologyConceptMapCache {
  getCode(cm: ConceptMapDeterministicKey, code: string): Promise<ConceptMapCacheEntry | undefined>;
  setCode(cm: ConceptMapDeterministicKey, code: string, entry: ConceptMapCacheEntry): Promise<void>;

  bulkSetCodes?(cm: ConceptMapDeterministicKey, entries: Array<[string, ConceptMapCacheEntry]>): Promise<void>;

  // Required: used for future server-based reload operations
  clearNamespace(cm: ConceptMapDeterministicKey): Promise<void>;
}
```

Implementation note for cache authors:
- Use a clear namespace prefix (for example `cm:pkg:` vs `cm:srv:`) so you can safely store both package-based and future server-based entries.

FTR supports two ways to track this state:

1) **Automatic external primed-state (default; no extra methods required)**

FTR automatically tracks whether a ValueSet has been primed in the external cache using the **same `getCode/setCode` methods you already implement**.

Concretely:
- After a successful prime, FTR writes a reserved **sentinel entry** under a reserved “code” key.
- Before priming, FTR checks whether that sentinel entry exists.

This means the “standard cache interface” is just `getCode`/`setCode` (and optionally `bulkSetCodes`). You do **not** need to implement any additional primed-state methods.

What you might see in your cache:
- FTR may store an extra entry with `code = '__ftr__primed__'` to represent “this ValueSet has been primed”.
- This entry is internal bookkeeping and is never used as a real terminology code lookup.

Collision note (extremely unlikely): if a ValueSet legitimately contains the code `'__ftr__primed__'`, FTR will avoid using the sentinel mechanism for that ValueSet and will fall back to in-memory priming guards.

2) **In-memory primed-state (fallback)**

If the external cache is unavailable (or throws), FTR uses an in-memory Set (one per process) to avoid re-priming repeatedly within the same runtime instance.

This distinction matters:
- The in-memory guard prevents repeated priming *only within the current process*.
- The external primed-state prevents repeated priming across processes and restarts.

#### A concrete mental model

Consider a large ValueSet `VS` and a code lookup `inValueSet('C10', VS)`:

1) FTR tries the in-memory LRUs.
2) If configured, FTR tries the external cache for `(VS-key, 'C10')`.
3) If not found, FTR expands/indexes locally, answers the lookup, and then:
   - **syncs** the single code result to the external cache, and
   - may **prime** the external cache for `VS` (bulk write) so future codes (`C11`, `C12`, …) can be served externally.

#### Priming is not ValueSet expansion caching

FTR has two separate caching concepts:
- **Expansion caching**: stores the expanded ValueSet JSON on disk under `.ftr/` alongside packages.
- **Membership caching**: accelerates `inValueSet` lookups (in-memory LRUs + optional external cache).

“Priming” only refers to the **external membership cache** behavior.

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

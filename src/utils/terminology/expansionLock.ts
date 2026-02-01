/**
 * © Copyright Outburn Ltd. 2022-2025 All Rights Reserved
 *   Project name: fhir-terminology-runtime
 * 
 * Expansion Lock Utilities
 * 
 * Provides a two-layer locking mechanism for ValueSet expansion generation:
 * 
 * 1. **In-memory (module-level)**: For FTR instances running in the same Node.js process,
 *    uses a shared in-flight promise map. This is cache-path agnostic - the same expansion
 *    is deduplicated across all in-process instances regardless of their configured cache paths.
 * 
 * 2. **On-disk (lockfile)**: For multi-process coordination, uses lockfiles with timestamps.
 *    This layer is only shared between processes using the same cache folder path.
 * 
 * Both layers support a configurable TTL (default 5 minutes) to handle stale locks
 * from hanging/crashed expansion processes.
 */

import path from 'path';
import fs from 'fs-extra';

/** Default lock TTL in milliseconds (5 minutes) */
export const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000;

/** Lock file extension */
const LOCK_EXTENSION = '.lock';

/**
 * Lockfile content structure stored on disk.
 */
interface LockFileContent {
  /** ISO timestamp when the lock was acquired */
  timestamp: string;
  /** Process ID that acquired the lock (for debugging) */
  pid: number;
  /** Optional identifier for the expansion being processed */
  expansionKey?: string;
}

/**
 * Result of attempting to acquire an on-disk lock.
 */
export type DiskLockAcquireResult =
  | { acquired: true }
  | { acquired: false; reason: 'held-by-other' | 'stale-reclaimed' };

/**
 * Module-level in-memory inflight promise map.
 * 
 * This is shared across ALL FhirTerminologyRuntime instances within the same Node.js process,
 * regardless of their configured cache paths. This provides optimal deduplication for
 * scenarios where multiple FTR instances are created with different cache paths but
 * may request the same ValueSet expansion.
 * 
 * Key format: `${packageId}#${packageVersion}::${filename}`
 */
const globalInflightExpansions: Map<string, Promise<any>> = new Map();

/**
 * Generates a unique key for the in-memory inflight map.
 * This key is intentionally cache-path agnostic.
 */
export function getExpansionInflightKey(packageId: string, packageVersion: string, filename: string): string {
  return `${packageId}#${packageVersion}::${filename}`;
}

/**
 * Check if an expansion is currently in-flight in the same process.
 * If so, returns the promise to await; otherwise returns undefined.
 */
export function getInflightExpansion(key: string): Promise<any> | undefined {
  return globalInflightExpansions.get(key);
}

/**
 * Register an expansion as in-flight.
 * Call this when starting expansion generation.
 */
export function setInflightExpansion(key: string, promise: Promise<any>): void {
  globalInflightExpansions.set(key, promise);
}

/**
 * Remove an expansion from the in-flight map.
 * Call this when expansion generation completes (success or failure).
 */
export function clearInflightExpansion(key: string): void {
  globalInflightExpansions.delete(key);
}

/**
 * Execute a function with in-memory single-flight protection.
 * If the same key is already in-flight, returns the existing promise.
 * Otherwise, executes the function and registers it as in-flight.
 * 
 * @param key - Unique expansion key (cache-path agnostic)
 * @param fn - Async function to execute
 * @returns Promise resolving to the expansion result
 */
export async function withInflightLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = globalInflightExpansions.get(key);
  if (existing) {
    return existing;
  }

  const promise = fn();
  globalInflightExpansions.set(key, promise);

  try {
    return await promise;
  } finally {
    // Only clear if this is still our promise (avoid race with concurrent calls)
    if (globalInflightExpansions.get(key) === promise) {
      globalInflightExpansions.delete(key);
    }
  }
}

/**
 * Gets the lockfile path for a given expansion cache file path.
 */
export function getLockFilePath(cacheFilePath: string): string {
  return cacheFilePath + LOCK_EXTENSION;
}

/**
 * Read and parse a lockfile, returning undefined if it doesn't exist or is invalid.
 */
async function readLockFile(lockPath: string): Promise<LockFileContent | undefined> {
  try {
    if (!await fs.exists(lockPath)) {
      return undefined;
    }
    const content = await fs.readJSON(lockPath);
    if (typeof content?.timestamp === 'string' && typeof content?.pid === 'number') {
      return content as LockFileContent;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check if a lockfile is stale based on its timestamp and the configured TTL.
 */
function isLockStale(lock: LockFileContent, ttlMs: number = DEFAULT_LOCK_TTL_MS): boolean {
  const lockTime = new Date(lock.timestamp).getTime();
  // Invalid timestamp (NaN) - treat as stale
  if (isNaN(lockTime)) return true;
  const now = Date.now();
  return (now - lockTime) > ttlMs;
}

/**
 * Attempt to acquire an on-disk lock for expansion generation.
 * 
 * Uses a simple but robust strategy:
 * 1. Check if lockfile exists
 * 2. If exists and not stale, another process is working - return false
 * 3. If exists and stale, reclaim the lock
 * 4. If doesn't exist, create it
 * 
 * This isn't atomic but is sufficient for the use case - worst case we do
 * redundant work, but we won't corrupt data.
 * 
 * @param lockPath - Path to the lockfile
 * @param ttlMs - Lock TTL in milliseconds
 * @param expansionKey - Optional key for debugging
 * @returns Whether the lock was acquired
 */
export async function acquireDiskLock(
  lockPath: string,
  ttlMs: number = DEFAULT_LOCK_TTL_MS,
  expansionKey?: string
): Promise<DiskLockAcquireResult> {
  try {
    const existingLock = await readLockFile(lockPath);
    
    if (existingLock) {
      if (isLockStale(existingLock, ttlMs)) {
        // Lock is stale - reclaim it
        await writeLockFile(lockPath, expansionKey);
        return { acquired: true };
      } else {
        // Lock is held by another process
        return { acquired: false, reason: 'held-by-other' };
      }
    }

    // No existing lock - create one
    await writeLockFile(lockPath, expansionKey);
    return { acquired: true };
  } catch {
    // If we can't acquire the lock (e.g., permissions), assume we should proceed
    // rather than blocking forever. The file write will fail anyway if there's
    // a real permission issue.
    return { acquired: true };
  }
}

/**
 * Write a lockfile with the current timestamp and process ID.
 */
async function writeLockFile(lockPath: string, expansionKey?: string): Promise<void> {
  const content: LockFileContent = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    expansionKey
  };
  await fs.ensureDir(path.dirname(lockPath));
  await fs.writeJSON(lockPath, content);
}

/**
 * Release an on-disk lock by removing the lockfile.
 */
export async function releaseDiskLock(lockPath: string): Promise<void> {
  try {
    await fs.remove(lockPath);
  } catch {
    // Ignore errors - lock may have already been released
  }
}

/**
 * Wait for an existing on-disk lock to be released or become stale.
 * Polls periodically until the lock is released or TTL expires.
 * 
 * @param lockPath - Path to the lockfile
 * @param ttlMs - Lock TTL in milliseconds
 * @param pollIntervalMs - How often to check the lock (default 500ms)
 * @returns When the lock is released or stale
 */
export async function waitForDiskLock(
  lockPath: string,
  ttlMs: number = DEFAULT_LOCK_TTL_MS,
  pollIntervalMs: number = 500
): Promise<void> {
  const startTime = Date.now();
  const maxWaitTime = ttlMs + 5000; // Wait up to TTL + 5 seconds

  while (Date.now() - startTime < maxWaitTime) {
    const lock = await readLockFile(lockPath);
    
    // Lock released or doesn't exist
    if (!lock) {
      return;
    }

    // Lock is stale - we can proceed
    if (isLockStale(lock, ttlMs)) {
      return;
    }

    // Still locked - wait and retry
    await sleep(pollIntervalMs);
  }

  // Timeout - proceed anyway (lock will be treated as stale by acquireDiskLock)
}

/**
 * Check if an on-disk lock exists and is not stale.
 */
export async function isDiskLockHeld(lockPath: string, ttlMs: number = DEFAULT_LOCK_TTL_MS): Promise<boolean> {
  const lock = await readLockFile(lockPath);
  if (!lock) return false;
  return !isLockStale(lock, ttlMs);
}

/**
 * Simple sleep utility.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Combined locking strategy for expansion generation.
 * 
 * This function handles both in-memory and on-disk locking:
 * 
 * 1. First checks the in-memory inflight map. If an expansion is already in-flight
 *    in this process, returns that promise directly (regardless of cache path).
 * 
 * 2. If not in-flight, checks the on-disk lock:
 *    - If locked by another process and not stale, waits for it to complete
 *      then returns undefined (caller should read from cache)
 *    - If not locked or lock is stale, acquires the lock and proceeds
 * 
 * 3. Executes the expansion function with both locks held, then releases.
 * 
 * @param key - Unique expansion key (cache-path agnostic) for in-memory dedup
 * @param cacheFilePath - Path where the expansion cache file will be written
 * @param fn - Async function that generates the expansion
 * @param options - Lock configuration options
 * @returns The expansion result, or undefined if another process completed it
 */
export async function withExpansionLock<T>(
  key: string,
  cacheFilePath: string,
  fn: () => Promise<T>,
  options: {
    ttlMs?: number;
    pollIntervalMs?: number;
    /** If true, skip on-disk locking (useful for cacheMode='none') */
    skipDiskLock?: boolean;
    /** Logger for debug messages */
    // eslint-disable-next-line no-unused-vars
    logger?: { debug?: (...args: unknown[]) => void };
  } = {}
): Promise<{ result: T; fromOtherProcess: false } | { result: undefined; fromOtherProcess: true }> {
  const { ttlMs = DEFAULT_LOCK_TTL_MS, pollIntervalMs = 500, skipDiskLock = false, logger } = options;
  const lockPath = getLockFilePath(cacheFilePath);

  // Layer 1: Check in-memory inflight map
  const existing = globalInflightExpansions.get(key);
  if (existing) {
    logger?.debug?.(`[FTR Lock] Expansion '${key}' already in-flight in this process, waiting...`);
    const result = await existing;
    return { result, fromOtherProcess: false };
  }

  // Layer 2: On-disk locking (if enabled)
  if (!skipDiskLock) {
    const diskLockHeld = await isDiskLockHeld(lockPath, ttlMs);
    if (diskLockHeld) {
      logger?.debug?.(`[FTR Lock] Expansion '${key}' locked by another process, waiting...`);
      await waitForDiskLock(lockPath, ttlMs, pollIntervalMs);
      // After waiting, the other process should have written the result to cache
      // Return undefined to signal caller to read from cache
      return { result: undefined, fromOtherProcess: true };
    }
  }

  // Acquire both locks and execute
  const promise = (async () => {
    let diskLockAcquired = false;
    
    try {
      // Acquire disk lock (if enabled)
      if (!skipDiskLock) {
        const lockResult = await acquireDiskLock(lockPath, ttlMs, key);
        diskLockAcquired = lockResult.acquired;
        /* c8 ignore start - Multi-process race condition path, difficult to test deterministically */
        if (!lockResult.acquired) {
          // Another process beat us - wait for them
          logger?.debug?.(`[FTR Lock] Lost disk lock race for '${key}', waiting...`);
          await waitForDiskLock(lockPath, ttlMs, pollIntervalMs);
          // Signal to read from cache
          throw new LockRaceError('Lost disk lock race');
        }
        /* c8 ignore stop */
      }

      // Execute the expansion function
      return await fn();
    } finally {
      // Release disk lock
      if (diskLockAcquired) {
        await releaseDiskLock(lockPath);
      }
    }
  })();

  // Register in inflight map
  globalInflightExpansions.set(key, promise);

  try {
    const result = await promise;
    return { result, fromOtherProcess: false };
  } catch (e) {
    /* c8 ignore start - Catches LockRaceError from multi-process race condition */
    if (e instanceof LockRaceError) {
      return { result: undefined, fromOtherProcess: true };
    }
    /* c8 ignore stop */
    throw e;
  } finally {
    // Clear from inflight map
    if (globalInflightExpansions.get(key) === promise) {
      globalInflightExpansions.delete(key);
    }
  }
}

/**
 * Internal error class to signal that we lost a lock race.
 */
class LockRaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockRaceError';
  }
}

/**
 * Clear all in-memory inflight expansions.
 * Primarily useful for testing.
 */
export function clearAllInflightExpansions(): void {
  globalInflightExpansions.clear();
}

/**
 * Get the count of in-memory inflight expansions.
 * Primarily useful for testing.
 */
export function getInflightExpansionCount(): number {
  return globalInflightExpansions.size;
}

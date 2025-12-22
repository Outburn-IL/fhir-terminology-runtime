import path from 'path';
import fs from 'fs-extra';
import { describe, it, expect } from 'vitest';
import { FhirTerminologyRuntime } from '../src/index';

describe('ensureExpansionCached (unit)', () => {
  it('tolerates expansion generation failures when cache file is missing (pre-generation catch path)', async () => {
    const tempCachePath = path.join(process.cwd(), 'test', '.tmp-cache-ensure-expansion');
    await fs.remove(tempCachePath);

    const warnings: string[] = [];

    const logger: any = {
      info() {
        // no-op
      },
      warn(msg: any) {
        warnings.push(String(msg));
      },
      error() {
        // no-op
      }
    };

    const fpeStub: any = {
      getCachePath: () => tempCachePath,
      getContextPackages: () => [{ id: 'test.pkg', version: '1.0.0' }],
      async lookupMeta() {
        return [];
      },
      async resolveMeta() {
        return undefined;
      },
      async resolve() {
        return undefined;
      }
    };

    const ftr = await FhirTerminologyRuntime.create({
      fpe: fpeStub,
      cacheMode: 'lazy',
      fhirVersion: '4.0.1',
      logger
    });

    // Create and then delete the exact cache file path to simulate a missing cache file.
    const cacheFilePath = (ftr as any).getCacheFilePath('vs.json', 'p', '1.0.0');
    await fs.ensureDir(path.dirname(cacheFilePath));
    await fs.writeFile(cacheFilePath, '{}');
    await fs.remove(cacheFilePath);

    // Make expansion generation fail.
    (ftr as any).expandValueSetByMeta = async () => {
      throw new Error('generation failed');
    };

    await (ftr as any).ensureExpansionCached('vs.json', 'p', '1.0.0');

    expect(warnings.some(w => w.includes('Failed to pre-cache ValueSet expansion for \'vs.json\' in \'p@1.0.0\''))).toBe(true);

    await fs.remove(tempCachePath);
  });
});

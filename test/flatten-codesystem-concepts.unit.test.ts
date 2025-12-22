import { describe, it, expect } from 'vitest';
import { flattenCodeSystemConcepts } from '../src/utils/terminology/flattenCodeSystemConcepts';

describe('flattenCodeSystemConcepts (unit)', () => {
  it('returns empty map when CodeSystem.concept is missing or not an array', () => {
    expect(flattenCodeSystemConcepts(undefined).size).toBe(0);
    expect(flattenCodeSystemConcepts({ concept: null }).size).toBe(0);
    expect(flattenCodeSystemConcepts({ concept: {} }).size).toBe(0);
  });

  it('collects nested concepts, ignores invalid entries, and does not overwrite duplicate codes', () => {
    const cs = {
      concept: [
        null,
        'x',
        { code: 123, display: 'nope' },
        { display: 'missing-code' },
        { code: 'A', display: 'Alpha' },
        // duplicate code should not overwrite
        { code: 'A', display: 'Alpha-2' },
        {
          code: 'P',
          display: 'Parent',
          concept: [{ code: 'C', display: 'Child' }]
        }
      ]
    };

    const map = flattenCodeSystemConcepts(cs);
    expect(map.get('A')).toBe('Alpha');
    expect(map.get('P')).toBe('Parent');
    expect(map.get('C')).toBe('Child');
    expect(map.has('missing-code')).toBe(false);
  });
});

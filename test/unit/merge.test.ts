import { describe, it, expect } from 'vitest';
import { mergeReviewResults } from '../../src/review/merge.js';
import type { ReviewResult, ReviewAnnotation } from '../../src/types/review.js';

function annotation(overrides: Partial<ReviewAnnotation> = {}): ReviewAnnotation {
  return {
    path: 'src/a.ts',
    startLine: 10,
    endLine: 10,
    severity: 'warning',
    category: 'bug',
    title: 'Possible nil deref',
    body: 'details',
    ...overrides,
  };
}

function result(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    summary: 'part summary',
    score: 90,
    annotations: [],
    stats: { critical: 0, warning: 0, suggestion: 0, nitpick: 0 },
    tokensUsed: { input: 1_000, output: 100, cached: 500 },
    ...overrides,
  };
}

describe('mergeReviewResults', () => {
  it('throws on empty input', () => {
    expect(() => mergeReviewResults([])).toThrow();
  });

  it('returns the single result unchanged', () => {
    const only = result({ score: 42 });
    expect(mergeReviewResults([only])).toBe(only);
  });

  it('deduplicates annotations by path, startLine and title (case-insensitive)', () => {
    const merged = mergeReviewResults([
      result({ annotations: [annotation({ title: 'Possible nil deref' })] }),
      result({ annotations: [annotation({ title: 'possible NIL deref' })] }),
      result({ annotations: [annotation({ startLine: 20, title: 'Possible nil deref' })] }),
    ]);
    expect(merged.annotations).toHaveLength(2);
  });

  it('recomputes stats from merged annotations', () => {
    const merged = mergeReviewResults([
      result({
        annotations: [annotation({ severity: 'critical', title: 'A' })],
        stats: { critical: 1, warning: 0, suggestion: 0, nitpick: 0 },
      }),
      result({
        annotations: [
          annotation({ severity: 'critical', title: 'A' }), // duplicate
          annotation({ severity: 'suggestion', title: 'B' }),
        ],
        stats: { critical: 1, warning: 0, suggestion: 1, nitpick: 0 },
      }),
    ]);
    expect(merged.stats).toEqual({ critical: 1, warning: 0, suggestion: 1, nitpick: 0 });
  });

  it('sums token usage and takes the minimum score', () => {
    const merged = mergeReviewResults([
      result({ score: 95, tokensUsed: { input: 1_000, output: 100, cached: 500 } }),
      result({ score: 60, tokensUsed: { input: 2_000, output: 200, cached: 0 } }),
      result({ score: 88, tokensUsed: { input: 500, output: 50, cached: 100 } }),
    ]);
    expect(merged.score).toBe(60);
    expect(merged.tokensUsed).toEqual({ input: 3_500, output: 350, cached: 600 });
  });

  it('joins part summaries under a chunked header', () => {
    const merged = mergeReviewResults([
      result({ summary: 'first part' }),
      result({ summary: 'second part' }),
    ]);
    expect(merged.summary).toContain('2 parts');
    expect(merged.summary).toContain('**Part 1/2:** first part');
    expect(merged.summary).toContain('**Part 2/2:** second part');
  });
});

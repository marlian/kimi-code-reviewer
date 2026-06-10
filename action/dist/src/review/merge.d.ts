import type { ReviewResult } from '../types/review.js';
/**
 * Merge the per-batch results of a chunked review into a single ReviewResult.
 *
 * - annotations: concatenated, deduplicated by (path, startLine, title)
 * - stats: recomputed from the merged annotations
 * - tokensUsed: summed across batches
 * - score: minimum across batches (a PR is as healthy as its worst part)
 * - summary: per-part summaries joined under a chunked-review header
 */
export declare function mergeReviewResults(parts: ReviewResult[]): ReviewResult;
//# sourceMappingURL=merge.d.ts.map
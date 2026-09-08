import type { ReviewResult } from '../types/review.js';
/**
 * Merge the per-batch results of a chunked review into a single ReviewResult.
 *
 * - annotations: concatenated, deduplicated by (path, startLine, title)
 * - stats: recomputed from the merged annotations
 * - tokensUsed: summed across batches
 * - score: minimum across the batches that were reviewed (a PR is as
 *   healthy as its worst part; an incomplete part has no score)
 * - summary: per-part summaries joined under a chunked-review header
 * - incomplete: set if any part is incomplete (first one wins, part number
 *   added), so a batch the model failed on never reads as clean; the other
 *   parts' findings are kept
 */
export declare function mergeReviewResults(parts: ReviewResult[]): ReviewResult;
//# sourceMappingURL=merge.d.ts.map
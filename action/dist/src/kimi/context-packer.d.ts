import type { PullRequestContext, PackPlan } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
/**
 * Plan how the PR context will be sent to Kimi.
 *
 * - full: whole diff + all file contents fit in one call
 * - mixed: whole diff in one call, file contents included by priority until budget
 * - chunked: diff is too large for one call — split changed files into batches,
 *   one API call per batch (map), results merged afterwards (reduce)
 */
export declare function planContext(ctx: PullRequestContext, config: ReviewConfig): PackPlan;
//# sourceMappingURL=context-packer.d.ts.map
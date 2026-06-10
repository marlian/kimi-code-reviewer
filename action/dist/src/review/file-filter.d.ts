import type { ChangedFile } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
/**
 * Filter changed files based on include/exclude glob patterns from config.
 */
export declare function filterFiles(files: ChangedFile[], config: ReviewConfig): ChangedFile[];
/**
 * Restrict a unified diff to the given set of file paths.
 *
 * The PR diff fetched from the GitHub API covers every changed file,
 * including files excluded by the repo filter config — without this pass,
 * excluded hunks (generated output, vendored code, scratch dirs) still
 * reach the model in the full/mixed strategies.
 *
 * A section is kept when either side of its `diff --git` header is in the
 * allowed set (covers renames). Headers that fail to parse are kept
 * (fail open: reviewing too much is safer than silently dropping hunks).
 */
export declare function filterUnifiedDiff(diff: string, allowed: Set<string>): string;
//# sourceMappingURL=file-filter.d.ts.map
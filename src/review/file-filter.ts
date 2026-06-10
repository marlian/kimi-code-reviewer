import { minimatch } from 'minimatch';
import type { ChangedFile } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import { logger } from '../utils/logger.js';

/**
 * Filter changed files based on include/exclude glob patterns from config.
 */
export function filterFiles(
  files: ChangedFile[],
  config: ReviewConfig,
): ChangedFile[] {
  const { include, exclude } = config.files;

  const filtered = files.filter((file) => {
    // Must match at least one include pattern
    const included = include.some((pattern) =>
      minimatch(file.filename, pattern, { dot: true }),
    );
    if (!included) return false;

    // Must not match any exclude pattern
    const excluded = exclude.some((pattern) =>
      minimatch(file.filename, pattern, { dot: true }),
    );
    if (excluded) return false;

    // Skip removed files (nothing to review)
    if (file.status === 'removed') return false;

    // Skip files without patches (binary files)
    if (!file.patch) return false;

    return true;
  });

  const skipped = files.length - filtered.length;
  if (skipped > 0) {
    logger.info({ total: files.length, filtered: filtered.length, skipped }, 'Files filtered');
  }

  return filtered;
}

// Matches `diff --git a/<path> b/<path>` headers, including quoted paths
// (used by git when a path contains special characters).
const DIFF_GIT_HEADER = /^diff --git (?:"a\/(.+?)"|a\/(.+?)) (?:"b\/(.+)"|b\/(.+))$/;

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
export function filterUnifiedDiff(diff: string, allowed: Set<string>): string {
  if (!diff) return diff;

  const lines = diff.split('\n');
  const out: string[] = [];
  let keep = true;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const match = line.match(DIFF_GIT_HEADER);
      if (match) {
        const aPath = match[1] ?? match[2];
        const bPath = match[3] ?? match[4];
        keep =
          (aPath !== undefined && allowed.has(aPath)) ||
          (bPath !== undefined && allowed.has(bPath));
      } else {
        keep = true;
      }
    }
    if (keep) out.push(line);
  }

  return out.join('\n');
}

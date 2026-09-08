import type { ReviewResult, ReviewAnnotation, Severity } from '../types/review.js';

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
export function mergeReviewResults(parts: ReviewResult[]): ReviewResult {
  if (parts.length === 0) {
    throw new Error('mergeReviewResults requires at least one result');
  }
  if (parts.length === 1) {
    return parts[0];
  }

  const seen = new Set<string>();
  const annotations: ReviewAnnotation[] = [];
  for (const part of parts) {
    for (const annotation of part.annotations) {
      const key = `${annotation.path}:${annotation.startLine}:${annotation.title.trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      annotations.push(annotation);
    }
  }

  const stats: Record<Severity, number> = { critical: 0, warning: 0, suggestion: 0, nitpick: 0 };
  for (const annotation of annotations) {
    stats[annotation.severity]++;
  }

  const tokensUsed = parts.reduce(
    (acc, part) => ({
      input: acc.input + part.tokensUsed.input,
      output: acc.output + part.tokensUsed.output,
      cached: acc.cached + part.tokensUsed.cached,
    }),
    { input: 0, output: 0, cached: 0 },
  );

  // A part with no verdict has no score; the merged score is the worst of
  // the parts that were actually reviewed.
  const scored = parts.filter((part) => !part.incomplete).map((part) => part.score);
  const score = scored.length > 0 ? Math.min(...scored) : 0;

  const summaryParts: string[] = [
    `Large PR reviewed in ${parts.length} parts (chunked mode).`,
    '',
  ];
  parts.forEach((part, index) => {
    summaryParts.push(`**Part ${index + 1}/${parts.length}:** ${part.summary}`);
  });

  const firstIncomplete = parts.findIndex((part) => part.incomplete);
  const incomplete =
    firstIncomplete >= 0
      ? {
          ...parts[firstIncomplete].incomplete!,
          detail: `Part ${firstIncomplete + 1}/${parts.length}: ${parts[firstIncomplete].incomplete!.detail}`,
        }
      : undefined;

  return {
    summary: summaryParts.join('\n'),
    score,
    annotations,
    stats,
    tokensUsed,
    ...(incomplete ? { incomplete } : {}),
  };
}

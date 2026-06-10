import type { ReviewResult, ReviewAnnotation, Severity } from '../types/review.js';

/**
 * Merge the per-batch results of a chunked review into a single ReviewResult.
 *
 * - annotations: concatenated, deduplicated by (path, startLine, title)
 * - stats: recomputed from the merged annotations
 * - tokensUsed: summed across batches
 * - score: minimum across batches (a PR is as healthy as its worst part)
 * - summary: per-part summaries joined under a chunked-review header
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

  const score = Math.min(...parts.map((part) => part.score));

  const summaryParts: string[] = [
    `Large PR reviewed in ${parts.length} parts (chunked mode).`,
    '',
  ];
  parts.forEach((part, index) => {
    summaryParts.push(`**Part ${index + 1}/${parts.length}:** ${part.summary}`);
  });

  return {
    summary: summaryParts.join('\n'),
    score,
    annotations,
    stats,
    tokensUsed,
  };
}

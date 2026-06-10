import type { PullRequestContext, ChangedFile, PackPlan, FileBatch } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import { estimateTokens } from '../utils/tokens.js';
import { logger } from '../utils/logger.js';

/**
 * Fraction of the per-call budget that the diff + file contents may occupy.
 * The remainder is headroom for system prompt drift, message framing, and
 * tokenizer estimation error.
 */
const PACK_FILL_RATIO = 0.9;

/**
 * In mixed mode the diff must leave room for at least some file contents,
 * otherwise mixed mode degenerates into diff-only and chunking is better.
 */
const MIXED_DIFF_RATIO = 0.6;

/**
 * In chunked mode, cap how much of the per-call budget file contents may
 * occupy on top of the batch diff.
 */
const CHUNK_CONTENT_RATIO = 0.6;

/** Per-file framing overhead (markdown headers, fences) in tokens. */
const FILE_OVERHEAD_TOKENS = 24;

interface FileCost {
  file: ChangedFile;
  patchTokens: number;
  contentTokens: number;
}

function fileCosts(ctx: PullRequestContext): FileCost[] {
  return ctx.changedFiles.map((file) => {
    const content = ctx.fileContents.get(file.filename);
    return {
      file,
      patchTokens: file.patch ? estimateTokens(file.patch) + FILE_OVERHEAD_TOKENS : 0,
      contentTokens: content ? estimateTokens(content) + FILE_OVERHEAD_TOKENS : 0,
    };
  });
}

/**
 * Plan how the PR context will be sent to Kimi.
 *
 * - full: whole diff + all file contents fit in one call
 * - mixed: whole diff in one call, file contents included by priority until budget
 * - chunked: diff is too large for one call — split changed files into batches,
 *   one API call per batch (map), results merged afterwards (reduce)
 */
export function planContext(ctx: PullRequestContext, config: ReviewConfig): PackPlan {
  const contextTokens = config.review.contextTokens;
  const chunkTokens = Math.min(config.review.chunkTokens, contextTokens);
  const packBudget = Math.floor(contextTokens * PACK_FILL_RATIO);

  const diffTokens = estimateTokens(ctx.diff);
  const costs = fileCosts(ctx);
  const totalContentTokens = costs.reduce((sum, c) => sum + c.contentTokens, 0);

  logger.info(
    { diffTokens, totalContentTokens, filesCount: ctx.changedFiles.length, contextTokens, chunkTokens },
    'Planning context',
  );

  // Full mode: everything fits.
  if (diffTokens + totalContentTokens <= packBudget) {
    return {
      strategy: 'full',
      includedFiles: costs.filter((c) => c.contentTokens > 0).map((c) => c.file.filename),
      truncatedFiles: [],
      unreviewableFiles: [],
      batches: [],
      diffTokens,
      contextTokens,
    };
  }

  // Mixed mode: full diff still fits with room for prioritized contents.
  if (diffTokens <= Math.floor(contextTokens * MIXED_DIFF_RATIO)) {
    const includedFiles: string[] = [];
    const truncatedFiles: string[] = [];
    let used = diffTokens;

    // Prioritize files by change size (more changes = more important for context)
    const sorted = [...costs].sort(
      (a, b) =>
        (b.file.additions + b.file.deletions) - (a.file.additions + a.file.deletions),
    );

    for (const cost of sorted) {
      if (cost.contentTokens === 0) continue;
      if (used + cost.contentTokens <= packBudget) {
        includedFiles.push(cost.file.filename);
        used += cost.contentTokens;
      } else {
        truncatedFiles.push(cost.file.filename);
      }
    }

    return {
      strategy: 'mixed',
      includedFiles,
      truncatedFiles,
      unreviewableFiles: [],
      batches: [],
      diffTokens,
      contextTokens,
    };
  }

  // Chunked mode: split files into batches of per-file patches.
  const batches: FileBatch[] = [];
  const unreviewableFiles: string[] = [];
  let current: FileBatch | null = null;

  for (const cost of costs) {
    if (!cost.file.patch) {
      // Binary or too-large-for-API files have no patch; they cannot be
      // reviewed inline and are reported in the summary instead.
      unreviewableFiles.push(cost.file.filename);
      continue;
    }

    if (current && current.diffTokens + cost.patchTokens > chunkTokens) {
      batches.push(current);
      current = null;
    }
    if (!current) {
      current = { files: [], diffTokens: 0, contentFiles: [] };
    }
    current.files.push(cost.file);
    current.diffTokens += cost.patchTokens;
  }
  if (current && current.files.length > 0) {
    batches.push(current);
  }

  // Per batch, attach file contents while the call stays within budget.
  const contentBudget = Math.floor(contextTokens * CHUNK_CONTENT_RATIO);
  for (const batch of batches) {
    let used = batch.diffTokens;
    const sorted = [...batch.files].sort(
      (a, b) => (b.additions + b.deletions) - (a.additions + a.deletions),
    );
    for (const file of sorted) {
      const cost = costs.find((c) => c.file.filename === file.filename);
      if (!cost || cost.contentTokens === 0) continue;
      if (used + cost.contentTokens <= contentBudget) {
        batch.contentFiles.push(file.filename);
        used += cost.contentTokens;
      }
    }
  }

  const includedFiles = batches.flatMap((b) => b.contentFiles);
  const truncatedFiles = costs
    .filter((c) => c.contentTokens > 0 && !includedFiles.includes(c.file.filename))
    .map((c) => c.file.filename);

  return {
    strategy: 'chunked',
    includedFiles,
    truncatedFiles,
    unreviewableFiles,
    batches,
    diffTokens,
    contextTokens,
  };
}

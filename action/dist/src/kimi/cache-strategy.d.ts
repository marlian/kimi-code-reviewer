import type { ChatMessage, PullRequestContext, FileBatch } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
export declare function buildCacheOptimizedMessages(systemPrompt: string, ctx: PullRequestContext, config: ReviewConfig, fileContents: Map<string, string>): ChatMessage[];
/**
 * Build messages for one batch of a chunked review. Shares the stable prefix
 * with every other batch (prefix cache), then includes only this batch's
 * file contents and per-file patches.
 */
export declare function buildChunkedMessages(systemPrompt: string, ctx: PullRequestContext, config: ReviewConfig, batch: FileBatch, batchIndex: number, batchCount: number, fileContents: Map<string, string>): ChatMessage[];
//# sourceMappingURL=cache-strategy.d.ts.map
import type { ChatMessage, PullRequestContext } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
export declare function buildReviewSystemPrompt(config: ReviewConfig): string;
export declare function buildReviewMessages(ctx: PullRequestContext, config: ReviewConfig): ChatMessage[];
//# sourceMappingURL=prompt-builder.d.ts.map
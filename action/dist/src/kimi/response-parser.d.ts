import type { ReviewResult } from '../types/review.js';
export interface ParseOptions {
    /** `finish_reason` of the call, OpenAI vocabulary: `length` means the output cap cut it. */
    finishReason?: string;
    /** The `max_tokens` the call was made with, named in the detail when it was hit. */
    maxTokens?: number;
}
export declare function parseKimiResponse(raw: string, tokenUsage: {
    input: number;
    output: number;
    cached: number;
}, options?: ParseOptions): ReviewResult;
//# sourceMappingURL=response-parser.d.ts.map
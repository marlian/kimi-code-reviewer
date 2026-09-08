import type { ChatMessage } from '../types/review.js';
export interface KimiClientConfig {
    apiKey: string;
    model?: string;
    baseUrl?: string;
    maxTokens?: number;
    temperature?: number;
    /** Ceiling on one call, connection to last byte. */
    timeout?: number;
    /** Longest silence tolerated on a streaming call before it is abandoned. */
    idleTimeout?: number;
    /** Total attempts per call, retryable failures only. */
    retryAttempts?: number;
    /** Send `stream: true` and assemble the event stream; the default. */
    stream?: boolean;
    protocol?: 'openai' | 'anthropic';
    thinking?: KimiThinkingMode;
    reasoningEffort?: string;
}
export type KimiThinkingMode = 'default' | 'enabled' | 'disabled';
export interface ChatCompletionResponse {
    id: string;
    choices: Array<{
        index: number;
        message: {
            role: string;
            content: string;
        };
        /** OpenAI vocabulary on both protocols: `stop`, `length`, or the provider's own word. */
        finish_reason: string;
    }>;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        cached_tokens?: number;
    };
}
export declare const DEFAULT_MAX_TOKENS = 16384;
export declare const DEFAULT_TIMEOUT_MS = 300000;
export declare const DEFAULT_IDLE_TIMEOUT_MS = 120000;
export declare const DEFAULT_RETRY_ATTEMPTS = 3;
type CompletionParams = {
    messages: ChatMessage[];
    responseFormat?: {
        type: 'json_object' | 'text';
    };
};
export declare class KimiClient {
    private baseUrl;
    private apiKey;
    private model;
    private readonly maxTokensValue;
    private temperature;
    private timeout;
    private idleTimeout;
    private retryAttempts;
    private stream;
    private dispatcher;
    private protocol;
    private thinking;
    private reasoningEffort?;
    constructor(config: KimiClientConfig);
    /** The output cap sent with every call; the parser names it when the output is cut. */
    get maxTokens(): number;
    chatCompletion(params: CompletionParams): Promise<ChatCompletionResponse>;
    /** 2s, 6s, 18s... with up to 25% jitter, so parallel jobs do not retry in step. */
    protected retryDelayMs(attempt: number): number;
    private completeOnce;
    private openaiRequest;
    private anthropicRequest;
    private fromAnthropicMessage;
    private thinkingBody;
    private reasoningBody;
}
export {};
//# sourceMappingURL=client.d.ts.map
import type { ChatMessage } from '../types/review.js';
export interface KimiClientConfig {
    apiKey: string;
    model?: string;
    baseUrl?: string;
    maxTokens?: number;
    temperature?: number;
    timeout?: number;
    protocol?: 'openai' | 'anthropic';
    thinking?: KimiThinkingMode;
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
        finish_reason: string;
    }>;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        cached_tokens?: number;
    };
}
export declare class KimiClient {
    private baseUrl;
    private apiKey;
    private model;
    private maxTokens;
    private temperature;
    private timeout;
    private protocol;
    private thinking;
    constructor(config: KimiClientConfig);
    chatCompletion(params: {
        messages: ChatMessage[];
        responseFormat?: {
            type: 'json_object' | 'text';
        };
    }): Promise<ChatCompletionResponse>;
    private openaiCompletion;
    private anthropicCompletion;
    private thinkingBody;
}
//# sourceMappingURL=client.d.ts.map
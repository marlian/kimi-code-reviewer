export type KimiApiErrorKind = 'quota' | 'auth' | 'server' | 'other';
/** Longest provider message we carry into check summaries and job output. */
export declare const API_MESSAGE_MAX_CHARS = 600;
/**
 * Pull the provider's own message out of an error body. Both API shapes the
 * client speaks put it at `error.message` (Anthropic: `{error:{type,message}}`,
 * OpenAI: `{error:{message,type,code}}`). A body that is not JSON, or JSON
 * without that field, is returned as-is, trimmed. Bounded either way.
 */
export declare function extractApiMessage(body: unknown): string | undefined;
/**
 * Classify a failed call by what the operator can do about it. `quota` and
 * `server` are transient and outside the repository's control; `auth` and
 * `other` are configuration or contract problems that must stay loud.
 */
export declare function classifyApiError(status: number, apiMessage?: string): KimiApiErrorKind;
export declare class KimiApiError extends Error {
    statusCode: number;
    responseBody?: unknown | undefined;
    readonly kind: KimiApiErrorKind;
    readonly apiMessage?: string;
    constructor(message: string, statusCode: number, responseBody?: unknown | undefined);
    /** Transient on the provider's side: the review is skipped, not failed. */
    get isTransient(): boolean;
}
export declare class ConfigError extends Error {
    constructor(message: string);
}
export declare class ReviewError extends Error {
    phase: string;
    constructor(message: string, phase: string);
}
//# sourceMappingURL=errors.d.ts.map
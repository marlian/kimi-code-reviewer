export type KimiApiErrorKind = 'quota' | 'auth' | 'server' | 'other';

/** Longest provider message we carry into check summaries and job output. */
export const API_MESSAGE_MAX_CHARS = 600;

/**
 * Pull the provider's own message out of an error body. Both API shapes the
 * client speaks put it at `error.message` (Anthropic: `{error:{type,message}}`,
 * OpenAI: `{error:{message,type,code}}`). A body that is not JSON, or JSON
 * without that field, is returned as-is, trimmed. Bounded either way.
 */
export function extractApiMessage(body: unknown): string | undefined {
  let text: string | undefined;
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (!trimmed) return undefined;
    try {
      const parsed = JSON.parse(trimmed) as { error?: { message?: unknown } };
      text = typeof parsed?.error?.message === 'string' ? parsed.error.message : trimmed;
    } catch {
      text = trimmed;
    }
  } else if (body && typeof body === 'object') {
    const message = (body as { error?: { message?: unknown } }).error?.message;
    text = typeof message === 'string' ? message : JSON.stringify(body);
  }
  if (!text) return undefined;
  return text.length > API_MESSAGE_MAX_CHARS ? `${text.slice(0, API_MESSAGE_MAX_CHARS)}...` : text;
}

const QUOTA_MESSAGE = /usage limit|quota|rate limit|too many requests|insufficient_quota|exceeded/i;

/**
 * Classify a failed call by what the operator can do about it. `quota` and
 * `server` are transient and outside the repository's control; `auth` and
 * `other` are configuration or contract problems that must stay loud.
 */
export function classifyApiError(status: number, apiMessage?: string): KimiApiErrorKind {
  if (status === 429) return 'quota';
  if (status === 403 && apiMessage && QUOTA_MESSAGE.test(apiMessage)) return 'quota';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'server';
  return 'other';
}

export class KimiApiError extends Error {
  public readonly kind: KimiApiErrorKind;
  public readonly apiMessage?: string;

  constructor(
    message: string,
    public statusCode: number,
    public responseBody?: unknown,
  ) {
    const apiMessage = extractApiMessage(responseBody);
    super(apiMessage ? `${message}: ${apiMessage}` : message);
    this.name = 'KimiApiError';
    this.apiMessage = apiMessage;
    this.kind = classifyApiError(statusCode, apiMessage);
  }

  /** Transient on the provider's side: the review is skipped, not failed. */
  get isTransient(): boolean {
    return this.kind === 'quota' || this.kind === 'server';
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class ReviewError extends Error {
  constructor(
    message: string,
    public phase: string,
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}

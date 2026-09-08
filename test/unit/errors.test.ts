import { describe, it, expect } from 'vitest';
import {
  API_MESSAGE_MAX_CHARS,
  KimiApiError,
  classifyApiError,
  extractApiMessage,
  KimiTransportError,
  isRetryableError,
} from '../../src/utils/errors.js';

// The body Kimi returned on 2026-09-08 (legate-dev/legate #281): a 403 whose
// statusText alone said nothing, while the body named a weekly cap.
const WEEKLY_LIMIT_BODY =
  '{"error":{"type":"permission_error","message":"You\'ve reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota"},"type":"error"}';

describe('extractApiMessage', () => {
  it('reads error.message from an Anthropic-shaped body', () => {
    expect(extractApiMessage(WEEKLY_LIMIT_BODY)).toMatch(/^You've reached your weekly \(7-day\) usage limit/);
  });

  it('reads error.message from an OpenAI-shaped body', () => {
    const body = '{"error":{"message":"Rate limit reached for model","type":"requests","code":"rate_limit_exceeded"}}';
    expect(extractApiMessage(body)).toBe('Rate limit reached for model');
  });

  it('falls back to the trimmed raw body when it is not JSON or lacks the field', () => {
    expect(extractApiMessage('  <html>502 Bad Gateway</html>\n')).toBe('<html>502 Bad Gateway</html>');
    expect(extractApiMessage('{"detail":"nope"}')).toBe('{"detail":"nope"}');
    expect(extractApiMessage({ error: { message: 'from object' } })).toBe('from object');
  });

  it('returns undefined for an empty body', () => {
    expect(extractApiMessage('')).toBeUndefined();
    expect(extractApiMessage('   ')).toBeUndefined();
    expect(extractApiMessage(undefined)).toBeUndefined();
  });

  it('bounds the message', () => {
    const long = 'x'.repeat(API_MESSAGE_MAX_CHARS + 100);
    const got = extractApiMessage(long)!;
    expect(got.length).toBe(API_MESSAGE_MAX_CHARS + 3);
    expect(got.endsWith('...')).toBe(true);
  });
});

describe('classifyApiError', () => {
  it('treats 429 and a 403 that names a usage limit as quota', () => {
    expect(classifyApiError(429)).toBe('quota');
    expect(classifyApiError(403, extractApiMessage(WEEKLY_LIMIT_BODY))).toBe('quota');
  });

  it('treats a bare 401/403 as auth, so a bad key stays loud', () => {
    expect(classifyApiError(401, 'invalid api key')).toBe('auth');
    expect(classifyApiError(403)).toBe('auth');
    expect(classifyApiError(403, 'Forbidden')).toBe('auth');
  });

  it('treats 5xx as server and the rest as other', () => {
    expect(classifyApiError(500)).toBe('server');
    expect(classifyApiError(503, 'overloaded')).toBe('server');
    expect(classifyApiError(400, 'bad request')).toBe('other');
    expect(classifyApiError(404)).toBe('other');
  });
});

describe('KimiApiError', () => {
  it('carries the provider message in .message, .apiMessage and .kind', () => {
    const err = new KimiApiError('Kimi API error: 403 Forbidden', 403, WEEKLY_LIMIT_BODY);
    expect(err.name).toBe('KimiApiError');
    expect(err.statusCode).toBe(403);
    expect(err.kind).toBe('quota');
    expect(err.isTransient).toBe(true);
    expect(err.apiMessage).toMatch(/weekly \(7-day\) usage limit/);
    expect(err.message).toMatch(/^Kimi API error: 403 Forbidden: You've reached/);
  });

  it('keeps the plain message when the body is empty', () => {
    const err = new KimiApiError('Kimi API error: 502 Bad Gateway', 502, '');
    expect(err.message).toBe('Kimi API error: 502 Bad Gateway');
    expect(err.apiMessage).toBeUndefined();
    expect(err.kind).toBe('server');
    expect(err.isTransient).toBe(true);
  });

  it('is not transient for auth and other', () => {
    expect(new KimiApiError('Kimi API error: 401 Unauthorized', 401, '{"error":{"message":"invalid key"}}').isTransient).toBe(false);
    expect(new KimiApiError('Kimi API error: 400 Bad Request', 400, '').isTransient).toBe(false);
  });
});

describe('retry policy', () => {
  it('retries only what another attempt could fix', () => {
    expect(isRetryableError(new KimiApiError('Kimi API error: 503 Service Unavailable', 503, ''))).toBe(true);
    expect(isRetryableError(new KimiApiError('Kimi API error: 429 Too Many Requests', 429, ''))).toBe(false);
    expect(isRetryableError(new KimiApiError('Kimi API error: 401 Unauthorized', 401, ''))).toBe(false);
    expect(isRetryableError(new KimiApiError('Kimi API error: 400 Bad Request', 400, ''))).toBe(false);
    expect(isRetryableError(new Error('something else'))).toBe(false);
  });

  it('retries every transport failure except the overall timeout', () => {
    for (const kind of ['network', 'idle-timeout', 'stream'] as const) {
      const err = new KimiTransportError(kind, kind);
      expect(err.isRetryable).toBe(true);
      expect(err.isTransient).toBe(true);
    }
    const timeout = new KimiTransportError('timeout', 'timeout');
    expect(timeout.isRetryable).toBe(false);
    expect(timeout.isTransient).toBe(true);
  });
});

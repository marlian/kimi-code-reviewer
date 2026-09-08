import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { KimiClient } from '../../src/kimi/client.js';
import { KimiApiError, KimiTransportError } from '../../src/utils/errors.js';

/**
 * The client is exercised through a real HTTP server on localhost: real
 * fetch, real undici dispatcher, real event-stream framing. Each test queues
 * one handler per expected request; the queue running dry is itself a
 * failure (an unexpected retry).
 */
type Handler = (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void;

let server: Server | undefined;
let handlers: Handler[] = [];
const requests: Array<{ path: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }> = [];

async function startServer(...queue: Handler[]): Promise<string> {
  handlers = queue;
  requests.length = 0;
  server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push({ path: req.url ?? '', headers: req.headers, body });
      const handler = handlers.shift();
      if (!handler) {
        res.writeHead(500).end('unexpected request');
        return;
      }
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return `http://127.0.0.1:${address.port}/v1`;
}

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

function sseHead(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
}

function sseWrite(res: ServerResponse, event: string | null, data: unknown): void {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  res.write(`${event ? `event: ${event}\n` : ''}data: ${payload}\n\n`);
}

/** A complete Anthropic-protocol stream: thinking, then text, then the stop. */
function anthropicStream(res: ServerResponse, textParts: string[], stopReason = 'end_turn'): void {
  sseHead(res);
  sseWrite(res, 'message_start', {
    type: 'message_start',
    message: { id: 'msg_1', usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 20 } },
  });
  sseWrite(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
  sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me think ' } });
  sseWrite(res, 'ping', { type: 'ping' });
  sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } });
  sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sseWrite(res, 'content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  for (const part of textParts) {
    sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: part } });
  }
  sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: 1 });
  sseWrite(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 42 } });
  sseWrite(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function openaiStream(res: ServerResponse, textParts: string[], finishReason = 'stop'): void {
  sseHead(res);
  sseWrite(res, null, { id: 'chatcmpl-1', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  sseWrite(res, null, { id: 'chatcmpl-1', choices: [{ index: 0, delta: { reasoning_content: 'thinking...' }, finish_reason: null }] });
  for (const part of textParts) {
    sseWrite(res, null, { id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: part }, finish_reason: null }] });
  }
  sseWrite(res, null, { id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
  sseWrite(res, null, {
    id: 'chatcmpl-1',
    choices: [],
    usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230, prompt_tokens_details: { cached_tokens: 50 } },
  });
  sseWrite(res, null, '[DONE]');
  res.end();
}

/** No backoff between attempts: the retry logic is under test, not the clock. */
class FastClient extends KimiClient {
  protected override retryDelayMs(): number {
    return 1;
  }
}

const messages = [
  { role: 'system' as const, content: 'You review code.' },
  { role: 'user' as const, content: 'Review this.' },
];

describe('KimiClient streaming (Anthropic protocol)', () => {
  it('assembles text deltas, drops thinking, reads stop_reason and usage', async () => {
    const baseUrl = await startServer((_req, res) => anthropicStream(res, ['{"summary":', '"ok",', '"score":90}']));
    const client = new FastClient({ apiKey: 'k', baseUrl, protocol: 'anthropic', model: 'k3-256k', maxTokens: 777, thinking: 'enabled', reasoningEffort: 'max' });

    const response = await client.chatCompletion({ messages, responseFormat: { type: 'json_object' } });

    expect(response.choices[0].message.content).toBe('{"summary":"ok","score":90}');
    expect(response.choices[0].finish_reason).toBe('stop');
    expect(response.usage).toEqual({ prompt_tokens: 100, completion_tokens: 42, total_tokens: 142, cached_tokens: 20 });

    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe('/v1/messages');
    expect(requests[0].headers['x-api-key']).toBe('k');
    expect(requests[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(requests[0].body).toMatchObject({
      model: 'k3-256k',
      max_tokens: 777,
      stream: true,
      system: 'You review code.',
      messages: [{ role: 'user', content: 'Review this.' }],
      thinking: { type: 'enabled' },
      output_config: { effort: 'max' },
    });
  });

  it('reports max_tokens as finish_reason length', async () => {
    const baseUrl = await startServer((_req, res) => anthropicStream(res, ['{"summary":"cut'], 'max_tokens'));
    const client = new FastClient({ apiKey: 'k', baseUrl, protocol: 'anthropic' });

    const response = await client.chatCompletion({ messages });

    expect(response.choices[0].finish_reason).toBe('length');
    expect(response.choices[0].message.content).toBe('{"summary":"cut');
  });

  it('retries a stream that carries an error event, then succeeds', async () => {
    const baseUrl = await startServer(
      (_req, res) => {
        sseHead(res);
        sseWrite(res, 'message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } });
        sseWrite(res, 'error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
        res.end();
      },
      (_req, res) => anthropicStream(res, ['{"score":1}']),
    );
    const client = new FastClient({ apiKey: 'k', baseUrl, protocol: 'anthropic', retryAttempts: 3 });

    const response = await client.chatCompletion({ messages });

    expect(response.choices[0].message.content).toBe('{"score":1}');
    expect(requests).toHaveLength(2);
  });

  it('treats a stream that ends before message_stop as broken', async () => {
    const baseUrl = await startServer((_req, res) => {
      sseHead(res);
      sseWrite(res, 'message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } });
      sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"sum' } });
      res.end();
    });
    const client = new FastClient({ apiKey: 'k', baseUrl, protocol: 'anthropic', retryAttempts: 1 });

    await expect(client.chatCompletion({ messages })).rejects.toMatchObject({
      name: 'KimiTransportError',
      kind: 'stream',
      message: 'Kimi API stream ended before the message did',
    });
  });

  it('sends stream: false and reads the whole message when streaming is off', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: '{"score":5}' }],
          stop_reason: 'max_tokens',
          usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 3 },
        }),
      );
    });
    const client = new FastClient({ apiKey: 'k', baseUrl, protocol: 'anthropic', stream: false });

    const response = await client.chatCompletion({ messages });

    expect(requests[0].body.stream).toBe(false);
    expect(response.choices[0].message.content).toBe('{"score":5}');
    expect(response.choices[0].finish_reason).toBe('length');
    expect(response.usage).toEqual({ prompt_tokens: 10, completion_tokens: 7, total_tokens: 17, cached_tokens: 3 });
  });
});

describe('KimiClient streaming (OpenAI protocol)', () => {
  it('assembles content deltas, drops reasoning_content, reads finish_reason and usage', async () => {
    const baseUrl = await startServer((_req, res) => openaiStream(res, ['{"summary":"ok"', ',"score":80}'], 'length'));
    const client = new FastClient({ apiKey: 'k', baseUrl, protocol: 'openai', model: 'deepseek-reasoner', reasoningEffort: 'high' });

    const response = await client.chatCompletion({ messages, responseFormat: { type: 'json_object' } });

    expect(response.id).toBe('chatcmpl-1');
    expect(response.choices[0].message.content).toBe('{"summary":"ok","score":80}');
    expect(response.choices[0].finish_reason).toBe('length');
    expect(response.usage).toEqual({ prompt_tokens: 200, completion_tokens: 30, total_tokens: 230, cached_tokens: 50 });

    expect(requests[0].path).toBe('/v1/chat/completions');
    expect(requests[0].headers.authorization).toBe('Bearer k');
    expect(requests[0].body).toMatchObject({
      model: 'deepseek-reasoner',
      stream: true,
      stream_options: { include_usage: true },
      response_format: { type: 'json_object' },
      reasoning_effort: 'high',
      messages,
    });
  });
});

describe('KimiClient retry policy', () => {
  it('retries a 5xx with backoff and succeeds on the next attempt', async () => {
    const baseUrl = await startServer(
      (_req, res) => res.writeHead(503, { 'Content-Type': 'text/plain' }).end('upstream'),
      (_req, res) => anthropicStream(res, ['{"score":1}']),
    );
    const client = new FastClient({ apiKey: 'k', baseUrl, protocol: 'anthropic', retryAttempts: 3 });

    const response = await client.chatCompletion({ messages });

    expect(response.choices[0].message.content).toBe('{"score":1}');
    expect(requests).toHaveLength(2);
  });

  it('gives up after retry_attempts and reports how many were made', async () => {
    const fail: Handler = (_req, res) => res.writeHead(504).end('gateway timeout');
    const baseUrl = await startServer(fail, fail, fail);
    const client = new FastClient({ apiKey: 'k', baseUrl, protocol: 'anthropic', retryAttempts: 3 });

    const err = await client.chatCompletion({ messages }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(KimiApiError);
    expect((err as KimiApiError).kind).toBe('server');
    expect((err as KimiApiError).attempts).toBe(3);
    expect(requests).toHaveLength(3);
  });

  it('never retries a quota refusal', async () => {
    const baseUrl = await startServer((_req, res) =>
      res
        .writeHead(403, { 'Content-Type': 'application/json' })
        .end('{"error":{"type":"permission_error","message":"You\'ve reached your weekly (7-day) usage limit."},"type":"error"}'),
    );
    const client = new FastClient({ apiKey: 'k', baseUrl, protocol: 'anthropic', retryAttempts: 3 });

    const err = await client.chatCompletion({ messages }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(KimiApiError);
    expect((err as KimiApiError).kind).toBe('quota');
    expect((err as KimiApiError).attempts).toBe(1);
    expect(requests).toHaveLength(1);
  });

  it('never retries an auth refusal', async () => {
    const baseUrl = await startServer((_req, res) => res.writeHead(401).end('{"error":{"message":"bad key"}}'));
    const client = new FastClient({ apiKey: 'k', baseUrl, protocol: 'openai', retryAttempts: 3 });

    await expect(client.chatCompletion({ messages })).rejects.toMatchObject({ name: 'KimiApiError', kind: 'auth' });
    expect(requests).toHaveLength(1);
  });
});

describe('KimiClient timeouts', () => {
  it('abandons a stream that goes silent and retries it', async () => {
    const baseUrl = await startServer(
      (_req, res) => {
        // Headers and one event, then silence with the socket held open.
        sseHead(res);
        sseWrite(res, 'message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } });
      },
      (_req, res) => anthropicStream(res, ['{"score":2}']),
    );
    const client = new FastClient({ apiKey: 'k', baseUrl, protocol: 'anthropic', idleTimeout: 150, timeout: 10_000, retryAttempts: 2 });

    const response = await client.chatCompletion({ messages });

    expect(response.choices[0].message.content).toBe('{"score":2}');
    expect(requests).toHaveLength(2);
  });

  it('names the silence when it gives up', async () => {
    const baseUrl = await startServer((_req, res) => {
      sseHead(res);
    });
    const client = new FastClient({ apiKey: 'k', baseUrl, protocol: 'anthropic', idleTimeout: 150, timeout: 10_000, retryAttempts: 1 });

    await expect(client.chatCompletion({ messages })).rejects.toMatchObject({
      name: 'KimiTransportError',
      kind: 'idle-timeout',
      message: 'Kimi API call abandoned: no bytes for 150 ms',
    });
  });

  it('counts a server that never answers as idle too', async () => {
    const baseUrl = await startServer(() => {
      // Never write anything.
    });
    const client = new FastClient({ apiKey: 'k', baseUrl, protocol: 'openai', idleTimeout: 150, timeout: 10_000, retryAttempts: 1 });

    await expect(client.chatCompletion({ messages })).rejects.toMatchObject({ kind: 'idle-timeout' });
  });

  it('does not retry a call that outran the overall timeout while still live', async () => {
    const baseUrl = await startServer((req, res) => {
      sseHead(res);
      const ping = setInterval(() => sseWrite(res, 'ping', { type: 'ping' }), 20);
      req.on('close', () => clearInterval(ping));
    });
    const client = new FastClient({ apiKey: 'k', baseUrl, protocol: 'anthropic', idleTimeout: 1_000, timeout: 200, retryAttempts: 3 });

    const err = await client.chatCompletion({ messages }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(KimiTransportError);
    expect((err as KimiTransportError).kind).toBe('timeout');
    expect((err as KimiTransportError).message).toBe('Kimi API call abandoned: exceeded 200 ms');
    expect(requests).toHaveLength(1);
  });

  it('reports a refused connection as a network failure', async () => {
    const baseUrl = await startServer();
    const port = Number(new URL(baseUrl).port);
    server!.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const client = new FastClient({ apiKey: 'k', baseUrl: `http://127.0.0.1:${port}/v1`, protocol: 'openai', retryAttempts: 2 });

    await expect(client.chatCompletion({ messages })).rejects.toMatchObject({ name: 'KimiTransportError', kind: 'network' });
  });
});

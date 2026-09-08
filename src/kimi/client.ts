import { Agent } from 'undici';
import type { ChatMessage } from '../types/review.js';
import { KimiApiError, KimiTransportError, isRetryableError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { SseParser, type SseEvent } from './sse.js';

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
    message: { role: string; content: string };
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

export const DEFAULT_MAX_TOKENS = 16384;
export const DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
export const DEFAULT_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 2_000;

type CompletionParams = {
  messages: ChatMessage[];
  responseFormat?: { type: 'json_object' | 'text' };
};

/** Anthropic's stop reasons in OpenAI's words, so one parser reads both. */
function normalizeStopReason(reason: string | null | undefined): string {
  if (!reason) return 'stop';
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop';
  if (reason === 'max_tokens') return 'length';
  return reason;
}

function parseJson(data: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(data) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turns one protocol's event stream into a ChatCompletionResponse. Text is
 * kept; thinking is counted and dropped (it never reaches the parser, and
 * its deltas are what keep the connection alive during a long reasoning
 * phase); unknown events are ignored so a provider extension cannot break
 * the review.
 */
interface StreamAssembler {
  push(event: SseEvent): void;
  finish(): ChatCompletionResponse;
  readonly thinkingChars: number;
}

class AnthropicStreamAssembler implements StreamAssembler {
  private text = '';
  thinkingChars = 0;
  private inputTokens = 0;
  private cachedTokens = 0;
  private outputTokens = 0;
  private stopReason: string | undefined;
  private stopped = false;

  push(event: SseEvent): void {
    const data = parseJson(event.data);
    if (!data) return;
    const type = typeof data.type === 'string' ? data.type : event.event;
    switch (type) {
      case 'message_start': {
        const usage = (data.message as { usage?: Record<string, number> } | undefined)?.usage;
        this.inputTokens = usage?.input_tokens ?? 0;
        this.cachedTokens = usage?.cache_read_input_tokens ?? 0;
        break;
      }
      case 'content_block_delta': {
        const delta = data.delta as { type?: string; text?: string; thinking?: string } | undefined;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') this.text += delta.text;
        else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') this.thinkingChars += delta.thinking.length;
        break;
      }
      case 'message_delta': {
        const delta = data.delta as { stop_reason?: string | null } | undefined;
        if (delta?.stop_reason) this.stopReason = delta.stop_reason;
        const usage = data.usage as { output_tokens?: number } | undefined;
        if (typeof usage?.output_tokens === 'number') this.outputTokens = usage.output_tokens;
        break;
      }
      case 'message_stop':
        this.stopped = true;
        break;
      case 'error': {
        const error = data.error as { type?: string; message?: string } | undefined;
        throw new KimiTransportError(
          'stream',
          `Kimi API stream error: ${error?.type ?? 'error'}${error?.message ? `: ${error.message}` : ''}`,
        );
      }
      default:
        break;
    }
  }

  finish(): ChatCompletionResponse {
    if (!this.stopped && !this.stopReason) {
      throw new KimiTransportError('stream', 'Kimi API stream ended before the message did');
    }
    return {
      id: 'anthropic',
      choices: [{ index: 0, message: { role: 'assistant', content: this.text }, finish_reason: normalizeStopReason(this.stopReason) }],
      usage: {
        prompt_tokens: this.inputTokens,
        completion_tokens: this.outputTokens,
        total_tokens: this.inputTokens + this.outputTokens,
        cached_tokens: this.cachedTokens,
      },
    };
  }
}

class OpenAIStreamAssembler implements StreamAssembler {
  private id = 'openai';
  private text = '';
  thinkingChars = 0;
  private usage: ChatCompletionResponse['usage'] | undefined;
  private finishReason: string | undefined;
  private done = false;

  push(event: SseEvent): void {
    if (event.data.trim() === '[DONE]') {
      this.done = true;
      return;
    }
    const data = parseJson(event.data);
    if (!data) return;
    if (data.error && typeof data.error === 'object') {
      const error = data.error as { type?: string; message?: string };
      throw new KimiTransportError(
        'stream',
        `Kimi API stream error: ${error.type ?? 'error'}${error.message ? `: ${error.message}` : ''}`,
      );
    }
    if (typeof data.id === 'string') this.id = data.id;
    const choice = (data.choices as Array<Record<string, unknown>> | undefined)?.[0];
    const delta = choice?.delta as { content?: string; reasoning_content?: string } | undefined;
    if (typeof delta?.content === 'string') this.text += delta.content;
    if (typeof delta?.reasoning_content === 'string') this.thinkingChars += delta.reasoning_content.length;
    if (typeof choice?.finish_reason === 'string') this.finishReason = choice.finish_reason;
    const usage = data.usage as
      | { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
      | undefined;
    if (usage && typeof usage.prompt_tokens === 'number') {
      this.usage = {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.prompt_tokens + (usage.completion_tokens ?? 0),
        cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0,
      };
    }
  }

  finish(): ChatCompletionResponse {
    if (!this.done && !this.finishReason) {
      throw new KimiTransportError('stream', 'Kimi API stream ended before the message did');
    }
    if (!this.usage) {
      logger.warn('Kimi API stream carried no usage; token counts are zero for this call');
    }
    return {
      id: this.id,
      choices: [{ index: 0, message: { role: 'assistant', content: this.text }, finish_reason: this.finishReason ?? 'stop' }],
      usage: this.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 },
    };
  }
}

export class KimiClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private readonly maxTokensValue: number;
  private temperature: number;
  private timeout: number;
  private idleTimeout: number;
  private retryAttempts: number;
  private stream: boolean;
  private dispatcher: Agent;
  private protocol: 'openai' | 'anthropic';
  private thinking: KimiThinkingMode;
  private reasoningEffort?: string;

  constructor(config: KimiClientConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'kimi-k2.5';
    this.baseUrl = config.baseUrl ?? 'https://api.moonshot.cn/v1';
    this.maxTokensValue = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.temperature = config.temperature ?? 1;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
    this.idleTimeout = config.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.retryAttempts = Math.max(1, config.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS);
    this.stream = config.stream ?? true;
    // The socket-level timeouts back the overall ceiling; silence on a
    // streaming call is caught earlier by the idle timer below.
    this.dispatcher = new Agent({
      headersTimeout: this.timeout,
      bodyTimeout: this.timeout,
    });
    this.protocol = config.protocol ?? 'openai';
    this.thinking = config.thinking ?? 'default';
    this.reasoningEffort = config.reasoningEffort;
  }

  /** The output cap sent with every call; the parser names it when the output is cut. */
  get maxTokens(): number {
    return this.maxTokensValue;
  }

  async chatCompletion(params: CompletionParams): Promise<ChatCompletionResponse> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.completeOnce(params, attempt);
      } catch (err) {
        if (!isRetryableError(err) || attempt >= this.retryAttempts) {
          if (err instanceof KimiApiError || err instanceof KimiTransportError) err.attempts = attempt;
          throw err;
        }
        const delayMs = this.retryDelayMs(attempt);
        logger.warn(
          { attempt, of: this.retryAttempts, delayMs, err: err instanceof Error ? err.message : String(err) },
          'Kimi API call failed; retrying',
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  /** 2s, 6s, 18s... with up to 25% jitter, so parallel jobs do not retry in step. */
  protected retryDelayMs(attempt: number): number {
    const base = RETRY_BASE_DELAY_MS * 3 ** (attempt - 1);
    return Math.round(base * (1 + Math.random() * 0.25));
  }

  private async completeOnce(params: CompletionParams, attempt: number): Promise<ChatCompletionResponse> {
    const { url, headers, body } = this.protocol === 'anthropic' ? this.anthropicRequest(params) : this.openaiRequest(params);

    const controller = new AbortController();
    let abortReason: 'timeout' | 'idle-timeout' | undefined;
    const overall = setTimeout(() => {
      abortReason = 'timeout';
      controller.abort();
    }, this.timeout);
    let idle: NodeJS.Timeout | undefined;
    // Armed before the request goes out, so a server that never answers is
    // idle too; re-armed on every chunk, so a slow but live stream is not.
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        abortReason = 'idle-timeout';
        controller.abort();
      }, this.idleTimeout);
    };
    armIdle();

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
        dispatcher: this.dispatcher,
      } as RequestInit & { dispatcher: Agent });
      armIdle();

      if (!res.ok) {
        const errorBody = await res.text().catch(() => '');
        throw new KimiApiError(`Kimi API error: ${res.status} ${res.statusText}`, res.status, errorBody);
      }

      let response: ChatCompletionResponse;
      let thinkingChars = 0;
      if (this.stream && res.body) {
        const assembler: StreamAssembler =
          this.protocol === 'anthropic' ? new AnthropicStreamAssembler() : new OpenAIStreamAssembler();
        const parser = new SseParser();
        const decoder = new TextDecoder();
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          armIdle();
          for (const event of parser.feed(decoder.decode(value, { stream: true }))) assembler.push(event);
        }
        for (const event of parser.flush()) assembler.push(event);
        response = assembler.finish();
        thinkingChars = assembler.thinkingChars;
      } else {
        const data = (await res.json()) as Record<string, unknown>;
        response = this.protocol === 'anthropic' ? this.fromAnthropicMessage(data) : (data as unknown as ChatCompletionResponse);
      }

      logger.info(
        {
          model: this.model,
          protocol: this.protocol,
          attempt,
          streamed: this.stream,
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          cachedTokens: response.usage.cached_tokens ?? 0,
          thinkingChars,
          finishReason: response.choices[0]?.finish_reason,
        },
        'Kimi API call completed',
      );
      return response;
    } catch (err) {
      if (err instanceof KimiApiError || err instanceof KimiTransportError) throw err;
      if (abortReason === 'idle-timeout') {
        throw new KimiTransportError('idle-timeout', `Kimi API call abandoned: no bytes for ${this.idleTimeout} ms`, { cause: err });
      }
      if (abortReason === 'timeout') {
        throw new KimiTransportError('timeout', `Kimi API call abandoned: exceeded ${this.timeout} ms`, { cause: err });
      }
      const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
      throw new KimiTransportError('network', `Kimi API call failed: ${cause}`, { cause: err });
    } finally {
      clearTimeout(overall);
      clearTimeout(idle);
    }
  }

  private openaiRequest(params: CompletionParams) {
    return {
      url: `${this.baseUrl}/chat/completions`,
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: {
        model: this.model,
        messages: params.messages,
        max_tokens: this.maxTokensValue,
        temperature: this.temperature,
        ...(params.responseFormat && { response_format: params.responseFormat }),
        ...(this.stream && { stream: true, stream_options: { include_usage: true } }),
        ...this.thinkingBody(),
        ...this.reasoningBody(),
      },
    };
  }

  private anthropicRequest(params: CompletionParams) {
    const systemMessage = params.messages.find((m) => m.role === 'system');
    const otherMessages = params.messages.filter((m) => m.role !== 'system');
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokensValue,
      messages: otherMessages,
      stream: this.stream,
      ...this.thinkingBody(),
      ...this.reasoningBody(),
    };
    if (systemMessage) body.system = systemMessage.content;
    return {
      url: `${this.baseUrl}/messages`,
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body,
    };
  }

  private fromAnthropicMessage(data: Record<string, unknown>): ChatCompletionResponse {
    const content = (data.content as Array<{ type: string; text?: string }> | undefined) ?? [];
    const usage = (data.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } | undefined) ?? {};
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    return {
      id: 'anthropic',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('') },
          finish_reason: normalizeStopReason(data.stop_reason as string | null | undefined),
        },
      ],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        cached_tokens: usage.cache_read_input_tokens ?? 0,
      },
    };
  }

  private thinkingBody(): Record<string, unknown> {
    if (this.thinking === 'default') {
      return {};
    }
    return { thinking: { type: this.thinking } };
  }

  private reasoningBody(): Record<string, unknown> {
    if (!this.reasoningEffort) {
      return {};
    }
    if (this.protocol === 'anthropic') {
      return { output_config: { effort: this.reasoningEffort } };
    }
    return { reasoning_effort: this.reasoningEffort };
  }
}

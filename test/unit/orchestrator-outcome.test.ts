import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PullRequestContext } from '../../src/types/review.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { KimiApiError, KimiTransportError, ReviewError } from '../../src/utils/errors.js';

// The two external boundaries are faked -- GitHub (octokit) and the model
// (KimiClient) -- and everything between them runs for real: file filter,
// context planning, prompt building, parsing, merge, summary.
const state = vi.hoisted(() => ({ ctx: null as PullRequestContext | null }));

function smallContext(): PullRequestContext {
  return {
    owner: 'o',
    repo: 'r',
    pullNumber: 7,
    baseSha: 'base',
    headSha: 'head',
    title: 'feat: thing',
    body: '',
    diff: '',
    changedFiles: [
      {
        filename: 'src/a.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1,2 +1,3 @@\n line1\n+const x = 1;\n line2\n',
      },
    ],
    fileContents: new Map([['src/a.ts', 'line1\nconst x = 1;\nline2\n']]),
  };
}

// Two files whose patches do not fit one chunk at the budget the chunked
// test sets, so the planner takes the chunked path with one batch per file.
function twoFileContext(): PullRequestContext {
  const patch = (n: number) =>
    '@@ -1,40 +1,80 @@\n' + Array.from({ length: 40 }, (_, i) => `+const v${n}_${i} = ${i};`).join('\n') + '\n';
  const changedFiles = [1, 2].map((n) => ({
    filename: `src/f${n}.ts`,
    status: 'modified' as const,
    additions: 40,
    deletions: 0,
    patch: patch(n),
  }));
  return {
    ...smallContext(),
    diff: changedFiles.map((f) => `diff --git a/${f.filename} b/${f.filename}\n${f.patch}`).join(''),
    changedFiles,
    fileContents: new Map(),
  };
}

vi.mock('../../src/github/pulls.js', () => ({
  extractPullRequestContext: async (): Promise<PullRequestContext> => state.ctx ?? smallContext(),
}));

const { ReviewOrchestrator } = await import('../../src/review/orchestrator.js');

const WEEKLY_LIMIT_BODY =
  '{"error":{"type":"permission_error","message":"You\'ve reached your weekly (7-day) usage limit."},"type":"error"}';

function fakeOctokit() {
  const calls = { update: [] as any[], createReview: [] as any[] };
  const octokit = {
    checks: {
      create: vi.fn(async () => ({ data: { id: 42 } })),
      update: vi.fn(async (args: any) => {
        calls.update.push(args);
        return { data: {} };
      }),
    },
    pulls: {
      createReview: vi.fn(async (args: any) => {
        calls.createReview.push(args);
        return { data: {} };
      }),
    },
  };
  return { octokit, calls };
}

function fakeKimi(content: string | Error) {
  return {
    chatCompletion: vi.fn(async () => {
      if (content instanceof Error) throw content;
      return {
        id: 'x',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cached_tokens: 0 },
      };
    }),
  };
}

const params = { owner: 'o', repo: 'r', pullNumber: 7, headSha: 'head' };

describe('ReviewOrchestrator outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.ctx = null;
  });

  it('ends the check neutral with the provider message and posts no review on a quota 403', async () => {
    const { octokit, calls } = fakeOctokit();
    const kimi = fakeKimi(new KimiApiError('Kimi API error: 403 Forbidden', 403, WEEKLY_LIMIT_BODY));
    const orchestrator = new ReviewOrchestrator(octokit as any, kimi as any, DEFAULT_CONFIG);

    const result = await orchestrator.reviewPullRequest(params);

    expect(result.incomplete).toEqual({
      kind: 'api',
      reason: 'quota',
      detail: "Kimi API 403: You've reached your weekly (7-day) usage limit.",
    });
    expect(result.annotations).toEqual([]);
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0].conclusion).toBe('neutral');
    expect(calls.update[0].output.title).toMatch(/No verdict/);
    expect(calls.update[0].output.summary).toBe(
      "**Review skipped (quota):** Kimi API 403: You've reached your weekly (7-day) usage limit.",
    );
    expect(calls.createReview).toHaveLength(0);
  });

  it('ends the check neutral when the call never completed, and says how many attempts it took', async () => {
    const { octokit, calls } = fakeOctokit();
    const err = new KimiTransportError('idle-timeout', 'Kimi API call abandoned: no bytes for 120000 ms');
    err.attempts = 3;
    const orchestrator = new ReviewOrchestrator(octokit as any, fakeKimi(err) as any, DEFAULT_CONFIG);

    const result = await orchestrator.reviewPullRequest(params);

    expect(result.incomplete).toEqual({
      kind: 'api',
      reason: 'idle-timeout',
      detail: 'Kimi API call abandoned: no bytes for 120000 ms (after 3 attempts)',
    });
    expect(calls.update[0].conclusion).toBe('neutral');
    expect(calls.update[0].output.summary).toBe(
      '**Review skipped (idle-timeout):** Kimi API call abandoned: no bytes for 120000 ms (after 3 attempts)',
    );
  });

  it('reports the output cap, not the output shape, when the provider says the cap cut the review', async () => {
    const { octokit, calls } = fakeOctokit();
    const kimi = {
      maxTokens: 16384,
      chatCompletion: vi.fn(async () => ({
        id: 'x',
        choices: [{ index: 0, message: { role: 'assistant', content: '{"summary": "The change' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 10, completion_tokens: 16384, total_tokens: 16394, cached_tokens: 0 },
      })),
    };
    const orchestrator = new ReviewOrchestrator(octokit as any, kimi as any, DEFAULT_CONFIG);

    const result = await orchestrator.reviewPullRequest(params);

    expect(result.incomplete).toEqual({
      kind: 'parse',
      reason: 'max-tokens',
      detail: 'The model hit max_tokens (16384) after 16384 output tokens and the review JSON was cut off; raise max_tokens.',
    });
    expect(calls.update[0].conclusion).toBe('neutral');
    expect(calls.update[0].output.summary).toBe(
      '**Review incomplete (max-tokens):** The model hit max_tokens (16384) after 16384 output tokens and the review JSON was cut off; raise max_tokens.',
    );
    expect(calls.createReview).toHaveLength(0);
  });

  it('ends the check neutral on a 5xx too', async () => {
    const { octokit, calls } = fakeOctokit();
    const kimi = fakeKimi(new KimiApiError('Kimi API error: 502 Bad Gateway', 502, ''));
    const orchestrator = new ReviewOrchestrator(octokit as any, kimi as any, DEFAULT_CONFIG);

    const result = await orchestrator.reviewPullRequest(params);

    expect(result.incomplete?.reason).toBe('server');
    expect(calls.update[0].conclusion).toBe('neutral');
    expect(calls.update[0].output.summary).toBe('**Review skipped (server):** Kimi API 502');
  });

  it('still fails the check and throws on an auth error, with the provider message', async () => {
    const { octokit, calls } = fakeOctokit();
    const kimi = fakeKimi(
      new KimiApiError('Kimi API error: 401 Unauthorized', 401, '{"error":{"message":"invalid api key"}}'),
    );
    const orchestrator = new ReviewOrchestrator(octokit as any, kimi as any, DEFAULT_CONFIG);

    await expect(orchestrator.reviewPullRequest(params)).rejects.toBeInstanceOf(ReviewError);
    expect(calls.update[0].conclusion).toBe('failure');
    expect(calls.update[0].output.summary).toBe(
      'Review failed: Kimi API error: 401 Unauthorized: invalid api key',
    );
    expect(calls.createReview).toHaveLength(0);
  });

  it('ends the check neutral and posts no review when the output is not a review', async () => {
    const { octokit, calls } = fakeOctokit();
    const kimi = fakeKimi('I cannot review this.');
    const orchestrator = new ReviewOrchestrator(octokit as any, kimi as any, DEFAULT_CONFIG);

    const result = await orchestrator.reviewPullRequest(params);

    expect(result.incomplete?.kind).toBe('parse');
    expect(result.incomplete?.reason).toBe('malformed-json');
    expect(calls.update[0].conclusion).toBe('neutral');
    expect(calls.update[0].output.summary).toBe(
      '**Review incomplete (malformed-json):** The model returned 21 characters (5 output tokens) that are not valid JSON; the output starts with "I cannot review this.".',
    );
    expect(calls.createReview).toHaveLength(0);
  });

  it('is unchanged for a parsed review: conclusion from fail_on, review posted', async () => {
    const { octokit, calls } = fakeOctokit();
    const review = JSON.stringify({
      summary: 'One warning.',
      score: 80,
      annotations: [
        {
          path: 'src/a.ts',
          startLine: 2,
          endLine: 2,
          severity: 'warning',
          category: 'style',
          title: 'Unused variable',
          body: 'x is never read',
        },
      ],
    });
    const orchestrator = new ReviewOrchestrator(fakeOctokit().octokit as any, fakeKimi(review) as any, DEFAULT_CONFIG);
    void calls;
    const result = await orchestrator.reviewPullRequest(params);

    expect(result.incomplete).toBeUndefined();
    expect(result.stats.warning).toBe(1);
  });

  it('posts the parsed findings and stays neutral when one chunk of a chunked review is malformed', async () => {
    state.ctx = twoFileContext();
    const { octokit, calls } = fakeOctokit();
    const review = JSON.stringify({
      summary: 'One warning.',
      score: 80,
      annotations: [
        { path: 'src/f1.ts', startLine: 2, endLine: 2, severity: 'warning', category: 'style', title: 'Unused variable', body: 'v1_0 is never read' },
      ],
    });
    const kimi = { chatCompletion: vi.fn() };
    kimi.chatCompletion.mockResolvedValueOnce({
      id: '1', choices: [{ index: 0, message: { role: 'assistant', content: review }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    kimi.chatCompletion.mockResolvedValueOnce({
      id: '2', choices: [{ index: 0, message: { role: 'assistant', content: 'garbage' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const config = { ...DEFAULT_CONFIG, review: { ...DEFAULT_CONFIG.review, contextTokens: 300, chunkTokens: 150 } };
    const orchestrator = new ReviewOrchestrator(octokit as any, kimi as any, config);

    const result = await orchestrator.reviewPullRequest(params);

    expect(kimi.chatCompletion).toHaveBeenCalledTimes(2);
    expect(result.incomplete).toEqual({
      kind: 'parse',
      reason: 'malformed-json',
      detail: expect.stringMatching(/^Part 2\/2: The model returned 7 characters/),
    });
    expect(result.stats.warning).toBe(1);
    expect(result.score).toBe(80);
    expect(calls.update[0].conclusion).toBe('neutral');
    expect(calls.update[0].output.summary).toMatch(/^\*\*Review incomplete \(malformed-json\):\*\* Part 2\/2: .*\n\n## Score: 80\/100/s);
    expect(calls.createReview).toHaveLength(1);
    expect(calls.createReview[0].event).toBe('COMMENT');
    expect(calls.createReview[0].comments).toHaveLength(1);
  });
});

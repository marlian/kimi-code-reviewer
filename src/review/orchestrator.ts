import type { Octokit } from '@octokit/rest';
import type { ReviewConfig } from '../config/schema.js';
import type { ReviewResult } from '../types/review.js';
import { KimiClient } from '../kimi/client.js';
import { planContext } from '../kimi/context-packer.js';
import { buildReviewSystemPrompt } from '../kimi/prompt-builder.js';
import { buildCacheOptimizedMessages, buildChunkedMessages } from '../kimi/cache-strategy.js';
import { mergeReviewResults } from './merge.js';
import { parseKimiResponse } from '../kimi/response-parser.js';
import { extractPullRequestContext } from '../github/pulls.js';
import { createCheckRun, completeCheckRun } from '../github/checks.js';
import { createPRReview } from '../github/comments.js';
import { filterFiles } from './file-filter.js';
import { buildSummary } from './summary-builder.js';
import { ReviewError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

interface ReviewParams {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
}

export class ReviewOrchestrator {
  constructor(
    private octokit: Octokit,
    private kimi: KimiClient,
    private config: ReviewConfig,
  ) {}

  async reviewPullRequest(params: ReviewParams): Promise<ReviewResult> {
    const { owner, repo, pullNumber, headSha } = params;

    // Step 1: Create Check Run
    const checkRunId = await createCheckRun(this.octokit, {
      owner,
      repo,
      headSha,
    });

    try {
      // Step 2: Extract PR context
      logger.info({ pullNumber }, 'Extracting PR context');
      const prContext = await extractPullRequestContext(
        this.octokit,
        owner,
        repo,
        pullNumber,
        this.config,
      );

      // Step 3: Filter files
      const filteredFiles = filterFiles(prContext.changedFiles, this.config);
      prContext.changedFiles = filteredFiles;

      if (filteredFiles.length === 0) {
        const result: ReviewResult = {
          summary: 'No reviewable files in this PR (all files matched exclude patterns).',
          score: 100,
          annotations: [],
          stats: { critical: 0, warning: 0, suggestion: 0, nitpick: 0 },
          tokensUsed: { input: 0, output: 0, cached: 0 },
        };

        await completeCheckRun(this.octokit, {
          owner,
          repo,
          checkRunId,
          conclusion: 'success',
          summary: result.summary,
          annotations: [],
        });

        return result;
      }

      // Step 3.5: Drop contents of files excluded by the filter so they
      // never reach the model context.
      const allowedFiles = new Set(filteredFiles.map((f) => f.filename));
      for (const name of [...prContext.fileContents.keys()]) {
        if (!allowedFiles.has(name)) {
          prContext.fileContents.delete(name);
        }
      }

      // Step 4: Plan context packing (budget-aware)
      const plan = planContext(prContext, this.config);
      logger.info(
        {
          strategy: plan.strategy,
          diffTokens: plan.diffTokens,
          includedFiles: plan.includedFiles.length,
          truncatedFiles: plan.truncatedFiles.length,
          batches: plan.batches.length,
        },
        'Context planned',
      );

      const systemPrompt = buildReviewSystemPrompt(this.config);
      let result: ReviewResult;

      if (plan.strategy === 'chunked') {
        // Step 5-7 (chunked): one call per batch, then merge (map-reduce).
        const parts: ReviewResult[] = [];
        for (const [index, batch] of plan.batches.entries()) {
          const messages = buildChunkedMessages(
            systemPrompt,
            prContext,
            this.config,
            batch,
            index,
            plan.batches.length,
            prContext.fileContents,
          );
          logger.info(
            { batch: index + 1, batches: plan.batches.length, files: batch.files.length, diffTokens: batch.diffTokens },
            'Calling Kimi API (chunked)',
          );
          const response = await this.kimi.chatCompletion({
            messages,
            responseFormat: { type: 'json_object' },
          });
          parts.push(
            parseKimiResponse(response.choices[0].message.content, {
              input: response.usage.prompt_tokens,
              output: response.usage.completion_tokens,
              cached: response.usage.cached_tokens ?? 0,
            }),
          );
        }
        result = mergeReviewResults(parts);
      } else {
        // Step 5 (single call): only the planned file contents enter context.
        const includedContents = new Map<string, string>();
        for (const name of plan.includedFiles) {
          const content = prContext.fileContents.get(name);
          if (content) includedContents.set(name, content);
        }
        const messages = buildCacheOptimizedMessages(
          systemPrompt,
          prContext,
          this.config,
          includedContents,
        );

        // Step 6: Call Kimi API
        logger.info({ messageCount: messages.length }, 'Calling Kimi API');
        const response = await this.kimi.chatCompletion({
          messages,
          responseFormat: { type: 'json_object' },
        });

        // Step 7: Parse response
        result = parseKimiResponse(response.choices[0].message.content, {
          input: response.usage.prompt_tokens,
          output: response.usage.completion_tokens,
          cached: response.usage.cached_tokens ?? 0,
        });
      }

      // Step 7.5: Surface files that could not be reviewed inline.
      if (plan.unreviewableFiles.length > 0) {
        result.summary += `\n\n**Not reviewed inline** (no patch available — binary or too large): ${plan.unreviewableFiles.join(', ')}`;
      }

      // Step 8: Filter by severity
      const minSeverityOrder = ['critical', 'warning', 'suggestion', 'nitpick'];
      const minIdx = minSeverityOrder.indexOf(this.config.review.minSeverity);
      result.annotations = result.annotations.filter(
        (a) => minSeverityOrder.indexOf(a.severity) <= minIdx,
      );

      // Step 9: Limit annotations
      if (result.annotations.length > this.config.review.maxAnnotations) {
        result.annotations = result.annotations.slice(0, this.config.review.maxAnnotations);
      }

      // Step 10: Determine conclusion
      const conclusion =
        this.config.review.failOn === 'critical' && result.stats.critical > 0
          ? 'failure'
          : this.config.review.failOn === 'warning' &&
              (result.stats.critical > 0 || result.stats.warning > 0)
            ? 'failure'
            : 'success';

      // Step 11: Update Check Run
      const summaryMd = buildSummary(result);
      await completeCheckRun(this.octokit, {
        owner,
        repo,
        checkRunId,
        conclusion,
        summary: summaryMd,
        annotations: result.annotations,
      });

      // Step 12: Create PR Review
      await createPRReview(this.octokit, {
        owner,
        repo,
        pullNumber,
        commitSha: headSha,
        result,
        failOn: this.config.review.failOn,
      });

      logger.info(
        {
          pullNumber,
          score: result.score,
          annotations: result.annotations.length,
          conclusion,
        },
        'Review completed',
      );

      return result;
    } catch (err) {
      logger.error({ err, pullNumber }, 'Review failed');

      await completeCheckRun(this.octokit, {
        owner,
        repo,
        checkRunId,
        conclusion: 'failure',
        summary: `Review failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        annotations: [],
      });

      throw new ReviewError(
        err instanceof Error ? err.message : 'Unknown error',
        'orchestration',
      );
    }
  }
}

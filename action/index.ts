import * as core from '@actions/core';
import * as github from '@actions/github';
import { ReviewOrchestrator } from '../src/review/orchestrator.js';
import { KimiClient, type KimiThinkingMode } from '../src/kimi/client.js';
import { loadConfig } from '../src/config/loader.js';
import { calculateCost } from '../src/utils/tokens.js';

function parseThinkingMode(raw: string): KimiThinkingMode {
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'default') {
    return 'default';
  }
  if (value === 'enabled' || value === 'disabled') {
    return value;
  }
  throw new Error('thinking must be one of: default, enabled, disabled');
}

async function run(): Promise<void> {
  try {
    // Get inputs
    const kimiApiKey = core.getInput('kimi_api_key', { required: true });
    const githubToken = core.getInput('github_token');
    const baseUrlInput = core.getInput('base_url').trim();
    const modelInput = core.getInput('model').trim();
    const protocolInput = core.getInput('protocol').trim();
    const thinking = parseThinkingMode(core.getInput('thinking').trim());
    const failOn = (core.getInput('fail_on') || 'critical') as 'critical' | 'warning' | 'never';

    // Resolve endpoint defaults: if base_url points at Kimi Code, switch to Anthropic protocol
    // and default model to k2p6; otherwise fall back to Moonshot OpenAI defaults.
    const baseUrl = baseUrlInput || undefined;
    const isKimiCode = baseUrlInput.includes('api.kimi.com/coding');
    const protocol = (protocolInput || (isKimiCode ? 'anthropic' : 'openai')) as 'openai' | 'anthropic';
    const model = modelInput || (isKimiCode ? 'k2p6' : 'kimi-k2.5');

    core.info(
      `Using protocol: ${protocol}, model: ${model}, baseUrl: ${baseUrl ?? 'default'}, thinking: ${thinking}`,
    );

    const octokit = github.getOctokit(githubToken);
    const context = github.context;

    // Only run on pull requests
    if (!context.payload.pull_request) {
      core.info('Not a pull request event, skipping.');
      return;
    }

    const owner = context.repo.owner;
    const repo = context.repo.repo;
    const pullNumber = context.payload.pull_request.number;
    const headSha = context.payload.pull_request.head.sha;

    core.info(`Reviewing PR #${pullNumber} (${headSha.slice(0, 7)})`);

    // @actions/github getOctokit puts REST methods under .rest,
    // but our code expects @octokit/rest shape (octokit.checks, octokit.pulls, etc.)
    const restOctokit = octokit.rest;

    // Load config from repo
    const config = await loadConfig(restOctokit as any, owner, repo);
    // Override failOn from action input
    config.review.failOn = failOn;

    // Create Kimi client
    const kimi = new KimiClient({ apiKey: kimiApiKey, model, baseUrl, protocol, thinking });

    // Run review
    const orchestrator = new ReviewOrchestrator(restOctokit as any, kimi, config);
    const result = await orchestrator.reviewPullRequest({
      owner,
      repo,
      pullNumber,
      headSha,
    });

    // Set outputs
    core.setOutput('review_summary', result.summary);
    core.setOutput('annotations_count', result.annotations.length.toString());
    core.setOutput('critical_count', result.stats.critical.toString());
    core.setOutput(
      'tokens_used',
      (result.tokensUsed.input + result.tokensUsed.output).toString(),
    );
    core.setOutput('cost_estimate', calculateCost(result.tokensUsed).toString());

    // Summary in job output
    core.summary
      .addHeading('Kimi Code Review', 2)
      .addRaw(`**Score:** ${result.score}/100\n\n`)
      .addRaw(result.summary)
      .addTable([
        [
          { data: 'Severity', header: true },
          { data: 'Count', header: true },
        ],
        ['Critical', result.stats.critical.toString()],
        ['Warning', result.stats.warning.toString()],
        ['Suggestion', result.stats.suggestion.toString()],
      ]);
    await core.summary.write();

    // Fail the action if needed
    if (failOn === 'critical' && result.stats.critical > 0) {
      core.setFailed(`Found ${result.stats.critical} critical issue(s)`);
    } else if (
      failOn === 'warning' &&
      (result.stats.critical > 0 || result.stats.warning > 0)
    ) {
      core.setFailed(
        `Found ${result.stats.critical} critical and ${result.stats.warning} warning issue(s)`,
      );
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`Kimi review failed: ${error.message}`);
    } else {
      core.setFailed('Kimi review failed with unknown error');
    }
  }
}

run();

import type { ChatMessage, PullRequestContext } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';

const REVIEW_JSON_SCHEMA = `{
  "summary": "string — overall review summary in markdown",
  "score": "number 0-100 — code quality score",
  "annotations": [
    {
      "path": "string — file path relative to repo root",
      "startLine": "number — starting line number (1-indexed)",
      "endLine": "number — ending line number (1-indexed)",
      "severity": "critical | warning | suggestion | nitpick",
      "category": "bug | security | performance | style | best-practice | documentation | testing | other",
      "title": "string — short issue title",
      "body": "string — detailed explanation in markdown",
      "suggestedFix": "string | null — suggested code replacement"
    }
  ]
}`;

function buildSystemPrompt(config: ReviewConfig, customRules: string): string {
  const aspects = Object.entries(config.review.aspects)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(', ');

  const instructionsBlock = config.instructions
    ? `\n## Repository Instructions\n${config.instructions}\n`
    : '';

  const reviewFocusBlock = config.prompt.reviewFocus
    ? `\n## Review Focus\n${config.prompt.reviewFocus}\n`
    : '';

  return `You are an expert code reviewer. Analyze the pull request diff and provide structured feedback.

## Review Dimensions
Focus on: ${aspects}

## Severity Definitions
- critical: Bugs, security vulnerabilities, data loss risks — must fix before merge
- warning: Performance issues, potential bugs, bad practices — should fix
- suggestion: Code improvements, readability, maintainability — nice to have
- nitpick: Style preferences, minor formatting — optional

## Output Format
Respond with a single JSON object matching this schema:
${REVIEW_JSON_SCHEMA}

## Rules
- Only annotate lines that exist in the diff (added or modified lines)
- Be specific: reference exact variable names, function names, line numbers
- Provide actionable suggestions, not vague observations
- suggestedFix should be the replacement code snippet, not the full file
- Keep summary concise (2-5 sentences)
- Score: 90-100 = excellent, 70-89 = good, 50-69 = needs improvement, <50 = significant issues
${instructionsBlock}${reviewFocusBlock}${customRules ? `\n## Additional Rules (from repository config)\n${customRules}` : ''}${config.prompt.systemAppend ? `\n${config.prompt.systemAppend}` : ''}`;
}

function buildUserPrompt(ctx: PullRequestContext, fileContents: Map<string, string>): string {
  const parts: string[] = [];

  parts.push(`## Pull Request: ${ctx.title}\n`);
  if (ctx.body) {
    parts.push(`### Description\n${ctx.body}\n`);
  }

  // Include full file contents for context (base versions)
  if (fileContents.size > 0) {
    parts.push('### File Contents (for context)\n');
    for (const [path, content] of fileContents) {
      parts.push(`#### ${path}\n\`\`\`\n${content}\n\`\`\`\n`);
    }
  }

  parts.push(`### Diff\n\`\`\`diff\n${ctx.diff}\n\`\`\`\n`);

  return parts.join('\n');
}

export function buildReviewSystemPrompt(config: ReviewConfig): string {
  const customRules = config.rules
    .map((r) => `- [${r.severity}] ${r.name}: ${r.description}`)
    .join('\n');

  return buildSystemPrompt(config, customRules);
}

export function buildReviewMessages(
  ctx: PullRequestContext,
  config: ReviewConfig,
): ChatMessage[] {
  return [
    { role: 'system', content: buildReviewSystemPrompt(config) },
    { role: 'user', content: buildUserPrompt(ctx, ctx.fileContents) },
  ];
}

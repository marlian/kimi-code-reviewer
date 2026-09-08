import type { Octokit } from '@octokit/rest';
import type { ReviewAnnotation, Severity } from '../types/review.js';
import { logger } from '../utils/logger.js';

type CheckAnnotationLevel = 'notice' | 'warning' | 'failure';

const SEVERITY_TO_LEVEL: Record<Severity, CheckAnnotationLevel> = {
  critical: 'failure',
  warning: 'warning',
  suggestion: 'notice',
  nitpick: 'notice',
};

const MAX_ANNOTATIONS_PER_REQUEST = 50;

export async function createCheckRun(
  octokit: Octokit,
  params: { owner: string; repo: string; headSha: string; name?: string },
): Promise<number> {
  const { data } = await octokit.checks.create({
    owner: params.owner,
    repo: params.repo,
    name: params.name ?? 'Kimi Code Review',
    head_sha: params.headSha,
    status: 'in_progress',
    started_at: new Date().toISOString(),
  });

  logger.info({ checkRunId: data.id }, 'Check run created');
  return data.id;
}

function checkTitle(conclusion: 'success' | 'failure' | 'neutral'): string {
  switch (conclusion) {
    case 'success':
      return 'No critical issues found';
    case 'neutral':
      return 'No verdict: review skipped or incomplete';
    default:
      return 'Issues found';
  }
}

export async function completeCheckRun(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    checkRunId: number;
    conclusion: 'success' | 'failure' | 'neutral';
    summary: string;
    annotations: ReviewAnnotation[];
  },
): Promise<void> {
  const { owner, repo, checkRunId, conclusion, summary, annotations } = params;

  // GitHub API limits annotations to 50 per request — batch them
  const batches: ReviewAnnotation[][] = [];
  for (let i = 0; i < annotations.length; i += MAX_ANNOTATIONS_PER_REQUEST) {
    batches.push(annotations.slice(i, i + MAX_ANNOTATIONS_PER_REQUEST));
  }

  // First update includes the summary
  await octokit.checks.update({
    owner,
    repo,
    check_run_id: checkRunId,
    status: 'completed',
    conclusion,
    completed_at: new Date().toISOString(),
    output: {
      title: checkTitle(conclusion),
      summary,
      annotations: (batches[0] ?? []).map(toCheckAnnotation),
    },
  });

  // Subsequent batches of annotations
  for (let i = 1; i < batches.length; i++) {
    await octokit.checks.update({
      owner,
      repo,
      check_run_id: checkRunId,
      output: {
        title: checkTitle(conclusion),
        summary,
        annotations: batches[i].map(toCheckAnnotation),
      },
    });
  }

  logger.info({ checkRunId, conclusion, annotationCount: annotations.length }, 'Check run completed');
}

function toCheckAnnotation(a: ReviewAnnotation) {
  return {
    path: a.path,
    start_line: a.startLine,
    end_line: a.endLine,
    annotation_level: SEVERITY_TO_LEVEL[a.severity],
    title: `[${a.severity}] ${a.title}`,
    message: a.body,
    raw_details: a.suggestedFix ?? undefined,
  };
}

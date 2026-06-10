export type Severity = 'critical' | 'warning' | 'suggestion' | 'nitpick';

export type AnnotationCategory =
  | 'bug'
  | 'security'
  | 'performance'
  | 'style'
  | 'best-practice'
  | 'documentation'
  | 'testing'
  | 'other';

export interface ReviewAnnotation {
  path: string;
  startLine: number;
  endLine: number;
  severity: Severity;
  category: AnnotationCategory;
  title: string;
  body: string;
  suggestedFix?: string;
}

export interface ReviewResult {
  summary: string;
  score: number; // 0-100
  annotations: ReviewAnnotation[];
  stats: Record<Severity, number>;
  tokensUsed: {
    input: number;
    output: number;
    cached: number;
  };
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  patch?: string;
}

export interface PullRequestContext {
  owner: string;
  repo: string;
  pullNumber: number;
  baseSha: string;
  headSha: string;
  title: string;
  body: string;
  diff: string;
  changedFiles: ChangedFile[];
  fileContents: Map<string, string>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface FileBatch {
  files: ChangedFile[];
  /** Estimated tokens of the per-file patches in this batch (incl. framing). */
  diffTokens: number;
  /** Files in this batch whose full contents are included in the call. */
  contentFiles: string[];
}

export interface PackPlan {
  strategy: 'full' | 'mixed' | 'chunked';
  /** Files whose full contents are sent for context. */
  includedFiles: string[];
  /** Files whose contents are omitted to respect the budget. */
  truncatedFiles: string[];
  /** Changed files with no patch (binary / too large) — not reviewable inline. */
  unreviewableFiles: string[];
  /** Non-empty only for the chunked strategy: one API call per batch. */
  batches: FileBatch[];
  diffTokens: number;
  contextTokens: number;
}

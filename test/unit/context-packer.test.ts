import { describe, it, expect } from 'vitest';
import { planContext } from '../../src/kimi/context-packer.js';
import { reviewConfigSchema } from '../../src/config/schema.js';
import type { PullRequestContext, ChangedFile } from '../../src/types/review.js';

// Small budgets so fixtures stay readable. estimateTokens ~= chars / 4.
const config = reviewConfigSchema.parse({
  review: { contextTokens: 10_000, chunkTokens: 5_000 },
});

interface FixtureFile {
  name: string;
  patchChars?: number;
  contentChars?: number;
  additions?: number;
}

function makeCtx(files: FixtureFile[], diffChars?: number): PullRequestContext {
  const changedFiles: ChangedFile[] = files.map((f) => ({
    filename: f.name,
    status: 'modified',
    additions: f.additions ?? 1,
    deletions: 0,
    patch: f.patchChars !== undefined ? 'x'.repeat(f.patchChars) : undefined,
  }));
  const fileContents = new Map<string, string>();
  for (const f of files) {
    if (f.contentChars !== undefined) {
      fileContents.set(f.name, 'y'.repeat(f.contentChars));
    }
  }
  const totalPatchChars = files.reduce((sum, f) => sum + (f.patchChars ?? 0), 0);
  return {
    owner: 'o',
    repo: 'r',
    pullNumber: 1,
    baseSha: 'base',
    headSha: 'head',
    title: 'Test PR',
    body: '',
    diff: 'd'.repeat(diffChars ?? totalPatchChars),
    changedFiles,
    fileContents,
  };
}

describe('planContext', () => {
  it('selects full mode when diff + all contents fit the budget', () => {
    const ctx = makeCtx([
      { name: 'a.ts', patchChars: 2_000, contentChars: 4_000 },
      { name: 'b.ts', patchChars: 2_000, contentChars: 4_000 },
    ]);
    const plan = planContext(ctx, config);
    expect(plan.strategy).toBe('full');
    expect(plan.includedFiles).toEqual(['a.ts', 'b.ts']);
    expect(plan.truncatedFiles).toEqual([]);
    expect(plan.batches).toEqual([]);
  });

  it('selects mixed mode and prioritizes by change size within the budget', () => {
    // diff 2000 tokens (<= 6000 mixed threshold); each content ~4024 tokens.
    // 2000 + 4024 fits in 9000; adding a second does not.
    const ctx = makeCtx(
      [
        { name: 'big.ts', patchChars: 0, contentChars: 16_000, additions: 100 },
        { name: 'mid.ts', patchChars: 0, contentChars: 16_000, additions: 10 },
        { name: 'small.ts', patchChars: 0, contentChars: 16_000, additions: 5 },
      ],
      8_000,
    );
    const plan = planContext(ctx, config);
    expect(plan.strategy).toBe('mixed');
    expect(plan.includedFiles).toEqual(['big.ts']);
    expect(plan.truncatedFiles).toEqual(['mid.ts', 'small.ts']);
    expect(plan.batches).toEqual([]);
  });

  it('selects chunked mode when the diff exceeds the single-call budget', () => {
    // diff 10000 tokens > packBudget 9000 and > mixed threshold 6000.
    // 5 files of ~1024 patch tokens each: chunkTokens 5000 -> first batch
    // holds 4 files, second batch holds 1.
    const ctx = makeCtx(
      [
        { name: 'f1.ts', patchChars: 4_000 },
        { name: 'f2.ts', patchChars: 4_000 },
        { name: 'f3.ts', patchChars: 4_000 },
        { name: 'f4.ts', patchChars: 4_000 },
        { name: 'f5.ts', patchChars: 4_000 },
      ],
      40_000,
    );
    const plan = planContext(ctx, config);
    expect(plan.strategy).toBe('chunked');
    expect(plan.batches).toHaveLength(2);
    expect(plan.batches[0].files.map((f) => f.filename)).toEqual(['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts']);
    expect(plan.batches[1].files.map((f) => f.filename)).toEqual(['f5.ts']);
  });

  it('partitions every reviewable file into exactly one batch', () => {
    const files = Array.from({ length: 12 }, (_, i) => ({
      name: `f${i}.ts`,
      patchChars: 6_000,
    }));
    const ctx = makeCtx(files, 80_000);
    const plan = planContext(ctx, config);
    expect(plan.strategy).toBe('chunked');
    const batched = plan.batches.flatMap((b) => b.files.map((f) => f.filename));
    expect(batched.sort()).toEqual(files.map((f) => f.name).sort());
    expect(new Set(batched).size).toBe(batched.length);
  });

  it('keeps each batch within chunkTokens unless a single file exceeds it', () => {
    const ctx = makeCtx(
      [
        { name: 'normal.ts', patchChars: 4_000 },
        { name: 'huge.ts', patchChars: 24_000 }, // ~6024 tokens > chunkTokens
        { name: 'tail.ts', patchChars: 4_000 },
      ],
      40_000,
    );
    const plan = planContext(ctx, config);
    expect(plan.strategy).toBe('chunked');
    const hugeBatch = plan.batches.find((b) =>
      b.files.some((f) => f.filename === 'huge.ts'),
    );
    expect(hugeBatch?.files).toHaveLength(1);
    for (const batch of plan.batches) {
      if (batch.files.length > 1) {
        expect(batch.diffTokens).toBeLessThanOrEqual(5_000);
      }
    }
  });

  it('reports files without a patch as unreviewable', () => {
    const ctx = makeCtx(
      [
        { name: 'normal.ts', patchChars: 4_000 },
        { name: 'binary.png' }, // no patch
      ],
      40_000,
    );
    const plan = planContext(ctx, config);
    expect(plan.strategy).toBe('chunked');
    expect(plan.unreviewableFiles).toEqual(['binary.png']);
    const batched = plan.batches.flatMap((b) => b.files.map((f) => f.filename));
    expect(batched).not.toContain('binary.png');
  });

  it('returns zero batches when no changed file has a patch', () => {
    const ctx = makeCtx(
      [
        { name: 'huge-generated.js' }, // no patch (oversized diff)
        { name: 'image.png' }, // no patch (binary)
      ],
      40_000, // unified diff is still huge -> chunked
    );
    const plan = planContext(ctx, config);
    expect(plan.strategy).toBe('chunked');
    expect(plan.batches).toEqual([]);
    expect(plan.unreviewableFiles).toEqual(['huge-generated.js', 'image.png']);
  });

  it('attaches batch file contents only while the content budget allows', () => {
    // contentBudget = 6000 tokens. Batch diff ~1024; one content of ~4024 fits,
    // a second of ~4024 would exceed 6000.
    const ctx = makeCtx(
      [
        { name: 'a.ts', patchChars: 2_000, contentChars: 16_000, additions: 100 },
        { name: 'b.ts', patchChars: 2_000, contentChars: 16_000, additions: 10 },
      ],
      40_000, // force chunked via oversized total diff
    );
    const plan = planContext(ctx, config);
    expect(plan.strategy).toBe('chunked');
    const batch = plan.batches[0];
    expect(batch.contentFiles).toEqual(['a.ts']);
    expect(plan.truncatedFiles).toContain('b.ts');
  });
});

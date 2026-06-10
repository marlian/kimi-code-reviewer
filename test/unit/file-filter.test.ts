import { describe, it, expect } from 'vitest';
import { filterFiles } from '../../src/review/file-filter.js';
import type { ChangedFile } from '../../src/types/review.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

function makeFile(filename: string, overrides?: Partial<ChangedFile>): ChangedFile {
  return {
    filename,
    status: 'modified',
    additions: 10,
    deletions: 5,
    patch: '@@ -1,3 +1,3 @@\n context\n-old\n+new',
    ...overrides,
  };
}

describe('filterFiles', () => {
  it('should exclude node_modules', () => {
    const files = [
      makeFile('src/index.ts'),
      makeFile('node_modules/foo/index.js'),
    ];
    const filtered = filterFiles(files, DEFAULT_CONFIG);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].filename).toBe('src/index.ts');
  });

  it('should exclude lock files', () => {
    const files = [
      makeFile('src/app.ts'),
      makeFile('package-lock.json'),
      makeFile('yarn.lock'),
    ];
    const filtered = filterFiles(files, DEFAULT_CONFIG);
    expect(filtered).toHaveLength(1);
  });

  it('should exclude removed files', () => {
    const files = [
      makeFile('src/old.ts', { status: 'removed' }),
      makeFile('src/new.ts', { status: 'added' }),
    ];
    const filtered = filterFiles(files, DEFAULT_CONFIG);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].filename).toBe('src/new.ts');
  });

  it('should exclude files without patches (binary)', () => {
    const files = [
      makeFile('src/index.ts'),
      makeFile('assets/image.png', { patch: undefined }),
    ];
    const filtered = filterFiles(files, DEFAULT_CONFIG);
    expect(filtered).toHaveLength(1);
  });
});

import { filterUnifiedDiff } from '../../src/review/file-filter.js';

function diffSection(path: string, body = '+added line'): string {
  return [
    `diff --git a/${path} b/${path}`,
    `index 0000000..1111111 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,1 +1,1 @@',
    body,
  ].join('\n');
}

describe('filterUnifiedDiff', () => {
  it('keeps only sections for allowed files', () => {
    const diff = [diffSection('src/a.ts'), diffSection('dist/bundle.js'), diffSection('src/b.ts')].join('\n');
    const out = filterUnifiedDiff(diff, new Set(['src/a.ts', 'src/b.ts']));
    expect(out).toContain('a/src/a.ts');
    expect(out).toContain('a/src/b.ts');
    expect(out).not.toContain('dist/bundle.js');
  });

  it('keeps renamed files when either side is allowed', () => {
    const rename = [
      'diff --git a/src/old-name.ts b/src/new-name.ts',
      'similarity index 90%',
      'rename from src/old-name.ts',
      'rename to src/new-name.ts',
    ].join('\n');
    const out = filterUnifiedDiff(rename, new Set(['src/new-name.ts']));
    expect(out).toContain('rename to src/new-name.ts');
  });

  it('drops everything when nothing is allowed', () => {
    const diff = diffSection('generated/big.js');
    expect(filterUnifiedDiff(diff, new Set())).toBe('');
  });

  it('handles quoted paths with special characters', () => {
    const quoted = [
      'diff --git "a/src/sp ace.ts" "b/src/sp ace.ts"',
      '--- "a/src/sp ace.ts"',
      '+++ "b/src/sp ace.ts"',
      '@@ -1,1 +1,1 @@',
      '+x',
    ].join('\n');
    const out = filterUnifiedDiff(quoted, new Set(['src/sp ace.ts']));
    expect(out).toContain('sp ace.ts');
  });

  it('fails open on unparseable headers', () => {
    const weird = ['diff --git weird header line', '+content'].join('\n');
    const out = filterUnifiedDiff(weird, new Set());
    expect(out).toContain('+content');
  });

  it('returns empty diff unchanged', () => {
    expect(filterUnifiedDiff('', new Set(['a.ts']))).toBe('');
  });
});

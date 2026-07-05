import { describe, expect, it } from 'vitest';
import { DiffHandler } from '../diff-handler';

describe('DiffHandler.generateLineDiff', () => {
  it('identifies additions, deletions, and normal lines', () => {
    const original = 'line 1\nline 2\nline 3';
    const proposed = 'line 1\nline 2 added\nline 3';

    const diff = DiffHandler.generateLineDiff(original, proposed);

    expect(diff).toEqual([
      { type: 'normal', text: 'line 1' },
      { type: 'removed', text: 'line 2' },
      { type: 'added', text: 'line 2 added' },
      { type: 'normal', text: 'line 3' }
    ]);
  });

  it('handles empty strings', () => {
    const diff = DiffHandler.generateLineDiff('', '');
    expect(diff).toEqual([]);
  });

  it('handles purely additions', () => {
    const original = '';
    const proposed = 'line 1\nline 2';
    const diff = DiffHandler.generateLineDiff(original, proposed);
    expect(diff).toEqual([
      { type: 'added', text: 'line 1' },
      { type: 'added', text: 'line 2' }
    ]);
  });

  it('handles purely deletions', () => {
    const original = 'line 1\nline 2';
    const proposed = '';
    const diff = DiffHandler.generateLineDiff(original, proposed);
    expect(diff).toEqual([
      { type: 'removed', text: 'line 1' },
      { type: 'removed', text: 'line 2' }
    ]);
  });
});

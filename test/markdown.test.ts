import { describe, expect, it } from 'vitest';
import { markdownCell } from '../src/data/markdown.ts';

describe('markdownCell (docs tables written by scripts/export-contract.ts)', () => {
  it('escapes the column separator so a value never splits a cell', () => {
    expect(markdownCell('a | b')).toBe('a \\| b');
  });
  it('escapes backslashes first, so a value ending in a backslash cannot un-escape the next pipe (CodeQL js/incomplete-sanitization)', () => {
    expect(markdownCell('C:\\temp\\')).toBe('C:\\\\temp\\\\');
    expect(markdownCell('x\\|y')).toBe('x\\\\\\|y');
  });
  it('writes a dash for an empty value and text for booleans', () => {
    expect(markdownCell(null)).toBe('—');
    expect(markdownCell(undefined)).toBe('—');
    expect(markdownCell(false)).toBe('false');
  });
});

import { describe, expect, it } from 'vitest';
import { addBusinessDays, addDays, businessDaysBetween, clampDate, diffDays, isWeekday } from '../src/normalise/dates.js';

describe('date helpers', () => {
  it('adds and diffs calendar days across month/year boundaries', () => {
    expect(addDays('2026-09-29', 3)).toBe('2026-10-02');
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(diffDays('2026-10-05', '2026-09-29')).toBe(6);
  });

  it('knows 2026-09-29 (demo date) is a Tuesday', () => {
    expect(isWeekday('2026-09-29')).toBe(true);
    expect(isWeekday('2026-10-03')).toBe(false); // Saturday
  });

  it('counts business days in (from, to]', () => {
    expect(businessDaysBetween('2026-09-28', '2026-09-29')).toBe(1);   // Mon -> Tue
    expect(businessDaysBetween('2026-09-25', '2026-09-29')).toBe(2);   // Fri -> Tue (Mon, Tue)
    expect(businessDaysBetween('2026-09-29', '2026-09-25')).toBe(-2);
    expect(businessDaysBetween('2026-09-29', '2026-09-29')).toBe(0);
  });

  it('adds business days skipping weekends', () => {
    expect(addBusinessDays('2026-09-29', -1)).toBe('2026-09-28');
    expect(addBusinessDays('2026-09-28', -1)).toBe('2026-09-25');
    expect(addBusinessDays('2026-10-02', 1)).toBe('2026-10-05');
  });

  it('clamps', () => {
    expect(clampDate('2026-01-01', '2026-09-30', '2026-10-05')).toBe('2026-09-30');
    expect(clampDate('2026-12-01', '2026-09-30', '2026-10-05')).toBe('2026-10-05');
  });

  it('rejects non-ISO input', () => {
    expect(() => addDays('29/09/2026', 1)).toThrow(/Not an ISO date/);
  });
});

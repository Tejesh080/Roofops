/** Calendar-date helpers over 'YYYY-MM-DD' strings. No time zones, no Date objects leaking out. */

export type IsoDate = string;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function toEpochDay(d: IsoDate): number {
  if (!ISO.test(d)) throw new Error(`Not an ISO date: '${d}'`);
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, day) / DAY_MS;
}

function fromEpochDay(n: number): IsoDate {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(d: IsoDate, n: number): IsoDate {
  return fromEpochDay(toEpochDay(d) + n);
}

/** a − b in whole days. */
export function diffDays(a: IsoDate, b: IsoDate): number {
  return toEpochDay(a) - toEpochDay(b);
}

export const minDate = (a: IsoDate, b: IsoDate): IsoDate => (a <= b ? a : b);
export const maxDate = (a: IsoDate, b: IsoDate): IsoDate => (a >= b ? a : b);

export function clampDate(d: IsoDate, lo: IsoDate, hi: IsoDate): IsoDate {
  return maxDate(lo, minDate(d, hi));
}

export function isWeekday(d: IsoDate): boolean {
  const dow = new Date(toEpochDay(d) * DAY_MS).getUTCDay();
  return dow !== 0 && dow !== 6;
}

/** Number of weekdays in the half-open interval (from, to]. Negative if to < from. */
export function businessDaysBetween(from: IsoDate, to: IsoDate): number {
  if (to < from) return -businessDaysBetween(to, from);
  let n = 0;
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) if (isWeekday(d)) n++;
  return n;
}

/** Move n weekdays forward (n > 0) or back (n < 0). */
export function addBusinessDays(d: IsoDate, n: number): IsoDate {
  const step = n >= 0 ? 1 : -1;
  let left = Math.abs(n);
  let cur = d;
  while (left > 0) {
    cur = addDays(cur, step);
    if (isWeekday(cur)) left--;
  }
  return cur;
}

/** Local calendar date of an ISO-8601 timestamp as written ('2026-07-01T07:30:00+10:00' → '2026-07-01'). */
export function datePart(ts: string): IsoDate {
  return ts.slice(0, 10);
}

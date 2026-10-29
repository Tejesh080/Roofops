/**
 * Which "today" RoofOps is using, and whether it is real (app_business_date(), migration 20261017030000). A synthetic
 * date (demo data) is always shown as such next to the real date, so nobody mistakes it for today. Pure apart from
 * `query`, which the caller supplies.
 */
import type { Query } from './queries.ts';

export interface BusinessDate { date: string; real_date: string | null; synthetic: boolean | null }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-09-29" -> "29 Sep 2026" (no locale or timezone involved). */
export const longDate = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso;
};

export async function getBusinessDate(q: Query): Promise<BusinessDate> {
  try {
    const [r] = await q<{ b: { date: string; real_date: string; synthetic: boolean } }>('select app_business_date() b');
    return { date: String(r!.b.date), real_date: String(r!.b.real_date), synthetic: r!.b.synthetic === true };
  } catch {
    // A database without 20261017030000: only the date is known, not whether it is real.
    const [r] = await q<{ d: string }>('select app_today()::text d');
    return { date: r?.d ?? '', real_date: null, synthetic: null };
  }
}

/** The words in the banner on every page. */
export function businessDateNotice(b: BusinessDate): string {
  if (b.synthetic === true) return `Business date ${longDate(b.date)} (synthetic, for demo data; today is ${longDate(b.real_date ?? '')})`;
  if (b.synthetic === false) return `Today ${longDate(b.date)}`;
  return `Business date ${longDate(b.date)}`;
}

/**
 * The business "today" the synthetic dataset is anchored to. Every relative
 * statement in the demo ("overdue", "starts next week") is true as of this date.
 * The database exposes it through app_today() so the demo stays coherent even
 * when it is presented on a later calendar day.
 */
export const DEMO_DATE = '2026-09-29';

export const BUSINESS_TIMEZONE = 'Australia/Brisbane';

/** A sent PO is "awaiting supplier confirmation" once it is older than this. */
export const SUPPLIER_ACK_SLA_BUSINESS_DAYS = 2;

/** Version of the date normalisation rules; bump when a rule changes. */
export const DATE_RULES_VERSION = '1.0.0';

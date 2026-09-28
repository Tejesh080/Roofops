import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUNDLE_TABLES, DATE_COLUMNS, loadBundle, PRIMARY_KEY } from '../src/data/bundle.js';
import { parseCsv } from '../src/data/csv.js';
import { DEMO_DATE } from '../src/config/demo.js';
import { normaliseDates } from '../src/normalise/rules.js';
import { checkDateInvariants } from '../src/normalise/invariants.js';
import { buildScenarioManifest } from '../src/normalise/scenarios.js';

const raw = loadBundle('data/raw');
const committed = loadBundle('data/normalised');
const { bundle: fresh, changes } = normaliseDates(raw, DEMO_DATE);

describe('date normalisation (DEMO_DATE = 2026-09-29)', () => {
  it('the raw bundle really does violate the date invariants', () => {
    const v = checkDateInvariants(raw, DEMO_DATE);
    expect(v.length).toBeGreaterThan(50);
    // the Phase 0 headline problem is detected: active projects silently past their dates
    expect(v.some((x) => x.table === 'projects' && /delayed by dates without DELAYED_PROJECT/.test(x.message))).toBe(true);
    expect(v.some((x) => x.table === 'invoices' && /before quote accepted/.test(x.message))).toBe(true);
  });

  it('the normalised bundle satisfies every invariant', () => {
    expect(checkDateInvariants(fresh, DEMO_DATE)).toEqual([]);
    expect(checkDateInvariants(committed, DEMO_DATE)).toEqual([]);
  });

  it('is deterministic', () => {
    expect(normaliseDates(raw, DEMO_DATE)).toEqual({ bundle: fresh, changes });
  });

  it('committed data/normalised equals a fresh run (no hand edits, no drift)', () => {
    for (const t of BUNDLE_TABLES) expect(committed[t].rows, t).toEqual(fresh[t].rows);
    const log = parseCsv(readFileSync('data/normalised/date_changes.csv', 'utf8')).rows;
    expect(log.map((r) => [r.table, r.record_id, r.field, r.from, r.to, r.rule]))
      .toEqual(changes.map((c) => [c.table, c.recordId, c.field, c.from, c.to, c.rule]));
  });

  it('changes ONLY date columns: every other cell (IDs, names, amounts, statuses, tags) is byte-identical', () => {
    for (const t of BUNDLE_TABLES) {
      expect(fresh[t].headers, t).toEqual(raw[t].headers);
      expect(fresh[t].rows.length, t).toBe(raw[t].rows.length);
      const dateCols = new Set(DATE_COLUMNS[t]);
      raw[t].rows.forEach((r, i) => {
        const n = fresh[t].rows[i]!;
        for (const h of raw[t].headers) if (!dateCols.has(h)) expect(n[h], `${t}[${r[PRIMARY_KEY[t]]}].${h}`).toBe(r[h]);
      });
    }
  });

  it('every changed cell is in the change log, and every log entry is a real change', () => {
    const diffs: string[] = [];
    for (const t of BUNDLE_TABLES) {
      raw[t].rows.forEach((r, i) => {
        for (const h of DATE_COLUMNS[t]) {
          if (r[h] !== fresh[t].rows[i]![h]) diffs.push(`${t}|${r[PRIMARY_KEY[t]]}|${h}|${r[h]}|${fresh[t].rows[i]![h]}`);
        }
      });
    }
    expect(changes.map((c) => `${c.table}|${c.recordId}|${c.field}|${c.from}|${c.to}`).sort()).toEqual(diffs.sort());
    expect(changes.every((c) => c.reason.length > 10)).toBe(true);
  });

  it('never touches quotes, events, notes, documents, exceptions or the idempotency ledger', () => {
    const untouched = ['quotes', 'properties', 'suppliers', 'products', 'project_events', 'site_notes', 'documents', 'workflow_exceptions', 'processed_events'];
    expect(changes.filter((c) => untouched.includes(c.table))).toEqual([]);
  });

  it('leaves completed projects and already-consistent active projects alone', () => {
    const changedProjects = new Set(changes.filter((c) => c.table === 'projects').map((c) => c.recordId));
    for (const p of raw.projects.rows.filter((r) => r.project_status === 'Completed')) expect(changedProjects.has(p.project_id!)).toBe(false);
    expect(changedProjects.has('PRJ-2026-0024')).toBe(false); // In Progress 09-27..10-02: already true on the demo date
  });

  it('preserves every planted scenario marker', () => {
    expect(buildScenarioManifest(fresh)).toEqual(buildScenarioManifest(raw));
    expect(JSON.parse(readFileSync('data/normalised/scenario-manifest.json', 'utf8'))).toEqual(buildScenarioManifest(raw));
  });

  it('keeps the two overdue invoices overdue and makes no other invoice overdue', () => {
    const overdue = fresh.invoices.rows.filter((i) => i.invoice_status === 'Sent' && i.due_date! < DEMO_DATE).map((i) => i.invoice_id);
    expect(overdue.sort()).toEqual(['INV-2026-0025', 'INV-2026-0032']);
  });

  it('moves no payment onto or past the demo date', () => {
    expect(fresh.invoices.rows.filter((i) => i.paid_date && i.paid_date >= DEMO_DATE)).toEqual([]);
  });
});

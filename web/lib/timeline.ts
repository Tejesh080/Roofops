/**
 * Turns the raw automation + audit history of a project into a short, readable story:
 *  - audit rows that merely mirror an automation event are folded away;
 *  - a run of retries becomes one entry ("5 attempts over 29 seconds · stopped safely");
 *  - repeated deliveries become one "ignored safely" entry;
 *  - a staff retry absorbs the recovery steps that followed it.
 * Pure: no I/O, so it is unit-tested with the real history shapes.
 */
import type { TimelineEntry } from './queries.ts';
import { actorName, plainReason, timelineTitle } from './labels.ts';

export type TimelineTone = 'done' | 'retry' | 'attention' | 'recorded' | 'duplicate';

export interface TimelineGroup {
  id: string;
  whenIso: string;
  when: string;
  tone: TimelineTone;
  title: string;
  detail: string | null;
  lines: string[];
  entries: TimelineEntry[];
}

// audit action -> the automation event that already tells the same story
const MIRROR: Record<string, string> = {
  'quote.accept': 'quote.accepted', 'project.create': 'project.created', 'task.create': 'materials.review_requested',
  'drive.folder.link': 'drive.project_folder.verified', 'airtable.project.writeback': 'airtable.project_writeback.verified',
  'invoice.preview_prepared': 'invoice.preview_prepared', 'invoice.create': 'invoice.created',
  'xero.invoice.draft_created': 'xero.create_draft_invoice.verified', 'approval.approve': 'invoice.approved',
};
const RETRY = new Set(['automation.retry_scheduled', 'automation.failed']);
const SERVICE_OF: Record<string, string> = {
  'drive.project_folder.verified': 'Google Drive', 'airtable.project_writeback.verified': 'Airtable', 'xero.create_draft_invoice.verified': 'Xero',
};
const ms = (e: TimelineEntry) => Date.parse(`${e.occurred_iso}Z`);

function toneOf(e: TimelineEntry): TimelineTone {
  if (e.status === 'DUPLICATE_IGNORED') return 'duplicate';
  if (e.status === 'REJECTED' || e.status === 'FAILED') return 'attention';
  if (e.status === 'SUCCEEDED') return 'done';
  return e.kind === 'exception.retry_queued' ? 'retry' : 'recorded';
}

function single(e: TimelineEntry, project: string): TimelineGroup {
  const note = [actorName(e.actor, e.channel), e.reference && e.reference !== project ? e.reference : null, plainReason(e.reason)].filter(Boolean).join(' · ');
  return { id: `${e.occurred_iso}-${e.kind}-${e.source}`, whenIso: e.occurred_iso, when: e.occurred_at, tone: toneOf(e),
           title: timelineTitle(e.kind), detail: note || null, lines: [], entries: [e] };
}

export function groupTimeline(entriesNewestFirst: TimelineEntry[], project: string): TimelineGroup[] {
  const asc = [...entriesNewestFirst].sort((a, b) => ms(a) - ms(b) || (a.source === 'EVENT' ? -1 : 1));
  const events = asc.filter((e) => e.source === 'EVENT');
  const kept = asc.filter((e) => {
    const mirror = e.source === 'AUDIT' ? MIRROR[e.kind] : undefined;
    return !mirror || !events.some((v) => v.kind === mirror && Math.abs(ms(v) - ms(e)) <= 180_000);
  });

  const groups: TimelineGroup[] = [];
  for (let i = 0; i < kept.length; i++) {
    const e = kept[i]!;
    if (e.source === 'EVENT' && RETRY.has(e.kind)) {
      const run: TimelineEntry[] = [e];
      while (i + 1 < kept.length && kept[i + 1]!.source === 'EVENT' && RETRY.has(kept[i + 1]!.kind) && kept[i + 1]!.reference === e.reference) run.push(kept[++i]!);
      const last = run[run.length - 1]!;
      const stopped = run.some((r) => r.kind === 'automation.failed');
      const later = kept.slice(i + 1).find((x) => SERVICE_OF[x.kind]);
      const service = later ? SERVICE_OF[later.kind] : 'A connected service';
      const secs = Math.max(1, Math.round((ms(last) - ms(e)) / 1000));
      groups.push({ id: `${e.occurred_iso}-retries`, whenIso: e.occurred_iso, when: e.occurred_at, tone: stopped ? 'attention' : 'retry',
        title: `${service} temporarily unavailable`,
        detail: `${run.length} attempt${run.length > 1 ? 's' : ''} over ${secs} seconds`,
        lines: [stopped ? 'Automation stopped safely: nothing was created twice' : 'Retry in progress'], entries: run });
      continue;
    }
    if (e.kind === 'exception.retry_queued') {
      const run: TimelineEntry[] = [e];
      while (i + 1 < kept.length && ms(kept[i + 1]!) - ms(e) <= 180_000) run.push(kept[++i]!);
      const recovered = run.slice(1).filter((r) => r.status === 'SUCCEEDED').map((r) => timelineTitle(r.kind));
      const repeats = run.filter((r) => r.status === 'DUPLICATE_IGNORED').length;
      groups.push({ id: `${e.occurred_iso}-staff-retry`, whenIso: e.occurred_iso, when: e.occurred_at, tone: recovered.length ? 'done' : 'retry',
        title: 'Retried by staff', detail: plainReason(e.reason)?.split(';')[0] ?? null,
        lines: [...(recovered.length ? recovered : ['Waiting for the retry to finish']),
                ...(repeats ? [`Repeated request ignored safely${repeats > 1 ? ` ×${repeats}` : ''}: nothing was created twice`] : []),
                ...(recovered.length ? ['Completed successfully'] : [])], entries: run });
      continue;
    }
    if (e.status === 'DUPLICATE_IGNORED') {
      const run: TimelineEntry[] = [e];
      while (i + 1 < kept.length && kept[i + 1]!.status === 'DUPLICATE_IGNORED' && ms(kept[i + 1]!) - ms(e) <= 600_000) run.push(kept[++i]!);
      if (run.length > 1) {
        groups.push({ id: `${e.occurred_iso}-dups`, whenIso: e.occurred_iso, when: e.occurred_at, tone: 'duplicate',
          title: 'Repeated requests ignored safely', detail: `${run.length} repeats · nothing was done twice`,
          lines: [...new Set(run.map((r) => timelineTitle(r.kind)))], entries: run });
        continue;
      }
    }
    groups.push(single(e, project));
  }
  return groups.reverse();
}

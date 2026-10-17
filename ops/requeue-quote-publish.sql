-- Operator action: re-queue ONE stopped quote hand-off to Airtable (n8n 10) after its cause has been fixed (for example a
-- missing Airtable option), and say so in the audit log. Edit the two literals below, then:
--   npx tsx scripts/sql.ts -f ops/requeue-quote-publish.sql
-- Only the quote's LATEST hand-off is re-queued, and only if all of these hold (otherwise nothing changes and
-- refused_because says why): the quote is still SENT; that hand-off is stopped (FAILED, not retried); it carries the
-- quote's current version; and no other hand-off of the quote is open. A superseded (older) hand-off is never revived.
-- Attempts are not reset: n8n 10 reports with its attempt number and Postgres ignores any older one (a late worker).
-- n8n 10 picks it up on its next run; wf_claim_side_effect still guarantees a single worker, the look-up finds the
-- Airtable quote by RoofOps ID (an existing one is never rewritten), and completion still requires read-back proof
-- (which also resolves the exception).
with target as (
  select 'Q-2026-0066'::text as quote_number, 'EXC-0000'::text as exception_number
), q as (
  select q.id, q.status, (select max(v.version_number) from quote_versions v where v.quote_id = q.id) as version
    from quotes q, target t where q.quote_number = t.quote_number
), latest as (
  select o.* from outbox o, q
   where o.topic = 'airtable.quote_publish' and o.aggregate_id = q.id
   order by coalesce((o.payload -> 'quote_fields' ->> 'fldEjEqlzE8Y0M1nf')::int, 0) desc, o.created_at desc, o.id desc limit 1
), others_open as (
  select count(*)::int as n from outbox o, q, latest
   where o.topic = 'airtable.quote_publish' and o.aggregate_id = q.id and o.id <> latest.id
     and (o.status in ('PENDING', 'DISPATCHING') or (o.status = 'FAILED' and o.next_attempt_at <> 'infinity'))
), refusal as (
  select case
    when not exists (select 1 from q) then 'no such quote'
    when (select status from q) <> 'SENT' then 'the quote is ' || lower((select status from q)) || ', not sent: only a sent quote is published'
    when not exists (select 1 from latest) then 'the quote has no Airtable hand-off'
    when (select status from latest) <> 'FAILED' or (select next_attempt_at from latest) <> 'infinity' then
      'its latest hand-off is ' || (select status from latest) || ', not stopped: nothing to re-queue'
    when coalesce(((select payload from latest) -> 'quote_fields' ->> 'fldEjEqlzE8Y0M1nf')::int, 0) <> (select version from q) then
      'its latest hand-off is for version ' || coalesce((select payload from latest) -> 'quote_fields' ->> 'fldEjEqlzE8Y0M1nf', '?') || ', the quote is at version ' || (select version from q)
    when (select n from others_open) > 0 then 'another hand-off of the quote is open'
  end as reason
), o as (
  update outbox set status = 'PENDING', next_attempt_at = now(), last_error = null
   where id = (select id from latest) and (select reason from refusal) is null
     and status = 'FAILED' and next_attempt_at = 'infinity'
  returning aggregate_id, idempotency_key, attempts
), e as (
  update workflow_exceptions set resolution_status = 'RETRY_QUEUED', last_attempt_at = now()
   where exception_number = (select exception_number from target) and resolution_status = 'OPEN'
     and entity_id = (select aggregate_id from o)
  returning exception_number
), a as (
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
  select 'USER', 'operator', 'exception.retry_queued', 'quote', o.aggregate_id, (select quote_number from target),
         jsonb_build_object('outbox', 'FAILED (stopped)', 'exception', 'OPEN'),
         jsonb_build_object('outbox', 'PENDING', 'exception', 'RETRY_QUEUED'),
         'Cause fixed; re-queued ' || o.idempotency_key || ' after ' || o.attempts || ' attempts'
  from o
  returning seq
)
select (select count(*)::int from o) as requeued, (select count(*)::int from e) as exceptions_queued, (select count(*)::int from a) as audited,
       (select reason from refusal) as refused_because;

-- Operator action: re-queue ONE stopped quote hand-off to Airtable (n8n 10) after its cause has been fixed (for example a
-- missing Airtable option), and say so in the audit log. Edit the two literals below, then:
--   npx tsx scripts/sql.ts -f ops/requeue-quote-publish.sql
-- n8n 10 picks it up on its next run; wf_claim_side_effect still guarantees a single worker, the upserts find the same
-- Airtable rows by RoofOps ID, and completion still requires read-back proof (which also resolves the exception).
with target as (
  select 'Q-2026-0066'::text as quote_number, 'EXC-0000'::text as exception_number
), o as (
  update outbox set status = 'PENDING', next_attempt_at = now(), last_error = null
   where topic = 'airtable.quote_publish' and status = 'FAILED' and next_attempt_at = 'infinity'
     and aggregate_id = (select q.id from quotes q, target t where q.quote_number = t.quote_number)
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
select (select count(*)::int from o) as requeued, (select count(*)::int from e) as exceptions_queued, (select count(*)::int from a) as audited;

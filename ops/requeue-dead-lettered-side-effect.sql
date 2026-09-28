-- Operator action (Phase 2 stand-in for the Phase 3 exception-queue "Retry" button):
-- re-queue ONE dead-lettered side effect after its cause has been fixed, and say so in the audit log.
-- Edit the two literals below, then:  npx tsx scripts/sql.ts -f ops/requeue-dead-lettered-side-effect.sql
-- The next delivery of the quote's event (or a replayed ping) re-drives it; wf_claim_side_effect
-- still guarantees a single worker, and completion still requires read-back proof.
with target as (
  select 'PRJ-2026-0033'::text as project_number, 'EXC-0015'::text as exception_number
), o as (
  update outbox set status = 'PENDING', next_attempt_at = now(), last_error = null
   where status = 'FAILED' and next_attempt_at = 'infinity'
     and aggregate_id = (select p.id from projects p, target t where p.project_number = t.project_number)
  returning aggregate_id, idempotency_key, attempts
), e as (
  update workflow_exceptions set resolution_status = 'RETRY_QUEUED', last_attempt_at = now()
   where exception_number = (select exception_number from target) and resolution_status = 'OPEN'
     and exists (select 1 from o)
  returning exception_number
), a as (
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
  select 'USER', 'operator:phase2-test', 'exception.retry_queued', 'project', o.aggregate_id, (select project_number from target),
         jsonb_build_object('outbox', 'FAILED (dead-lettered)', 'exception', 'OPEN'),
         jsonb_build_object('outbox', 'PENDING', 'exception', 'RETRY_QUEUED'),
         'Cause fixed (Drive root restored); re-queued ' || o.idempotency_key || ' after ' || o.attempts || ' attempts'
  from o
  returning seq
)
select (select count(*) from o) as requeued, (select count(*) from e) as exceptions_queued, (select count(*) from a) as audited;

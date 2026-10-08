-- AC-14C hardening, audit P2-H1 (docs/defect-ledger.md): the VOIDED -> APPROVED guard accepted a merely PENDING reissue
-- approval, so privileged raw SQL carrying a fresh request plus the void evidence could put a voided final invoice back to
-- APPROVED with no replacement generation opened and the approval never consumed (test/xero-reissue.test.ts VAL-RIS-012
-- case (e) pinned that). The supported ops_reissue_decide transaction is now the only valid recovery path: the guard keeps
-- every existing check and adds the binding to the decide's own in-flight state; integrity flags any invoice brought back
-- on a reissue approval without the generation that approval queued. ops_reissue_decide itself is unchanged.

-- 1. create or replace function invoice_reissue_guard()
create or replace function invoice_reissue_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a approvals; v_bound text; v_link text; v_obs xero_invoice_observations; v_target int; v_bound_ok boolean;
begin
  select * into a from approvals where id = new.approval_id;
  -- First the evidence (unchanged): a matching reissue approval that is live, the void proof, no money moved, no live
  -- write of an older generation. Then (audit P2-H1) the binding: only the ops_reissue_decide transaction itself.
  if a.id is null or a.action_type <> 'REISSUE_INVOICE' or a.entity_type <> 'invoice' or a.entity_id <> new.id
     or not (a.status in ('APPROVED', 'EXECUTING') or (a.status = 'PENDING' and a.expires_at > now())) then
    raise exception 'invoice % cannot go back to APPROVED without a matching REISSUE_INVOICE approval attached (a supervised reissue decides that, not raw SQL; only ops_reissue_decide may make this transition)',
      new.invoice_number using errcode = 'check_violation';
  end if;
  v_bound := (select o.payload ->> 'xero_tenant_id' from outbox_current('xero.create_draft_invoice', new.id) o);
  v_link := (select l.external_id from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice'
               and l.entity_type = 'invoice' and l.entity_id = new.id);
  select * into v_obs from xero_invoice_observations x
   where x.invoice_id = new.id and x.xero_invoice_id is not distinct from v_link and x.verdict = 'VERIFIED'
   order by x.observed_at desc, x.id desc limit 1;
  if v_obs.id is null or v_obs.settlement not in ('VOIDED', 'DELETED') or v_obs.tenant_id is distinct from v_bound then
    raise exception 'invoice % cannot go back to APPROVED without a verified void or deletion of its linked Xero invoice % in the bound tenant % (the last verified read is %); raw SQL is not a recovery path',
      new.invoice_number, coalesce(v_link, '(none)'), coalesce(v_bound, '(none)'), coalesce(v_obs.settlement || ' in ' || v_obs.tenant_id, 'none')
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from payments where invoice_id = new.id)
     or exists (select 1 from xero_invoice_observations x where x.invoice_id = new.id and x.verdict = 'VERIFIED'
                  and (coalesce(x.amount_paid, 0) > 0 or coalesce(x.amount_credited, 0) > 0)) then
    raise exception 'invoice % cannot go back to APPROVED: money moved on it (a payment or a credit exists); a person must check the customer account',
      new.invoice_number using errcode = 'check_violation';
  end if;
  -- The reissue opens exactly one new generation in this transaction; that write is the guard's own target (the newest
  -- generation row). A live write of an older generation is still a refusal.
  v_target := (select max(g.generation) from invoice_xero_draft_generations g where g.invoice_id = new.id);
  if exists (select 1 from outbox o where o.topic = 'xero.create_draft_invoice' and o.aggregate_id = new.id
               and (o.status in ('PENDING', 'DISPATCHING') or (o.status = 'FAILED' and o.next_attempt_at <> 'infinity'))
               and o.generation is distinct from v_target) then
    raise exception 'invoice % cannot go back to APPROVED while an older generation''s Xero draft write is still live (target generation %); let it finish or fail first',
      new.invoice_number, coalesce(v_target::text, 'none') using errcode = 'check_violation';
  end if;
  -- P2-H1: a valid request (even a fresh PENDING one) is evidence, not the act. The act is ops_reissue_decide's own
  -- transaction, and only it leaves this exact state behind before its invoice update: the approval EXECUTING and its
  -- one-time consumption claim still PROCESSING, the previous generation SUPERSEDED, and the next generation's ledger
  -- row PENDING with its draft write PENDING, both bound to this approval. Anything else (raw SQL with a pending,
  -- approved, executed or forged approval) is refused, so the transition cannot happen without the replacement.
  v_bound_ok := a.status = 'EXECUTING' and v_target >= 2
    and exists (select 1 from processed_events pe where pe.consumer = 'invoice.reissue:' || a.approval_number
                   and pe.idempotency_key = a.approval_number and pe.status = 'PROCESSING')
    and exists (select 1 from invoice_xero_draft_generations g where g.invoice_id = new.id and g.generation = v_target
                   and g.approval_id = a.id and g.superseded_at is null and g.status = 'PENDING'
                   and g.outbox_idempotency_key = xero_draft_outbox_key(new.id, v_target))
    and exists (select 1 from invoice_xero_draft_generations g where g.invoice_id = new.id and g.generation = v_target - 1 and g.superseded_at is not null)
    and exists (select 1 from outbox o where o.topic = 'xero.create_draft_invoice' and o.aggregate_id = new.id and o.generation = v_target
                   and o.idempotency_key = xero_draft_outbox_key(new.id, v_target) and o.status = 'PENDING'
                   and o.payload ->> 'approval_number' = a.approval_number);
  if not coalesce(v_bound_ok, false) then
    raise exception 'invoice % cannot go back to APPROVED here: only ops_reissue_decide may make this transition (approval % is %, and generation % must be queued and bound to it in the same decision)',
      new.invoice_number, a.approval_number, a.status, coalesce((v_target + case when a.status = 'EXECUTING' then 0 else 1 end)::text, '2')
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- 2. create or replace function integrity_check()
create or replace function integrity_check()
returns table (entity text, check_key text, status text, failing int, detail text, refs text[])
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_refs text[];
begin
  return query select c.* from integrity_check_core() c where c.check_key not in ('done_has_proof', 'xero_link_only_when_synced');
  -- P2-H1: an invoice brought back from VOIDED on a reissue approval carries the generation that approval queued.
  select array_agg(i.invoice_number || ' (' || a.approval_number || ' ' || lower(a.status) || ')' order by i.invoice_number) into v_refs
    from invoices i join approvals a on a.id = i.approval_id and a.action_type = 'REISSUE_INVOICE'
   where i.status <> 'VOIDED'
     and not (a.status = 'EXECUTED'
              and exists (select 1 from invoice_xero_draft_generations g join outbox o on o.idempotency_key = g.outbox_idempotency_key
                           where g.invoice_id = i.id and g.approval_id = a.id and g.generation >= 2
                             and o.topic = 'xero.create_draft_invoice' and o.aggregate_id = i.id and o.generation = g.generation
                             and o.payload ->> 'approval_number' = a.approval_number));
  entity := 'invoice'; check_key := 'reissue_transition_bound';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'An invoice reissued from VOIDED is bound to an executed reissue approval and the generation it queued (only ops_reissue_decide reissues)'; return next;
  select array_agg(i.invoice_number order by i.invoice_number) into v_refs from invoices i
    left join outbox o on o.topic = 'xero.create_draft_invoice' and o.aggregate_id = i.id
   where i.status = 'VOIDED' and i.record_origin = 'ROOFOPS'
     and (i.sync_status in ('PENDING', 'UNKNOWN', 'SYNCED') or o.status in ('DISPATCHING', 'DONE')
          or exists (select 1 from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id))
     and not exists (select 1 from xero_invoice_observations x
                      where x.invoice_id = i.id and x.verdict = 'VERIFIED' and x.settlement in ('VOIDED', 'DELETED')
                        and x.tenant_id = o.payload ->> 'xero_tenant_id'
                        and x.xero_invoice_id = (select l.external_id from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id)
                        and not exists (select 1 from xero_invoice_observations y
                                         where y.invoice_id = x.invoice_id and y.verdict = 'VERIFIED' and y.xero_invoice_id = x.xero_invoice_id
                                           and y.settlement not in ('VOIDED', 'DELETED') and (y.observed_at, y.id) > (x.observed_at, x.id)));
  entity := 'invoice'; check_key := 'voided_invoice_has_no_xero_write';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'No Xero draft is created, pending, ambiguous or linked for a voided invoice, unless the exact linked Xero invoice was verified VOIDED or DELETED in the tenant its write is bound to'; return next;
  -- AC-09: once a final invoice exists, everything validly billed equals the entitlement (short = under-billed).
  select array_agg(x.project_number || ' (' || (x.b ->> 'remaining') || ' left)' order by x.project_number) into v_refs
    from (select p.project_number, project_billing(p.id) b from projects p
           where exists (select 1 from invoices i where i.project_id = p.id and i.invoice_type = 'FINAL' and i.status not in ('VOIDED', 'DRAFT', 'PENDING_APPROVAL'))) x
   where (x.b ->> 'remaining')::numeric > 0;
  entity := 'invoice'; check_key := 'final_invoice_settles_entitlement';
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'After the final invoice, quote + approved/invoiced variations - everything billed = 0 (left over means under-billed; a variation approved later needs its own invoice)'; return next;
  -- AC-13A: a CLOSED project is settled: nothing left to bill, nothing over-billed, everything paid, completion gate satisfied.
  select array_agg(p.project_number order by p.project_number) into v_refs from projects p
   where p.status = 'CLOSED' and ((project_billing(p.id) ->> 'remaining')::numeric <> 0
      or exists (select 1 from invoices i where i.project_id = p.id and not (invoice_financial_state(i.id, false) ->> 'settled')::boolean)
      or exists (select 1 from v_projects_missing_completion_docs v where v.id = p.id));
  entity := 'project'; check_key := 'closed_project_settled';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Closed projects have nothing left to bill, nothing over-billed, every invoice paid or voided, and their completion items done or waived'; return next;
  -- AC-13A: completed jobs held only by open completion items (staff set them in Airtable: Completion Photos / Compliance Certificate).
  select array_agg(x.project_number || ' (' || x.items || ')' order by x.project_number) into v_refs
    from (select v.project_number, string_agg(v.label, ', ' order by v.label) items from v_projects_missing_completion_docs v join projects p on p.id = v.id
           where p.status = 'COMPLETED' group by v.project_number) x;
  entity := 'project'; check_key := 'completed_awaiting_completion_items';
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Completed jobs whose completion items are still To do in Airtable (Completion Photos / Compliance Certificate); no final invoice until they are Done, Waived or Not applicable'; return next;
  -- AC-14: every Xero-linked invoice was last read successfully, and RoofOps shows the state Xero verified.
  select array_agg(i.invoice_number || ' (' || case when x.id is null then 'never read from Xero'
                                                   when x.verdict <> 'VERIFIED' then 'last Xero check: ' || lower(replace(x.verdict, '_', ' '))
                                                   else 'Xero ' || lower(replace(x.settlement, '_', ' ')) || ', RoofOps ' || lower(i.status) end || ')' order by i.invoice_number) into v_refs
    from invoices i join external_links l on l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id and l.verified_at is not null
    left join lateral (select * from xero_invoice_observations o where o.invoice_id = i.id and o.xero_invoice_id = l.external_id
                        order by o.observed_at desc, o.id desc limit 1) x on true
   where i.sync_status = 'SYNCED' and (x.id is null or x.verdict <> 'VERIFIED' or i.status is distinct from xero_settlement_status(x.settlement));
  entity := 'invoice'; check_key := 'xero_invoice_state_verified';
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Every Xero-linked invoice was last read from its own Xero tenant and RoofOps shows the state Xero verified (a repair run applies it)'; return next;
  -- AC-04, generation-aware (see above): the link must match the invoice's sync state, except that a superseded
  -- generation's document may stay linked while its replacement is queued - that link is history.
  select array_agg(i.invoice_number order by i.invoice_number) into v_refs
    from invoices i join external_links l on l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id
   where i.sync_status <> 'SYNCED'
     and not exists (select 1 from invoice_xero_draft_generations g
                      where g.invoice_id = i.id and g.superseded_at is not null and g.xero_invoice_id = l.external_id);
  entity := 'invoice'; check_key := 'xero_link_only_when_synced';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'No Xero link on an invoice RoofOps does not consider synced (the document of a superseded generation is history, not the current link)'; return next;
  -- done_has_proof, generation-aware (see above): the same rule for every topic, except that only the CURRENT draft
  -- write of an invoice must match its sync_status; an earlier DONE generation is history.
  select array_agg(o.topic || ':' || o.aggregate_id) into v_refs from outbox o
   where o.status = 'DONE' and not case o.topic
     when 'drive.ensure_project_folder' then exists (select 1 from external_links l where l.provider = 'GOOGLE_DRIVE' and l.entity_type = 'project'
                                                       and l.external_type = 'Folder' and l.entity_id = o.aggregate_id and l.verified_at is not null)
     when 'airtable.project_writeback' then exists (select 1 from external_links l where l.provider = 'AIRTABLE' and l.entity_type = 'project'
                                                      and l.external_type = 'Record' and l.entity_id = o.aggregate_id and l.verified_at is not null)
     when 'xero.create_draft_invoice' then o.id <> (select c.id from outbox_current('xero.create_draft_invoice', o.aggregate_id) c)
                                          or exists (select 1 from invoices i where i.id = o.aggregate_id and i.sync_status = 'SYNCED')
     else true end;
  entity := 'side_effect'; check_key := 'done_has_proof';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Every DONE side effect (Drive folder, Airtable write-back, Xero draft) has verified proof; for a Xero draft that means its CURRENT generation is the one that is DONE'; return next;
end $$;

revoke execute on all functions in schema public from public;
revoke execute on function invoice_reissue_guard() from roofops_workflow, roofops_dashboard;
grant execute on function integrity_check() to roofops_dashboard;

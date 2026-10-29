-- Rollback of 20261022010000_fully_billed_job_is_not_cancelled.sql (owner only; one transaction). It restores project_transition_guard and integrity_check exactly as
-- 20261022000000_pre_start_gate_before_work_starts.sql defined them, and removes the migration's record. No data changes.
-- Run: npx tsx scripts/sql.ts -f ops/rollback/20261022010000_fully_billed_job_is_not_cancelled.down.sql
begin;

-- restore project_transition_guard (20261022000000_pre_start_gate_before_work_starts.sql)
create or replace function project_transition_guard(p projects, p_to text)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_final text; v_over jsonb; v_bill jsonb; v_open text;
begin
  -- AC-08: an over-billed job is never closed; a person corrects the billing first (no credit-note model).
  if p_to = 'CLOSED' then
    v_over := project_over_billing(p.id);
    if v_over is not null then
      return format('%s cannot be closed: it is over-billed by %s (billed %s against %s: %s). Correct the billing first, for example void the unpaid duplicate invoice',
        p.project_number, v_over ->> 'excess', v_over ->> 'billed', v_over ->> 'entitled', v_over ->> 'invoices');
    end if;
  end if;
  if p_to = 'IN_PROGRESS' and p.status = 'SCHEDULED' and p.planned_start_date is null then
    return 'set a Planned Start before marking the job In Progress';
  end if;
  if p_to = 'IN_PROGRESS' and p.status = 'ON_HOLD' and p.actual_start_date is null then
    return 'this job never started; move it back to Scheduled instead of In Progress';
  end if;
  -- AC-13B: every required pre-start item Done, or Waived / Not applicable with a reason where allowed, before work starts.
  -- Keyed on the status, not on Actual Start, so a direct update of Actual Start cannot skip the gate; resuming an On Hold job
  -- that has started is not a start and is not checked again (its items were satisfied, and are locked, when work began).
  if p_to = 'IN_PROGRESS' and p.status = 'SCHEDULED' then
    select string_agg(label, ', ' order by sort_order) into v_open from project_checklist_items
     where project_id = p.id and stage = 'PRE_START' and is_required and status not in ('DONE', 'WAIVED', 'NOT_APPLICABLE');
    if v_open is not null then
      return format('pre-start items are still open (%s); set them in Airtable (SWMS Signed / Materials Reviewed) before the job starts', v_open);
    end if;
  end if;
  if p.status = 'COMPLETED' and p_to = 'CANCELLED' then
    select string_agg(invoice_number, ', ') into v_final from invoices where project_id = p.id and invoice_type = 'FINAL' and status <> 'VOIDED';
    if v_final is not null then
      return format('a final invoice (%s) already exists; void it first, then cancel', v_final);
    end if;
    if exists (select 1 from approvals where entity_id = p.id and action_type = 'CREATE_INVOICE' and status in ('EXECUTING', 'APPROVED')) then
      return 'a final invoice is being created in Xero right now; wait for it to finish';
    end if;
  end if;
  if p.status = 'COMPLETED' and p_to = 'CLOSED' then
    -- AC-14: settled only on verified state (Xero for a Xero-linked invoice; the import's payments for an imported one).
    select string_agg(i.invoice_number || ' (' || (f ->> 'reason') || ')', ', ' order by i.invoice_number) into v_final
      from invoices i cross join lateral (select invoice_financial_state(i.id) f) s
     where i.project_id = p.id and not (f ->> 'settled')::boolean;
    if v_final is not null then return format('not every invoice is paid yet: %s', v_final); end if;
    -- AC-13A: closed means settled: everything entitled is billed (AC-09 project_billing; over-billing is refused above).
    v_bill := project_billing(p.id);
    if (v_bill ->> 'remaining')::numeric > 0 then
      select string_agg(invoice_number, ', ') into v_final from invoices where project_id = p.id and invoice_type = 'FINAL' and status <> 'VOIDED';
      return case when v_final is null then format('%s left to bill: the final invoice has not been raised yet', v_bill ->> 'remaining')
                  else format('%s left to bill after final invoice %s (for example a variation approved later); invoice it before closing', v_bill ->> 'remaining', v_final) end;
    end if;
    select string_agg(label, ', ' order by label) into v_open from v_projects_missing_completion_docs v where v.id = p.id;
    if v_open is not null then
      return format('completion items are still open (%s); set them in Airtable (Completion Photos / Compliance Certificate) before closing', v_open);
    end if;
    if exists (select 1 from approvals where entity_id = p.id and action_type = 'CREATE_INVOICE' and status = 'PENDING') then
      return 'a final invoice preview is awaiting approval; approve or withdraw it first';
    end if;
    -- AC-04 semantics: never close while a Xero write is in flight or uncertain.
    select string_agg(invoice_number || ' (' || lower(sync_status) || ')', ', ' order by invoice_number) into v_final
      from invoices where project_id = p.id and sync_status in ('PENDING', 'UNKNOWN');
    if v_final is not null or exists (select 1 from approvals where entity_id = p.id and action_type = 'CREATE_INVOICE' and status in ('APPROVED', 'EXECUTING')) then
      return format('a Xero write is still in flight or uncertain%s; wait until Xero confirms it', coalesce(': ' || v_final, ''));
    end if;
  end if;
  return null;
end $$;

-- restore integrity_check (20261022000000_pre_start_gate_before_work_starts.sql)
create or replace function integrity_check()
returns table (entity text, check_key text, status text, failing int, detail text, refs text[])
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_refs text[]; v_mode text; v_override text;
begin
  return query select c.* from integrity_check_before_release_blockers() c where c.check_key <> 'done_has_proof';

  -- done_has_proof, now failing closed: a DONE side effect whose topic has no rule here is a FAIL, not a pass.
  select array_agg(o.topic || ':' || coalesce(o.payload ->> 'invoice_number', o.payload ->> 'quote_number', o.payload ->> 'project_number', o.aggregate_id::text))
    into v_refs from outbox o
   where o.status = 'DONE' and not case o.topic
     when 'drive.ensure_project_folder' then exists (select 1 from external_links l where l.provider = 'GOOGLE_DRIVE' and l.entity_type = 'project'
                                                       and l.external_type = 'Folder' and l.entity_id = o.aggregate_id and l.verified_at is not null)
     when 'airtable.project_writeback' then exists (select 1 from external_links l where l.provider = 'AIRTABLE' and l.entity_type = 'project'
                                                      and l.external_type = 'Record' and l.entity_id = o.aggregate_id and l.verified_at is not null)
     when 'xero.create_draft_invoice' then o.id <> (select c.id from outbox_current('xero.create_draft_invoice', o.aggregate_id) c)
                                          or exists (select 1 from invoices i where i.id = o.aggregate_id and i.sync_status = 'SYNCED')
     when 'airtable.quote_publish' then (select count(*) from external_links l
                                          where l.provider = 'AIRTABLE' and l.external_type = 'Record' and l.verified_at is not null
                                            and ((l.entity_type = 'quote' and l.entity_id = o.aggregate_id)
                                              or (l.entity_type = 'customer' and l.entity_id::text = o.payload ->> 'customer_id')
                                              or (l.entity_type = 'property' and l.entity_id::text = o.payload ->> 'property_id'))) = 3
     else false end;
  entity := 'side_effect'; check_key := 'done_has_proof';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Every DONE side effect has verified proof (Drive folder, Airtable project or quote/customer/property records, Xero draft for its current generation); a topic without a rule fails'; return next;

  -- A worker claimed it and never reported back (crashed or cut off): nothing else re-drives Drive/Airtable writes.
  select array_agg(o.topic || ':' || coalesce(o.payload ->> 'invoice_number', o.payload ->> 'quote_number', o.payload ->> 'project_number', o.aggregate_id::text) order by o.locked_until)
    into v_refs from outbox o where o.status = 'DISPATCHING' and o.locked_until < now() - interval '15 minutes';
  entity := 'side_effect'; check_key := 'claimed_and_abandoned';
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Side effects claimed by a worker whose lease ran out more than 15 minutes ago without a result; re-drive or investigate them'; return next;

  select upper(btrim(coalesce(value, 'REAL'))) into v_mode from app_settings where key = 'business_date_mode';
  v_mode := coalesce(v_mode, 'REAL');
  select btrim(coalesce(value, '')) into v_override from app_settings where key = 'business_date_override';
  entity := 'settings'; check_key := 'business_date';
  if v_mode = 'SYNTHETIC' then
    status := 'WARNING'; failing := 1; refs := array['synthetic ' || coalesce(v_override, '?'), 'real ' || app_date_at(now())::text];
    detail := 'The business date is SYNTHETIC: invoices, quotes, tasks and overdue rules use the configured demo date, not today';
  elsif coalesce(v_override, '') <> '' then
    status := 'WARNING'; failing := 1; refs := array['ignored override ' || v_override];
    detail := 'business_date_override is set but business_date_mode is REAL, so it is ignored; clear it to avoid confusion';
  else
    status := 'PASS'; failing := 0; refs := null;
    detail := 'The business date is the real date in Brisbane';
  end if;
  return next;

  -- AC-13B: a job that has started passed the pre-start gate.
  select array_agg(x.project_number || ' (' || x.items || ')' order by x.project_number) into v_refs
    from (select p.project_number, string_agg(ci.label, ', ' order by ci.sort_order) items from projects p join project_checklist_items ci on ci.project_id = p.id
           where (p.actual_start_date is not null or p.status in ('IN_PROGRESS', 'COMPLETED', 'CLOSED')) and ci.stage = 'PRE_START' and ci.is_required
             and ci.status not in ('DONE', 'WAIVED', 'NOT_APPLICABLE') group by p.project_number) x;
  entity := 'project'; check_key := 'started_with_pre_start_open';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'No started job has a required pre-start item (SWMS signed, materials reviewed) still open'; return next;
end $$;

delete from schema_migrations where version = '20261022010000_fully_billed_job_is_not_cancelled.sql';
commit;

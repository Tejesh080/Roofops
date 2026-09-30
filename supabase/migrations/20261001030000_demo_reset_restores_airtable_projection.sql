-- demo:reset follow-up (docs/defect-ledger.md, AC-03 §13): withdrawing the demo project's pending invoice preview left
-- its Airtable row on "Awaiting approval" (with the amount and the preview text) until someone cleared it by hand or a
-- full repair run came by. Reconciliation then reported the drift.
--
-- Rule: RoofOps puts that row back through its normal verified Airtable path. demo:reset asks n8n 07 for a repair run
-- scoped to one project's invoice projection (Invoice Status, Invoice Amount, Invoice Preview). The scoped run compares
-- only that row's three fields, writes blanks where Airtable still shows something, and 07 PATCHes, reads back and proves
-- the write like every reconciliation repair. It never touches other rows or fields, never replays staff edits, skips the
-- Drive and Xero checks, and runs only with the operator token, in repair mode, when the project has no preview in flight
-- and no invoice (their projection is not "blank").

alter table reconciliation_runs add column scope jsonb;
comment on column reconciliation_runs.scope is 'null: the whole base. {kind: invoice_projection_reset, project, record_id, project_id}: one row''s invoice fields';

-- The invoice projection a reset puts back: the fields 04 writes for a preview.
create or replace function invoice_projection_fields()
returns table (field_id text, airtable_name text) language sql stable set search_path = public, pg_temp as $$
  select airtable_field_id, airtable_name from field_contract
   where entity = 'project' and field_key in ('invoice_status', 'invoice_amount', 'invoice_preview') order by airtable_name
$$;

alter function wf_reconcile_start(text, text, text) rename to wf_reconcile_start_core;
create or replace function wf_reconcile_start(p_trigger text, p_mode text default 'repair', p_token text default null, p_scope jsonb default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_res jsonb; p projects; v_rec text;
begin
  if p_scope is null or jsonb_typeof(p_scope) = 'null' then
    return wf_reconcile_start_core(p_trigger, p_mode, p_token);
  end if;
  if p_scope ->> 'kind' is distinct from 'invoice_projection_reset' then
    return jsonb_build_object('started', false, 'reason', 'unknown reconciliation scope');
  end if;
  if p_trigger <> 'manual' or p_mode <> 'repair' then
    return jsonb_build_object('started', false, 'reason', 'a scoped run is a manual repair run (operator token)');
  end if;
  select * into p from projects where project_number = p_scope ->> 'project';
  select external_id into v_rec from external_links
   where provider = 'AIRTABLE' and entity_type = 'project' and external_type = 'Record' and entity_id = p.id order by verified_at desc nulls last limit 1;
  if p.id is null or v_rec is null then
    return jsonb_build_object('started', false, 'reason', coalesce(p_scope ->> 'project', 'no project') || ' has no linked Airtable row');
  end if;
  if exists (select 1 from approvals where entity_id = p.id and action_type = 'CREATE_INVOICE' and status = 'PENDING')
     or exists (select 1 from invoices where project_id = p.id and invoice_type = 'FINAL' and status <> 'VOIDED') then
    return jsonb_build_object('started', false, 'reason', p.project_number || ' has a preview in flight or an invoice: its Airtable invoice projection is not blank');
  end if;
  v_res := wf_reconcile_start_core(p_trigger, p_mode, p_token);   -- operator token, quota guard, the run row
  if not coalesce((v_res ->> 'started')::boolean, false) then return v_res; end if;
  update reconciliation_runs set scope = jsonb_build_object('kind', 'invoice_projection_reset', 'project', p.project_number, 'project_id', p.id, 'record_id', v_rec)
   where run_key = v_res ->> 'run_key';
  return v_res || jsonb_build_object('tables', jsonb_build_array('tblvUPIoebC3zoacv'),
                                     'scope', jsonb_build_object('kind', 'invoice_projection_reset', 'project', p.project_number));
end $$;

-- A scoped run compares one row's invoice projection with blank, and nothing else.
create or replace function reconcile_invoice_projection_reset(p_run reconciliation_runs, p_table_id text, p_records jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_rec text := p_run.scope ->> 'record_id'; v_fields jsonb; v_corr jsonb := '{}'; f record; v_n int := 0;
begin
  if p_table_id <> 'tblvUPIoebC3zoacv' then
    return jsonb_build_object('ok', true, 'table_id', p_table_id, 'records', 0, 'fields_checked', 0, 'drift', 0, 'corrections', '[]'::jsonb);
  end if;
  select y -> 'fields' into v_fields from jsonb_array_elements(coalesce(p_records, '[]'::jsonb)) y where y ->> 'id' = v_rec limit 1;
  if v_fields is null then
    return jsonb_build_object('ok', false, 'table_id', p_table_id, 'reason', 'the scoped row ' || v_rec || ' was not in the read');
  end if;
  -- Re-checked under the run: a preview prepared since the run started keeps its projection.
  if exists (select 1 from approvals where entity_id = (p_run.scope ->> 'project_id')::uuid and action_type = 'CREATE_INVOICE' and status = 'PENDING')
     or exists (select 1 from invoices where project_id = (p_run.scope ->> 'project_id')::uuid and invoice_type = 'FINAL' and status <> 'VOIDED') then
    return jsonb_build_object('ok', true, 'table_id', p_table_id, 'records', 1, 'fields_checked', 0, 'drift', 0, 'corrections', '[]'::jsonb,
                              'note', 'a preview or invoice appeared: nothing reset');
  end if;
  for f in select * from invoice_projection_fields() loop
    if coalesce(at_norm(v_fields -> f.field_id), '') <> '' then
      v_n := v_n + 1;
      v_corr := v_corr || jsonb_build_object(f.field_id, null);
      insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, field, expected, actual, classification, action, detail)
      values (p_run.id, 'AIRTABLE', 'project', p_run.scope ->> 'project', v_rec, f.airtable_name, null, left(at_norm(v_fields -> f.field_id), 500),
              'SAFE_AUTO_REPAIR', 'REPAIRED_AIRTABLE', 'demo:reset: the withdrawn invoice preview is removed from Airtable (no preview in flight, no invoice)');
    end if;
  end loop;
  if v_n > 0 then
    perform airtable_record_writes('reconcile:' || p_run.run_key, p_table_id, v_rec, v_corr, v_fields, 'reconcile:' || p_run.run_key);
  end if;
  return jsonb_build_object('ok', true, 'table_id', p_table_id, 'records', 1, 'fields_checked', 3, 'drift', v_n,
    'corrections', case when v_n > 0 then jsonb_build_array(jsonb_build_object('id', v_rec, 'fields', v_corr)) else '[]'::jsonb end);
end $$;

create or replace function wf_reconcile_airtable(p_run_key text, p_table_id text, p_records jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_run reconciliation_runs; v_res jsonb; c jsonb;
begin
  select * into v_run from reconciliation_runs where run_key = p_run_key;
  if v_run.scope is not null then
    if v_run.status <> 'RUNNING' then return jsonb_build_object('ok', false, 'table_id', p_table_id, 'reason', 'run ' || p_run_key || ' is not running'); end if;
    return reconcile_invoice_projection_reset(v_run, p_table_id, p_records);
  end if;
  -- AC-10: record the repairs this run hands to n8n 07, like every other RoofOps write.
  v_res := wf_reconcile_airtable_core(p_run_key, p_table_id, p_records);
  for c in select * from jsonb_array_elements(coalesce(v_res -> 'corrections', '[]'::jsonb)) loop
    perform airtable_record_writes('reconcile:' || p_run_key, p_table_id, c ->> 'id', c -> 'fields',
      (select y -> 'fields' from jsonb_array_elements(p_records) y where y ->> 'id' = c ->> 'id' limit 1), 'reconcile:' || p_run_key);
  end loop;
  return v_res;
end $$;

-- A scoped run checks no Drive folders and no Xero invoices.
alter function wf_reconcile_targets(text) rename to wf_reconcile_targets_core;
create or replace function wf_reconcile_targets(p_run_key text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from reconciliation_runs where run_key = p_run_key and scope is not null) then
    return jsonb_build_object('drive', '[]'::jsonb, 'xero', '[]'::jsonb);
  end if;
  return wf_reconcile_targets_core(p_run_key);
end $$;

revoke execute on all functions in schema public from public;
revoke execute on function wf_reconcile_start_core(text, text, text), wf_reconcile_targets_core(text),
  reconcile_invoice_projection_reset(reconciliation_runs, text, jsonb), invoice_projection_fields() from roofops_workflow, roofops_dashboard;
grant execute on function wf_reconcile_start(text, text, text, jsonb), wf_reconcile_airtable(text, text, jsonb), wf_reconcile_targets(text) to roofops_workflow;

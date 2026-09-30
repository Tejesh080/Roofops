-- AC-02 (docs/defect-ledger.md): a change to an Airtable FIELD was replayed as a staff edit on every RECORD.
--  1. The Airtable API leaves blank cells, and field ids that no longer exist, out of `fields`. The reconciler read an
--     absent key as "staff blanked it", so one deleted or recreated field blanked that field on every record.
--  2. A date field switched to "include time" returns UTC instants ('2026-10-04T14:00:00.000Z' for Brisbane 5 Oct).
--     '…T14:00:00.000Z'::date is the previous day, and the correction written back fed the next night's shift, so dates
--     moved back a day per run. The webhook path (06) and the read-back proof had the same conversion.
--
-- Rules:
--  * A date is a Brisbane business day. Every Airtable value for a date field is normalised to that day before it is
--    compared, applied, recorded or accepted as proof (reconciler, webhook handler, read-back).
--  * A field id absent from EVERY record of a read, while RoofOps holds a value for it, says nothing about staff: the
--    field was deleted, renamed or recreated. It is not compared, observed, replayed or written; a person is asked once.
--    (A blank cell on some records, with the field present on others, is still a missed staff edit.)
--  * The same staff-editable field differing on at least 5 records and 20% of a read is a change to the field (format,
--    time zone, bulk import), not individual edits: nothing is replayed for it; the drift stays visible; a person is
--    asked once. Missed edits after an outage still arrive through the webhook drain, which carries real payloads.
--    Only records unchanged since the run started count (the AC-01 rule), so a legitimate bulk edit that the webhook
--    applied after the read is never mistaken for a field-level change.

alter table field_contract add column value_type text not null default 'text' check (value_type in ('text', 'date'));
update field_contract set value_type = 'date'
 where field_key in ('planned_start_date', 'planned_completion_date', 'actual_start_date', 'actual_completion_date',
                     'expected_delivery_date', 'po_date', 'created_on', 'sent_on', 'accepted_on', 'customer_since');

-- An Airtable date or date-time value as the Brisbane business day it denotes. Anything else is returned unchanged.
create or replace function at_business_date(p_value jsonb)
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare s text;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'string' then return p_value; end if;
  s := p_value #>> '{}';
  if s ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$' then
    return to_jsonb(((s::timestamptz) at time zone 'Australia/Brisbane')::date::text);
  elsif s ~ '^\d{4}-\d{2}-\d{2}T' then
    return to_jsonb(left(s, 10));   -- a local date-time without a zone: its date part is the day
  end if;
  return p_value;
exception when others then
  return p_value;                    -- not a date after all: compared as given, never guessed
end $$;

-- Airtable cells (field id → value) with every date field normalised to its business day. Absent keys stay absent.
create or replace function at_normalize_fields(p_fields jsonb)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select case when p_fields is null or jsonb_typeof(p_fields) <> 'object' then p_fields else
    coalesce((select jsonb_object_agg(k, case when exists (select 1 from field_contract c where c.airtable_field_id = k and c.value_type = 'date')
                                              then at_business_date(v) else v end)
              from jsonb_each(p_fields) as t(k, v)), '{}'::jsonb) end
$$;

-- Webhook path: normalise the event, then the unchanged handler (renamed; n8n keeps calling wf_airtable_change).
alter function wf_airtable_change(jsonb, text) rename to wf_airtable_change_core;
create or replace function wf_airtable_change(p_event jsonb, p_worker text default 'n8n')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_changes jsonb := p_event -> 'changes'; v_event jsonb := p_event;
begin
  if jsonb_typeof(v_changes) = 'object' then
    v_event := jsonb_set(v_event, '{changes}', coalesce((
      select jsonb_object_agg(k, case when jsonb_typeof(v) = 'object' and exists (select 1 from field_contract c where c.airtable_field_id = k and c.value_type = 'date')
                                      then v || jsonb_strip_nulls(jsonb_build_object('current', at_business_date(v -> 'current'), 'previous', at_business_date(v -> 'previous')))
                                      else v end)
        from jsonb_each(v_changes) as t(k, v)), '{}'::jsonb));
  end if;
  if jsonb_typeof(p_event -> 'current') = 'object' then
    v_event := jsonb_set(v_event, '{current}', at_normalize_fields(p_event -> 'current'));
  end if;
  return wf_airtable_change_core(v_event, p_worker);
end $$;

-- Read-back proof: compare what Airtable stored by business day as well.
alter function wf_airtable_writeback_verified(text, text, text, jsonb) rename to wf_airtable_writeback_verified_core;
create or replace function wf_airtable_writeback_verified(p_event_key text, p_table_id text, p_record_id text, p_readback jsonb)
returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select wf_airtable_writeback_verified_core(p_event_key, p_table_id, p_record_id, at_normalize_fields(p_readback))
$$;

-- Reconciliation: the AC-01 function (20260930000000) with the input normalised and the two field-level guards added.
create or replace function wf_reconcile_airtable(p_run_key text, p_table_id text, p_records jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run reconciliation_runs; r record; e record; c field_contract; a jsonb; v_res jsonb; v_corr jsonb := '{}'::jsonb;
  v_checked int := 0; v_drift int := 0; v_records int := 0; v_ev jsonb; v_exc text; v_entity text;
  v_changed_at timestamptz; v_deferred int := 0; v_exp jsonb;
  v_read int; v_absent text[] := '{}'; v_mass text[] := '{}'; v_n int; v_table_name text;
begin
  select * into v_run from reconciliation_runs where run_key = p_run_key and status = 'RUNNING';
  if v_run.id is null then return jsonb_build_object('ok', false, 'reason', 'no running reconciliation ' || coalesce(p_run_key, '')); end if;
  select min(entity) into v_entity from field_contract where airtable_table_id = p_table_id;
  v_table_name := case v_entity when 'property' then 'Properties' when 'purchase_order' then 'Purchase Orders' else initcap(v_entity) || 's' end;

  -- Every date the read contains, as the business day it denotes.
  p_records := coalesce((select jsonb_agg(case when jsonb_typeof(x -> 'fields') = 'object' then jsonb_set(x, '{fields}', at_normalize_fields(x -> 'fields')) else x end)
                           from jsonb_array_elements(p_records) x), '[]'::jsonb);
  select count(*) into v_read from v_airtable_expected x join jsonb_array_elements(p_records) y on y ->> 'id' = x.record_id where x.table_id = p_table_id;

  -- Field-level guard 1: a field id missing from every record of the read, while RoofOps holds a value for it.
  if v_read > 0 then
    select coalesce(array_agg(fc.airtable_field_id), '{}') into v_absent from field_contract fc
     where fc.airtable_table_id = p_table_id and fc.reconcile in ('APPLY_VIA_HANDLER', 'REPAIR_AIRTABLE', 'PROJECTION')
       and not exists (select 1 from jsonb_array_elements(p_records) y where (y -> 'fields') ? fc.airtable_field_id)
       and exists (select 1 from v_airtable_expected x join jsonb_array_elements(p_records) y on y ->> 'id' = x.record_id
                    where x.table_id = p_table_id and at_norm(at_repair_value(x.expected -> fc.airtable_field_id)) is not null);
  end if;
  for c in select * from field_contract where airtable_field_id = any (v_absent) order by airtable_name loop
    v_exc := case when v_run.mode = 'repair' then wf_open_sync_exception('reconciliation', v_entity, null, 'Airtable ' || v_table_name || '.' || c.airtable_name,
      'SCHEMA_MISMATCH', format('Airtable %s field "%s" (%s) is missing from every record read. It was deleted, renamed or recreated in Airtable; RoofOps did not compare, change or write it. Restore the field (same id), or update the RoofOps field contract.',
                                v_table_name, c.airtable_name, c.airtable_field_id)) end;
    insert into reconciliation_findings (run_id, system, entity_type, field, classification, action, detail)
    values (v_run.id, 'AIRTABLE', v_entity, c.airtable_name, 'REQUIRES_HUMAN', case when v_exc is null then 'NONE_OBSERVE_ONLY' else 'EXCEPTION_OPENED' end,
            coalesce(v_exc || ': ', '') || 'field missing from every record read (not treated as staff edits)');
  end loop;

  -- Field-level guard 2: the same staff-editable field differs on many records at once. Only records unchanged since
  -- the run started count (the AC-01 rule): a legitimate bulk edit applied by the webhook after this read is not drift.
  for c in select * from field_contract where airtable_table_id = p_table_id and owner = 'AIRTABLE_EDIT' and not (airtable_field_id = any (v_absent)) loop
    select count(*) into v_n from v_airtable_expected x join jsonb_array_elements(p_records) y on y ->> 'id' = x.record_id
     where x.table_id = p_table_id and x.expected ? c.airtable_field_id and not at_matches(x.expected -> c.airtable_field_id, y -> 'fields' -> c.airtable_field_id)
       and not exists (select 1 from projects t where t.id = x.entity_id and t.updated_at > v_run.started_at)
       and not exists (select 1 from quotes t where t.id = x.entity_id and t.updated_at > v_run.started_at)
       and not exists (select 1 from purchase_orders t where t.id = x.entity_id and t.updated_at > v_run.started_at);
    if v_n >= 5 and v_n * 5 >= v_read then
      v_mass := v_mass || c.airtable_field_id;
      v_exc := case when v_run.mode = 'repair' then wf_open_sync_exception('reconciliation', v_entity, null, 'Airtable ' || v_table_name || '.' || c.airtable_name,
        'RECONCILIATION_MISMATCH', format('%s of %s Airtable %s records show a different "%s" in one read. That looks like a change to the field (format, time zone, bulk import), not individual staff edits, so RoofOps replayed none of them. Check the field in Airtable; genuine changes can be re-made record by record.',
                                          v_n, v_read, v_table_name, c.airtable_name)) end;
      insert into reconciliation_findings (run_id, system, entity_type, field, classification, action, detail)
      values (v_run.id, 'AIRTABLE', v_entity, c.airtable_name, 'REQUIRES_HUMAN', case when v_exc is null then 'NONE_OBSERVE_ONLY' else 'EXCEPTION_OPENED' end,
              format('%s%s of %s records differ in one read (not replayed)', coalesce(v_exc || ': ', ''), v_n, v_read));
    end if;
  end loop;

  -- Airtable records RoofOps does not know (created in Airtable) → a person decides.
  for r in select x ->> 'id' as rec from jsonb_array_elements(p_records) x
            where not exists (select 1 from external_links l where l.provider = 'AIRTABLE' and l.external_type = 'Record' and l.external_id = x ->> 'id')
  loop
    v_exc := case when v_run.mode = 'repair' then wf_open_sync_exception('reconciliation', v_entity, null, r.rec, 'RECONCILIATION_MISMATCH',
      format('Airtable %s record %s exists only in Airtable; RoofOps does not create records from Airtable. Delete it or recreate it through the supported flow.', v_entity, r.rec)) end;
    insert into reconciliation_findings (run_id, system, entity_type, external_id, classification, action, detail)
    values (v_run.id, 'AIRTABLE', v_entity, r.rec, 'UNKNOWN', case when v_exc is null then 'NONE_OBSERVE_ONLY' else 'EXCEPTION_OPENED' end, v_exc);
  end loop;

  -- Canonical records whose Airtable twin is gone.
  for e in select x.* from v_airtable_expected x where x.table_id = p_table_id
            and not exists (select 1 from jsonb_array_elements(p_records) y where y ->> 'id' = x.record_id)
  loop
    v_exc := case when v_run.mode = 'repair' then wf_open_sync_exception('reconciliation', e.entity_type, e.entity_id, e.business_key, 'EXTERNAL_MISSING',
      format('%s has no Airtable record any more (%s was deleted or moved). Staff cannot see it in Airtable.', e.business_key, e.record_id)) end;
    insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, classification, action, detail)
    values (v_run.id, 'AIRTABLE', e.entity_type, e.business_key, e.record_id, 'EXTERNAL_MISSING', case when v_exc is null then 'NONE_OBSERVE_ONLY' else 'EXCEPTION_OPENED' end, v_exc);
  end loop;

  for e in select x.*, y -> 'fields' as fields from v_airtable_expected x
             join jsonb_array_elements(p_records) y on y ->> 'id' = x.record_id where x.table_id = p_table_id
  loop
    v_records := v_records + 1;

    -- Is this read still evidence? Lock the canonical row, then check it has not changed since the run started (AC-01).
    v_changed_at := null;
    case e.entity_type
      when 'project' then select updated_at into v_changed_at from projects where id = e.entity_id for update;
      when 'quote' then select updated_at into v_changed_at from quotes where id = e.entity_id for update;
      when 'purchase_order' then select updated_at into v_changed_at from purchase_orders where id = e.entity_id for update;
      when 'customer' then select updated_at into v_changed_at from customers where id = e.entity_id for update;
      when 'property' then select updated_at into v_changed_at from properties where id = e.entity_id for update;
      when 'supplier' then select updated_at into v_changed_at from suppliers where id = e.entity_id for update;
      else null;
    end case;
    select x.expected into v_exp from v_airtable_expected x where x.table_id = p_table_id and x.record_id = e.record_id;
    if v_changed_at > v_run.started_at then
      for c in select * from field_contract where airtable_table_id = p_table_id and airtable_field_id in (select jsonb_object_keys(v_exp))
                   and not (airtable_field_id = any (v_absent))
                   and reconcile in ('APPLY_VIA_HANDLER', 'REPAIR_AIRTABLE', 'PROJECTION') order by (field_key = 'status') desc
      loop
        v_checked := v_checked + 1;
        a := e.fields -> c.airtable_field_id;
        if at_matches(v_exp -> c.airtable_field_id, a) then continue; end if;
        v_deferred := v_deferred + 1;
        insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, field, expected, actual, classification, action, detail)
        values (v_run.id, 'AIRTABLE', e.entity_type, e.business_key, e.record_id, c.airtable_name, at_norm(v_exp -> c.airtable_field_id), at_norm(a),
                'STALE_EVENT', 'NONE', 'RoofOps changed this record after the run read Airtable; the read is out of date and is re-checked next run');
      end loop;
      continue;
    end if;

    -- Record what Airtable showed (a field missing from the whole read was not observed).
    insert into airtable_observations (table_id, record_id, field_id, value, observed_at, source)
    select p_table_id, e.record_id, k.key, at_norm(e.fields -> k.key), now(), 'reconciliation' from jsonb_each(v_exp) k
     where not (k.key = any (v_absent))
    on conflict (table_id, record_id, field_id) do update set value = excluded.value, observed_at = excluded.observed_at, source = excluded.source;

    for c in select * from field_contract where airtable_table_id = p_table_id and airtable_field_id in (select jsonb_object_keys(v_exp))
                 and not (airtable_field_id = any (v_absent))
                 and reconcile in ('APPLY_VIA_HANDLER', 'REPAIR_AIRTABLE', 'PROJECTION') order by (field_key = 'status') desc
    loop
      v_checked := v_checked + 1;
      a := e.fields -> c.airtable_field_id;
      if at_matches(v_exp -> c.airtable_field_id, a) then continue; end if;
      v_drift := v_drift + 1;
      if c.airtable_field_id = any (v_mass) then continue; end if;   -- reported once for the field, above
      if c.owner = 'AIRTABLE_EDIT' then
        if e.entity_type = 'quote' and c.field_key = 'status' and at_norm(a) = 'Accepted' then
          v_exc := case when v_run.mode = 'repair' then wf_open_sync_exception('reconciliation', 'quote', e.entity_id, e.business_key, 'RECONCILIATION_MISMATCH',
            format('%s is Accepted in Airtable but RoofOps never received the acceptance. Set Status back to Sent, then to Accepted, to run the Quote → Project workflow.', e.business_key)) end;
          insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, field, expected, actual, classification, action, detail)
          values (v_run.id, 'AIRTABLE', 'quote', e.business_key, e.record_id, c.airtable_name, at_norm(v_exp -> c.airtable_field_id), at_norm(a),
                  'REQUIRES_HUMAN', case when v_exc is null then 'NONE_OBSERVE_ONLY' else 'EXCEPTION_OPENED' end, v_exc);
          continue;
        end if;
        if v_run.mode = 'observe' then
          insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, field, expected, actual, classification, action, detail)
          values (v_run.id, 'AIRTABLE', e.entity_type, e.business_key, e.record_id, c.airtable_name, at_norm(v_exp -> c.airtable_field_id), at_norm(a),
                  'SAFE_AUTO_REPAIR', 'NONE_OBSERVE_ONLY', 'Missed Airtable edit; a repair run replays it through the same validation');
          continue;
        end if;
        v_ev := jsonb_build_object('event_id', 'reconcile:' || p_run_key || ':' || e.record_id || ':' || c.airtable_field_id, 'source', 'reconciler',
                  'actor_id', 'reconciliation', 'occurred_at', v_run.started_at, 'table_id', p_table_id, 'record_id', e.record_id,
                  'changes', jsonb_build_object(c.airtable_field_id, jsonb_build_object('current', a)), 'current', e.fields);
        v_res := wf_airtable_change(v_ev, 'reconciler');
        v_corr := v_corr || jsonb_build_object(e.record_id, coalesce(v_corr -> e.record_id, '{}'::jsonb) || coalesce(v_res -> 'corrections', '{}'::jsonb));
        insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, field, expected, actual, classification, action, detail)
        values (v_run.id, 'AIRTABLE', e.entity_type, e.business_key, e.record_id, c.airtable_name, at_norm(v_exp -> c.airtable_field_id), at_norm(a),
                'SAFE_AUTO_REPAIR', case when jsonb_array_length(coalesce(v_res -> 'applied', '[]')) > 0 then 'APPLIED_TO_POSTGRES' else 'REJECTED_AND_REPAIRED' end,
                coalesce(v_res ->> 'note', v_res ->> 'outcome'));
      else
        insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, field, expected, actual, classification, action, detail)
        values (v_run.id, 'AIRTABLE', e.entity_type, e.business_key, e.record_id, c.airtable_name, at_norm(at_repair_value(v_exp -> c.airtable_field_id)), at_norm(a),
                case when c.reconcile = 'PROJECTION' or at_norm(a) is null then 'SAFE_AUTO_REPAIR' else 'UNAUTHORIZED_STATE' end,
                case when v_run.mode = 'repair' then 'REPAIRED_AIRTABLE' else 'NONE_OBSERVE_ONLY' end,
                case when c.reconcile = 'PROJECTION' then 'Airtable projection of canonical invoice state was stale'
                     when at_norm(a) is null then 'RoofOps value was never written to Airtable (missing projection)'
                     else c.airtable_name || ' is managed by RoofOps; edited in Airtable' end);
        if v_run.mode = 'repair' then
          v_corr := v_corr || jsonb_build_object(e.record_id, coalesce(v_corr -> e.record_id, '{}'::jsonb)
                     || jsonb_build_object(c.airtable_field_id, at_repair_value(v_exp -> c.airtable_field_id))
                     || coalesce((select jsonb_build_object(s.airtable_field_id, to_char(now() at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI')
                                   || E'\n↺ ' || c.airtable_name || case when c.reconcile = 'PROJECTION' or at_norm(a) is null then ' refreshed from RoofOps.' else ' is managed by RoofOps; reverted by reconciliation.' end)
                                  from field_contract s where s.airtable_table_id = p_table_id and s.field_key = 'roofops_sync'), '{}'::jsonb));
        end if;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('ok', true, 'table_id', p_table_id, 'records', v_records, 'fields_checked', v_checked, 'drift', v_drift,
    'rechecked_next_run', v_deferred,
    'suspect_fields', (select coalesce(jsonb_agg(airtable_name order by airtable_name), '[]'::jsonb) from field_contract where airtable_field_id = any (v_absent || v_mass)),
    'corrections', (select coalesce(jsonb_agg(jsonb_build_object('id', k, 'fields', v)), '[]'::jsonb) from jsonb_each(v_corr) as t(k, v) where v <> '{}'::jsonb));
end $$;

-- n8n calls only the entry points; the renamed internals are not callable from outside.
revoke execute on all functions in schema public from public;
revoke execute on function wf_airtable_change_core(jsonb, text), wf_airtable_writeback_verified_core(text, text, text, jsonb) from roofops_workflow;
grant execute on function wf_airtable_change(jsonb, text), wf_airtable_writeback_verified(text, text, text, jsonb), wf_reconcile_airtable(text, text, jsonb)
  to roofops_workflow;

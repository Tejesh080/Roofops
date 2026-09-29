-- Found by the first live reconciliation: Q-2026-0041/0044/0048 were accepted through the Phase 2 workflow, which sets
-- quotes.accepted_on but never wrote "Accepted On" to Airtable. A blank Airtable cell that RoofOps never filled is a
-- missing projection (SAFE_AUTO_REPAIR), not an edit made in Airtable (UNAUTHORIZED_STATE). Same repair; honest label.

create or replace function wf_reconcile_airtable(p_run_key text, p_table_id text, p_records jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run reconciliation_runs; r record; e record; c field_contract; a jsonb; v_res jsonb; v_corr jsonb := '{}'::jsonb;
  v_checked int := 0; v_drift int := 0; v_records int := 0; v_ev jsonb; v_exc text; v_entity text;
begin
  select * into v_run from reconciliation_runs where run_key = p_run_key and status = 'RUNNING';
  if v_run.id is null then return jsonb_build_object('ok', false, 'reason', 'no running reconciliation ' || coalesce(p_run_key, '')); end if;
  select min(entity) into v_entity from field_contract where airtable_table_id = p_table_id;

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
    -- Record what Airtable showed (drives drift display and the Copilot's sync warnings).
    insert into airtable_observations (table_id, record_id, field_id, value, observed_at, source)
    select p_table_id, e.record_id, k.key, at_norm(e.fields -> k.key), now(), 'reconciliation' from jsonb_each(e.expected) k
    on conflict (table_id, record_id, field_id) do update set value = excluded.value, observed_at = excluded.observed_at, source = excluded.source;

    for c in select * from field_contract where airtable_table_id = p_table_id and airtable_field_id in (select jsonb_object_keys(e.expected))
                 and reconcile in ('APPLY_VIA_HANDLER', 'REPAIR_AIRTABLE', 'PROJECTION') order by (field_key = 'status') desc
    loop
      v_checked := v_checked + 1;
      a := e.fields -> c.airtable_field_id;
      if at_matches(e.expected -> c.airtable_field_id, a) then continue; end if;
      v_drift := v_drift + 1;
      if c.owner = 'AIRTABLE_EDIT' then
        if e.entity_type = 'quote' and c.field_key = 'status' and at_norm(a) = 'Accepted' then
          -- A missed acceptance cannot be replayed without the Drive + Airtable side effects: a person re-triggers it.
          v_exc := case when v_run.mode = 'repair' then wf_open_sync_exception('reconciliation', 'quote', e.entity_id, e.business_key, 'RECONCILIATION_MISMATCH',
            format('%s is Accepted in Airtable but RoofOps never received the acceptance. Set Status back to Sent, then to Accepted, to run the Quote → Project workflow.', e.business_key)) end;
          insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, field, expected, actual, classification, action, detail)
          values (v_run.id, 'AIRTABLE', 'quote', e.business_key, e.record_id, c.airtable_name, at_norm(e.expected -> c.airtable_field_id), at_norm(a),
                  'REQUIRES_HUMAN', case when v_exc is null then 'NONE_OBSERVE_ONLY' else 'EXCEPTION_OPENED' end, v_exc);
          continue;
        end if;
        if v_run.mode = 'observe' then
          insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, field, expected, actual, classification, action, detail)
          values (v_run.id, 'AIRTABLE', e.entity_type, e.business_key, e.record_id, c.airtable_name, at_norm(e.expected -> c.airtable_field_id), at_norm(a),
                  'SAFE_AUTO_REPAIR', 'NONE_OBSERVE_ONLY', 'Missed Airtable edit; a repair run replays it through the same validation');
          continue;
        end if;
        -- A missed human edit: replay it through the exact same validation as the webhook path.
        v_ev := jsonb_build_object('event_id', 'reconcile:' || p_run_key || ':' || e.record_id || ':' || c.airtable_field_id, 'source', 'reconciler',
                  'actor_id', 'reconciliation', 'occurred_at', now(), 'table_id', p_table_id, 'record_id', e.record_id,
                  'changes', jsonb_build_object(c.airtable_field_id, jsonb_build_object('current', a)), 'current', e.fields);
        v_res := wf_airtable_change(v_ev, 'reconciler');
        v_corr := v_corr || jsonb_build_object(e.record_id, coalesce(v_corr -> e.record_id, '{}'::jsonb) || coalesce(v_res -> 'corrections', '{}'::jsonb));
        insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, field, expected, actual, classification, action, detail)
        values (v_run.id, 'AIRTABLE', e.entity_type, e.business_key, e.record_id, c.airtable_name, at_norm(e.expected -> c.airtable_field_id), at_norm(a),
                'SAFE_AUTO_REPAIR', case when jsonb_array_length(coalesce(v_res -> 'applied', '[]')) > 0 then 'APPLIED_TO_POSTGRES' else 'REJECTED_AND_REPAIRED' end,
                coalesce(v_res ->> 'note', v_res ->> 'outcome'));
      else
        insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, field, expected, actual, classification, action, detail)
        values (v_run.id, 'AIRTABLE', e.entity_type, e.business_key, e.record_id, c.airtable_name, at_norm(at_repair_value(e.expected -> c.airtable_field_id)), at_norm(a),
                case when c.reconcile = 'PROJECTION' or at_norm(a) is null then 'SAFE_AUTO_REPAIR' else 'UNAUTHORIZED_STATE' end,
                case when v_run.mode = 'repair' then 'REPAIRED_AIRTABLE' else 'NONE_OBSERVE_ONLY' end,
                case when c.reconcile = 'PROJECTION' then 'Airtable projection of canonical invoice state was stale'
                     when at_norm(a) is null then 'RoofOps value was never written to Airtable (missing projection)'
                     else c.airtable_name || ' is managed by RoofOps; edited in Airtable' end);
        if v_run.mode = 'repair' then
          v_corr := v_corr || jsonb_build_object(e.record_id, coalesce(v_corr -> e.record_id, '{}'::jsonb)
                     || jsonb_build_object(c.airtable_field_id, at_repair_value(e.expected -> c.airtable_field_id))
                     || coalesce((select jsonb_build_object(s.airtable_field_id, to_char(now() at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI')
                                   || E'\n↺ ' || c.airtable_name || case when c.reconcile = 'PROJECTION' or at_norm(a) is null then ' refreshed from RoofOps.' else ' is managed by RoofOps; reverted by reconciliation.' end)
                                  from field_contract s where s.airtable_table_id = p_table_id and s.field_key = 'roofops_sync'), '{}'::jsonb));
        end if;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('ok', true, 'table_id', p_table_id, 'records', v_records, 'fields_checked', v_checked, 'drift', v_drift,
    'corrections', (select coalesce(jsonb_agg(jsonb_build_object('id', k, 'fields', v)), '[]'::jsonb) from jsonb_each(v_corr) as t(k, v) where v <> '{}'::jsonb));
end $$;

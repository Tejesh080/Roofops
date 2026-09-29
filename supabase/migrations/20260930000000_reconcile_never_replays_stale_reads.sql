-- AC-01 (docs/defect-ledger.md): a reconciliation run replayed an Airtable read that was older than the canonical row.
-- n8n 07 starts the run, reads every Airtable table, then calls wf_reconcile_airtable. A staff edit that n8n 06 applied
-- between the read and that call looked like drift; its replay (source 'reconciler', which skips the webhook path's
-- stale and compare-and-set checks) put the old value back, wrote no Airtable correction (Airtable already showed the
-- read value), and recorded the old read as what Airtable shows, so v_state_drift reported nothing.
--
-- Rule: an Airtable read is evidence only for a record whose canonical row has not changed since the run started (07
-- always starts the run before it reads). Such a record is not compared this run: the finding is STALE_EVENT and the
-- next run re-checks it. The row is locked before the check, so no webhook edit can commit between check and replay,
-- and the comparison uses canonical state re-read after the lock (a concurrent edit may commit while the lock waits).
-- A replay is dated by the run start (the earliest the read can have happened), not by now(), so a later staff edit
-- whose webhook arrives after the replay is not judged older than it and dropped as STALE.

create or replace function wf_reconcile_airtable(p_run_key text, p_table_id text, p_records jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run reconciliation_runs; r record; e record; c field_contract; a jsonb; v_res jsonb; v_corr jsonb := '{}'::jsonb;
  v_checked int := 0; v_drift int := 0; v_records int := 0; v_ev jsonb; v_exc text; v_entity text;
  v_changed_at timestamptz; v_deferred int := 0; v_exp jsonb;
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

    -- Is this read still evidence? Lock the canonical row, then check it has not changed since the run started.
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
    -- Compare against canonical as it is now that the row is locked (the loop's own rows were read before any wait).
    select x.expected into v_exp from v_airtable_expected x where x.table_id = p_table_id and x.record_id = e.record_id;
    if v_changed_at > v_run.started_at then
      -- Changed in RoofOps after (possibly while) Airtable was read: the read may be older than canonical. Neither
      -- replay it nor record it as what Airtable shows; the next run compares a fresh read.
      for c in select * from field_contract where airtable_table_id = p_table_id and airtable_field_id in (select jsonb_object_keys(v_exp))
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

    -- Record what Airtable showed (drives drift display and the Copilot's sync warnings).
    insert into airtable_observations (table_id, record_id, field_id, value, observed_at, source)
    select p_table_id, e.record_id, k.key, at_norm(e.fields -> k.key), now(), 'reconciliation' from jsonb_each(v_exp) k
    on conflict (table_id, record_id, field_id) do update set value = excluded.value, observed_at = excluded.observed_at, source = excluded.source;

    for c in select * from field_contract where airtable_table_id = p_table_id and airtable_field_id in (select jsonb_object_keys(v_exp))
                 and reconcile in ('APPLY_VIA_HANDLER', 'REPAIR_AIRTABLE', 'PROJECTION') order by (field_key = 'status') desc
    loop
      v_checked := v_checked + 1;
      a := e.fields -> c.airtable_field_id;
      if at_matches(v_exp -> c.airtable_field_id, a) then continue; end if;
      v_drift := v_drift + 1;
      if c.owner = 'AIRTABLE_EDIT' then
        if e.entity_type = 'quote' and c.field_key = 'status' and at_norm(a) = 'Accepted' then
          -- A missed acceptance cannot be replayed without the Drive + Airtable side effects: a person re-triggers it.
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
        -- A missed human edit: replay it through the exact same validation as the webhook path, dated by the run start.
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
    'corrections', (select coalesce(jsonb_agg(jsonb_build_object('id', k, 'fields', v)), '[]'::jsonb) from jsonb_each(v_corr) as t(k, v) where v <> '{}'::jsonb));
end $$;

-- A record re-checked next run is not drift that was found.
create or replace view v_consistency as
with run as (select * from reconciliation_runs where status = 'COMPLETED' order by finished_at desc limit 1),
f as (select f.* from reconciliation_findings f join run on run.id = f.run_id)
select 'AIRTABLE'::text as system,
       coalesce((select sum((t ->> 'records')::int) from run, jsonb_array_elements(coalesce(run.summary -> 'airtable' -> 'tables', '[]'::jsonb)) t), 0)::int as checked,
       (select count(distinct external_id) from f where system = 'AIRTABLE' and classification <> 'STALE_EVENT')::int as drift_found,
       (select count(distinct external_id) from f where system = 'AIRTABLE' and action in ('APPLIED_TO_POSTGRES','REJECTED_AND_REPAIRED','REPAIRED_AIRTABLE'))::int as repaired,
       (select count(*) from f where system = 'AIRTABLE' and classification in ('REQUIRES_HUMAN','EXTERNAL_MISSING','UNKNOWN'))::int as needs_person,
       (select count(distinct record_id) from v_state_drift)::int as drift_now,
       (select count(*) from external_links where provider = 'AIRTABLE' and external_type = 'Record')::int as linked,
       (select finished_at from run) as checked_at
union all
select 'GOOGLE_DRIVE', coalesce((select (summary -> 'drive' ->> 'checked')::int from run), 0),
       coalesce((select (summary -> 'drive' ->> 'drift')::int from run), 0), 0,
       (select count(*) from f where system = 'DRIVE')::int, null,
       (select count(*) from external_links where provider = 'GOOGLE_DRIVE' and entity_type = 'project' and external_type = 'Folder' and verified_at is not null)::int,
       (select finished_at from run)
union all
select 'XERO', coalesce((select (summary -> 'xero' ->> 'checked')::int from run), 0),
       coalesce((select (summary -> 'xero' ->> 'drift')::int from run), 0), 0,
       (select count(*) from f where system = 'XERO')::int, null,
       (select count(*) from external_links where provider = 'XERO' and external_type = 'Invoice' and verified_at is not null)::int,
       (select finished_at from run);

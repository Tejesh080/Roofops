-- Phase 6 follow-up (after 1200 reached hosted): Airtable-quota economy and retry safety for Airtable edits.
--  * A plain accepted edit needs no Airtable write-back; the RoofOps Sync note is written only when something is
--    corrected, refused or reverted (the Free plan allows 1,000 API calls a month).
--  * No-op echoes of our own writes and deferred acceptances are logged as INFO, not SUCCEEDED.
--  * If the first delivery's Airtable write-back never got verified (n8n failed after Postgres committed), a redelivery
--    re-issues the corrections, recomputed from canonical state as it is now; once verified they are never re-sent.

create or replace function wf_airtable_change(p_event jsonb, p_worker text default 'n8n')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_key text := p_event ->> 'event_id'; v_table text := p_event ->> 'table_id'; v_rec text := p_event ->> 'record_id';
  v_src text := coalesce(nullif(p_event ->> 'source', ''), 'airtable'); v_actor text := coalesce(nullif(p_event ->> 'actor_id', ''), 'unknown');
  v_changes jsonb := coalesce(p_event -> 'changes', '{}'::jsonb); v_current jsonb := coalesce(p_event -> 'current', '{}'::jsonb);
  v_at timestamptz; v_entity text; v_id uuid; v_ref text; v_evid uuid; v_claimed boolean; v_pe processed_events;
  f record; v_new text; v_prev text; v_canon text; v_reason text; v_exp jsonb; v_exp_after jsonb; v_status_applied boolean := false;
  v_applied jsonb := '[]'; v_rejected jsonb := '[]'; v_reverted jsonb := '[]'; v_stale jsonb := '[]'; v_deferred jsonb := '[]';
  v_corr jsonb := '{}'::jsonb; v_note text := ''; v_res jsonb; v_outcome text; v_exc text; v_sync_field text;
begin
  -- 1. Validate the envelope.
  if coalesce(v_key, '') = '' or length(v_key) > 300 or coalesce(v_table, '') !~ '^tbl[A-Za-z0-9]{14}$' or coalesce(v_rec, '') !~ '^rec[A-Za-z0-9]{14}$'
     or jsonb_typeof(v_changes) <> 'object' then
    return jsonb_build_object('outcome', 'INVALID_EVENT', 'message', 'event_id, table_id, record_id and changes are required');
  end if;
  begin v_at := coalesce((p_event ->> 'occurred_at')::timestamptz, now());
  exception when others then return jsonb_build_object('outcome', 'INVALID_EVENT', 'message', 'occurred_at must be an ISO timestamp'); end;
  select min(entity) into v_entity from field_contract where airtable_table_id = v_table;
  if v_entity is null then return jsonb_build_object('outcome', 'INVALID_EVENT', 'message', 'table is not managed by RoofOps'); end if;
  select airtable_field_id into v_sync_field from field_contract where airtable_table_id = v_table and field_key = 'roofops_sync';

  -- 2. Transport idempotency: the same Airtable transaction is processed once, whatever the delivery count.
  v_evid := wf_log_event(v_key, stable_uuid('correlation', v_key), null, 'airtable.record_changed', v_entity, null, null,
                         case when v_src = 'reconciler' then 'SYSTEM' else 'USER' end, v_actor, v_src, 'RECEIVED', null,
                         jsonb_build_object('record_id', v_rec, 'table_id', v_table, 'worker', p_worker), p_event);
  insert into processed_events (consumer, idempotency_key, first_event_id, request_hash, status, locked_by, lease_expires_at)
  values ('airtable_change@1', v_key, v_evid, md5(p_event::text), 'PROCESSING', p_worker, now() + interval '5 minutes')
  on conflict do nothing returning true into v_claimed;
  if v_claimed is null then
    select * into v_pe from processed_events where consumer = 'airtable_change@1' and idempotency_key = v_key for update;
    update processed_events set delivery_count = delivery_count + 1, last_seen_at = now() where consumer = v_pe.consumer and idempotency_key = v_key;
    -- Corrections already written and read back are not written again. Unverified ones (the first delivery failed
    -- before its Airtable write-back) are re-issued, recomputed from canonical state as it is NOW.
    if coalesce((v_pe.result ->> 'writeback_verified')::boolean, false) or coalesce(v_pe.result -> 'corrections', '{}'::jsonb) = '{}'::jsonb then
      v_corr := '{}'::jsonb;
    else
      select coalesce(jsonb_object_agg(k, coalesce(at_repair_value(x.expected -> k), v_pe.result -> 'corrections' -> k)), '{}'::jsonb) into v_corr
        from jsonb_object_keys(v_pe.result -> 'corrections') k
        left join v_airtable_expected x on x.table_id = v_table and x.record_id = v_rec;
    end if;
    return coalesce(v_pe.result, '{}'::jsonb) || jsonb_build_object('duplicate', true, 'delivery_count', v_pe.delivery_count + 1, 'corrections', v_corr);
  end if;

  -- 3. Identity: the record link recorded by RoofOps (never names).
  select entity_id into v_id from external_links where provider = 'AIRTABLE' and entity_type = v_entity and external_type = 'Record' and external_id = v_rec;
  if v_id is null then
    v_exc := wf_open_sync_exception('airtable_sync', v_entity, null, v_rec, 'NOT_FOUND',
               format('Airtable %s record %s is not linked to any RoofOps record (created directly in Airtable?). RoofOps ignored its changes.', v_entity, v_rec));
    v_res := jsonb_build_object('outcome', 'UNKNOWN_RECORD', 'record_id', v_rec, 'exception_number', v_exc, 'corrections', '{}'::jsonb);
    update automation_events set status = 'REJECTED', error_class = 'NOT_FOUND', metadata = metadata || jsonb_build_object('reason', 'unknown record') where event_id = v_evid;
    update processed_events set status = 'COMPLETED', completed_at = now(), result = v_res, lease_expires_at = null where consumer = 'airtable_change@1' and idempotency_key = v_key;
    return v_res;
  end if;

  -- 4. One writer per record: everything below is evaluated against the row as it is *after* any concurrent change commits.
  case v_entity
    when 'project' then select project_number into v_ref from projects where id = v_id for update;
    when 'quote' then select quote_number into v_ref from quotes where id = v_id for update;
    when 'purchase_order' then select po_number into v_ref from purchase_orders where id = v_id for update;
    when 'customer' then select customer_number into v_ref from customers where id = v_id for update;
    when 'property' then select property_number into v_ref from properties where id = v_id for update;
    when 'supplier' then select supplier_code into v_ref from suppliers where id = v_id for update;
  end case;
  select expected into v_exp from v_airtable_expected where table_id = v_table and entity_id = v_id;
  v_current := v_current || (select coalesce(jsonb_object_agg(k, v -> 'current'), '{}'::jsonb) from jsonb_each(v_changes) as x(k, v));

  -- 5. Each changed field, by its owner.
  for f in select c.*, ch.key as fid, ch.value as chv from jsonb_each(v_changes) ch
             join field_contract c on c.airtable_table_id = v_table and c.airtable_field_id = ch.key
            where c.reconcile in ('APPLY_VIA_HANDLER', 'REPAIR_AIRTABLE') order by (c.field_key = 'status') desc, c.field_key
  loop
    v_new := at_norm(f.chv -> 'current');
    v_canon := at_norm(v_exp -> f.fid);
    if v_new is not distinct from v_canon then continue; end if;          -- no change, or our own write echoing back
    if f.owner <> 'AIRTABLE_EDIT' then
      v_reverted := v_reverted || jsonb_build_object('field', f.airtable_name, 'attempted', v_new, 'kept', v_canon);
      insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
      values ('SYSTEM', 'airtable_sync', 'airtable.edit_reverted', v_entity, v_id, v_ref, jsonb_build_object(f.field_key, v_new),
              jsonb_build_object(f.field_key, v_canon), f.airtable_name || ' is managed by RoofOps [' || v_key || ']');
      continue;
    end if;
    -- Delayed / out-of-order delivery: a newer change to this field was already applied.
    if v_src = 'airtable' and exists (select 1 from external_field_versions x where x.entity_type = v_entity and x.entity_id = v_id
                                        and x.field_key = f.field_key and x.last_source_at > v_at) then
      v_stale := v_stale || jsonb_build_object('field', f.airtable_name, 'value', v_new);
      continue;
    end if;
    -- Compare-and-set: the edit was made against a value RoofOps no longer holds (concurrent change) → refuse, do not guess.
    if v_src = 'airtable' and coalesce((f.chv ->> 'has_previous')::boolean, f.chv ? 'previous')
       and at_norm(f.chv -> 'previous') is distinct from v_canon then
      v_rejected := v_rejected || jsonb_build_object('field', f.airtable_name, 'attempted', v_new, 'kept', v_canon,
        'reason', format('it was changed from "%s", but RoofOps already had "%s" (someone else changed it at the same time); please re-apply if still intended',
                         coalesce(at_norm(f.chv -> 'previous'), 'blank'), coalesce(v_canon, 'blank')), 'conflict', true);
      continue;
    end if;
    v_reason := case v_entity
      when 'project' then project_apply_change(v_id, f.field_key, v_new, v_current, v_actor, v_key)
      when 'purchase_order' then po_apply_change(v_id, f.field_key, v_new, v_current, v_actor, v_key)
      when 'quote' then quote_apply_change(v_id, f.field_key, v_new, v_current, v_actor, v_key)
      else 'this field cannot be changed from Airtable' end;
    if v_reason is null then
      v_applied := v_applied || jsonb_build_object('field', f.airtable_name, 'from', v_canon, 'to', v_new);
      if f.field_key = 'status' then v_status_applied := true; end if;
      insert into external_field_versions (entity_type, entity_id, field_key, last_source, last_source_at, last_event_key, last_value)
      values (v_entity, v_id, f.field_key, v_src, v_at, v_key, v_new)
      on conflict (entity_type, entity_id, field_key) do update set last_source = excluded.last_source,
        last_source_at = greatest(external_field_versions.last_source_at, excluded.last_source_at), last_event_key = excluded.last_event_key,
        last_value = excluded.last_value, applied_at = now();
    elsif v_reason = 'DEFERRED' then
      v_deferred := v_deferred || jsonb_build_object('field', f.airtable_name, 'to', v_new, 'handled_by', 'Quote Accepted → Project workflow');
    else
      v_rejected := v_rejected || jsonb_build_object('field', f.airtable_name, 'attempted', v_new, 'kept', v_canon, 'reason', v_reason);
    end if;
  end loop;

  -- 6. Corrections: every checked field Airtable now shows differently from canonical (except deferred acceptance).
  select expected into v_exp_after from v_airtable_expected where table_id = v_table and entity_id = v_id;
  select coalesce(jsonb_object_agg(e.key, at_repair_value(e.value)), '{}'::jsonb) into v_corr
    from jsonb_each(v_exp_after) e
    join field_contract c on c.airtable_table_id = v_table and c.airtable_field_id = e.key and c.reconcile in ('APPLY_VIA_HANDLER', 'REPAIR_AIRTABLE')
   where (v_changes ? e.key or (v_status_applied and c.field_key in ('actual_start_date', 'actual_completion_date', 'sent_on')))
     and not at_matches(e.value, v_current -> e.key)
     and not exists (select 1 from jsonb_array_elements(v_deferred || v_stale) d where d ->> 'field' = c.airtable_name);

  v_note := concat_ws(E'\n',
    (select string_agg(format('✓ %s: %s → %s applied', a ->> 'field', coalesce(a ->> 'from', 'blank'), coalesce(a ->> 'to', 'blank')), E'\n') from jsonb_array_elements(v_applied) a),
    (select string_agg(format('✗ %s: "%s" not applied: %s. Kept "%s".', r ->> 'field', coalesce(r ->> 'attempted', 'blank'), r ->> 'reason', coalesce(r ->> 'kept', 'blank')), E'\n') from jsonb_array_elements(v_rejected) r),
    (select string_agg(format('↺ %s is managed by RoofOps; "%s" was reverted to "%s".', r ->> 'field', coalesce(r ->> 'attempted', 'blank'), coalesce(r ->> 'kept', 'blank')), E'\n') from jsonb_array_elements(v_reverted) r),
    (select string_agg(format('• %s: an older change arrived late and was ignored.', s ->> 'field'), E'\n') from jsonb_array_elements(v_stale) s));
  -- Airtable API calls are scarce (Free plan): a plain accepted edit needs no write-back; a refusal, a revert or a derived
  -- field does, and then the note says why.
  if v_note <> '' and v_sync_field is not null and (v_corr <> '{}'::jsonb or jsonb_array_length(v_rejected) + jsonb_array_length(v_reverted) > 0) then
    v_corr := v_corr || jsonb_build_object(v_sync_field, to_char(now() at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI') || E'\n' || v_note);
  end if;

  v_outcome := case when jsonb_array_length(v_applied) > 0 and jsonb_array_length(v_rejected) + jsonb_array_length(v_reverted) = 0 then 'APPLIED'
                    when jsonb_array_length(v_applied) > 0 then 'PARTIALLY_APPLIED'
                    when jsonb_array_length(v_rejected) > 0 then 'REJECTED'
                    when jsonb_array_length(v_reverted) > 0 then 'REVERTED'
                    when jsonb_array_length(v_stale) > 0 then 'STALE'
                    when jsonb_array_length(v_deferred) > 0 then 'DEFERRED'
                    else 'NO_CHANGE' end;
  v_res := jsonb_build_object('outcome', v_outcome, 'entity', v_entity, 'business_key', v_ref, 'entity_id', v_id, 'record_id', v_rec, 'table_id', v_table,
                              'applied', v_applied, 'rejected', v_rejected, 'reverted', v_reverted, 'stale', v_stale, 'deferred', v_deferred,
                              'corrections', v_corr, 'note', nullif(v_note, ''));
  update automation_events set entity_id = v_id, business_reference = v_ref,
         status = case when v_outcome in ('REJECTED', 'REVERTED') then 'REJECTED' when v_outcome = 'STALE' then 'DUPLICATE_IGNORED'
                       when v_outcome in ('NO_CHANGE', 'DEFERRED') then 'INFO' else 'SUCCEEDED' end,
         error_class = case when v_outcome = 'REJECTED' then 'ILLEGAL_TRANSITION' when v_outcome = 'REVERTED' then 'UNAUTHORIZED_EDIT'
                            when v_outcome = 'STALE' then 'STALE_EVENT' end,
         metadata = metadata || jsonb_build_object('outcome', v_outcome, 'reason', nullif(v_note, ''))
   where event_id = v_evid;
  update processed_events set status = 'COMPLETED', completed_at = now(), result = v_res, lease_expires_at = null
   where consumer = 'airtable_change@1' and idempotency_key = v_key;
  -- What RoofOps now believes Airtable shows (after the corrections n8n is about to write).
  insert into airtable_observations (table_id, record_id, field_id, value, observed_at, source)
  select v_table, v_rec, k, at_norm(coalesce(v_corr -> k, v_current -> k)), now(), v_src
    from jsonb_object_keys(v_current) k where exists (select 1 from field_contract c where c.airtable_field_id = k and c.reconcile <> 'IGNORE'
                                                        and not exists (select 1 from jsonb_array_elements(v_stale) st where st ->> 'field' = c.airtable_name))
  on conflict (table_id, record_id, field_id) do update set value = excluded.value, observed_at = excluded.observed_at, source = excluded.source;
  return v_res;
end $$;

create or replace function wf_airtable_writeback_verified(p_event_key text, p_table_id text, p_record_id text, p_readback jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_exp jsonb; v_bad jsonb;
begin
  select expected into v_exp from v_airtable_expected where table_id = p_table_id and record_id = p_record_id;
  select coalesce(jsonb_agg(e.key), '[]'::jsonb) into v_bad from jsonb_each(coalesce(v_exp, '{}'::jsonb)) e
   join field_contract c on c.airtable_field_id = e.key and c.reconcile in ('APPLY_VIA_HANDLER', 'REPAIR_AIRTABLE')
   where p_readback ? e.key and not at_matches(e.value, p_readback -> e.key);
  perform wf_log_event(p_event_key || ':writeback', stable_uuid('correlation', p_event_key), stable_uuid('event', p_event_key), 'airtable.writeback.verified',
                       null, null, p_record_id, 'INTEGRATION', 'airtable', 'airtable', case when jsonb_array_length(v_bad) = 0 then 'SUCCEEDED' else 'FAILED' end,
                       case when jsonb_array_length(v_bad) = 0 then null else 'RECONCILIATION_MISMATCH' end, jsonb_build_object('mismatched_fields', v_bad), null);
  if jsonb_array_length(v_bad) = 0 then
    update processed_events set result = result || '{"writeback_verified": true}'::jsonb
     where consumer = 'airtable_change@1' and idempotency_key = p_event_key and status = 'COMPLETED';
  end if;
  insert into airtable_observations (table_id, record_id, field_id, value, observed_at, source)
  select p_table_id, p_record_id, k, at_norm(p_readback -> k), now(), 'readback' from jsonb_object_keys(p_readback) k
   where exists (select 1 from field_contract c where c.airtable_field_id = k and c.reconcile <> 'IGNORE')
  on conflict (table_id, record_id, field_id) do update set value = excluded.value, observed_at = excluded.observed_at, source = excluded.source;
  return jsonb_build_object('verified', jsonb_array_length(v_bad) = 0, 'mismatched_fields', v_bad);
end $$;

-- AC-10 (docs/defect-ledger.md): n8n 06 applied RoofOps's own Airtable write back as a staff edit and ping-ponged.
-- 06 runs wf_airtable_change for every item of a batch, then writes each item's corrections. A correction computed for
-- an earlier item (for instance re-issued after a failed read-back) can be written after a later item in the same batch
-- applied a staff edit. That stale write:
--  * never verified (read-back is compared with canonical *now*), so the cursor never advanced and the batch was
--    redelivered forever;
--  * came back as a webhook echo whose `previous` was the staff value, i.e. canonical, so compare-and-set passed and the
--    echo was applied as a staff edit, flipping canonical on every redelivery.
-- Related: a staff member who fixed their own refused edit before RoofOps's correction landed was refused as "someone
-- else changed it", because compare-and-set compared their `previous` (the refused value Airtable was showing) with
-- canonical. The reconciler could also replay such a stale RoofOps write as a missed staff edit.
--
-- Rule: RoofOps records every value it asks n8n to write to Airtable (airtable_writes). A change whose value is an
-- outstanding RoofOps write for that field is RoofOps's own write coming back: it is never applied; if canonical has
-- moved on, Airtable is corrected to canonical. A staff edit whose `previous` is the value a pending RoofOps correction
-- is replacing was made against what Airtable visibly showed: compare-and-set accepts it (it is still validated). A write
-- that landed but was overtaken is verified as landed; its echo converges Airtable.
-- A person choosing the value RoofOps wrote is never mistaken for its echo: an edit made in the Airtable UI ('client'
-- origin, passed on by n8n 06) is never an echo, and nothing in the batch of the execution that issued a write can be
-- its echo (06 PATCHes only after applying the whole batch). The ledger is bounded (airtable_writes_prune).

create table airtable_writes (
  id          bigserial primary key,
  table_id    text not null,
  record_id   text not null,
  field_id    text not null,
  value       text,                 -- at_norm of the value RoofOps asked to write
  replaces    text,                 -- at_norm of the value Airtable showed when the write was issued (if known)
  source_key  text not null,        -- the change event, or 'reconcile:<run>', that issued it
  issued_by   text,                 -- the worker (n8n execution) that issued it: it PATCHes only after applying its whole batch
  issued_at  timestamptz not null default now(),
  echoed_at   timestamptz,          -- its echo was seen (or it can no longer produce one)
  verified_at timestamptz           -- read back after the write
);
create index airtable_writes_open_idx on airtable_writes (table_id, record_id, field_id, issued_at) where echoed_at is null;
create index airtable_writes_source_idx on airtable_writes (source_key);
create index airtable_writes_issued_idx on airtable_writes (issued_at);
alter table airtable_writes enable row level security;
revoke all on airtable_writes from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on airtable_writes from anon, authenticated';
  end if;
end $$;

-- Retention. Every rule below reads only writes issued in the last 7 days (the widest recognition window: the
-- reconciler's; the webhook's is 30 minutes, and Airtable keeps webhook payloads for 7 days). Older rows can not change
-- any decision. Settled writes (echo seen or read back) are kept 30 days and unsettled ones 90 days, for diagnosis;
-- then they are deleted. It runs whenever writes are recorded, so the table stays bounded without a scheduler.
create or replace function airtable_writes_prune()
returns int language sql security definer set search_path = public, pg_temp as $$
  with d as (
    delete from airtable_writes
     where issued_at < now() - interval '90 days'
        or (issued_at < now() - interval '30 days' and (echoed_at is not null or verified_at is not null))
    returning 1)
  select count(*)::int from d
$$;

-- Record the writes a result asks n8n to make. Fields Airtable already shows with that value produce no echo: skipped.
create or replace function airtable_record_writes(p_source_key text, p_table_id text, p_record_id text, p_corrections jsonb, p_current jsonb, p_issued_by text)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  insert into airtable_writes (table_id, record_id, field_id, value, replaces, source_key, issued_by)
  select p_table_id, p_record_id, k, at_norm(v), at_norm(p_current -> k), p_source_key, p_issued_by
    from jsonb_each(coalesce(p_corrections, '{}'::jsonb)) as t(k, v)
   where exists (select 1 from field_contract c where c.airtable_field_id = k and c.reconcile <> 'IGNORE')
     and at_norm(v) is distinct from at_norm(at_normalize_fields(coalesce(p_current, '{}'::jsonb)) -> k);
  get diagnostics n = row_count;
  if n > 0 then perform airtable_writes_prune(); end if;
  return n;
end $$;

-- The webhook and reconciler entry point: AC-02 normalisation, then the AC-10 rules, then the unchanged handler.
create or replace function wf_airtable_change(p_event jsonb, p_worker text default 'n8n')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_event jsonb := p_event; v_changes jsonb := p_event -> 'changes';
  v_table text := p_event ->> 'table_id'; v_rec text := p_event ->> 'record_id'; v_key text := p_event ->> 'event_id';
  v_src text := coalesce(nullif(p_event ->> 'source', ''), 'airtable'); v_at timestamptz;
  -- Airtable's actionMetadata.source, passed on by n8n 06: 'client' is a person in the Airtable UI, 'publicApi' an API
  -- client (RoofOps's own PATCHes arrive as 'publicApi'). Absent from events sent by older versions of 06.
  v_origin text := nullif(p_event ->> 'origin', '');
  v_link external_links; v_exp jsonb; v_exp_after jsonb; k text; v jsonb; w airtable_writes;
  v_echoes jsonb := '{}'; v_based text[] := '{}'; v_res jsonb; v_corr jsonb; v_sync text; v_note text;
begin
  -- AC-02: every date as the Brisbane business day it denotes.
  if jsonb_typeof(v_changes) = 'object' then
    v_event := jsonb_set(v_event, '{changes}', coalesce((
      select jsonb_object_agg(k2, case when jsonb_typeof(v2) = 'object' and exists (select 1 from field_contract c where c.airtable_field_id = k2 and c.value_type = 'date')
                                      then v2 || jsonb_strip_nulls(jsonb_build_object('current', at_business_date(v2 -> 'current'), 'previous', at_business_date(v2 -> 'previous')))
                                      else v2 end)
        from jsonb_each(v_changes) as t(k2, v2)), '{}'::jsonb));
  end if;
  if jsonb_typeof(p_event -> 'current') = 'object' then
    v_event := jsonb_set(v_event, '{current}', at_normalize_fields(p_event -> 'current'));
  end if;
  v_changes := v_event -> 'changes';

  -- AC-10: only for a well-formed change to a record RoofOps knows (anything else is the handler's to reject).
  select * into v_link from external_links where provider = 'AIRTABLE' and external_type = 'Record' and external_id = v_rec;
  if jsonb_typeof(v_changes) = 'object' and v_link.id is not null
     and not exists (select 1 from processed_events where consumer = 'airtable_change@1' and idempotency_key = v_key) then
    begin v_at := coalesce((p_event ->> 'occurred_at')::timestamptz, now()); exception when others then v_at := now(); end;
    -- Same lock order as the handler: decide against canonical as it is once no one else can change it.
    case v_link.entity_type
      when 'project' then perform 1 from projects where id = v_link.entity_id for update;
      when 'quote' then perform 1 from quotes where id = v_link.entity_id for update;
      when 'purchase_order' then perform 1 from purchase_orders where id = v_link.entity_id for update;
      when 'customer' then perform 1 from customers where id = v_link.entity_id for update;
      when 'property' then perform 1 from properties where id = v_link.entity_id for update;
      when 'supplier' then perform 1 from suppliers where id = v_link.entity_id for update;
      else null;
    end case;
    select expected into v_exp from v_airtable_expected where table_id = v_table and record_id = v_rec;
    for k, v in select key, value from jsonb_each(v_changes) loop
      continue when jsonb_typeof(v) <> 'object';
      -- 1. RoofOps's own write coming back (the webhook echo of n8n's PATCH, or the reconciler reading it before then).
      -- An edit made in the Airtable UI (or by a form or automation) is never an echo: RoofOps writes only through the API.
      w := null;
      if v_src = 'reconciler' or v_origin is null or v_origin = 'publicApi' then
        select * into w from airtable_writes
         where table_id = v_table and record_id = v_rec and field_id = k and echoed_at is null
           and value is not distinct from at_norm(v -> 'current')
           -- An echo is stamped when n8n's PATCH landed: seconds after the write was issued (retries take under a minute).
           -- 5 minutes of clock skew between Airtable and Postgres is tolerated. The reconciler reads whatever is there.
           and case when v_src = 'reconciler' then issued_at > now() - interval '7 days'
                    else v_at between issued_at - interval '5 minutes' and issued_at + interval '30 minutes'
                         -- The execution that issued a write PATCHes only after applying its whole batch, so nothing in
                         -- that batch can be its echo: it is a person choosing that value.
                         and issued_by is distinct from p_worker end
         order by issued_at limit 1 for update;
      end if;
      if w.id is not null then
        if v_src = 'airtable' then
          -- Seen: this write can not echo again, and older writes of the same field can no longer arrive after it.
          update airtable_writes set echoed_at = now()
           where table_id = v_table and record_id = v_rec and field_id = k and echoed_at is null and issued_at <= w.issued_at;
        end if;
        if at_norm(at_repair_value(v_exp -> k)) is distinct from at_norm(v -> 'current') then
          v_echoes := v_echoes || jsonb_build_object(k, v -> 'current');
          v_changes := v_changes - k;          -- never a staff edit: not applied, not compared
        end if;
        continue;
      end if;
      -- 2. A staff edit made against the value Airtable showed while a RoofOps correction had not landed yet.
      if v_src = 'airtable' and coalesce((v ->> 'has_previous')::boolean, v ? 'previous')
         and at_norm(v -> 'previous') is distinct from at_norm(v_exp -> k)
         and exists (select 1 from airtable_writes x where x.table_id = v_table and x.record_id = v_rec and x.field_id = k
                      and x.echoed_at is null and x.issued_at > now() - interval '7 days'
                      and x.replaces is not null and x.replaces = at_norm(v -> 'previous')) then
        v_changes := jsonb_set(v_changes, array[k], v || jsonb_build_object('previous', v_exp -> k, 'previous_in_airtable', v -> 'previous'));
        v_based := v_based || k;
      end if;
    end loop;
    v_event := jsonb_set(v_event, '{changes}', v_changes);
  end if;

  v_res := wf_airtable_change_core(v_event, p_worker);

  -- Airtable shows an overtaken RoofOps write: put it back to canonical, and say why.
  if v_echoes <> '{}'::jsonb then
    select expected into v_exp_after from v_airtable_expected where table_id = v_table and record_id = v_rec;
    v_corr := coalesce(v_res -> 'corrections', '{}'::jsonb);
    select coalesce(v_corr, '{}'::jsonb) || coalesce(jsonb_object_agg(e.key, at_repair_value(v_exp_after -> e.key)), '{}'::jsonb) into v_corr
      from jsonb_each(v_echoes) e where at_norm(at_repair_value(v_exp_after -> e.key)) is distinct from at_norm(e.value);
    select airtable_field_id into v_sync from field_contract where airtable_table_id = v_table and field_key = 'roofops_sync';
    select string_agg(format('↺ %s: an earlier RoofOps correction arrived after a newer edit; "%s" is kept.', c.airtable_name,
                             coalesce(at_norm(at_repair_value(v_exp_after -> c.airtable_field_id)), 'blank')), E'\n')
      into v_note from field_contract c where c.airtable_table_id = v_table and v_echoes ? c.airtable_field_id;
    if v_sync is not null and v_note is not null and not (v_corr ? v_sync) then
      v_corr := v_corr || jsonb_build_object(v_sync, to_char(now() at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI') || E'\n' || v_note);
    end if;
    v_res := v_res || jsonb_build_object('corrections', v_corr,
      'own_writes_ignored', (select jsonb_agg(c.airtable_name order by c.airtable_name) from field_contract c where c.airtable_table_id = v_table and v_echoes ? c.airtable_field_id));
    update processed_events set result = v_res where consumer = 'airtable_change@1' and idempotency_key = v_key and status = 'COMPLETED'
       and not coalesce((result ->> 'duplicate')::boolean, false);
  end if;
  if cardinality(v_based) > 0 then
    v_res := v_res || jsonb_build_object('edited_before_correction_landed', to_jsonb(v_based));
  end if;
  perform airtable_record_writes(v_key, v_table, v_rec, v_res -> 'corrections', v_event -> 'current', p_worker);
  return v_res;
end $$;

-- Read-back proof: a field that shows canonical, or exactly the value this event asked to write (it landed, then a
-- newer change overtook it; its echo will correct Airtable), is verified. Anything else still fails.
create or replace function wf_airtable_writeback_verified(p_event_key text, p_table_id text, p_record_id text, p_readback jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_rb jsonb := at_normalize_fields(p_readback); v_exp jsonb; v_landed jsonb := '[]'; v_res jsonb; k text;
begin
  select expected into v_exp from v_airtable_expected where table_id = p_table_id and record_id = p_record_id;
  for k in select jsonb_object_keys(coalesce(v_rb, '{}'::jsonb)) loop
    if not at_matches(v_exp -> k, v_rb -> k) and exists (
         select 1 from airtable_writes w where w.table_id = p_table_id and w.record_id = p_record_id and w.field_id = k
            and w.issued_at > now() - interval '7 days'
            and (w.source_key = p_event_key or w.source_key like p_event_key || ':%')
            and w.value is not distinct from at_norm(v_rb -> k)) then
      v_landed := v_landed || to_jsonb(k);
    end if;
  end loop;
  update airtable_writes w set verified_at = coalesce(w.verified_at, now())
   where w.table_id = p_table_id and w.record_id = p_record_id and (w.source_key = p_event_key or w.source_key like p_event_key || ':%')
     and v_rb ? w.field_id and w.value is not distinct from at_norm(v_rb -> w.field_id);
  -- What Airtable shows for overtaken fields is still recorded, so the brief divergence is visible until the echo fixes it.
  insert into airtable_observations (table_id, record_id, field_id, value, observed_at, source)
  select p_table_id, p_record_id, x, at_norm(v_rb -> x), now(), 'readback' from jsonb_array_elements_text(v_landed) x
  on conflict (table_id, record_id, field_id) do update set value = excluded.value, observed_at = excluded.observed_at, source = excluded.source;
  v_res := wf_airtable_writeback_verified_core(p_event_key, p_table_id, p_record_id,
             (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(coalesce(v_rb, '{}'::jsonb)) where not (v_landed ? key)));
  if jsonb_array_length(v_landed) > 0 then
    v_res := v_res || jsonb_build_object('overtaken_fields', v_landed);
  end if;
  return v_res;
end $$;

-- Reconciliation: record the repairs it hands to n8n 07, like every other RoofOps write.
alter function wf_reconcile_airtable(text, text, jsonb) rename to wf_reconcile_airtable_core;
create or replace function wf_reconcile_airtable(p_run_key text, p_table_id text, p_records jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_res jsonb := wf_reconcile_airtable_core(p_run_key, p_table_id, p_records); c jsonb;
begin
  for c in select * from jsonb_array_elements(coalesce(v_res -> 'corrections', '[]'::jsonb)) loop
    perform airtable_record_writes('reconcile:' || p_run_key, p_table_id, c ->> 'id', c -> 'fields',
      (select y -> 'fields' from jsonb_array_elements(p_records) y where y ->> 'id' = c ->> 'id' limit 1), 'reconcile:' || p_run_key);
  end loop;
  return v_res;
end $$;

revoke execute on all functions in schema public from public;
revoke execute on function wf_reconcile_airtable_core(text, text, jsonb) from roofops_workflow;
grant execute on function wf_airtable_change(jsonb, text), wf_airtable_writeback_verified(text, text, text, jsonb), wf_reconcile_airtable(text, text, jsonb)
  to roofops_workflow;

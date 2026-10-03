-- AC-06 (docs/defect-ledger.md): unpinning or re-pointing the Xero tenant did not stop queued writes. The tenant is
-- copied into the outbox payload at approval, and wf_claim_side_effect / wf_complete_side_effect trusted the payload:
-- with app_settings xero.demo_tenant_id cleared (the documented "no writes possible" state) or changed to another
-- tenant, a queued or retrying job was still claimed, n8n 05 wrote it to the old tenant, and Postgres recorded it SYNCED.
-- Refusing only at completion is not enough: a worker that claimed before the change still POSTs to the old tenant,
-- and RoofOps would then record a failure while the draft exists.
--
-- Rule: a Xero write is bound for good to the tenant it was approved for. The pin cannot move while a write for the
-- pinned tenant can still run or may already have run, and a write never runs while its tenant is not the pinned one.
--  * The bound tenant cannot be changed (or the job re-pointed) after approval.
--  * Changing, clearing or deleting the pin is refused while a Xero write bound to the pinned tenant is not finished:
--    queued, being written, retry scheduled, or ambiguous (UNKNOWN, even if dead-lettered). Finished: done, or failed
--    for good with nothing created. A write held for another tenant (it can never run) does not block, so its own
--    tenant can always be pinned again.
--  * Pin changes and claims are serialized by one advisory lock (claims shared, pin changes exclusive), so a race has
--    two outcomes only. Worker first: the claim succeeds, the change waits and is then refused (the write is open).
--    Change first: the change succeeds, the claim waits, sees the missing/different pin, does not claim; no Xero call.
--  * The claim re-reads the pin under that lock; a write whose tenant is not pinned is not claimed and one exception
--    says why. Completion re-checks the pin as defence in depth.
-- n8n 05 is unchanged: claimed=false routes it to "not claimed", and a refused completion to "Proof Refused By Postgres".

-- 1. Why a Xero write may not run against the given pin (null: it may).
create or replace function xero_write_tenant_problem(o outbox, p_pin text)
returns text language sql stable set search_path = public, pg_temp as $$
  select case
    when coalesce(o.payload ->> 'xero_tenant_id', '') = '' then
      format('%s: Xero write stopped. It carries no Xero tenant, so RoofOps never sends it. A person decides what happens to it',
             o.payload ->> 'invoice_number')
    when coalesce(p_pin, '') = '' then
      format('%s: Xero write stopped. It was approved for Xero tenant %s…, but no Xero tenant is pinned now (app_settings xero.demo_tenant_id is empty). '
             'RoofOps never sends it to another tenant. Pin %s… again to let it continue, or a person decides what happens to it',
             o.payload ->> 'invoice_number', left(o.payload ->> 'xero_tenant_id', 8), left(o.payload ->> 'xero_tenant_id', 8))
    when p_pin <> o.payload ->> 'xero_tenant_id' then
      format('%s: Xero write stopped. It was approved for Xero tenant %s…, but the pinned tenant is now %s…. '
             'RoofOps never sends it to another tenant. Pin %s… again to let it continue, or a person decides what happens to it',
             o.payload ->> 'invoice_number', left(o.payload ->> 'xero_tenant_id', 8), left(p_pin, 8), left(o.payload ->> 'xero_tenant_id', 8))
  end
$$;

-- 2. The bound tenant is fixed once the write is approved.
create or replace function xero_write_tenant_is_fixed()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'The Xero tenant of % is fixed when it is approved (%…): it cannot be changed to %', old.idempotency_key,
    left(old.payload ->> 'xero_tenant_id', 8), coalesce(new.payload ->> 'xero_tenant_id', 'none') || case when new.topic is distinct from old.topic then ' / topic ' || new.topic else '' end
    using errcode = 'check_violation';
end $$;
create trigger outbox_xero_tenant_fixed before update of payload, topic on outbox
  for each row when (old.topic = 'xero.create_draft_invoice' and (new.topic is distinct from old.topic
                     or new.payload ->> 'xero_tenant_id' is distinct from old.payload ->> 'xero_tenant_id'))
  execute function xero_write_tenant_is_fixed();

-- 3. The pin cannot move while a write for the pinned tenant is not finished. Exclusive side of the pin lock.
create or replace function xero_pin_change_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old text; v_new text; v_open text;
begin
  if coalesce(new.key, old.key) <> 'xero.demo_tenant_id' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  v_old := case when tg_op = 'INSERT' then null else old.value end;
  v_new := case when tg_op = 'DELETE' then null else new.value end;
  if coalesce(v_old, '') <> coalesce(v_new, '') then
    -- Waits for claims in progress; claims wait for this change until it commits.
    perform pg_advisory_xact_lock(hashtextextended('roofops:xero.demo_tenant_id', 0));
    if coalesce(v_old, '') <> '' then
      select string_agg(i.invoice_number || ' (' || case when i.sync_status = 'UNKNOWN' then 'ambiguous: it may already exist in Xero'
                                                          when o.status = 'DISPATCHING' then 'being written'
                                                          when o.status = 'PENDING' then 'queued'
                                                          else 'retry scheduled' end || ')', ', ' order by i.invoice_number)
        into v_open
        from outbox o join invoices i on i.id = o.aggregate_id
       where o.topic = 'xero.create_draft_invoice' and o.payload ->> 'xero_tenant_id' = v_old
         and ((o.status <> 'DONE' and not (o.status = 'FAILED' and o.next_attempt_at = 'infinity')) or i.sync_status = 'UNKNOWN');
      if v_open is not null then
        raise exception 'The pinned Xero tenant %… cannot be changed or cleared while a Xero write for it is not finished: %. Let it finish or fail for good first (reconcile an ambiguous one)',
          left(v_old, 8), v_open using errcode = 'check_violation';
      end if;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger app_settings_xero_pin_guard before insert or update or delete on app_settings
  for each row execute function xero_pin_change_guard();

-- 4. Claim: re-read the pin under the shared side of the pin lock (redefined in place; AC-05's voided check kept).
create or replace function wf_claim_side_effect(p_key text, p_worker text, p_lease_seconds int default 120)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare o outbox; v_inv invoices; v_pin text; v_problem text;
begin
  select * into o from outbox where idempotency_key = p_key;
  if o.topic = 'xero.create_draft_invoice' then
    select * into v_inv from invoices where id = o.aggregate_id;
    if v_inv.status = 'VOIDED' then
      return jsonb_build_object('claimed', false, 'key', o.idempotency_key, 'topic', o.topic, 'status', 'INVOICE_VOIDED',
        'message', format('%s was voided: no Xero draft is created for it', v_inv.invoice_number));
    end if;
    if o.status <> 'DONE' then
      -- A pin change in progress makes this wait (then it sees the new pin); a claim in progress makes a change wait.
      perform pg_advisory_xact_lock_shared(hashtextextended('roofops:xero.demo_tenant_id', 0));
      select value into v_pin from app_settings where key = 'xero.demo_tenant_id';
      v_problem := xero_write_tenant_problem(o, v_pin);
      if v_problem is not null then
        perform wf_open_sync_exception('project_to_invoice', 'project', v_inv.project_id,
          (select project_number from projects where id = v_inv.project_id), 'PERMISSION_DENIED', v_problem);
        return jsonb_build_object('claimed', false, 'key', o.idempotency_key, 'topic', o.topic, 'message', v_problem,
          'status', case when coalesce(o.payload ->> 'xero_tenant_id', '') = '' then 'TENANT_MISSING'
                         when coalesce(v_pin, '') = '' then 'TENANT_NOT_PINNED' else 'TENANT_CHANGED' end);
      end if;
    end if;
  end if;
  return wf_claim_side_effect_core(p_key, p_worker, p_lease_seconds);
end $$;

-- 5. Completion (defence in depth: the guard keeps the pin fixed while a write is open): the draft must come from
--    the bound tenant, and that tenant must still be the pinned one.
create or replace function wf_complete_side_effect(p_key text, p_result jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare o outbox; v_inv invoices; v_pin text; v_bound text; v_draft text; v_from text;
begin
  select * into o from outbox where idempotency_key = p_key;
  if o.topic = 'xero.create_draft_invoice' then
    select * into v_inv from invoices where id = o.aggregate_id;
    if v_inv.status = 'VOIDED' then
      -- Refused like any bad proof: 05 records the failure (dead letter + exception) and tells Airtable nothing was linked.
      raise exception '% is voided: the Xero draft % was not linked. Void or delete it in Xero', v_inv.invoice_number,
        coalesce(p_result ->> 'invoice_number', o.payload ->> 'xero_invoice_number') using errcode = 'check_violation';
    end if;
    if o.status <> 'DONE' then
      select value into v_pin from app_settings where key = 'xero.demo_tenant_id';
      v_bound := nullif(o.payload ->> 'xero_tenant_id', '');
      v_draft := coalesce(p_result ->> 'invoice_number', o.payload ->> 'xero_invoice_number');
      v_from := coalesce(left(p_result ->> 'tenant_id', 8) || '…', 'an unnamed tenant');
      if v_bound is null then
        raise exception '% carries no Xero tenant: the Xero draft % read back from tenant % was not linked. A person must check it in that tenant',
          v_inv.invoice_number, v_draft, v_from using errcode = 'check_violation';
      elsif coalesce(v_pin, '') = '' then
        raise exception '%: no Xero tenant is pinned now (it was approved for tenant %…): the Xero draft % read back from tenant % was not linked. A person must check it in that tenant',
          v_inv.invoice_number, left(v_bound, 8), v_draft, v_from using errcode = 'check_violation';
      elsif v_pin <> v_bound then
        raise exception '%: the pinned Xero tenant changed from %… to %… while the draft was written: the Xero draft % read back from tenant % was not linked. A person must check it in that tenant',
          v_inv.invoice_number, left(v_bound, 8), left(v_pin, 8), v_draft, v_from using errcode = 'check_violation';
      end if;
      -- A proof from another tenant than the bound (and pinned) one is refused by the core check.
    end if;
  end if;
  return wf_complete_side_effect_core(p_key, p_result);
end $$;

revoke execute on all functions in schema public from public;
revoke execute on function xero_write_tenant_problem(outbox, text), xero_write_tenant_is_fixed(), xero_pin_change_guard()
  from roofops_workflow, roofops_dashboard;

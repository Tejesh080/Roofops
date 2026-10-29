-- AC-14C follow-up, audit P2-D2 (Postgres side): 05 refused the VOIDED/DELETED predecessor a supervised reissue requires,
-- and nothing told it which documents were superseded. The claim now admits a generation >= 2 write only as the proven
-- supervised reissue (xero_reissue_proof: executed reissue approval, payload = the approved draft under its hash,
-- predecessor superseded, invoice APPROVED on that approval) and hands 05 the superseded Xero InvoiceIDs; completion
-- refuses an unproven generation and any superseded InvoiceID, so a stale Xero id can never control the new generation.
-- Generation 1 is unchanged (same claim result, same checks); AC-04 (UNKNOWN), AC-05 (voided) and AC-06 (tenant) stay.

-- 1. create or replace function wf_claim_side_effect(p_key text, p_worker text, p_lease_seconds int default 120)
create or replace function wf_claim_side_effect(p_key text, p_worker text, p_lease_seconds int default 120)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare o outbox; v_inv invoices; v_pin text; v_problem text; v_res jsonb;
begin
  select * into o from outbox where idempotency_key = p_key;
  if o.topic = 'xero.create_draft_invoice' then
    select * into v_inv from invoices where id = o.aggregate_id;
    if v_inv.status = 'VOIDED' then
      return jsonb_build_object('claimed', false, 'key', o.idempotency_key, 'topic', o.topic, 'status', 'INVOICE_VOIDED',
        'message', format('%s was voided: no Xero draft is created for it', v_inv.invoice_number));
    end if;
    -- AC-14C P2-D2: a generation >= 2 write is claimed only as the proven supervised reissue (xero_reissue_proof).
    if o.status <> 'DONE' and o.generation >= 2 then
      v_problem := xero_reissue_proof(o);
      if v_problem is not null then
        perform wf_open_sync_exception('project_to_invoice', 'invoice', v_inv.id, v_inv.invoice_number, 'RECONCILIATION_MISMATCH',
          format('%s: the generation %s Xero draft write was not claimed: %s. Nothing was sent to Xero; a person must check the reissue', v_inv.invoice_number, o.generation, v_problem));
        return jsonb_build_object('claimed', false, 'key', o.idempotency_key, 'topic', o.topic, 'status', 'REISSUE_NOT_PROVEN', 'message', v_problem);
      end if;
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
  v_res := wf_claim_side_effect_core(p_key, p_worker, p_lease_seconds);
  -- AC-14C P2-D2: 05 needs the superseded Xero InvoiceIDs of a proven reissue so a stale document never controls it.
  -- Generation 1's claim result is unchanged.
  if o.topic = 'xero.create_draft_invoice' and o.generation >= 2 and coalesce((v_res ->> 'claimed')::boolean, false) then
    v_res := v_res || jsonb_build_object('generation', o.generation,
      'superseded_xero_invoice_ids', coalesce((select jsonb_agg(g.xero_invoice_id order by g.generation) from invoice_xero_draft_generations g
                                                where g.invoice_id = o.aggregate_id and g.superseded_at is not null and g.xero_invoice_id is not null), '[]'::jsonb),
      'reissue_approval_number', o.payload ->> 'approval_number');
  end if;
  return v_res;
end $$;

-- 2. create or replace function wf_complete_side_effect(p_key text, p_result jsonb)
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
      -- AC-14C P2-D2: a generation >= 2 draft is linked only as the proven reissue, and never to a superseded InvoiceID.
      if o.generation >= 2 then
        v_from := xero_reissue_proof(o);
        if v_from is not null then
          raise exception '%: the generation % Xero draft % was not linked: %', v_inv.invoice_number, o.generation, v_draft, v_from using errcode = 'check_violation';
        end if;
        if exists (select 1 from invoice_xero_draft_generations g where g.invoice_id = o.aggregate_id and g.superseded_at is not null
                      and g.xero_invoice_id = p_result ->> 'invoice_id') then
          raise exception '%: % is a superseded Xero invoice (an earlier generation); it cannot be linked as generation %',
            v_inv.invoice_number, p_result ->> 'invoice_id', o.generation using errcode = 'check_violation';
        end if;
      end if;
    end if;
  end if;
  return wf_complete_side_effect_core(p_key, p_result);
end $$;

revoke execute on all functions in schema public from public;

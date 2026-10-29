-- AC-14C follow-up, audit P2-D1 (docs/defect-ledger.md): a queued generation-2 xero.create_draft_invoice write (opened by
-- ops_reissue_decide) had no supported dispatcher. Generation 1 is dispatched by n8n 04 right after its approval; nothing
-- dispatched a reissue's write.
--
-- The smallest path on the existing outbox/n8n architecture: n8n 08 (operator webhook, token checked here like 07's
-- reconcile trigger) asks wf_reissue_dispatch for the due, proven generation >= 2 writes and runs the unchanged 05
-- sub-workflow for each one, exactly as 04 does for a first issue. xero_reissue_proof is the one statement of "this
-- generation >= 2 write is the supervised reissue": 05's claim and completion use it too (next migration).

-- 1. The operator token for 08, stored only as a SHA-256 hash (empty: every dispatch is refused).
insert into app_settings (key, value) values ('reissue.dispatch_token_sha256', '') on conflict (key) do nothing;

-- 2. Is this generation >= 2 draft write the supervised reissue? null = proven, otherwise the reason it is not.
--    Generation 1 is not a reissue and is always null here (its own rules are unchanged).
create or replace function xero_reissue_proof(o outbox)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare g invoice_xero_draft_generations; a approvals; i invoices;
begin
  if o.topic is distinct from 'xero.create_draft_invoice' or o.generation < 2 then return null; end if;
  select * into g from invoice_xero_draft_generations where invoice_id = o.aggregate_id and generation = o.generation;
  if g.invoice_id is null then return format('generation %s has no draft-generation ledger row', o.generation); end if;
  if g.superseded_at is not null then return format('generation %s was superseded', o.generation); end if;
  if g.outbox_idempotency_key is distinct from o.idempotency_key then
    return format('generation %s is ledgered under %s, not %s', o.generation, g.outbox_idempotency_key, o.idempotency_key);
  end if;
  select * into a from approvals where id = g.approval_id;
  if a.id is null or a.action_type <> 'REISSUE_INVOICE' or a.entity_id <> o.aggregate_id or a.status <> 'EXECUTED' then
    return format('generation %s is not bound to an executed reissue approval (%s)', o.generation, coalesce(a.approval_number || ' ' || a.status, 'none'));
  end if;
  if a.action_payload -> 'draft' is null or not (o.payload @> (a.action_payload -> 'draft'))
     or o.payload ->> 'reissue_preview_hash' is distinct from a.payload_hash or o.payload ->> 'approval_number' is distinct from a.approval_number then
    return format('generation %s payload is not the approved draft of %s', o.generation, a.approval_number);
  end if;
  if not exists (select 1 from invoice_xero_draft_generations p where p.invoice_id = o.aggregate_id and p.generation = o.generation - 1 and p.superseded_at is not null) then
    return format('generation %s is still live', o.generation - 1);
  end if;
  select * into i from invoices where id = o.aggregate_id;
  if i.status <> 'APPROVED' or i.approval_id is distinct from a.id then
    return format('%s is %s on %s, not APPROVED on %s', i.invoice_number, i.status,
      coalesce((select approval_number from approvals where id = i.approval_id), 'no approval'), a.approval_number);
  end if;
  return null;
end $$;

-- 3. What n8n 08 dispatches: the due, proven generation >= 2 writes (a pure read; 05's claim does the rest, once).
create or replace function wf_reissue_dispatch(p_token text, p_worker text default 'n8n')
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_hash text := (select value from app_settings where key = 'reissue.dispatch_token_sha256');
begin
  if coalesce(v_hash, '') = '' or encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex') <> v_hash then
    return jsonb_build_object('ok', false, 'code', 'TOKEN_REFUSED', 'detail', 'a reissue dispatch needs the operator token');
  end if;
  return (
    with due as (
      select o.*, xero_reissue_proof(o) as problem, i.invoice_number
        from outbox o join invoices i on i.id = o.aggregate_id
       where o.topic = 'xero.create_draft_invoice' and o.generation >= 2
         and (o.status = 'PENDING' or (o.status = 'FAILED' and o.next_attempt_at <> 'infinity'))
         and coalesce(o.next_attempt_at, '-infinity') <= now())
    select jsonb_build_object('ok', true, 'worker', p_worker,
      'writes', coalesce((select jsonb_agg(jsonb_build_object('xero_key', d.idempotency_key, 'invoice_number', d.invoice_number, 'generation', d.generation)
                                           order by d.created_at, d.idempotency_key) from due d where d.problem is null), '[]'::jsonb),
      'unproven', coalesce((select jsonb_agg(jsonb_build_object('xero_key', d.idempotency_key, 'invoice_number', d.invoice_number, 'generation', d.generation,
                                                                'problem', d.problem) order by d.created_at, d.idempotency_key) from due d where d.problem is not null), '[]'::jsonb)));
end $$;

revoke execute on all functions in schema public from public;
revoke execute on function xero_reissue_proof(outbox) from roofops_workflow, roofops_dashboard;
revoke execute on function wf_reissue_dispatch(text, text) from roofops_dashboard;
grant execute on function wf_reissue_dispatch(text, text) to roofops_workflow;

-- =============================================================================
-- AC-14C Part B1 (docs/defect-ledger.md): one live Xero draft generation per invoice.
--
-- Part A (20261001140000) made a Xero-verified DELETED final invoice follow the void path. The invoice is then VOIDED
-- and settled, but the customer still owes the work, and the only way back is a replacement draft for the same invoice.
-- A replacement means a SECOND xero.create_draft_invoice write for one invoice, which every scalar lookup by
-- (topic, aggregate_id) in this schema reads as if there could only ever be one row. Part B1 prepares the foundation;
-- the operator-facing reissue facility (request + decide) is Part B2 and is not built here.
--
-- What this migration does, and nothing else:
--   1. outbox.generation (int, default 1) so one invoice can carry more than one draft write, and two indexes that keep
--      the multi-row model honest: one row per (topic, aggregate_id, generation), and at most one LIVE draft write per
--      invoice (PENDING / DISPATCHING; a DONE row is history, a FAILED one created nothing).
--   2. invoice_xero_draft_generations: the durable ledger of draft generations - which Xero InvoiceID each generation
--      produced, which approval asked for it, and when/why it was superseded. The ledger, not the outbox, is the
--      history: external_links keeps exactly one current link (unique (provider, entity_type, entity_id, external_type)),
--      so a superseded InvoiceID survives only here (plus xero_invoice_observations and audit_events). Backfilled for
--      every existing draft write (idempotent, re-runnable).
--      The backfill only inserts ledger rows: no invoice, outbox, observation or other row changes.
--   3. Ledger maintenance for NEW writes (the backup patch lacked this): the ledger row is opened when the draft write
--      is queued and mirrored as it progresses, by triggers on outbox scoped to the draft topic (AFTER INSERT opens;
--      AFTER UPDATE OF status mirrors) plus one on invoices.sync_status. PENDING -> PENDING, DISPATCHING -> DISPATCHING,
--      DONE -> CREATED (capturing the Xero InvoiceID, number and the bound tenant), a safe failure -> FAILED, an AC-04
--      ambiguous one -> UNKNOWN. SUPERSEDED is only ever set by the supervised reissue (Part B2), never automatically.
--   4. Generation-aware idempotency keys (frozen formats): generation 1 keeps the historical keys byte-for-byte, a
--      generation >= 2 gets ':g<n>' / '-g<n>' appended, and the writer (wf_invoice_decide_core) composes them with the
--      helpers rather than by hand. Xero must never see an Idempotency-Key it has already seen.
--   5. Every scalar lookup of outbox by (topic, aggregate_id) made generation-aware: the CURRENT generation is the row
--      with the greatest generation for that (topic, aggregate_id), ties broken by created_at then id (outbox_current()).
--      Semantics are unchanged while only one row exists - the whole existing suite is the regression proof. That is
--      stale-read protection: reconciliation targets the current generation only, and a superseded generation's Xero
--      InvoiceID is discounted wherever it is looked up (uncertain-write recovery included).
--
-- Decisions stated here (the brief leaves them to this migration):
--   * Ledger vocabulary: PENDING (queued for 05) / DISPATCHING (05 is creating it) / CREATED (Xero returned an
--     InvoiceID and 05 read it back) / FAILED (nothing was created) / UNKNOWN (the create answer was lost, it may exist -
--     AC-04) / SUPERSEDED (a later generation replaced it; superseded_at is set). The outbox lifecycle it mirrors is
--     PENDING -> DISPATCHING -> DONE | FAILED, so CREATED is the ledger's DONE.
--   * Invariant, enforced not just documented: at most one live (non-superseded) ledger row per invoice, and status
--     SUPERSEDED exactly when superseded_at is set.
--   * Ledger maintenance is done with triggers, not by editing the side-effect functions: the ledger then mirrors every
--     writer (05's claim/complete/fail, reconciliation's recovery, the operator requeue script) instead of the ones
--     this migration happens to remember. Triggers are security definer so the ledger stays closed to the workflow role.
--   * No operator function, no dashboard surface, no n8n change: Part B1 is storage, maintenance and lookups only.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. One row per draft generation; at most one live draft write per invoice.
-- -----------------------------------------------------------------------------
alter table outbox add column generation int not null default 1;
alter table outbox add constraint outbox_generation_positive check (generation >= 1);
-- One write per generation: the ledger's unique (invoice_id, generation) has exactly this meaning on the outbox side,
-- so a second write for the same invoice must carry a new generation (never the default).
create unique index outbox_one_row_per_draft_generation
  on outbox (topic, aggregate_id, generation) where topic = 'xero.create_draft_invoice';
-- At most one LIVE draft write per invoice. DONE (a draft was created and read back) and dead-lettered FAILED rows
-- (nothing was created) are history: they do not block a replacement generation.
create unique index outbox_one_live_draft_per_invoice
  on outbox (aggregate_id) where topic = 'xero.create_draft_invoice' and status in ('PENDING','DISPATCHING');

-- -----------------------------------------------------------------------------
-- 2. The durable ledger of draft generations.
-- -----------------------------------------------------------------------------
create table invoice_xero_draft_generations (
  id                     uuid primary key default gen_random_uuid(),
  invoice_id             uuid not null references invoices(id),
  generation             int not null check (generation >= 1),
  status                 text not null check (status in ('PENDING','DISPATCHING','CREATED','FAILED','UNKNOWN','SUPERSEDED')),
  outbox_idempotency_key text not null,              -- the outbox row that carries this generation's write
  xero_invoice_id        text,                       -- the Xero InvoiceID this generation produced (null until CREATED)
  xero_invoice_number    text,
  tenant_id              text,                       -- the Xero tenant the write was bound to (AC-06)
  approval_id            uuid references approvals(id),
  opened_by              text not null default 'workflow',   -- 'workflow' for a first-time draft, 'operator:<code>' for a reissue
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  superseded_at          timestamptz,
  superseded_reason      text,
  unique (invoice_id, generation),
  constraint invoice_xero_draft_generations_superseded_consistency check ((status = 'SUPERSEDED') = (superseded_at is not null))
);
-- At most one live generation per invoice: every earlier generation is superseded (its InvoiceID stays here).
create unique index invoice_xero_draft_generations_one_live
  on invoice_xero_draft_generations (invoice_id) where superseded_at is null;
create index invoice_xero_draft_generations_invoice_idx on invoice_xero_draft_generations (invoice_id, generation desc);
alter table invoice_xero_draft_generations enable row level security;
revoke all on invoice_xero_draft_generations from public;

-- Backfill (idempotent, re-runnable): every draft write that exists becomes exactly one generation row, and it only
-- inserts ledger rows - no invoice, outbox, observation, approval or audit row changes. Everything it writes comes from
-- the write itself: the key and the timestamps from the outbox row, the number and the bound tenant from its payload,
-- the approval from the invoice, and the Xero InvoiceID from the invoice's current verified XERO Invoice link (a draft
-- that was never read back has no InvoiceID yet). Status mapping (the brief's precedence): an invoice whose sync is
-- UNKNOWN is UNKNOWN whatever its write says; otherwise DONE -> CREATED, PENDING/DISPATCHING mirrored, everything else
-- (a closed write that created nothing) -> FAILED.
create or replace function invoice_xero_draft_generations_backfill()
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  insert into invoice_xero_draft_generations (invoice_id, generation, status, outbox_idempotency_key, xero_invoice_id,
                                              xero_invoice_number, tenant_id, approval_id, opened_by, created_at, updated_at)
  select o.aggregate_id, o.generation, xero_draft_ledger_status(o.status, i.sync_status), o.idempotency_key,
         (select l.external_id from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice'
            and l.entity_id = o.aggregate_id and l.verified_at is not null),
         o.payload ->> 'xero_invoice_number', o.payload ->> 'xero_tenant_id', i.approval_id,
         case when o.generation = 1 then 'workflow' else coalesce(o.payload ->> 'opened_by', 'operator') end,
         o.created_at, o.created_at
    from outbox o left join invoices i on i.id = o.aggregate_id
   where o.topic = 'xero.create_draft_invoice'
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- -----------------------------------------------------------------------------
-- 3. Generation-aware idempotency keys, and the one status mapping the ledger uses.
-- -----------------------------------------------------------------------------
-- Frozen formats. Generation 1 is the historic form - byte-identical to every draft key this schema has ever queued -
-- and every later generation gets its own key, so a replacement draft never sends Xero an Idempotency-Key Xero has
-- already seen. The writer (wf_invoice_decide_core) composes them with these helpers, never by hand.
create or replace function xero_draft_outbox_key(p_invoice uuid, p_generation int)
returns text language sql immutable as $$
  select case when p_generation = 1 then 'xero:invoice:' || p_invoice::text
              else 'xero:invoice:' || p_invoice::text || ':g' || p_generation::text end
$$;
create or replace function xero_draft_provider_key(p_invoice uuid, p_generation int)
returns text language sql immutable as $$
  select case when p_generation = 1 then 'roofops-' || p_invoice::text
              else 'roofops-' || p_invoice::text || '-g' || p_generation::text end
$$;

-- The mapping the backfill and the maintenance triggers share (see the backfill's comment). Pure, so immutable.
create or replace function xero_draft_ledger_status(p_outbox_status text, p_sync_status text)
returns text language sql immutable as $$
  select case
    when p_sync_status = 'UNKNOWN' then 'UNKNOWN'
    when p_outbox_status = 'DONE' then 'CREATED'
    when p_outbox_status in ('PENDING', 'DISPATCHING') then p_outbox_status
    else 'FAILED' end
$$;

-- The backfill itself, run once here for the history that already exists (and re-runnable at any time; it only inserts).
select invoice_xero_draft_generations_backfill() as draft_generations_backfilled;

-- -----------------------------------------------------------------------------
-- 4. One definition of "the current draft write", and the superseded history a lookup may discount.
-- -----------------------------------------------------------------------------
-- The current generation of a (topic, aggregate_id): greatest generation, ties broken newest-first.
create or replace function outbox_current(p_topic text, p_aggregate_id uuid)
returns outbox language sql stable security definer set search_path = public, pg_temp as $$
  select * from outbox where topic = p_topic and aggregate_id = p_aggregate_id
   order by generation desc, created_at desc, id desc limit 1
$$;

-- The known Xero InvoiceIDs of this invoice's superseded generations: a match by number whose InvoiceID is one of
-- these is an earlier draft, never the one an uncertain write is looking for. Empty (so nothing is discounted) for
-- every invoice that never went through a reissue.
create or replace function xero_draft_superseded_ids(p_invoice uuid)
returns text[] language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(g.xero_invoice_id order by g.xero_invoice_id), '{}'::text[])
    from invoice_xero_draft_generations g
   where g.invoice_id = p_invoice and g.superseded_at is not null and g.xero_invoice_id is not null
$$;

-- -----------------------------------------------------------------------------
-- 5. Ledger maintenance for new writes: open the row when the write is queued, mirror it as the write progresses.
-- -----------------------------------------------------------------------------
-- Opening: every queued draft write gets its generation row, carrying the write's number, its bound tenant and the
-- invoice's approval. An explicit ledger row that already exists wins (the supervised reissue writes its own, Part B2),
-- and `on conflict do nothing` also means a second live generation is refused by the ledger's own one-live rule rather
-- than failing the transaction that queued the write.
create or replace function xero_draft_generation_open()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare i invoices;
begin
  select * into i from invoices where id = new.aggregate_id;
  insert into invoice_xero_draft_generations (invoice_id, generation, status, outbox_idempotency_key, xero_invoice_number,
                                              tenant_id, approval_id, opened_by)
  values (new.aggregate_id, new.generation, xero_draft_ledger_status(new.status, i.sync_status), new.idempotency_key,
          new.payload ->> 'xero_invoice_number', new.payload ->> 'xero_tenant_id', i.approval_id,
          case when new.generation = 1 then 'workflow' else coalesce(new.payload ->> 'opened_by', 'operator') end)
  on conflict do nothing;
  return new;
end $$;
create trigger outbox_xero_draft_generation_open after insert on outbox
  for each row when (new.topic = 'xero.create_draft_invoice') execute function xero_draft_generation_open();

-- Mirroring: PENDING -> PENDING, DISPATCHING -> DISPATCHING, DONE -> CREATED, a closed write that created nothing ->
-- FAILED - with the invoice's sync state taking precedence (an UNKNOWN invoice is UNKNOWN). DONE is the moment the Xero
-- InvoiceID is captured: from the invoice's verified XERO Invoice link 05 created, falling back to the write's own
-- recorded result. A superseded generation is history and is never written again.
create or replace function xero_draft_generation_mirror()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_status text; v_xero_id text;
begin
  v_status := xero_draft_ledger_status(new.status, (select i.sync_status from invoices i where i.id = new.aggregate_id));
  if new.status = 'DONE' then
    v_xero_id := coalesce((select l.external_id from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice'
                             and l.entity_id = new.aggregate_id and l.verified_at is not null), new.result ->> 'invoice_id');
  end if;
  update invoice_xero_draft_generations g
     set status = v_status, xero_invoice_id = coalesce(g.xero_invoice_id, v_xero_id),
         xero_invoice_number = coalesce(new.payload ->> 'xero_invoice_number', g.xero_invoice_number),
         tenant_id = coalesce(new.payload ->> 'xero_tenant_id', g.tenant_id), updated_at = now()
   where g.invoice_id = new.aggregate_id and g.generation = new.generation and g.status <> 'SUPERSEDED';
  return new;
end $$;
create trigger outbox_xero_draft_generation_mirror after update of status on outbox
  for each row when (new.topic = 'xero.create_draft_invoice' and new.status is distinct from old.status)
  execute function xero_draft_generation_mirror();

-- ... and the invoice's own sync state, which is what separates an ambiguous write (UNKNOWN: it may exist) from a safe
-- one (FAILED: nothing was created). wf_fail_side_effect records it *after* it has closed the write, so the ledger
-- cannot learn it from the outbox update alone; the same trigger clears UNKNOWN again when reconciliation proves the
-- draft absent (FAILED) - a recovered draft clears it through the DONE mirror above instead.
create or replace function xero_draft_generation_sync_mirror()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare o outbox; v_status text;
begin
  select * into o from outbox_current('xero.create_draft_invoice', new.id);
  if o.id is null then return new; end if;
  v_status := xero_draft_ledger_status(o.status, new.sync_status);
  update invoice_xero_draft_generations g
     set status = v_status, updated_at = now()
   where g.invoice_id = new.id and g.generation = o.generation and g.status <> 'SUPERSEDED'
     and g.status is distinct from v_status;
  return new;
end $$;
create trigger invoices_xero_draft_generation_sync after update of sync_status on invoices
  for each row when (old.sync_status is distinct from new.sync_status) execute function xero_draft_generation_sync_mirror();

-- The reopen path itself (the REISSUE_INVOICE approval, the VOIDED -> APPROVED and invoice_sync SYNCED -> PENDING
-- edges, and invoice_reissue_guard()) is Part B2, and is deliberately NOT built here: Part B1 prepares the storage, the
-- maintenance and the generation-aware reads, and nothing else. Until B2 lands the only way to express a second
-- generation is to write the ledger row and the queued write directly (as the tests do), which is exactly what the
-- constraints below are there to keep honest.

-- -----------------------------------------------------------------------------
-- 6. The writer: approve queues generation 1 (the historic keys), any later generation keeps its own key.
-- -----------------------------------------------------------------------------
-- Everything else in wf_invoice_decide_core is unchanged - the wrapper wf_invoice_decide, the preview binding, the
-- authorisation, the rejection paths and the audit trail are exactly as they were. The only edits are the generation
-- the queued write carries and the two key expressions, which now come from the helpers above. create or replace keeps
-- this function's privileges (it is executable by nobody but its owner and the wrappers that security-definer-call it).
create or replace function wf_invoice_decide_core(p_event jsonb, p_worker text default 'n8n')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e record; v_type text := p_event ->> 'event_type'; v_prj text := p_event -> 'payload' ->> 'project_number';
  p projects; v_ap approvals; v_key text; v_claimed boolean; v_pe processed_events; v_emp employees;
  v_prev jsonb; v_hash text; v_inv invoices; v_run uuid; v_res jsonb; v_exc text; v_class text; v_msg text;
  v_tenant text := (select value from app_settings where key = 'xero.demo_tenant_id');
  v_line jsonb; v_gen int;
begin
  select * into e from wf_invoice_log_event(p_event, coalesce(nullif(v_type, ''), 'invoice.approved'), p_worker);
  if v_type not in ('invoice.approved', 'invoice.rejected') then
    e.issues := array_append(e.issues, 'event_type: must be invoice.approved or invoice.rejected'::text);
  end if;
  if array_length(e.issues, 1) > 0 then
    v_exc := wf_open_invoice_rejection(e.event_id, null, coalesce(v_prj, 'unknown'), 'VALIDATION_ERROR',
               'Invalid invoice decision event: ' || array_to_string(e.issues, '; '));
    update automation_events set status = 'REJECTED', error_class = 'VALIDATION_ERROR' where event_id = e.event_id;
    return jsonb_build_object('outcome', 'INVALID_EVENT', 'error_class', 'VALIDATION_ERROR', 'issues', to_jsonb(e.issues), 'exception_number', v_exc);
  end if;

  select * into p from projects where project_number = v_prj;
  if p.id is not null then
    select * into v_ap from approvals a where a.action_type = 'CREATE_INVOICE' and a.entity_id = p.id
       and (coalesce(p_event -> 'payload' ->> 'approval_number', '') = '' or a.approval_number = p_event -> 'payload' ->> 'approval_number')
     order by (a.status = 'PENDING') desc, a.created_at desc limit 1;
  end if;
  if p.id is null or v_ap.id is null then
    v_class := case when p.id is null then 'NOT_FOUND' else 'INVALID_STATE' end;
    v_msg := case when p.id is null then v_prj || ' does not exist' else 'No invoice preview to decide for ' || v_prj || '; prepare one first' end;
    v_exc := wf_open_invoice_rejection(e.event_id, p.id, v_prj, v_class, v_msg);
    update automation_events set status = 'REJECTED', error_class = v_class, metadata = metadata || jsonb_build_object('reason', v_msg) where event_id = e.event_id;
    return jsonb_build_object('outcome', 'INVALID_STATE', 'error_class', v_class, 'message', v_msg, 'exception_number', v_exc, 'project_number', v_prj);
  end if;

  -- One decision per approval, however many times (or ways) it is delivered.
  v_key := 'invoice.decision:' || v_ap.approval_number;
  insert into processed_events (consumer, idempotency_key, first_event_id, request_hash, status, locked_by, lease_expires_at)
  values ('invoice_decision@1', v_key, e.event_id, md5(v_ap.approval_number), 'PROCESSING', p_worker, now() + interval '5 minutes')
  on conflict do nothing returning true into v_claimed;
  if v_claimed is null then
    select * into v_pe from processed_events where consumer = 'invoice_decision@1' and idempotency_key = v_key for update;
    update processed_events set delivery_count = delivery_count + 1, last_seen_at = now() where consumer = v_pe.consumer and idempotency_key = v_key;
    update automation_events set status = 'DUPLICATE_IGNORED', error_class = 'DUPLICATE_EVENT', causation_id = v_pe.first_event_id,
           metadata = metadata || jsonb_build_object(
             'reason', case when e.redelivery then 'transport redelivery of the same event_id' else 'semantic duplicate: ' || v_ap.approval_number || ' was already decided' end,
             'delivery_count', v_pe.delivery_count + 1)
     where event_id = e.event_id;
    return coalesce(v_pe.result, '{}'::jsonb) || jsonb_build_object('outcome', 'ALREADY_PROCESSED', 'first_outcome', v_pe.result ->> 'outcome',
      'duplicate', true, 'delivery_count', v_pe.delivery_count + 1,
      'pending_side_effects', (select coalesce(jsonb_agg(jsonb_build_object('topic', topic, 'key', idempotency_key, 'status', status)), '[]')
                                 from outbox where aggregate_id = (v_pe.result ->> 'invoice_id')::uuid and status <> 'DONE'));
  end if;

  -- Authorisation: the Airtable user must map to an active employee in an approving role.
  select emp.* into v_emp from employee_external_identities ei join employees emp on emp.id = ei.employee_id
   where ei.provider = 'AIRTABLE' and ei.external_id = p_event ->> 'actor_id' and emp.is_active;
  if v_emp.id is null or not (v_emp.role = any (string_to_array((select value from app_settings where key = 'invoice.approver_roles'), ','))) then
    v_class := 'PERMISSION_DENIED';
    v_msg := format('Airtable user %s is not an authorised invoice approver (%s)', p_event ->> 'actor_id', coalesce(v_emp.role, 'not mapped to an employee'));
  elsif v_ap.status <> 'PENDING' then
    v_class := 'INVALID_STATE'; v_msg := format('%s is %s; only a PENDING preview can be decided', v_ap.approval_number, v_ap.status);
  elsif v_ap.expires_at <= now() then
    update approvals set status = 'EXPIRED' where id = v_ap.id;
    v_class := 'INVALID_STATE'; v_msg := format('%s expired at %s; prepare a new preview', v_ap.approval_number, v_ap.expires_at);
  elsif v_type = 'invoice.approved' then
    v_prev := invoice_final_preview(p.id);
    v_hash := case when (v_prev ->> 'ok')::boolean then invoice_preview_hash(v_prev -> 'preview') end;
    if v_hash is distinct from v_ap.payload_hash then
      update approvals set status = 'CANCELLED', decision_reason = 'Stale: the invoice would differ from the approved preview' where id = v_ap.id;
      v_class := 'INVALID_STATE';
      v_msg := format('%s is stale: %s. Prepare a new preview', v_ap.approval_number, coalesce(v_prev ->> 'message', 'the amount or details changed since it was prepared'));
    elsif coalesce(v_tenant, '') = '' then
      v_class := 'INVALID_STATE'; v_msg := 'No Xero Demo Company tenant is pinned (app_settings xero.demo_tenant_id); refusing to queue a Xero write';
    end if;
  end if;

  if v_class is not null then
    delete from processed_events where consumer = 'invoice_decision@1' and idempotency_key = v_key;   -- a corrected retry may decide later
    v_exc := wf_open_invoice_rejection(e.event_id, p.id, v_prj, v_class, v_msg);
    update automation_events set status = 'REJECTED', error_class = v_class, metadata = metadata || jsonb_build_object('reason', v_msg) where event_id = e.event_id;
    return jsonb_build_object('outcome', case when v_class = 'PERMISSION_DENIED' then 'PERMISSION_DENIED' else 'INVALID_STATE' end,
      'error_class', v_class, 'message', v_msg, 'exception_number', v_exc, 'approval_number', v_ap.approval_number, 'project_number', v_prj);
  end if;

  if v_type = 'invoice.rejected' then
    update approvals set status = 'REJECTED', decided_by = v_emp.id, decided_at = now(),
           decision_reason = coalesce(nullif(p_event -> 'payload' ->> 'reason', ''), 'Rejected in Airtable') where id = v_ap.id;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason, correlation_id)
    values ('USER', v_emp.employee_code, 'approval.reject', 'approval', v_ap.id, v_ap.approval_number,
            jsonb_build_object('status', 'PENDING'), jsonb_build_object('status', 'REJECTED'), 'Invoice preview rejected', e.correlation_id);
    v_res := jsonb_build_object('outcome', 'REJECTED_BY_APPROVER', 'approval_number', v_ap.approval_number, 'decided_by', v_emp.full_name);
  else
    -- Approve: the RoofOps invoice (one FINAL per project, ever) + ONE queued Xero side effect.
    update approvals set status = 'EXECUTING', decided_by = v_emp.id, decided_at = now() where id = v_ap.id;
    insert into invoices (invoice_number, project_id, customer_id, invoice_type, status, sync_status, line_amount_type,
                          issue_date, due_date, approval_id, approved_by, approved_at, idempotency_key)
    values (next_friendly_id('INV', extract(year from app_today())::int), p.id, p.customer_id, 'FINAL', 'APPROVED', 'PENDING', 'INCLUSIVE',
            (v_ap.action_payload ->> 'invoice_date')::date, (v_ap.action_payload ->> 'due_date')::date, v_ap.id, v_emp.id, now(),
            'invoice:final:' || p.id)
    returning * into v_inv;
    for v_line in select * from jsonb_array_elements(v_ap.action_payload -> 'lines') loop
      insert into invoice_lines (invoice_id, line_no, description, quantity, unit_price, variation_id, account_code)
      values (v_inv.id, (v_line ->> 'line_no')::int, v_line ->> 'description', (v_line ->> 'quantity')::numeric, (v_line ->> 'unit_amount')::numeric,
              nullif(v_line ->> 'variation_id', '')::uuid, v_ap.action_payload ->> 'xero_account_code');
    end loop;
    select * into v_inv from invoices where id = v_inv.id;   -- totals are derived by trigger from the lines
    if v_inv.total_inc_gst <> (v_ap.action_payload ->> 'amount_inc_gst')::numeric or v_inv.gst_amount <> (v_ap.action_payload ->> 'gst_amount')::numeric then
      raise exception 'invoice % totals % / GST % disagree with the approved preview % / %', v_inv.invoice_number, v_inv.total_inc_gst, v_inv.gst_amount,
        v_ap.action_payload ->> 'amount_inc_gst', v_ap.action_payload ->> 'gst_amount' using errcode = 'check_violation';
    end if;

    insert into workflow_runs (workflow_key, workflow_version, runner, trigger_event_id, correlation_id, idempotency_key,
                               entity_type, entity_id, business_reference, status, attempt_count, started_at)
    values ('project_to_invoice', (select value from app_settings where key = 'wf.project_to_invoice.version'), 'N8N', e.event_id, e.correlation_id,
            v_key, 'invoice', v_inv.id, v_inv.invoice_number, 'RUNNING', 1, now())
    returning id into v_run;
    -- AC-14C B1: this approval queues a generation, and the generation owns the keys. A first-time invoice gets
    -- generation 1 - the historic key formats, byte for byte - and the reissue facility (Part B2) queues the next one.
    v_gen := coalesce((select max(o.generation) from outbox o where o.topic = 'xero.create_draft_invoice' and o.aggregate_id = v_inv.id), 0) + 1;
    insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, generation)
    values ('xero.create_draft_invoice', 'invoice', v_inv.id, e.correlation_id, xero_draft_outbox_key(v_inv.id, v_gen),
      v_ap.action_payload || jsonb_build_object(
        'invoice_id', v_inv.id, 'invoice_number', v_inv.invoice_number,
        'xero_invoice_number', (v_ap.action_payload ->> 'xero_invoice_number_prefix') || v_inv.invoice_number,
        'xero_tenant_id', v_tenant, 'approval_number', v_ap.approval_number, 'approved_by', v_emp.full_name,
        'project_airtable_record_id', (select external_id from external_links where provider = 'AIRTABLE' and entity_type = 'project'
                                         and entity_id = p.id and verified_at is not null),
        'xero_idempotency_key', xero_draft_provider_key(v_inv.id, v_gen)), v_gen);
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason, correlation_id, workflow_run_id)
    values ('USER', v_emp.employee_code, 'approval.approve', 'approval', v_ap.id, v_ap.approval_number,
            jsonb_build_object('status', 'PENDING'), jsonb_build_object('status', 'EXECUTING', 'payload_hash', v_ap.payload_hash),
            'Final invoice approved by ' || v_emp.full_name, e.correlation_id, v_run),
           ('WORKFLOW', 'project_to_invoice@1', 'invoice.create', 'invoice', v_inv.id, v_inv.invoice_number, null,
            jsonb_build_object('project', v_prj, 'type', 'FINAL', 'status', 'APPROVED', 'total_inc_gst', v_inv.total_inc_gst, 'gst', v_inv.gst_amount),
            'Created from approved preview ' || v_ap.approval_number, e.correlation_id, v_run);
    insert into workflow_run_steps (run_id, attempt, seq, step_key, status, finished_at, detail) values
      (v_run, 1, 1, 'validate_event', 'SUCCEEDED', now(), '{}'),
      (v_run, 1, 2, 'authorise_approver', 'SUCCEEDED', now(), jsonb_build_object('employee', v_emp.employee_code, 'role', v_emp.role)),
      (v_run, 1, 3, 'recheck_preview_hash', 'SUCCEEDED', now(), jsonb_build_object('payload_hash', v_ap.payload_hash)),
      (v_run, 1, 4, 'create_invoice', 'SUCCEEDED', now(), jsonb_build_object('invoice_number', v_inv.invoice_number, 'total_inc_gst', v_inv.total_inc_gst)),
      (v_run, 1, 5, 'queue_xero_draft', 'SUCCEEDED', now(), jsonb_build_object('key', xero_draft_outbox_key(v_inv.id, v_gen), 'generation', v_gen));
    perform wf_log_event(e.event_key || ':invoice.approved', e.correlation_id, e.event_id, 'invoice.created', 'invoice', v_inv.id,
      v_inv.invoice_number, 'WORKFLOW', 'project_to_invoice@1', 'postgres', 'SUCCEEDED', null,
      jsonb_build_object('approval', v_ap.approval_number, 'total_inc_gst', v_inv.total_inc_gst), null);
    v_res := jsonb_build_object('outcome', 'APPROVED', 'approval_number', v_ap.approval_number, 'decided_by', v_emp.full_name,
      'invoice_id', v_inv.id, 'invoice_number', v_inv.invoice_number, 'amount_inc_gst', v_inv.total_inc_gst, 'workflow_run_id', v_run,
      'xero_key', xero_draft_outbox_key(v_inv.id, v_gen), 'generation', v_gen, 'preview', v_ap.action_payload);
  end if;

  update automation_events set status = 'SUCCEEDED', metadata = metadata || jsonb_build_object('outcome', v_res ->> 'outcome') where event_id = e.event_id;
  v_res := v_res || jsonb_build_object('project_number', v_prj, 'project_id', p.id, 'event_key', e.event_key, 'duplicate', false);
  update processed_events set status = 'COMPLETED', completed_at = now(), result = v_res, lease_expires_at = null
   where consumer = 'invoice_decision@1' and idempotency_key = v_key;
  return v_res;
end $$;
revoke execute on function wf_invoice_decide_core(jsonb, text) from public;

-- -----------------------------------------------------------------------------
-- 7. Generation-aware lookups (H1, H2, H3, H4, H5, H7 + invoice_xero_state).
-- -----------------------------------------------------------------------------
-- H1. xero_record_settlement: the read's tenant is checked against the CURRENT draft write's bound tenant. With a
--     replacement generation queued, a read in the superseded generation's tenant is WRONG_TENANT and applies nothing.
create or replace function xero_record_settlement(p_run_key text, p_results jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run reconciliation_runs; x jsonb; d jsonb; i invoices; v_link text; v_bound text; v_pin text := (select nullif(value, '') from app_settings where key = 'xero.demo_tenant_id');
  v_verdict text; v_settle text; v_target text; v_path text[]; v_step text; v_detail text; v_obs uuid; v_repair boolean; v_rank jsonb := '{"APPROVED":0,"ISSUED":1,"PARTIALLY_PAID":2,"PAID":3}';
  v_counts jsonb := '{}'::jsonb; v_applied int := 0; v_regressed int := 0; v_from text; v_observed xero_invoice_observations;
begin
  select * into v_run from reconciliation_runs where run_key = p_run_key and status = 'RUNNING';
  if v_run.id is null then return jsonb_build_object('ok', false); end if;
  v_repair := v_run.mode = 'repair';
  for x in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
    select inv.* into i from invoices inv join external_links l on l.entity_id = inv.id and l.provider = 'XERO' and l.external_type = 'Invoice'
     where l.external_id = x ->> 'invoice_id' for update of inv;
    continue when i.id is null;
    v_link := x ->> 'invoice_id';
    v_bound := (select payload ->> 'xero_tenant_id' from outbox_current('xero.create_draft_invoice', i.id));
    d := coalesce(x -> 'xero', '{}'::jsonb);
    v_settle := null; v_detail := null;
    if x ->> 'tenant_id' is null or v_bound is null or x ->> 'tenant_id' <> v_bound or v_bound is distinct from v_pin then
      v_verdict := 'WRONG_TENANT';
      v_detail := format('%s was read in Xero tenant %s, but its write is bound to %s and the pinned tenant is %s; that read is not trusted',
        i.invoice_number, coalesce(left(x ->> 'tenant_id', 8) || '…', 'none'), coalesce(left(v_bound, 8) || '…', 'none'), coalesce(left(v_pin, 8) || '…', 'none'));
    elsif coalesce((x ->> 'http')::int, 0) <> 200 then
      v_verdict := 'LOOKUP_FAILED';
      v_detail := format('%s could not be read from Xero (%s); nothing is assumed', i.invoice_number, coalesce('HTTP ' || (x ->> 'http'), x ->> 'error', 'no answer'));
    elsif d ->> 'InvoiceID' is distinct from v_link or d ->> 'Type' is distinct from 'ACCREC'
          or d ->> 'InvoiceNumber' is distinct from x ->> 'xero_invoice_number' or (d ->> 'Total')::numeric is distinct from i.total_inc_gst then
      v_verdict := 'MISMATCH';
      v_detail := format('%s: Xero returned %s %s %s total %s, not the linked invoice %s %s total %s', i.invoice_number,
        coalesce(d ->> 'Type', '?'), coalesce(d ->> 'InvoiceNumber', '?'), coalesce(d ->> 'InvoiceID', '?'), coalesce(d ->> 'Total', '?'),
        x ->> 'xero_invoice_number', v_link, i.total_inc_gst);
    else
      v_settle := xero_settlement(d ->> 'Status', (d ->> 'Total')::numeric, (d ->> 'AmountDue')::numeric, (d ->> 'AmountPaid')::numeric, (d ->> 'AmountCredited')::numeric);
      v_verdict := case when v_settle is null then 'INCONSISTENT' else 'VERIFIED' end;
      if v_settle is null then
        v_detail := format('%s: Xero says %s with total %s, paid %s, credited %s, due %s; that does not add up, so nothing is assumed', i.invoice_number,
          d ->> 'Status', d ->> 'Total', d ->> 'AmountPaid', coalesce(d ->> 'AmountCredited', '0'), d ->> 'AmountDue');
      end if;
    end if;
    insert into xero_invoice_observations (invoice_id, run_id, tenant_id, bound_tenant_id, xero_invoice_id, http_status, verdict, xero_status, total,
      amount_due, amount_paid, amount_credited, fully_paid_on, xero_updated, payments, settlement, detail)
    values (i.id, v_run.id, x ->> 'tenant_id', v_bound, v_link, (x ->> 'http')::int, v_verdict, d ->> 'Status', (d ->> 'Total')::numeric,
      (d ->> 'AmountDue')::numeric, (d ->> 'AmountPaid')::numeric, coalesce((d ->> 'AmountCredited')::numeric, case when v_verdict = 'VERIFIED' then 0 end),
      case when d ->> 'FullyPaidOnDate' ~ '^\d{4}-\d{2}-\d{2}' then left(d ->> 'FullyPaidOnDate', 10)::date end, d ->> 'UpdatedDateUTC',
      (select jsonb_agg(jsonb_build_object('payment_id', y ->> 'PaymentID', 'amount', y -> 'Amount', 'date', y ->> 'Date', 'status', y ->> 'Status'))
         from jsonb_array_elements(coalesce(d -> 'Payments', '[]'::jsonb)) y), v_settle, v_detail)
    on conflict (invoice_id, run_id) do nothing
    returning id into v_obs;
    continue when v_obs is null;                         -- this run already recorded this invoice
    v_counts := jsonb_set(v_counts, array[lower(v_verdict)], to_jsonb(coalesce((v_counts ->> lower(v_verdict))::int, 0) + 1));
    if v_verdict = 'WRONG_TENANT' then
      insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, classification, action, detail)
      values (v_run.id, 'XERO', 'invoice', i.invoice_number, v_link, 'UNAUTHORIZED_STATE', case when v_repair then 'EXCEPTION_OPENED' else 'NONE_OBSERVE_ONLY' end, v_detail);
      if v_repair then perform wf_open_sync_exception('reconciliation', 'invoice', i.id, i.invoice_number, 'PERMISSION_DENIED', v_detail); end if;
    elsif v_verdict in ('MISMATCH', 'INCONSISTENT') then
      insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, classification, action, detail)
      values (v_run.id, 'XERO', 'invoice', i.invoice_number, v_link, 'REQUIRES_HUMAN', case when v_repair then 'EXCEPTION_OPENED' else 'NONE_OBSERVE_ONLY' end, v_detail);
      if v_repair then perform wf_open_sync_exception('reconciliation', 'invoice', i.id, i.invoice_number, 'RECONCILIATION_MISMATCH', v_detail); end if;
    end if;
    -- Apply: verified, a settled write (AC-04: never UNKNOWN/PENDING), and a state RoofOps can follow.
    continue when v_verdict <> 'VERIFIED' or i.sync_status <> 'SYNCED';
    -- AC-14C: a deletion is a void only when no money ever moved on the invoice, here or in Xero. Otherwise a person
    -- decides: RoofOps must not write the invoice off while a payment or a credit exists somewhere.
    if v_settle = 'DELETED' then
      select * into v_observed from xero_invoice_observations where id = v_obs;
      if v_observed.amount_paid is null or v_observed.amount_paid <> 0 or coalesce(v_observed.amount_credited, 0) <> 0
         or exists (select 1 from payments where invoice_id = i.id) then
        v_detail := format('%s was deleted in Xero, but money moved on it (Xero paid %s, credited %s; %s local payment row(s)); it is not voided without a person: check the customer account first',
          i.invoice_number, coalesce(v_observed.amount_paid::text, 'unknown'), coalesce(v_observed.amount_credited::text, '0'),
          (select count(*) from payments where invoice_id = i.id));
        insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, classification, action, detail)
        values (v_run.id, 'XERO', 'invoice', i.invoice_number, v_link, 'REQUIRES_HUMAN', case when v_repair then 'EXCEPTION_OPENED' else 'NONE_OBSERVE_ONLY' end, v_detail);
        if v_repair then perform wf_open_sync_exception('reconciliation', 'invoice', i.id, i.invoice_number, 'RECONCILIATION_MISMATCH', v_detail); end if;
        continue;
      end if;
    end if;
    v_target := xero_settlement_status(v_settle);
    continue when v_target is null or v_target = i.status;
    v_path := case
      when v_target = 'VOIDED' and i.status in ('APPROVED', 'ISSUED') then array['VOIDED']
      when i.status = 'VOIDED' or v_target = 'VOIDED' then null
      when state_transition_allowed('invoice', i.status, v_target) then array[v_target]
      when i.status = 'APPROVED' and v_target in ('PARTIALLY_PAID', 'PAID') then array['ISSUED', v_target]
    end;
    if v_path is null then
      v_detail := format('%s is %s in RoofOps but Xero verified %s (%s); RoofOps cannot follow that change, a person must check',
        i.invoice_number, i.status, d ->> 'Status', lower(replace(v_settle, '_', ' ')));
      insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, classification, action, detail)
      values (v_run.id, 'XERO', 'invoice', i.invoice_number, v_link, 'REQUIRES_HUMAN', case when v_repair then 'EXCEPTION_OPENED' else 'NONE_OBSERVE_ONLY' end, v_detail);
      if v_repair then perform wf_open_sync_exception('reconciliation', 'invoice', i.id, i.invoice_number, 'RECONCILIATION_MISMATCH', v_detail); end if;
      continue;
    end if;
    v_detail := format('%s: Xero verified %s (due %s); RoofOps shows %s', i.invoice_number, lower(replace(v_settle, '_', ' ')), coalesce(d ->> 'AmountDue', '?'), i.status);
    if not v_repair then
      insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, classification, action, detail)
      values (v_run.id, 'XERO', 'invoice', i.invoice_number, v_link, 'SAFE_AUTO_REPAIR', 'NONE_OBSERVE_ONLY', v_detail || '; a repair run applies it');
      continue;
    end if;
    v_from := i.status;
    foreach v_step in array v_path loop
      update invoices set status = v_step,
        issue_date = case when v_step in ('ISSUED', 'PARTIALLY_PAID', 'PAID') then coalesce(issue_date, case when d ->> 'Date' ~ '^\d{4}-\d{2}-\d{2}' then left(d ->> 'Date', 10)::date end, app_today()) else issue_date end,
        due_date = case when v_step in ('ISSUED', 'PARTIALLY_PAID', 'PAID') then coalesce(due_date, case when d ->> 'DueDate' ~ '^\d{4}-\d{2}-\d{2}' then left(d ->> 'DueDate', 10)::date end,
                     coalesce(issue_date, app_today()) + (select value::int from app_settings where key = 'invoice.payment_terms_days')) else due_date end,
        voided_reason = case when v_step <> 'VOIDED' then voided_reason
                             when v_settle = 'DELETED' then format('Deleted in Xero (verified by reconciliation %s)', p_run_key)
                             else format('Voided in Xero (verified by reconciliation %s)', p_run_key) end
      where id = i.id;
      insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, external_reference, reason)
      values ('SYSTEM', 'workflow:reconciliation', 'invoice.xero_settlement_applied', 'invoice', i.id, i.invoice_number,
              jsonb_build_object('status', i.status), jsonb_build_object('status', v_step, 'xero_status', d ->> 'Status', 'amount_due', d -> 'AmountDue',
                'amount_paid', d -> 'AmountPaid', 'observation', v_obs), v_link,
              format('Reconciliation %s: Xero verified %s in tenant %s', p_run_key, lower(replace(v_settle, '_', ' ')), left(x ->> 'tenant_id', 8) || '…'));
      i.status := v_step;
    end loop;
    v_applied := v_applied + 1;
    insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, classification, action, detail)
    values (v_run.id, 'XERO', 'invoice', i.invoice_number, v_link, 'SAFE_AUTO_REPAIR', 'APPLIED_TO_POSTGRES', v_detail || '; applied');
    if v_target <> 'VOIDED' and (v_rank ->> v_target)::int < (v_rank ->> v_from)::int then   -- a payment reversed in Xero
      v_regressed := v_regressed + 1;
      perform wf_open_sync_exception('reconciliation', 'invoice', i.id, i.invoice_number, 'RECONCILIATION_MISMATCH',
        format('%s went back to %s: Xero now shows %s (due %s), so a payment was reversed or removed in Xero. A person must check with the customer%s',
          i.invoice_number, v_target, d ->> 'Status', d ->> 'AmountDue',
          case when (select status from projects where id = i.project_id) = 'CLOSED' then '; the project is already Closed' else '' end));
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'verdicts', v_counts, 'applied', v_applied, 'regressed', v_regressed);
end $$;

-- H2. wf_reconcile_targets_core: the number 07 read back is the CURRENT generation's.
create or replace function wf_reconcile_targets_core(p_run_key text)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'drive', coalesce((select jsonb_agg(jsonb_build_object('project_number', p.project_number, 'folder_id', l.external_id))
                       from external_links l join projects p on p.id = l.entity_id
                       where l.provider = 'GOOGLE_DRIVE' and l.entity_type = 'project' and l.external_type = 'Folder' and l.verified_at is not null), '[]'::jsonb),
    'xero', coalesce((select jsonb_agg(jsonb_build_object('invoice_number', i.invoice_number, 'project_number', p.project_number, 'invoice_id', l.external_id,
                        'tenant_id', (select value from app_settings where key = 'xero.demo_tenant_id'),
                        'xero_invoice_number', (select payload ->> 'xero_invoice_number' from outbox_current('xero.create_draft_invoice', i.id)),
                        'total', i.total_inc_gst, 'reference', p.project_number))
                      from external_links l join invoices i on i.id = l.entity_id join projects p on p.id = i.project_id
                      where l.provider = 'XERO' and l.external_type = 'Invoice' and l.verified_at is not null), '[]'::jsonb))
  where exists (select 1 from reconciliation_runs where run_key = p_run_key and status = 'RUNNING')
$$;

-- H3. The Airtable invoice projection: the number shown is the CURRENT generation's.
create or replace view v_airtable_expected as
select 'tblvUPIoebC3zoacv'::text as table_id, 'project'::text as entity_type, p.id as entity_id, p.project_number as business_key, l.external_id as record_id,
  jsonb_strip_nulls(jsonb_build_object(
    'fldhhnQXlbuFaveK3', p.project_number, 'fld08eKCeuDCsJLjz', at_link('quote', p.quote_id), 'fldG4mPoV6sUkA9rM', at_link('customer', p.customer_id),
    'fldi2Qwz1dAh2tcTE', sm_label('project', p.status), 'fldc4T0AgU3zCmANC', p.id::text)) ||
  jsonb_build_object(
    'fldnZcRBxG7hTebD5', to_jsonb(e.full_name), 'fld8rf6RZLgfs6Ron', to_jsonb(p.planned_start_date::text), 'fldvZtiassZEgLMAN', to_jsonb(p.planned_completion_date::text),
    'fldIje5e0a72cBfVD', to_jsonb(p.actual_start_date::text), 'fldWKRobTLlOjeN9j', to_jsonb(p.actual_completion_date::text),
    'fldgVDT29UOOOtlqO', to_jsonb((select d.external_url from external_links d where d.provider = 'GOOGLE_DRIVE' and d.entity_type = 'project'
                                     and d.external_type = 'Folder' and d.entity_id = p.id and d.verified_at is not null)),
    -- AC-13A: completion gate (the label staff pick in Airtable; blank where the project has no such item).
    'fldbbksVL3dT6cqyS', to_jsonb((select checklist_at_label(ci.status) from project_checklist_items ci where ci.project_id = p.id and ci.item_code = 'COMPLETION_PHOTOS')),
    'fldf7iJiyHFxOQgUy', to_jsonb((select checklist_at_label(ci.status) from project_checklist_items ci where ci.project_id = p.id and ci.item_code = 'COMPLIANCE_CERTIFICATE'))) ||
  -- Invoice projection, only where canonical invoice state is stable (never mid-flight).
  case
    when fi.sync_status = 'SYNCED' then jsonb_build_object('fldPuGgo27oWLKB5R', 'Xero draft created', 'fld5JDnWI3RFehQxA', fi.total_inc_gst,
      -- The current generation's number, written out rather than called: a function inside a view is executed with the
      -- CALLER's privileges (PostgreSQL), and roofops_dashboard reads this view - it must not need outbox_current, a
      -- SECURITY DEFINER function (scripts/security-check.ts pins exactly which of those the dashboard role may run).
      -- Same rule as outbox_current(): greatest generation for the invoice, ties broken by created_at then id.
      'fldgkN0Vm6k1MZLJp', (select o.payload ->> 'xero_invoice_number' from outbox o
                             where o.topic = 'xero.create_draft_invoice' and o.aggregate_id = fi.id
                             order by o.generation desc, o.created_at desc, o.id desc limit 1),
      'fld3sDI9LIX8Voo4u', (select external_id from external_links where provider = 'XERO' and external_type = 'Invoice' and entity_id = fi.id and verified_at is not null))
    when fi.id is not null then '{}'::jsonb
    when pa.id is not null and pa.created_at < now() - interval '2 minutes' then jsonb_build_object('fldPuGgo27oWLKB5R', 'Awaiting approval',
      'fld5JDnWI3RFehQxA', (pa.action_payload ->> 'amount_inc_gst')::numeric, 'fldgkN0Vm6k1MZLJp', null, 'fld3sDI9LIX8Voo4u', null)
    when pa.id is not null then '{}'::jsonb
    else jsonb_build_object('fldPuGgo27oWLKB5R', jsonb_build_object('$not_in', jsonb_build_array('Awaiting approval', 'Xero draft created', 'Approved - creating in Xero'), '$repair', null),
                            'fldgkN0Vm6k1MZLJp', null, 'fld3sDI9LIX8Voo4u', null)
  end as expected
from projects p
join external_links l on l.provider = 'AIRTABLE' and l.entity_type = 'project' and l.external_type = 'Record' and l.entity_id = p.id
left join employees e on e.id = p.project_manager_id
left join lateral (select * from invoices i where i.project_id = p.id and i.invoice_type = 'FINAL' and i.status <> 'VOIDED' order by created_at desc limit 1) fi on true
left join lateral (select * from approvals a where a.entity_id = p.id and a.action_type = 'CREATE_INVOICE' and a.status = 'PENDING' order by created_at desc limit 1) pa on true
union all
select 'tblzenPRNVV5O7lZP', 'quote', q.id, q.quote_number, l.external_id,
  jsonb_build_object(
    'fldyP20HNafS614d5', q.quote_number, 'fld4LsEu8c9EMFj0h', at_link('customer', q.customer_id), 'fldisUv1ckHz2Detv', at_link('property', q.property_id),
    'fldQpTa5tvrzlNg1h', sm_label('quote', q.status), 'fldEjEqlzE8Y0M1nf', qv.version_number, 'fldbfUE8DVh1Dwjfs', qv.total_inc_gst,
    'fldOaXGsOgYHuWFYg', case q.job_type when 'FULL_REROOF' then 'Full Re-roof' else at_title(q.job_type) end,
    'fldhY6d0ikMnsc7D3', at_title(i.roof_type), 'fldLjvBaV1EFB5RMG', i.roof_area_sqm, 'fld5Bz9FDhJSPibPk', est.full_name,
    'flduF4QFGUWbkuR2d', at_title(q.lead_source), 'fldHSFkvwuVLfAS7J', q.created_on::text, 'fldMnoHiondm5jBWv', q.sent_on::text,
    'fldfhsHggkGd8GKVq', q.accepted_on::text, 'fld1sZibwdMVnI4Hd', q.lost_reason, 'fldVUpqZkVKid3Fyy', q.id::text)
from quotes q
join external_links l on l.provider = 'AIRTABLE' and l.entity_type = 'quote' and l.external_type = 'Record' and l.entity_id = q.id
join lateral (select * from quote_versions v where v.quote_id = q.id order by version_number desc limit 1) qv on true
left join inspections i on i.id = q.inspection_id
left join employees est on est.id = q.estimator_id
union all
select 'tbluIbl4zpMiAlMVw', 'purchase_order', po.id, po.po_number, l.external_id,
  jsonb_build_object(
    'fld1yW7kd8vY975Tj', po.po_number, 'fldDVMu2hgtSVuJyR', at_link('project', po.project_id), 'fldnYTAgdcNXWUMfP', at_link('supplier', po.supplier_id),
    'fldMtDddp1Rm4tDHf', sm_label('purchase_order', po.status), 'fldqNNcA85jAC9FxM', po.po_date::text, 'fldqkJourPRGAcJya', po.expected_delivery_date::text,
    'fld8Muyf7XVB91CjK', po.subtotal_ex_gst, 'fldJ4Z5Rg5adnEFU0', po.supplier_reference, 'fldnzaXx4TTTjCakj', po.id::text)
from purchase_orders po
join external_links l on l.provider = 'AIRTABLE' and l.entity_type = 'purchase_order' and l.external_type = 'Record' and l.entity_id = po.id
union all
select 'tblHKX79FJFHn5FDc', 'customer', c.id, c.customer_number, l.external_id,
  jsonb_build_object(
    'fldzmWSHtLVZ4OTmZ', c.customer_number, 'fldI46VewtlNRnwui', c.display_name, 'fldNcSkEiFnb8m4XP', c.email, 'fldvBKPgd3UeIDYO4', c.phone,
    'fldisVgB2WysksjwW', at_title(c.customer_type), 'fldfNc5n8m2kjiRcB', case when c.preferred_contact = 'SMS' then 'SMS' else at_title(c.preferred_contact) end,
    'fldNu4bbDXjMbwmZ8', c.customer_since::text,
    'fldPXNXPyYie2kKQk', (select b.customer_number from customer_match_candidates m join customers b on b.id = case when m.customer_id = c.id then m.candidate_customer_id else m.customer_id end
                           where c.id in (m.customer_id, m.candidate_customer_id) and c.customer_number > b.customer_number limit 1),
    'fldDClu1e0ffwnojn', c.id::text)
from customers c
join external_links l on l.provider = 'AIRTABLE' and l.entity_type = 'customer' and l.external_type = 'Record' and l.entity_id = c.id
union all
select 'tblSYcCqId9wTMg3c', 'property', pr.id, pr.property_number, l.external_id,
  jsonb_build_object(
    'fldIy8ab7Ky67jL31', pr.property_number, 'fldu0CsGG5uPOVbRN', pr.address_line1, 'fldl6gKbKuZSF9MJG', pr.suburb, 'fldYjfr3STs04XDZr', pr.state,
    'flduw5J4VyRoOqEE2', pr.postcode, 'fldMH8wYXmkAYXCxe', at_title(pr.property_type), 'fldhsHUPCZ0pMbXeV', pr.storeys, 'fldP4PWGxdLZrA5ge', pr.access_notes,
    'fldVpX0MOcA8TnGvo', (select at_link('customer', cp.customer_id) from customer_properties cp where cp.property_id = pr.id and cp.relationship = 'OWNER' limit 1),
    'fldm6rtleyV6yp8ZS', pr.id::text)
from properties pr
join external_links l on l.provider = 'AIRTABLE' and l.entity_type = 'property' and l.external_type = 'Record' and l.entity_id = pr.id
union all
select 'tbloPJwCIcdIZQFVK', 'supplier', s.id, s.supplier_code, l.external_id,
  jsonb_build_object(
    'fldNy5hhua9oCbrge', s.supplier_code, 'fldmyVulHN1hsCE8f', s.name, 'fldPtnT9heTBGTFEM', s.orders_email, 'fldtNq7DluPgIM1rn', s.phone,
    'fldfXKzmQJYzbzgZY', s.default_lead_time_days, 'fldLNYP5FsVaR6TFk', s.id::text)
from suppliers s
join external_links l on l.provider = 'AIRTABLE' and l.entity_type = 'supplier' and l.external_type = 'Record' and l.entity_id = s.id;

-- H4. invoice_void_guard: the statuses it refuses on are the CURRENT generation's. With a replacement generation
--     queued (PENDING) behind a superseded DONE row, a void is refused as "queued"; with a superseded PENDING row
--     behind a DONE current generation, it is refused as "draft exists". Never the arbitrary row.
create or replace function invoice_void_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare o outbox;
begin
  select * into o from outbox_current('xero.create_draft_invoice', new.id);
  if o.id is null then return new; end if;
  -- AC-14 / AC-14C: voided or deleted in Xero, verified by reconciliation (the linked invoice, in its bound tenant):
  -- RoofOps follows Xero. A deletion with no money movement is the same business state as a void.
  if exists (select 1 from xero_invoice_observations x
              where x.id = (select id from xero_invoice_observations where invoice_id = new.id order by observed_at desc, id desc limit 1)
                and x.verdict = 'VERIFIED' and x.settlement in ('VOIDED', 'DELETED') and x.tenant_id = o.payload ->> 'xero_tenant_id'
                and x.xero_invoice_id = (select external_id from external_links where provider = 'XERO' and external_type = 'Invoice' and entity_id = new.id)) then
    return new;
  end if;
  if o.status = 'DISPATCHING' then
    raise exception '% cannot be voided: its Xero draft is being created right now. Try again when that has finished', old.invoice_number using errcode = 'check_violation';
  end if;
  if old.sync_status = 'SYNCED' or o.status = 'DONE'
     or exists (select 1 from external_links where provider = 'XERO' and external_type = 'Invoice' and entity_id = new.id) then
    raise exception '% cannot be voided: its Xero draft exists (%). Void or delete it in Xero first', old.invoice_number,
      coalesce(o.payload ->> 'xero_invoice_number', 'see the Xero link') using errcode = 'check_violation';
  end if;
  if old.sync_status = 'UNKNOWN' then
    raise exception '% cannot be voided: an earlier attempt may already exist in Xero. Run reconciliation (npm run reconcile) to settle it first', old.invoice_number
      using errcode = 'check_violation';
  end if;
  if o.status = 'PENDING' or (o.status = 'FAILED' and o.next_attempt_at <> 'infinity') then
    raise exception '% cannot be voided: its Xero draft is queued (%). Void it after the draft exists in Xero (then void it there first) or after the write has failed',
      old.invoice_number, case when o.status = 'PENDING' then 'not started yet' else 'retry scheduled' end using errcode = 'check_violation';
  end if;
  return new;   -- dead-lettered: nothing was created in Xero
end $$;

-- H5a. wf_reconcile_targets: only the CURRENT generation of an uncertain invoice is looked up, so a superseded write
--      is never settled by mistake (one row: the same row as before).
create or replace function wf_reconcile_targets(p_run_key text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from reconciliation_runs where run_key = p_run_key and scope is not null) then
    return jsonb_build_object('drive', '[]'::jsonb, 'xero', '[]'::jsonb, 'xero_uncertain', '[]'::jsonb);
  end if;
  return coalesce(wf_reconcile_targets_core(p_run_key), '{}'::jsonb) || jsonb_build_object('xero_uncertain', coalesce((
    select jsonb_agg(jsonb_build_object('key', o.idempotency_key, 'invoice_number', i.invoice_number, 'project_number', p.project_number,
             'xero_invoice_number', o.payload ->> 'xero_invoice_number', 'reference', o.payload ->> 'reference', 'tenant_id', o.payload ->> 'xero_tenant_id')
             order by i.invoice_number)
      from invoices i join outbox o on o.aggregate_id = i.id and o.topic = 'xero.create_draft_invoice' join projects p on p.id = i.project_id
     where i.sync_status = 'UNKNOWN' and o.status not in ('DONE', 'DISPATCHING')   -- a write 05 holds is left to 05
       and o.id = (select c.id from outbox_current('xero.create_draft_invoice', i.id) c)   -- the current generation only
       and o.payload ->> 'xero_tenant_id' = (select nullif(value, '') from app_settings where key = 'xero.demo_tenant_id')
       and exists (select 1 from reconciliation_runs where run_key = p_run_key and status = 'RUNNING')), '[]'::jsonb));
end $$;

-- H5b. wf_reconcile_xero_uncertain: a match whose InvoiceID is a known SUPERSEDED generation of this invoice is an
--      earlier draft, not the one being looked up, so it is discounted. For an invoice that never went through a
--      reissue nothing is discounted (no superseded rows) and every existing outcome is unchanged. The point: when a
--      replacement write timed out and Xero answers with only the old DELETED draft, that is proof of ABSENCE of the
--      new one, not a person's problem.
create or replace function wf_reconcile_xero_uncertain(p_run_key text, p_results jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run reconciliation_runs; x jsonb; o outbox; i invoices; v_pin text := (select nullif(value, '') from app_settings where key = 'xero.demo_tenant_id');
  v_num jsonb; v_live jsonb; v_other jsonb; d jsonb; v_outcome text; v_detail text; v_applied boolean; v_repair boolean;
  v_contact text; v_dead boolean; e record; v_items jsonb := '[]'; v_rec int := 0; v_abs int := 0; v_person int := 0; v_skip int := 0;
  v_superseded text[] := '{}'::text[];
begin
  select * into v_run from reconciliation_runs where run_key = p_run_key and status = 'RUNNING';
  if v_run.id is null then return jsonb_build_object('ok', false, 'reason', 'no running reconciliation ' || coalesce(p_run_key, '')); end if;
  v_repair := v_run.mode = 'repair';
  for x in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
    v_applied := false; v_detail := null; v_superseded := '{}'::text[];
    select * into o from outbox where idempotency_key = x ->> 'key' and topic = 'xero.create_draft_invoice' for update;
    select * into i from invoices where id = o.aggregate_id for update;
    if o.id is not null then v_superseded := xero_draft_superseded_ids(o.aggregate_id); end if;
    if o.id is null or i.id is null then
      v_outcome := 'UNKNOWN_KEY';
    elsif i.sync_status <> 'UNKNOWN' or o.status in ('DONE', 'DISPATCHING') then
      v_outcome := 'SKIPPED';                              -- already settled, or 05 is working on it right now
    elsif x ->> 'tenant_id' is distinct from o.payload ->> 'xero_tenant_id' or o.payload ->> 'xero_tenant_id' is distinct from v_pin then
      v_outcome := 'WRONG_TENANT';                         -- only a lookup in the bound, pinned tenant can settle it (AC-06)
      v_detail := format('%s: Xero was asked about %s in tenant %s, but the write is bound to %s and the pinned tenant is %s. Not settled; it stays uncertain. A person must check why',
        i.invoice_number, o.payload ->> 'xero_invoice_number', coalesce(left(x ->> 'tenant_id', 8) || '…', 'no tenant'),
        coalesce(left(o.payload ->> 'xero_tenant_id', 8) || '…', 'no tenant'), coalesce(left(v_pin, 8) || '…', 'none'));
      if v_repair then
        perform wf_open_sync_exception('reconciliation', 'invoice', i.id, i.invoice_number, 'PERMISSION_DENIED', v_detail);
        v_applied := true;
      end if;
      insert into reconciliation_findings (run_id, system, entity_type, entity_ref, classification, action, detail)
      values (v_run.id, 'XERO', 'invoice', i.invoice_number, 'UNAUTHORIZED_STATE', case when v_repair then 'EXCEPTION_OPENED' else 'NONE_OBSERVE_ONLY' end, v_detail);
    elsif coalesce((x ->> 'http_number')::int, (x ->> 'http')::int, 0) <> 200 or coalesce((x ->> 'http_reference')::int, (x ->> 'http')::int, 0) <> 200 then
      v_outcome := 'LOOKUP_FAILED';
    else
      select coalesce(jsonb_agg(y), '[]') into v_num from jsonb_array_elements(coalesce(x -> 'by_number', '[]')) y
       where y ->> 'InvoiceNumber' = o.payload ->> 'xero_invoice_number'
         and not (coalesce(y ->> 'InvoiceID', '') = any (v_superseded));
      select coalesce(jsonb_agg(y), '[]') into v_live from jsonb_array_elements(v_num) y where coalesce(y ->> 'Status', '') not in ('DELETED', 'VOIDED');
      select coalesce(jsonb_agg(y), '[]') into v_other from jsonb_array_elements(coalesce(x -> 'by_reference', '[]')) y
       where y ->> 'Reference' = o.payload ->> 'reference' and y ->> 'InvoiceNumber' is distinct from o.payload ->> 'xero_invoice_number'
         and coalesce(y ->> 'Status', '') not in ('DELETED', 'VOIDED')
         and not (coalesce(y ->> 'InvoiceID', '') = any (v_superseded));
      select external_id into v_contact from external_links
       where provider = 'XERO' and entity_type = 'customer' and entity_id = (o.payload ->> 'customer_id')::uuid and external_type = 'Contact';
      d := v_live -> 0;
      if jsonb_array_length(v_num) = 0 and jsonb_array_length(v_other) = 0 then
        v_outcome := 'PROVEN_ABSENT';
      elsif jsonb_array_length(v_num) = 1 and jsonb_array_length(v_live) = 1 and jsonb_array_length(v_other) = 0 and i.status <> 'VOIDED'
            and d ->> 'Reference' = o.payload ->> 'reference' and d ->> 'Type' = 'ACCREC' and d ->> 'Status' = 'DRAFT'
            and (d ->> 'Total')::numeric = (o.payload ->> 'amount_inc_gst')::numeric and (d ->> 'TotalTax')::numeric = (o.payload ->> 'gst_amount')::numeric
            and coalesce((d ->> 'AmountPaid')::numeric, -1) = 0
            and not coalesce((d ->> 'SentToContact')::boolean, false)   -- GET /Invoices omits it unless true (seen live); a DRAFT cannot be sent
            and d ->> 'CurrencyCode' = 'AUD' and d ->> 'LineAmountTypes' = 'Inclusive'
            and coalesce(d ->> 'InvoiceID', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            and coalesce(d -> 'Contact' ->> 'ContactID', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            and (v_contact is null or v_contact = d -> 'Contact' ->> 'ContactID')
            and not exists (select 1 from external_links where provider = 'XERO' and external_type = 'Invoice' and external_id = d ->> 'InvoiceID') then
        v_outcome := 'RECOVERED';
      else
        v_outcome := 'NEEDS_PERSON';
        v_detail := format('%s: reconciliation cannot tell which Xero invoice is RoofOps''s %s, so nothing was linked: %s with its number (%s), %s other live invoice(s) with reference %s%s. A person must check Xero (tenant %s…) and decide',
          i.invoice_number, o.payload ->> 'xero_invoice_number', jsonb_array_length(v_num),
          coalesce((select string_agg(coalesce(y ->> 'Status', '?') || ' ' || coalesce(y ->> 'Total', '?'), ', ') from jsonb_array_elements(v_num) y), 'none'),
          jsonb_array_length(v_other), o.payload ->> 'reference',
          case when jsonb_array_length(v_num) = 1 and jsonb_array_length(v_live) = 1 and jsonb_array_length(v_other) = 0 then ' (it differs from the approved draft)' else '' end,
          left(v_pin, 8));
      end if;
      v_dead := o.status = 'FAILED' and o.next_attempt_at = 'infinity';
      if v_repair and v_outcome = 'RECOVERED' then
        insert into external_links (provider, entity_type, entity_id, external_type, external_id, external_url, last_synced_at, verified_at)
        values ('XERO', 'invoice', o.aggregate_id, 'Invoice', d ->> 'InvoiceID', 'https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=' || (d ->> 'InvoiceID'), now(), now()),
               ('XERO', 'customer', (o.payload ->> 'customer_id')::uuid, 'Contact', d -> 'Contact' ->> 'ContactID',
                'https://go.xero.com/Contacts/View/' || (d -> 'Contact' ->> 'ContactID'), now(), now())
        on conflict (provider, entity_type, entity_id, external_type) do update set verified_at = now(), last_synced_at = now();
        update invoices set sync_status = 'SYNCED' where id = i.id;
        update outbox set status = 'DONE', dispatched_at = now(), locked_until = null,
               result = jsonb_build_object('recovered_by', p_run_key, 'tenant_id', x ->> 'tenant_id', 'invoice_id', d ->> 'InvoiceID', 'invoice_number', d ->> 'InvoiceNumber',
                 'reference', d ->> 'Reference', 'status', d ->> 'Status', 'total', d -> 'Total', 'total_tax', d -> 'TotalTax', 'contact_id', d -> 'Contact' ->> 'ContactID')
         where id = o.id;
        update approvals set status = 'EXECUTED', executed_at = now(), execution_result = jsonb_build_object('recovered_by', p_run_key, 'invoice_id', d ->> 'InvoiceID')
         where id = i.approval_id and status = 'EXECUTING';
        insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, external_reference, reason, correlation_id)
        values ('SYSTEM', 'workflow:reconciliation', 'xero.invoice.draft_recovered', 'invoice', i.id, i.invoice_number, jsonb_build_object('sync_status', 'UNKNOWN'),
                jsonb_build_object('sync_status', 'SYNCED', 'invoice_id', d ->> 'InvoiceID'), d ->> 'InvoiceID',
                format('Reconciliation %s found exactly one matching draft %s in the pinned Xero tenant and linked it', p_run_key, d ->> 'InvoiceNumber'), o.correlation_id);
        v_applied := true; v_rec := v_rec + 1;
      elsif v_repair and v_outcome = 'PROVEN_ABSENT' then
        if v_dead then
          update invoices set sync_status = 'FAILED' where id = i.id;
          update approvals set status = 'EXECUTION_FAILED', executed_at = now(),
                 execution_result = jsonb_build_object('proven_absent_by', p_run_key, 'message', 'no Xero draft exists; failed safely')
           where id = i.approval_id and status = 'EXECUTING';
          perform wf_open_sync_exception('project_to_invoice', 'invoice', i.id, i.invoice_number, 'INVALID_STATE',
            format('%s: failed safely. Reconciliation proved %s does not exist in Xero. It can be re-queued (ops/requeue-dead-lettered-side-effect.sql) or a person decides',
                   i.invoice_number, o.payload ->> 'xero_invoice_number'));
        else
          update invoices set sync_status = 'PENDING' where id = i.id;   -- the scheduled retry may go ahead (05 searches again first)
        end if;
        v_applied := true; v_abs := v_abs + 1;
      elsif v_repair and v_outcome = 'NEEDS_PERSON' then
        perform wf_open_sync_exception('reconciliation', 'invoice', i.id, i.invoice_number, 'RECONCILIATION_MISMATCH', v_detail);
        v_applied := true; v_person := v_person + 1;
      elsif v_outcome = 'NEEDS_PERSON' then
        v_person := v_person + 1;
      end if;
      if v_applied and v_outcome in ('RECOVERED', 'PROVEN_ABSENT') then
        -- The "may already exist" exception is answered either way.
        for e in select id, exception_number from workflow_exceptions
                  where (entity_id = i.id or business_reference = i.invoice_number) and error_class = 'AMBIGUOUS_WRITE' and resolution_status in ('OPEN', 'RETRY_QUEUED') for update loop
          update workflow_exceptions set resolution_status = 'RESOLVED', resolved_at = now(), resolved_by_system = 'workflow:reconciliation',
                 resolution_note = format('Reconciliation %s %s', p_run_key, case v_outcome when 'RECOVERED' then 'found and linked the draft' else 'proved the draft does not exist' end)
           where id = e.id;
          insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
          values ('SYSTEM', 'workflow:reconciliation', 'exception.resolved', 'workflow_exception', e.id, e.exception_number,
                  '{"resolution_status":"OPEN"}', '{"resolution_status":"RESOLVED"}',
                  format('Reconciliation %s settled uncertain Xero write %s: %s', p_run_key, i.invoice_number, lower(v_outcome)));
        end loop;
      end if;
      if not v_repair then
        v_outcome := case v_outcome when 'RECOVERED' then 'WOULD_RECOVER' when 'PROVEN_ABSENT' then 'WOULD_PROVE_ABSENT' else v_outcome end;
      end if;
      insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, classification, action, detail)
      values (v_run.id, 'XERO', 'invoice', i.invoice_number, d ->> 'InvoiceID',
              case when v_outcome in ('NEEDS_PERSON') then 'REQUIRES_HUMAN' else 'SAFE_AUTO_REPAIR' end,
              case when not v_repair then 'NONE_OBSERVE_ONLY' when v_outcome = 'NEEDS_PERSON' then 'EXCEPTION_OPENED' else 'APPLIED_TO_POSTGRES' end,
              coalesce(v_detail, format('Uncertain Xero write %s: %s', i.invoice_number, lower(v_outcome))));
    end if;
    if v_outcome in ('SKIPPED', 'UNKNOWN_KEY') then v_skip := v_skip + 1; end if;
    v_items := v_items || jsonb_build_object('invoice_number', coalesce(i.invoice_number, x ->> 'invoice_number'), 'outcome', v_outcome, 'applied', v_applied);
  end loop;
  update reconciliation_runs set summary = summary || jsonb_build_object('xero_uncertain', jsonb_build_object('checked', jsonb_array_length(coalesce(p_results, '[]'::jsonb)),
         'recovered', v_rec, 'proven_absent', v_abs, 'needs_person', v_person, 'skipped', v_skip)) where id = v_run.id;
  return jsonb_build_object('ok', true, 'checked', jsonb_array_length(coalesce(p_results, '[]'::jsonb)), 'recovered', v_rec, 'proven_absent', v_abs,
    'needs_person', v_person, 'skipped', v_skip, 'items', v_items);
end $$;

-- Extra finding (same rule, same shape as H2/H3): invoice_xero_state() reports the number of the CURRENT generation.
create or replace function invoice_xero_state(p_invoice uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
           'invoice_id', i.id, 'invoice_number', i.invoice_number, 'status', i.status, 'sync_status', i.sync_status,
           'total_inc_gst', i.total_inc_gst,
           'xero_invoice_id', (select external_id from external_links where provider = 'XERO' and entity_type = 'invoice'
                                  and external_type = 'Invoice' and entity_id = i.id and verified_at is not null),
           'xero_invoice_number', (select payload ->> 'xero_invoice_number' from outbox_current('xero.create_draft_invoice', i.id)),
           'xero_contact_id', (select external_id from external_links where provider = 'XERO' and entity_type = 'customer'
                                  and external_type = 'Contact' and entity_id = i.customer_id and verified_at is not null),
           'xero_tenant_name', (select value from app_settings where key = 'xero.demo_tenant_name'))
  from invoices i where i.id = p_invoice
$$;

-- H7 and the two integrity_check() interactions a generation model creates. Both are re-emitted here (the core row is
-- filtered out) because integrity_check_core() belongs to earlier migrations and both rules must stay single-sourced:
--   * xero_invoice_state_verified: "last read from its own Xero tenant" means the invoice's CURRENT link. The old
--     lateral took the latest observation overall, so after a link is re-pointed a superseded generation's later
--     VERIFIED DELETED read was reported as the current state ("Xero deleted, RoofOps approved") although the linked
--     draft is a different invoice. It now reads the observations of the linked InvoiceID only.
--   * xero_link_only_when_synced (AC-04): "no Xero link on an invoice RoofOps does not consider synced" was written for
--     a schema where an invoice has at most one draft, ever. A queued replacement generation (Part B2's reissue, or the
--     fixtures here) leaves the superseded generation's document linked while sync_status is PENDING by design, so the
--     rule becomes: a link on an unsynced invoice is a failure unless the linked document belongs to a superseded
--     generation of that invoice - the link is then history, not the current draft. Nothing is superseded for a normal
--     invoice, so its behaviour is exactly what it was.
--   * done_has_proof (defined in integrity_check_core(), 20260929001200): a DONE draft write required the invoice to be
--     SYNCED, which is false by design while a replacement generation is queued. The core row is replaced here with the
--     rule for the CURRENT generation only; an earlier DONE row is history, proved by the ledger and the observations,
--     not by today's sync_status.
create or replace function integrity_check()
returns table (entity text, check_key text, status text, failing int, detail text, refs text[])
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_refs text[];
begin
  return query select c.* from integrity_check_core() c where c.check_key not in ('done_has_proof', 'xero_link_only_when_synced');
  select array_agg(i.invoice_number order by i.invoice_number) into v_refs from invoices i
    left join outbox o on o.topic = 'xero.create_draft_invoice' and o.aggregate_id = i.id
   where i.status = 'VOIDED' and i.record_origin = 'ROOFOPS'
     and (i.sync_status in ('PENDING', 'UNKNOWN', 'SYNCED') or o.status in ('DISPATCHING', 'DONE')
          or exists (select 1 from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id))
     and not exists (select 1 from xero_invoice_observations x
                      where x.invoice_id = i.id and x.verdict = 'VERIFIED' and x.settlement in ('VOIDED', 'DELETED')
                        and x.tenant_id = o.payload ->> 'xero_tenant_id'
                        and x.xero_invoice_id = (select l.external_id from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id)
                        and not exists (select 1 from xero_invoice_observations y
                                         where y.invoice_id = x.invoice_id and y.verdict = 'VERIFIED' and y.xero_invoice_id = x.xero_invoice_id
                                           and y.settlement not in ('VOIDED', 'DELETED') and (y.observed_at, y.id) > (x.observed_at, x.id)));
  entity := 'invoice'; check_key := 'voided_invoice_has_no_xero_write';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'No Xero draft is created, pending, ambiguous or linked for a voided invoice, unless the exact linked Xero invoice was verified VOIDED or DELETED in the tenant its write is bound to'; return next;
  -- AC-09: once a final invoice exists, everything validly billed equals the entitlement (short = under-billed).
  select array_agg(x.project_number || ' (' || (x.b ->> 'remaining') || ' left)' order by x.project_number) into v_refs
    from (select p.project_number, project_billing(p.id) b from projects p
           where exists (select 1 from invoices i where i.project_id = p.id and i.invoice_type = 'FINAL' and i.status not in ('VOIDED', 'DRAFT', 'PENDING_APPROVAL'))) x
   where (x.b ->> 'remaining')::numeric > 0;
  entity := 'invoice'; check_key := 'final_invoice_settles_entitlement';
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'After the final invoice, quote + approved/invoiced variations - everything billed = 0 (left over means under-billed; a variation approved later needs its own invoice)'; return next;
  -- AC-13A: a CLOSED project is settled: nothing left to bill, nothing over-billed, everything paid, completion gate satisfied.
  select array_agg(p.project_number order by p.project_number) into v_refs from projects p
   where p.status = 'CLOSED' and ((project_billing(p.id) ->> 'remaining')::numeric <> 0
      or exists (select 1 from invoices i where i.project_id = p.id and not (invoice_financial_state(i.id, false) ->> 'settled')::boolean)
      or exists (select 1 from v_projects_missing_completion_docs v where v.id = p.id));
  entity := 'project'; check_key := 'closed_project_settled';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Closed projects have nothing left to bill, nothing over-billed, every invoice paid or voided, and their completion items done or waived'; return next;
  -- AC-13A: completed jobs held only by open completion items (staff set them in Airtable: Completion Photos / Compliance Certificate).
  select array_agg(x.project_number || ' (' || x.items || ')' order by x.project_number) into v_refs
    from (select v.project_number, string_agg(v.label, ', ' order by v.label) items from v_projects_missing_completion_docs v join projects p on p.id = v.id
           where p.status = 'COMPLETED' group by v.project_number) x;
  entity := 'project'; check_key := 'completed_awaiting_completion_items';
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Completed jobs whose completion items are still To do in Airtable (Completion Photos / Compliance Certificate); no final invoice until they are Done, Waived or Not applicable'; return next;
  -- AC-14: every Xero-linked invoice was last read successfully, and RoofOps shows the state Xero verified.
  select array_agg(i.invoice_number || ' (' || case when x.id is null then 'never read from Xero'
                                                   when x.verdict <> 'VERIFIED' then 'last Xero check: ' || lower(replace(x.verdict, '_', ' '))
                                                   else 'Xero ' || lower(replace(x.settlement, '_', ' ')) || ', RoofOps ' || lower(i.status) end || ')' order by i.invoice_number) into v_refs
    from invoices i join external_links l on l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id and l.verified_at is not null
    left join lateral (select * from xero_invoice_observations o where o.invoice_id = i.id and o.xero_invoice_id = l.external_id
                        order by o.observed_at desc, o.id desc limit 1) x on true
   where i.sync_status = 'SYNCED' and (x.id is null or x.verdict <> 'VERIFIED' or i.status is distinct from xero_settlement_status(x.settlement));
  entity := 'invoice'; check_key := 'xero_invoice_state_verified';
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Every Xero-linked invoice was last read from its own Xero tenant and RoofOps shows the state Xero verified (a repair run applies it)'; return next;
  -- AC-04, generation-aware (see above): the link must match the invoice's sync state, except that a superseded
  -- generation's document may stay linked while its replacement is queued - that link is history.
  select array_agg(i.invoice_number order by i.invoice_number) into v_refs
    from invoices i join external_links l on l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id
   where i.sync_status <> 'SYNCED'
     and not exists (select 1 from invoice_xero_draft_generations g
                      where g.invoice_id = i.id and g.superseded_at is not null and g.xero_invoice_id = l.external_id);
  entity := 'invoice'; check_key := 'xero_link_only_when_synced';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'No Xero link on an invoice RoofOps does not consider synced (the document of a superseded generation is history, not the current link)'; return next;
  -- done_has_proof, generation-aware (see above): the same rule for every topic, except that only the CURRENT draft
  -- write of an invoice must match its sync_status; an earlier DONE generation is history.
  select array_agg(o.topic || ':' || o.aggregate_id) into v_refs from outbox o
   where o.status = 'DONE' and not case o.topic
     when 'drive.ensure_project_folder' then exists (select 1 from external_links l where l.provider = 'GOOGLE_DRIVE' and l.entity_type = 'project'
                                                       and l.external_type = 'Folder' and l.entity_id = o.aggregate_id and l.verified_at is not null)
     when 'airtable.project_writeback' then exists (select 1 from external_links l where l.provider = 'AIRTABLE' and l.entity_type = 'project'
                                                      and l.external_type = 'Record' and l.entity_id = o.aggregate_id and l.verified_at is not null)
     when 'xero.create_draft_invoice' then o.id <> (select c.id from outbox_current('xero.create_draft_invoice', o.aggregate_id) c)
                                          or exists (select 1 from invoices i where i.id = o.aggregate_id and i.sync_status = 'SYNCED')
     else true end;
  entity := 'side_effect'; check_key := 'done_has_proof';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Every DONE side effect (Drive folder, Airtable write-back, Xero draft) has verified proof; for a Xero draft that means its CURRENT generation is the one that is DONE'; return next;
end $$;

-- The grant tail, as in 20261001140000 and 20261001080000: create or replace keeps each function's existing
-- privileges, so the blanket revoke only reaches the functions added here; the role grants are restated.
revoke execute on all functions in schema public from public;
revoke execute on function invoice_xero_draft_generations_backfill(), outbox_current(text, uuid), xero_draft_superseded_ids(uuid),
  xero_draft_outbox_key(uuid, int), xero_draft_provider_key(uuid, int), xero_draft_ledger_status(text, text),
  xero_draft_generation_open(), xero_draft_generation_mirror(), xero_draft_generation_sync_mirror(), wf_invoice_decide_core(jsonb, text),
  xero_record_settlement(text, jsonb), invoice_xero_state(uuid) from roofops_workflow, roofops_dashboard;
grant execute on function integrity_check() to roofops_dashboard;
grant execute on function wf_reconcile_targets(text), wf_reconcile_xero_uncertain(text, jsonb) to roofops_workflow;

-- =============================================================================
-- AC-14C Part B2 (docs/defect-ledger.md; mission architecture 4.2): the supervised final-invoice reissue.
--
-- Part A (20261001140000) made a Xero-verified DELETED final invoice follow the void path, B1a (20261001150000) made
-- Xero draft generations explicit and single-live, and B1b (20261001160000) made a voided invoice non-collectible
-- while the entitlement stays intact. A voided final invoice therefore still owes money (project_billing and the close
-- gate keep saying so) that no Xero document can collect any more. This migration is the only way back - and it is
-- deliberately manual: a FINANCE/ADMIN person requests a replacement draft for the SAME invoice row (one canonical
-- FINAL invoice per project, ever), stating a reason, and an authorised decision queues exactly one new generation.
-- Nothing is automatic: applying a verified void never creates a generation, and no workflow path calls these functions.
--
-- What this migration does, and nothing else:
--   1. app_settings invoice.reissue_roles = 'FINANCE,ADMIN' (idempotent insert).
--   2. approvals.action_type gains REISSUE_INVOICE (the full existing CHECK restated, every current value preserved).
--   3. Two legal transitions as data - ('invoice','VOIDED','APPROVED'), reachable only through the reissue guard, and
--      ('invoice_sync','SYNCED','PENDING'), the supervised re-queue - and VOIDED stops being terminal (a state with an
--      outgoing edge is not a dead end; test/state-integrity.test.ts pins both properties).
--   4. invoice_reissue_preview() / invoice_reissue_preview_hash(): the canonical preview of the act (invoice, project,
--      void evidence, generations, tenant, reason) and its hash - sha256 of the canonical jsonb text excluding
--      invoice_record_version, which binds separately - mirroring invoice_final_preview()/invoice_preview_hash().
--   5. ops_reissue_request() / ops_reissue_decide(): the two owner-only operator functions. Request records one
--      REISSUE_INVOICE approval bound to invoice + project + state + preview + generation + record version + tenant
--      after the full refusal battery; decide re-verifies everything, supersedes the current generation, opens the next
--      one, queues its write, moves the invoice back to APPROVED/PENDING and marks the approval EXECUTED - all in one
--      transaction with one audit event.
--   6. invoice_reissue_guard(): VOIDED -> APPROVED is refused unless the same statement carries a matching
--      REISSUE_INVOICE approval plus the void proof and no money, so raw SQL is not a recovery path (INV-11). It fires
--      before invoices_state_machine (name order) and only for that one transition.
--   7. invoice_void_guard(): the AC-14B/AC-14C-A verified-void/deletion exemption now applies only when the invoice's
--      draft writes are terminal, so a local void can never run while a replacement generation is live (finding 2f3a13b).
--   8. wf_complete_side_effect_core(): a generation >= 2 completion whose predecessor generation is superseded may MOVE
--      the one current external_links row to the new InvoiceID, under the existing proofs plus the generation binding.
--      The superseded generation's InvoiceID stays in the ledger, in its observations and in audit - history is
--      append-only (INV-5/INV-8).
--
-- Decisions stated here (the architecture leaves them to this migration):
--   * The approval is bound to the INVOICE (entity_type='invoice', entity_id = invoice_id): that is the scope the
--     partial unique index needs ("one open request per invoice"), and it lets the guard check "matching the invoice"
--     directly. The project is carried in the preview (project_id/project_number) and in the audit event. The existing
--     approvals table has no constraint on entity_type/entity_id, so both usages are legal (worker verified).
--   * Idempotency: the approval's idempotency_key is deterministic per cycle
--     ('reissue:request:<invoice>:<cycle>', cycle = count of prior REISSUE_INVOICE approvals for the invoice), and the
--     decide consumption guard is processed_events consumer 'invoice.reissue:<approval_number>' - a replay returns
--     ALREADY_PROCESSED and creates nothing, and a refusal deletes the claim so a corrected retry can proceed. The
--     decide's transport record is one automation_events row ('invoice.reissue:<approval_number>', actor USER, source
--     'ops'), which is also the event the claim references (processed_events requires one for a ROOFOPS row).
--   * Drift order is generation, then record version, then preview hash: the preview hash covers the generation, so
--     comparing the hash first would mask the specific GENERATION_CHANGED code. Any drift refuses and CANCELS the stale
--     approval (a fresh request is then possible); nothing else is touched.
--   * WRITE_IN_FLIGHT also counts a FAILED write with a retry scheduled (next_attempt_at <> 'infinity'), exactly as
--     invoice_void_guard treats "queued": such a write can still create a draft, and INV-2/INV-6 forbid a second live
--     generation while any prior write is live or UNKNOWN. A dead-lettered write (next_attempt_at = 'infinity') is not
--     live - that is the state a local void leaves behind.
--   * invoice_reissue_preview() takes the reason as a second, defaulted parameter (the architecture's payload carries
--     requested_reason, which only the caller knows), so it is still callable as invoice_reissue_preview(invoice).
--   * The decision does not clear invoices.voided_reason: the column records how the invoice came back (the CHECK only
--     requires a reason while VOIDED), the audit event and the ledger carry the act, and history stays append-only.
--   * Nothing here writes to Xero, and nothing here runs automatically.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Roles allowed to request and decide a reissue.
-- -----------------------------------------------------------------------------
insert into app_settings (key, value) values ('invoice.reissue_roles', 'FINANCE,ADMIN')
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- 2. approvals.action_type gains REISSUE_INVOICE (full CHECK restated).
-- -----------------------------------------------------------------------------
alter table approvals drop constraint approvals_action_type_check;
alter table approvals add constraint approvals_action_type_check check (action_type in (
  'SEND_PURCHASE_ORDER','APPROVE_PURCHASE_ORDER','CREATE_INVOICE','SYNC_INVOICE_TO_XERO','CANCEL_PROJECT',
  'CHANGE_APPROVED_MATERIALS','REISSUE_INVOICE'));

-- One open reissue request per invoice, enforced by Postgres (not by application code): a second request while one is
-- PENDING/APPROVED/EXECUTING is refused by ops_reissue_request with REISSUE_PENDING; the index is the backstop that
-- makes the rule true even for a concurrent caller that skipped the check.
create unique index approvals_reissue_open_idx on approvals (entity_id)
  where action_type = 'REISSUE_INVOICE' and status in ('PENDING','APPROVED','EXECUTING');

-- -----------------------------------------------------------------------------
-- 3. The two legal transitions, and VOIDED is not a dead end any more.
-- -----------------------------------------------------------------------------
insert into state_transitions (machine, from_state, to_state, note) values
  ('invoice', 'VOIDED', 'APPROVED',
   'AC-14C B2: supervised reissue only - invoice_reissue_guard() refuses it without a matching REISSUE_INVOICE approval, the void proof and no money movement'),
  ('invoice_sync', 'SYNCED', 'PENDING',
   'AC-14C B2: the reissue queues a new generation for the same invoice row, so its sync state is pending again')
on conflict (machine, from_state, to_state) do nothing;

update state_machine_states set is_terminal = false where machine = 'invoice' and state = 'VOIDED' and is_terminal;

-- -----------------------------------------------------------------------------
-- 4. The current generation of an invoice, and the canonical preview of the act.
-- -----------------------------------------------------------------------------
-- The greatest generation ever opened for the invoice - from the ledger (authoritative) and from the outbox (a fixture
-- that bypassed the ledger trigger must still not hand out a generation number that is taken). Monotone by construction.
create or replace function invoice_reissue_generation(p_invoice uuid)
returns int language sql stable security definer set search_path = public, pg_temp as $$
  select greatest(coalesce((select max(g.generation) from invoice_xero_draft_generations g where g.invoice_id = p_invoice), 0),
                  coalesce((select max(o.generation) from outbox o
                             where o.topic = 'xero.create_draft_invoice' and o.aggregate_id = p_invoice), 0))
$$;

-- The whole act, as data: what is being reissued, what evidence authorises it, which generation it replaces and which
-- tenant it writes to. invoice_record_version is carried but excluded from the hash (the approval binds it separately,
-- exactly as the invoice preview binds project_record_version).
create or replace function invoice_reissue_preview(p_invoice uuid, p_reason text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  i invoices; p projects; v_link text; v_bound text; v_obs xero_invoice_observations; v_gen int;
begin
  select * into i from invoices where id = p_invoice;
  if i.id is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'detail', coalesce(p_invoice::text, 'no invoice') || ' does not exist');
  end if;
  select * into p from projects where id = i.project_id;
  v_link := (select l.external_id from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice'
               and l.entity_type = 'invoice' and l.entity_id = i.id);
  v_bound := (select o.payload ->> 'xero_tenant_id' from outbox_current('xero.create_draft_invoice', i.id) o);
  select * into v_obs from xero_invoice_observations x
   where x.invoice_id = i.id and x.xero_invoice_id is not distinct from v_link and x.verdict = 'VERIFIED'
     and x.settlement in ('VOIDED', 'DELETED')
   order by x.observed_at desc, x.id desc limit 1;
  v_gen := invoice_reissue_generation(i.id);
  return jsonb_build_object('ok', true, 'preview', jsonb_build_object(
    'invoice_id', i.id, 'invoice_number', i.invoice_number,
    'xero_invoice_number', coalesce((select o.payload ->> 'xero_invoice_number' from outbox_current('xero.create_draft_invoice', i.id) o), ''),
    'invoice_type', i.invoice_type, 'record_origin', i.record_origin,
    'invoice_status', i.status, 'invoice_sync_status', i.sync_status, 'voided_reason', i.voided_reason,
    'invoice_record_version', i.record_version,
    'project_id', i.project_id, 'project_number', p.project_number, 'project_status', p.status,
    'total_inc_gst', i.total_inc_gst, 'gst_amount', i.gst_amount,
    'line_count', (select count(*) from invoice_lines l where l.invoice_id = i.id),
    'lines_hash', (select md5(coalesce(string_agg(l.line_no::text || '|' || l.description || '|' || l.quantity::text || '|' || l.unit_price::text,
                                                E'\n' order by l.line_no), '')) from invoice_lines l where l.invoice_id = i.id),
    'linked_xero_invoice_id', v_link,
    'void_evidence', case when v_obs.id is null then null else jsonb_build_object(
      'observation_id', v_obs.id, 'settlement', v_obs.settlement, 'tenant_id', v_obs.tenant_id,
      'observed_at', to_char(v_obs.observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'run_id', v_obs.run_id) end,
    'current_generation', v_gen, 'target_generation', v_gen + 1,
    'tenant', jsonb_build_object('tenant_id', v_bound, 'tenant_name', (select value from app_settings where key = 'xero.demo_tenant_name')),
    'requested_reason', btrim(coalesce(p_reason, ''))));
end $$;

-- Owner-only like the rest of the reissue surface (security definer, safe search_path): the hash is what an operator's
-- approval is bound to, so it is not a PUBLIC helper either.
create or replace function invoice_reissue_preview_hash(p_preview jsonb)
returns text language sql immutable security definer set search_path = public, pg_temp as $$
  select encode(sha256(convert_to((p_preview - 'invoice_record_version')::text, 'UTF8')), 'hex')
$$;

-- -----------------------------------------------------------------------------
-- 5. The refusal battery, in the pinned order (architecture 4.2 item 9).
-- -----------------------------------------------------------------------------
-- Authority, reason, reference, project state, tenancy, invoice state, observation semantics, money, write state - the
-- order is the contract. Every caller gets the first failing condition; nothing here changes any state.
create or replace function invoice_reissue_check(p_invoice uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  i invoices; p projects; v_pin text; v_bound text; v_link text; v_last xero_invoice_observations; v_void xero_invoice_observations;
  v_gen int; v_paid numeric; v_credited numeric; v_live int;
begin
  select * into i from invoices where id = p_invoice;
  if i.id is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'detail', coalesce(p_invoice::text, 'no invoice') || ' does not exist');
  end if;
  if i.record_origin <> 'ROOFOPS' or i.invoice_type <> 'FINAL'
     or i.idempotency_key is distinct from 'invoice:final:' || i.project_id::text then
    return jsonb_build_object('ok', false, 'code', 'NOT_FINAL_INVOICE',
      'detail', format('%s is not the canonical RoofOps-origin FINAL invoice of its project (%s, %s, key %s); a reissue replaces that one invoice row, never an imported or non-final one',
        i.invoice_number, i.record_origin, i.invoice_type, coalesce(i.idempotency_key, 'none')));
  end if;
  select * into p from projects where id = i.project_id;
  if p.status = 'CLOSED' then
    return jsonb_build_object('ok', false, 'code', 'PROJECT_CLOSED', 'detail', format('%s is CLOSED; a closed project is not reopened by a reissue', p.project_number));
  elsif p.status = 'CANCELLED' then
    return jsonb_build_object('ok', false, 'code', 'PROJECT_CANCELLED', 'detail', format('%s is CANCELLED; nothing is invoiced for it any more', p.project_number));
  elsif p.status <> 'COMPLETED' then
    return jsonb_build_object('ok', false, 'code', 'PROJECT_NOT_COMPLETED', 'detail', format('%s is %s; only a COMPLETED project has a final invoice to reissue', p.project_number, p.status));
  end if;
  v_pin := (select nullif(value, '') from app_settings where key = 'xero.demo_tenant_id');
  if v_pin is null then
    return jsonb_build_object('ok', false, 'code', 'TENANT_NOT_PINNED',
      'detail', 'No Xero Demo Company tenant is pinned (app_settings xero.demo_tenant_id); refusing to queue a Xero write');
  end if;
  v_bound := (select o.payload ->> 'xero_tenant_id' from outbox_current('xero.create_draft_invoice', i.id) o);
  if v_bound is null or v_bound <> v_pin then
    return jsonb_build_object('ok', false, 'code', 'TENANT_MISMATCH',
      'detail', format('%s: the draft write is bound to tenant %s but the pinned tenant is %s; a reissue never writes to another tenant', i.invoice_number, coalesce(v_bound, 'none'), v_pin));
  end if;
  v_link := (select l.external_id from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice'
               and l.entity_type = 'invoice' and l.entity_id = i.id);
  if i.status <> 'VOIDED' then
    return jsonb_build_object('ok', false, 'code', 'INVOICE_NOT_VOIDED',
      'detail', format('%s is %s; only a voided invoice is reissued (a live invoice is settled normally)', i.invoice_number, i.status));
  end if;
  -- Observation semantics: only reads of the exact linked InvoiceID, in the bound tenant, count.
  select * into v_last from xero_invoice_observations x
   where x.invoice_id = i.id and x.xero_invoice_id is not distinct from v_link
   order by x.observed_at desc, x.id desc limit 1;
  select * into v_void from xero_invoice_observations x
   where x.invoice_id = i.id and x.xero_invoice_id is not distinct from v_link and x.verdict = 'VERIFIED'
     and x.settlement in ('VOIDED', 'DELETED')
   order by x.observed_at desc, x.id desc limit 1;
  if v_last.id is not null and v_last.tenant_id is not null and v_last.tenant_id is distinct from v_bound then
    return jsonb_build_object('ok', false, 'code', 'TENANT_MISMATCH',
      'detail', format('%s: the latest read of linked Xero invoice %s came from tenant %s, but the write is bound to %s; that read is not trusted',
        i.invoice_number, v_link, v_last.tenant_id, v_bound));
  end if;
  if v_last.id is not null and v_last.verdict in ('LOOKUP_FAILED', 'MISMATCH', 'INCONSISTENT')
     and (v_void.id is null or (v_last.observed_at, v_last.id) > (v_void.observed_at, v_void.id)) then
    return jsonb_build_object('ok', false, 'code', 'OBSERVATION_AMBIGUOUS',
      'detail', format('%s: the latest read of linked Xero invoice %s is %s and no verified void came after it (%s); a reissue needs a settled void',
        i.invoice_number, coalesce(v_link, 'none'), v_last.verdict, coalesce(v_last.detail, 'no detail')));
  end if;
  if v_void.id is not null and exists (
      select 1 from xero_invoice_observations x where x.invoice_id = i.id and x.xero_invoice_id is not distinct from v_link
        and x.verdict = 'VERIFIED' and x.settlement not in ('VOIDED', 'DELETED')
        and (x.observed_at, x.id) > (v_void.observed_at, v_void.id)) then
    return jsonb_build_object('ok', false, 'code', 'OBSERVATION_CONTRADICTED',
      'detail', format('%s: a later verified read of linked Xero invoice %s says the document is not voided any more; a person must check Xero before a reissue',
        i.invoice_number, v_link));
  end if;
  if v_void.id is null then
    return jsonb_build_object('ok', false, 'code', 'VOID_NOT_VERIFIED',
      'detail', format('%s is voided in RoofOps but no verified Xero read of linked invoice %s says it was voided or deleted%s; a reissue needs that proof',
        i.invoice_number, coalesce(v_link, '(no Xero link)'),
        case when v_link is null then '' else ' (a read of another InvoiceID, or a read that is not void-family, is not proof)' end));
  end if;
  -- Money: any verified payment or credit, here or in Xero, means a person must look before a reissue.
  if exists (select 1 from payments where invoice_id = i.id) then
    return jsonb_build_object('ok', false, 'code', 'PAYMENT_EXISTS',
      'detail', format('%s has %s local payment row(s); money moved on it, so a void or deletion is not a reissue trigger', i.invoice_number,
        (select count(*) from payments where invoice_id = i.id)));
  end if;
  select max(x.amount_paid) into v_paid from xero_invoice_observations x
   where x.invoice_id = i.id and x.verdict = 'VERIFIED' and coalesce(x.amount_paid, 0) > 0;
  if v_paid is not null then
    return jsonb_build_object('ok', false, 'code', 'PAYMENT_EXISTS',
      'detail', format('%s: Xero verified a payment of %s on it; a person must check the customer account before a reissue', i.invoice_number, v_paid));
  end if;
  select max(x.amount_credited) into v_credited from xero_invoice_observations x
   where x.invoice_id = i.id and x.verdict = 'VERIFIED' and coalesce(x.amount_credited, 0) > 0;
  if v_credited is not null then
    return jsonb_build_object('ok', false, 'code', 'CREDIT_EXISTS',
      'detail', format('%s: Xero verified a credit of %s on it; a person must check the customer account before a reissue', i.invoice_number, v_credited));
  end if;
  -- Write state: no live draft write (a queued or retrying one can still create a document) and nothing ambiguous.
  select count(*) into v_live from outbox o
   where o.topic = 'xero.create_draft_invoice' and o.aggregate_id = i.id
     and (o.status in ('PENDING', 'DISPATCHING') or (o.status = 'FAILED' and o.next_attempt_at <> 'infinity'));
  if v_live > 0 then
    return jsonb_build_object('ok', false, 'code', 'WRITE_IN_FLIGHT',
      'detail', format('%s has %s live Xero draft write(s) (%s); a reissue cannot start while a generation may still create a document',
        i.invoice_number, v_live, (select string_agg(o.generation::text || ':' || o.status, ', ' order by o.generation) from outbox o
          where o.topic = 'xero.create_draft_invoice' and o.aggregate_id = i.id
            and (o.status in ('PENDING', 'DISPATCHING') or (o.status = 'FAILED' and o.next_attempt_at <> 'infinity')))));
  end if;
  if i.sync_status = 'UNKNOWN' or exists (select 1 from invoice_xero_draft_generations g where g.invoice_id = i.id and g.status = 'UNKNOWN') then
    return jsonb_build_object('ok', false, 'code', 'PRIOR_WRITE_UNKNOWN',
      'detail', format('%s has an UNKNOWN Xero write (sync %s); settle it with reconciliation before a reissue - nothing is assumed', i.invoice_number, i.sync_status));
  end if;
  v_gen := invoice_reissue_generation(i.id);
  return jsonb_build_object('ok', true, 'invoice_id', i.id, 'invoice_number', i.invoice_number, 'project_id', p.id, 'project_number', p.project_number,
    'linked_xero_invoice_id', v_link, 'bound_tenant_id', v_bound, 'pinned_tenant_id', v_pin,
    'current_generation', v_gen, 'target_generation', v_gen + 1,
    'void_observation_id', v_void.id, 'void_settlement', v_void.settlement, 'invoice_record_version', i.record_version);
end $$;

-- -----------------------------------------------------------------------------
-- 6. The guard: VOIDED -> APPROVED is a supervised act, never a raw UPDATE.
-- -----------------------------------------------------------------------------
create or replace function invoice_reissue_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a approvals; v_bound text; v_link text; v_obs xero_invoice_observations; v_target int;
begin
  select * into a from approvals where id = new.approval_id;
  -- A decided reissue (APPROVED/EXECUTING - what ops_reissue_decide sets before its own update) authorises the
  -- transition, and so does a fresh PENDING request: the request already ran the full battery, and VAL-RIS-012 pins
  -- that a raw UPDATE carrying a valid pending approval plus the evidence succeeds. An expired PENDING request does not.
  if a.id is null or a.action_type <> 'REISSUE_INVOICE' or a.entity_type <> 'invoice' or a.entity_id <> new.id
     or not (a.status in ('APPROVED', 'EXECUTING') or (a.status = 'PENDING' and a.expires_at > now())) then
    raise exception 'invoice % cannot go back to APPROVED without a matching REISSUE_INVOICE approval attached (a supervised reissue decides that, not raw SQL)',
      new.invoice_number using errcode = 'check_violation';
  end if;
  v_bound := (select o.payload ->> 'xero_tenant_id' from outbox_current('xero.create_draft_invoice', new.id) o);
  v_link := (select l.external_id from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice'
               and l.entity_type = 'invoice' and l.entity_id = new.id);
  select * into v_obs from xero_invoice_observations x
   where x.invoice_id = new.id and x.xero_invoice_id is not distinct from v_link and x.verdict = 'VERIFIED'
   order by x.observed_at desc, x.id desc limit 1;
  if v_obs.id is null or v_obs.settlement not in ('VOIDED', 'DELETED') or v_obs.tenant_id is distinct from v_bound then
    raise exception 'invoice % cannot go back to APPROVED without a verified void or deletion of its linked Xero invoice % in the bound tenant % (the last verified read is %); raw SQL is not a recovery path',
      new.invoice_number, coalesce(v_link, '(none)'), coalesce(v_bound, '(none)'), coalesce(v_obs.settlement || ' in ' || v_obs.tenant_id, 'none')
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from payments where invoice_id = new.id)
     or exists (select 1 from xero_invoice_observations x where x.invoice_id = new.id and x.verdict = 'VERIFIED'
                  and (coalesce(x.amount_paid, 0) > 0 or coalesce(x.amount_credited, 0) > 0)) then
    raise exception 'invoice % cannot go back to APPROVED: money moved on it (a payment or a credit exists); a person must check the customer account',
      new.invoice_number using errcode = 'check_violation';
  end if;
  -- The reissue opens exactly one new generation in this transaction; that write is the guard's own target (the newest
  -- generation row). A live write of an older generation is still a refusal.
  v_target := (select max(g.generation) from invoice_xero_draft_generations g where g.invoice_id = new.id);
  if exists (select 1 from outbox o where o.topic = 'xero.create_draft_invoice' and o.aggregate_id = new.id
               and (o.status in ('PENDING', 'DISPATCHING') or (o.status = 'FAILED' and o.next_attempt_at <> 'infinity'))
               and o.generation is distinct from v_target) then
    raise exception 'invoice % cannot go back to APPROVED while an older generation''s Xero draft write is still live (target generation %); let it finish or fail first',
      new.invoice_number, coalesce(v_target::text, 'none') using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists invoices_reissue_guard on invoices;
-- Fires before invoices_state_machine (name order): the transition is legal as data, the guard is what makes it safe.
create trigger invoices_reissue_guard before update of status on invoices
  for each row when (new.status = 'APPROVED' and old.status = 'VOIDED') execute function invoice_reissue_guard();

-- -----------------------------------------------------------------------------
-- 7. Request: one bound approval, or the first refusal.
-- -----------------------------------------------------------------------------
create or replace function ops_reissue_request(p_invoice uuid, p_employee_code text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_emp employees; v_reason text := btrim(coalesce(p_reason, '')); v_check jsonb; i invoices;
  v_open approvals; v_cycle int; v_preview jsonb; v_hash text; v_apr approvals; v_ttl int;
begin
  select * into v_emp from employees where employee_code = p_employee_code;
  if v_emp.id is null or not v_emp.is_active
     or not (v_emp.role = any (string_to_array((select value from app_settings where key = 'invoice.reissue_roles'), ','))) then
    return jsonb_build_object('ok', false, 'code', 'ACTOR_UNAUTHORIZED',
      'detail', format('%s is not an active RoofOps employee in a role that may reissue a final invoice (%s)',
        coalesce(nullif(p_employee_code, ''), 'no employee code'), coalesce((select value from app_settings where key = 'invoice.reissue_roles'), 'no roles configured')));
  end if;
  if length(v_reason) < 10 then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED',
      'detail', 'a reissue needs a reason saying why (at least 10 characters)');
  end if;
  v_check := invoice_reissue_check(p_invoice);
  if not (v_check ->> 'ok')::boolean then return v_check; end if;
  select * into i from invoices where id = p_invoice;
  select * into v_open from approvals a where a.action_type = 'REISSUE_INVOICE' and a.entity_id = i.id
     and a.status in ('PENDING', 'APPROVED', 'EXECUTING') order by a.created_at desc limit 1 for update;
  if v_open.id is not null and v_open.status = 'PENDING' and v_open.expires_at <= now() then
    update approvals set status = 'CANCELLED', decision_reason = 'Expired before it was decided; the next request replaces it' where id = v_open.id;
    v_open := null;
  end if;
  if v_open.id is not null then
    return jsonb_build_object('ok', false, 'code', 'REISSUE_PENDING', 'approval_number', v_open.approval_number,
      'detail', format('%s already has an open reissue request %s (%s, expires %s)', i.invoice_number, v_open.approval_number, v_open.status, v_open.expires_at));
  end if;
  select count(*) into v_cycle from approvals a where a.action_type = 'REISSUE_INVOICE' and a.entity_id = i.id;
  v_preview := invoice_reissue_preview(i.id, v_reason) -> 'preview';
  v_hash := invoice_reissue_preview_hash(v_preview);
  v_ttl := (select value::int from app_settings where key = 'invoice.approval_ttl_hours');
  begin
    insert into approvals (approval_number, action_type, entity_type, entity_id, business_reference, requested_by_actor_type,
                           requested_by_employee_id, required_permission, action_payload, payload_hash, expected_record_version,
                           idempotency_key, expires_at, status)
    values (next_friendly_id('APR', extract(year from app_today())::int), 'REISSUE_INVOICE', 'invoice', i.id, i.invoice_number, 'USER',
            v_emp.id, 'invoice.approve', v_preview, v_hash, i.record_version,
            'reissue:request:' || i.id::text || ':' || v_cycle::text, now() + make_interval(hours => v_ttl), 'PENDING')
    returning * into v_apr;
  exception when unique_violation then
    -- The partial unique index (or the per-cycle idempotency key) says a request is already open: the database wins.
    select * into v_apr from approvals a where a.action_type = 'REISSUE_INVOICE' and a.entity_id = i.id
       and a.status in ('PENDING', 'APPROVED', 'EXECUTING') order by a.created_at desc limit 1;
    return jsonb_build_object('ok', false, 'code', 'REISSUE_PENDING', 'approval_number', v_apr.approval_number,
      'detail', format('%s already has an open reissue request %s (%s); only one is open at a time', i.invoice_number, v_apr.approval_number, v_apr.status));
  end;
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
  values ('USER', v_emp.employee_code, 'invoice.reissue_requested', 'invoice', i.id, i.invoice_number,
          jsonb_build_object('status', i.status, 'sync_status', i.sync_status, 'generation', (v_check ->> 'current_generation')::int,
            'record_version', i.record_version, 'voided_reason', i.voided_reason),
          jsonb_build_object('approval_number', v_apr.approval_number, 'payload_hash', v_hash, 'target_generation', (v_check ->> 'target_generation')::int,
            'linked_xero_invoice_id', v_check ->> 'linked_xero_invoice_id', 'void_observation_id', v_check ->> 'void_observation_id',
            'void_settlement', v_check ->> 'void_settlement', 'bound_tenant_id', v_check ->> 'bound_tenant_id'),
          v_reason);
  return jsonb_build_object('ok', true, 'code', 'REISSUE_REQUESTED', 'approval_number', v_apr.approval_number,
    'invoice_number', i.invoice_number, 'invoice_id', i.id, 'expires_at', v_apr.expires_at, 'payload_hash', v_hash,
    'target_generation', (v_check ->> 'target_generation')::int,
    'detail', format('%s: reissue of %s requested, target generation %s (voided %s, verified by observation %s)',
      v_apr.approval_number, i.invoice_number, v_check ->> 'target_generation', v_check ->> 'void_settlement', v_check ->> 'void_observation_id'));
end $$;

-- -----------------------------------------------------------------------------
-- 8. Decide: everything re-verified, then one transaction that opens the next generation.
-- -----------------------------------------------------------------------------
create or replace function ops_reissue_decide(p_approval_number text, p_employee_code text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_emp employees; v_ap approvals; i invoices; v_check jsonb; v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_key text; v_claimed boolean; v_pe processed_events; v_event uuid; v_preview jsonb; v_hash text;
  v_gen int; v_payload jsonb; v_corr uuid; v_okey text; v_code text; v_detail text; v_res jsonb; v_reason text;
begin
  select * into v_emp from employees where employee_code = p_employee_code;
  if v_emp.id is null or not v_emp.is_active
     or not (v_emp.role = any (string_to_array((select value from app_settings where key = 'invoice.reissue_roles'), ','))) then
    return jsonb_build_object('ok', false, 'code', 'ACTOR_UNAUTHORIZED',
      'detail', format('%s is not an active RoofOps employee in a role that may reissue a final invoice (%s)',
        coalesce(nullif(p_employee_code, ''), 'no employee code'), coalesce((select value from app_settings where key = 'invoice.reissue_roles'), 'no roles configured')));
  end if;
  -- Row lock: concurrent decisions on one approval serialise here, and the loser sees the committed status below.
  select * into v_ap from approvals where approval_number = p_approval_number for update;
  if v_ap.id is null or v_ap.action_type <> 'REISSUE_INVOICE' then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND',
      'detail', coalesce(nullif(p_approval_number, ''), 'no approval number') || ' is not a reissue request');
  end if;
  -- Consumption guard: one decision per approval, however many times it is delivered.
  v_key := v_ap.approval_number;
  v_event := wf_log_event('invoice.reissue:' || v_ap.approval_number, stable_uuid('correlation', 'invoice.reissue:' || v_ap.approval_number), null,
    'invoice.reissue_decided', 'invoice', v_ap.entity_id, v_ap.approval_number, 'USER', v_emp.employee_code, 'ops', 'INFO', null,
    jsonb_build_object('approval_number', v_ap.approval_number, 'note', v_note), null);
  insert into processed_events (consumer, idempotency_key, first_event_id, request_hash, status, locked_by, lease_expires_at)
  values ('invoice.reissue:' || v_ap.approval_number, v_key, v_event, md5(v_ap.payload_hash), 'PROCESSING', 'ops_reissue_decide', now() + interval '5 minutes')
  on conflict do nothing returning true into v_claimed;
  if v_claimed is null then
    select * into v_pe from processed_events where consumer = 'invoice.reissue:' || v_ap.approval_number and idempotency_key = v_key for update;
    update processed_events set delivery_count = delivery_count + 1, last_seen_at = now() where consumer = v_pe.consumer and idempotency_key = v_key;
    return coalesce(v_pe.result, '{}'::jsonb) || jsonb_build_object('ok', false, 'code', 'ALREADY_PROCESSED', 'duplicate', true,
      'delivery_count', v_pe.delivery_count + 1,
      'detail', format('%s was already decided; nothing was created', v_ap.approval_number));
  end if;
  -- The full battery again (state, money, void proof, write state) - the request's evidence is re-verified, not trusted.
  v_check := invoice_reissue_check(v_ap.entity_id);
  if not (v_check ->> 'ok')::boolean then
    delete from processed_events where consumer = 'invoice.reissue:' || v_ap.approval_number and idempotency_key = v_key;
    return v_check || jsonb_build_object('approval_number', v_ap.approval_number);
  end if;
  if v_ap.status <> 'PENDING' then
    delete from processed_events where consumer = 'invoice.reissue:' || v_ap.approval_number and idempotency_key = v_key;
    return jsonb_build_object('ok', false, 'code', 'APPROVAL_NOT_PENDING', 'approval_number', v_ap.approval_number,
      'detail', format('%s is %s; only a PENDING request can be decided', v_ap.approval_number, v_ap.status));
  end if;
  if v_ap.expires_at <= now() then
    update approvals set status = 'EXPIRED' where id = v_ap.id;
    delete from processed_events where consumer = 'invoice.reissue:' || v_ap.approval_number and idempotency_key = v_key;
    return jsonb_build_object('ok', false, 'code', 'APPROVAL_EXPIRED', 'approval_number', v_ap.approval_number,
      'detail', format('%s expired at %s; request a fresh reissue', v_ap.approval_number, v_ap.expires_at));
  end if;
  -- Drift: generation, then record version, then preview hash (the hash covers the generation).
  select * into i from invoices where id = v_ap.entity_id;
  v_gen := (v_check ->> 'current_generation')::int;
  v_preview := invoice_reissue_preview(i.id, v_ap.action_payload ->> 'requested_reason') -> 'preview';
  v_hash := invoice_reissue_preview_hash(v_preview);
  if v_ap.action_payload ->> 'target_generation' is distinct from (v_gen + 1)::text then
    v_code := 'GENERATION_CHANGED';
    v_detail := format('%s was requested for generation %s but the current generation of %s is %s', v_ap.approval_number, v_ap.action_payload ->> 'target_generation', i.invoice_number, v_gen);
  elsif v_ap.expected_record_version is distinct from i.record_version then
    v_code := 'RECORD_VERSION_CHANGED';
    v_detail := format('%s was bound to %s record version %s but it is now %s; request a fresh reissue', v_ap.approval_number, i.invoice_number, v_ap.expected_record_version, i.record_version);
  elsif v_hash is distinct from v_ap.payload_hash then
    v_code := 'PREVIEW_CHANGED';
    v_detail := format('%s is stale: %s changed since the request (hash %s, now %s); request a fresh reissue', v_ap.approval_number, i.invoice_number, v_ap.payload_hash, v_hash);
  end if;
  if v_code is not null then
    update approvals set status = 'CANCELLED', decision_reason = v_detail where id = v_ap.id;
    delete from processed_events where consumer = 'invoice.reissue:' || v_ap.approval_number and idempotency_key = v_key;
    return jsonb_build_object('ok', false, 'code', v_code, 'approval_number', v_ap.approval_number, 'detail', v_detail);
  end if;
  -- From here the act is committed as one transaction. The approval moves to EXECUTING first (the guard accepts it),
  -- then to EXECUTED at the end with the generation it queued.
  update approvals set status = 'EXECUTING', decided_by = v_emp.id, decided_at = now(), decision_reason = v_note where id = v_ap.id;
  v_reason := v_ap.action_payload ->> 'requested_reason';
  v_okey := xero_draft_outbox_key(i.id, v_gen + 1);
  select o.payload, o.correlation_id into v_payload, v_corr from outbox_current('xero.create_draft_invoice', i.id) o;
  -- a. supersede the current generation (history: the row, its Xero InvoiceID and its keys stay).
  update invoice_xero_draft_generations
     set status = 'SUPERSEDED', superseded_at = now(), updated_at = now(),
         superseded_reason = coalesce(v_note || ' | ', '') || 'Reissue ' || v_ap.approval_number || ' by ' || v_emp.employee_code || ': ' || v_reason
   where invoice_id = i.id and superseded_at is null;
  -- b. open the new generation row (before its write, so the ledger never lags the outbox).
  insert into invoice_xero_draft_generations (invoice_id, generation, status, outbox_idempotency_key, xero_invoice_number, tenant_id, approval_id, opened_by)
  values (i.id, v_gen + 1, 'PENDING', v_okey, coalesce(v_payload ->> 'xero_invoice_number', v_preview ->> 'xero_invoice_number'),
          v_check ->> 'bound_tenant_id', v_ap.id, 'operator:' || v_emp.employee_code);
  -- c. queue exactly one new draft write, with new keys (generation >= 2) and the same bound tenant.
  insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, generation)
  values ('xero.create_draft_invoice', 'invoice', i.id, v_corr, v_okey,
          coalesce(v_payload, '{}'::jsonb) || jsonb_build_object(
            'generation', v_gen + 1, 'xero_idempotency_key', xero_draft_provider_key(i.id, v_gen + 1),
            'approval_number', v_ap.approval_number, 'opened_by', 'operator:' || v_emp.employee_code,
            'reissued_from_generation', v_gen, 'reissued_by', v_emp.employee_code, 'reissue_reason', v_reason), v_gen + 1);
  -- d. the invoice, in a single statement: VOIDED -> APPROVED and SYNCED -> PENDING, bound to the reissue approval.
  update invoices set status = 'APPROVED', sync_status = 'PENDING', approval_id = v_ap.id where id = i.id;
  -- e. the approval executed, with the generation it queued.
  update approvals set status = 'EXECUTED', executed_at = now(),
         execution_result = jsonb_build_object('outcome', 'REISSUE_QUEUED', 'invoice_id', i.id, 'invoice_number', i.invoice_number,
           'generation', v_gen + 1, 'superseded_generation', v_gen, 'outbox_idempotency_key', v_okey, 'decided_by', v_emp.employee_code)
   where id = v_ap.id;
  -- f. one audit event for the whole act.
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
  values ('USER', v_emp.employee_code, 'invoice.reissued', 'invoice', i.id, i.invoice_number,
          jsonb_build_object('status', 'VOIDED', 'sync_status', i.sync_status, 'generation', v_gen,
            'superseded_xero_invoice_id', (select g.xero_invoice_id from invoice_xero_draft_generations g where g.invoice_id = i.id and g.generation = v_gen),
            'void_observation_id', v_check ->> 'void_observation_id', 'void_settlement', v_check ->> 'void_settlement'),
          jsonb_build_object('status', 'APPROVED', 'sync_status', 'PENDING', 'generation', v_gen + 1, 'approval_number', v_ap.approval_number,
            'outbox_idempotency_key', v_okey, 'payload_hash', v_ap.payload_hash, 'bound_tenant_id', v_check ->> 'bound_tenant_id'),
          coalesce(v_note || ' | ', '') || v_reason);
  v_res := jsonb_build_object('ok', true, 'code', 'REISSUE_QUEUED', 'approval_number', v_ap.approval_number,
    'invoice_id', i.id, 'invoice_number', i.invoice_number, 'generation', v_gen + 1, 'superseded_generation', v_gen,
    'outbox_idempotency_key', v_okey, 'xero_idempotency_key', xero_draft_provider_key(i.id, v_gen + 1),
    'detail', format('%s: %s queued generation %s for %s (superseded generation %s, Xero invoice %s)',
      v_ap.approval_number, v_okey, v_gen + 1, i.invoice_number, v_gen, coalesce(v_check ->> 'linked_xero_invoice_id', 'none')));
  update processed_events set status = 'COMPLETED', completed_at = now(), result = v_res, lease_expires_at = null
   where consumer = 'invoice.reissue:' || v_ap.approval_number and idempotency_key = v_key;
  return v_res;
end $$;

-- -----------------------------------------------------------------------------
-- 9. invoice_void_guard: the verified-void exemption only when the draft writes are terminal.
-- -----------------------------------------------------------------------------
-- Finding 2f3a13b (AC-14B/AC-14C-A): the exemption was checked before the write state, so a local void could run while
-- a replacement generation was queued - a voided invoice with a live draft write (AC-05 violated). The exemption now
-- requires no live write and nothing UNKNOWN; everything else is unchanged, and a replacement generation that is
-- PENDING is refused as any queued write (it is a queued write). Reconciliation's own applies are unaffected: when a
-- verified void or deletion is applied the write is DONE (or FAILED), i.e. terminal.
create or replace function invoice_void_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare o outbox; v_live int;
begin
  select * into o from outbox_current('xero.create_draft_invoice', new.id);
  if o.id is null then return new; end if;
  select count(*) into v_live from outbox w where w.topic = 'xero.create_draft_invoice' and w.aggregate_id = new.id
     and (w.status in ('PENDING', 'DISPATCHING') or (w.status = 'FAILED' and w.next_attempt_at <> 'infinity'));
  -- AC-14 / AC-14C / AC-14C B2: voided or deleted in Xero, verified by reconciliation (the linked invoice, in its bound
  -- tenant), and nothing is still writing: RoofOps follows Xero. A deletion with no money movement is the same business
  -- state as a void.
  if v_live = 0 and new.sync_status <> 'UNKNOWN'
     and not exists (select 1 from invoice_xero_draft_generations g where g.invoice_id = new.id and g.status = 'UNKNOWN')
     and exists (select 1 from xero_invoice_observations x
                  where x.id = (select id from xero_invoice_observations where invoice_id = new.id order by observed_at desc, id desc limit 1)
                    and x.verdict = 'VERIFIED' and x.settlement in ('VOIDED', 'DELETED') and x.tenant_id = o.payload ->> 'xero_tenant_id'
                    and x.xero_invoice_id = (select external_id from external_links where provider = 'XERO' and external_type = 'Invoice' and entity_id = new.id)) then
    return new;
  end if;
  if o.status = 'DISPATCHING' then
    raise exception '% cannot be voided: its Xero draft is being created right now. Try again when that has finished', old.invoice_number using errcode = 'check_violation';
  end if;
  -- AC-14C B2: the supervised reissue window - the invoice is APPROVED with a replacement generation queued and the
  -- superseded generation's document still linked. That is a queued write like any other; the replacement must finish
  -- (or fail) before a person can void again.
  if exists (select 1 from invoice_xero_draft_generations g where g.invoice_id = new.id and g.superseded_at is null
               and g.generation > 1 and g.status = 'PENDING') then
    raise exception '% cannot be voided: its Xero draft is queued (replacement generation % not started yet). Let the reissue finish, or void it after the write has failed',
      old.invoice_number, (select max(g.generation) from invoice_xero_draft_generations g where g.invoice_id = new.id and g.superseded_at is null)
      using errcode = 'check_violation';
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

-- -----------------------------------------------------------------------------
-- 10. wf_complete_side_effect_core: the link moves on a supervised replacement's completion.
-- -----------------------------------------------------------------------------
-- Byte-for-byte the previous body except the Xero link check: a write of generation >= 2 whose predecessor generation
-- is superseded may move the ONE current external_links row to the new InvoiceID, under all the existing proofs (tenant,
-- DEMO, DRAFT, ACCREC, expected number and reference, contact, totals, AUD/inclusive, exactly one match). Generation 1,
-- or a generation whose predecessor is not superseded, keeps the old refusal. The superseded generation's InvoiceID
-- stays in invoice_xero_draft_generations, in its observations and in audit_events.
create or replace function wf_complete_side_effect_core(p_key text, p_result jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o outbox;
  v_existing text;
  v_run uuid;
  v_left int;
  v_ref text;
  v_expected jsonb;
  v_got jsonb;
  v_sub jsonb;
  v_drive_url text;
begin
  select * into o from outbox where idempotency_key = p_key for update;
  if not found then raise exception 'unknown side effect %', p_key using errcode = 'no_data_found'; end if;
  if o.status = 'DONE' then
    return jsonb_build_object('status', 'ALREADY_DONE', 'result', o.result);
  end if;
  if o.status <> 'DISPATCHING' then
    raise exception 'side effect % is %, not claimed', p_key, o.status using errcode = 'check_violation';
  end if;
  if coalesce((p_result ->> 'verified')::boolean, false) is not true then
    raise exception 'refusing to record % without read-back verification (verified=true)', p_key using errcode = 'check_violation';
  end if;
  v_ref := coalesce(o.payload ->> 'invoice_number', o.payload ->> 'project_number');

  if o.topic = 'drive.ensure_project_folder' then
    if coalesce(p_result ->> 'folder_id', '') = '' or coalesce(p_result ->> 'mime_type', '') <> 'application/vnd.google-apps.folder' then
      raise exception 'drive result needs folder_id and mime_type=application/vnd.google-apps.folder' using errcode = 'check_violation';
    end if;
    if coalesce(p_result ->> 'parent_id', '') = '' or coalesce((p_result ->> 'trashed')::boolean, true) then
      raise exception 'drive result needs parent_id and trashed=false from the read-back' using errcode = 'check_violation';
    end if;
    if p_result ->> 'name' is distinct from o.payload ->> 'folder_name' then
      raise exception 'drive folder name % does not match %', p_result ->> 'name', o.payload ->> 'folder_name' using errcode = 'check_violation';
    end if;
    if p_result -> 'app_properties' ->> 'roofops_project_id' is distinct from o.aggregate_id::text then
      raise exception 'drive folder is not tagged with project %', o.aggregate_id using errcode = 'check_violation';
    end if;
    -- Every requested subfolder, exactly once, each read back as a live folder inside the project folder.
    v_expected := coalesce(o.payload -> 'subfolders', '[]'::jsonb);
    select coalesce(jsonb_agg(s ->> 'name' order by s ->> 'name'), '[]') into v_got
      from jsonb_array_elements(coalesce(p_result -> 'subfolders', '[]'::jsonb)) s
     where coalesce(s ->> 'id', '') <> '' and s ->> 'parent_id' = p_result ->> 'folder_id'
       and s ->> 'mime_type' = 'application/vnd.google-apps.folder' and not coalesce((s ->> 'trashed')::boolean, true);
    if v_got <> (select coalesce(jsonb_agg(e order by e), '[]') from jsonb_array_elements_text(v_expected) e) then
      raise exception 'drive subfolders read back % do not match the required %', v_got, v_expected using errcode = 'check_violation';
    end if;

    select external_id into v_existing from external_links
     where provider = 'GOOGLE_DRIVE' and entity_type = 'project' and entity_id = o.aggregate_id and external_type = 'Folder';
    if v_existing is not null and v_existing <> p_result ->> 'folder_id' then
      raise exception 'project % already linked to Drive folder %, refusing a second folder %', v_ref, v_existing, p_result ->> 'folder_id'
        using errcode = 'unique_violation';
    end if;
    insert into external_links (provider, entity_type, entity_id, external_type, external_id, external_url, last_synced_at, verified_at)
    values ('GOOGLE_DRIVE', 'project', o.aggregate_id, 'Folder', p_result ->> 'folder_id', p_result ->> 'web_view_link', now(), now())
    on conflict (provider, entity_type, entity_id, external_type) do update set verified_at = now(), last_synced_at = now();
    for v_sub in select * from jsonb_array_elements(p_result -> 'subfolders') loop
      insert into external_links (provider, entity_type, entity_id, external_type, external_id, external_url, last_synced_at, verified_at)
      values ('GOOGLE_DRIVE', 'project', o.aggregate_id, 'Folder:' || (v_sub ->> 'name'), v_sub ->> 'id', v_sub ->> 'web_view_link', now(), now())
      on conflict (provider, entity_type, entity_id, external_type) do update set verified_at = now(), last_synced_at = now();
    end loop;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, external_reference, reason, correlation_id)
    values ('INTEGRATION', 'google-drive', 'drive.folder.link', 'project', o.aggregate_id, v_ref,
            p_result - 'verified', p_result ->> 'folder_id', 'Project folder and subfolders created and read back from Google Drive', o.correlation_id);

  elsif o.topic = 'airtable.project_writeback' then
    if coalesce(p_result ->> 'project_record_id', '') !~ '^rec[A-Za-z0-9]{14}$' then
      raise exception 'airtable result needs project_record_id (recXXXXXXXXXXXXXX)' using errcode = 'check_violation';
    end if;
    if p_result ->> 'roofops_id' is distinct from o.aggregate_id::text or p_result ->> 'project_number' is distinct from v_ref then
      raise exception 'airtable record read back does not carry project % / %', v_ref, o.aggregate_id using errcode = 'check_violation';
    end if;
    if o.payload ->> 'quote_airtable_record_id' is not null
       and not coalesce(p_result -> 'linked_quote_record_ids' ? (o.payload ->> 'quote_airtable_record_id'), false) then
      raise exception 'airtable project is not linked to quote record %', o.payload ->> 'quote_airtable_record_id' using errcode = 'check_violation';
    end if;
    select external_url into v_drive_url from external_links
     where provider = 'GOOGLE_DRIVE' and entity_type = 'project' and entity_id = o.aggregate_id and external_type = 'Folder';
    if v_drive_url is not null and p_result ->> 'drive_folder_url' is distinct from v_drive_url then
      raise exception 'airtable Drive Folder % does not match the verified folder %', p_result ->> 'drive_folder_url', v_drive_url using errcode = 'check_violation';
    end if;
    select external_id into v_existing from external_links
     where provider = 'AIRTABLE' and entity_type = 'project' and entity_id = o.aggregate_id and external_type = 'Record';
    if v_existing is not null and v_existing <> p_result ->> 'project_record_id' then
      raise exception 'project % already linked to Airtable record %, refusing a second record %', v_ref, v_existing, p_result ->> 'project_record_id'
        using errcode = 'unique_violation';
    end if;
    insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
    values ('AIRTABLE', 'project', o.aggregate_id, 'Record', p_result ->> 'project_record_id', now(), now())
    on conflict (provider, entity_type, entity_id, external_type) do update set verified_at = now(), last_synced_at = now();
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, external_reference, reason, correlation_id)
    values ('INTEGRATION', 'airtable', 'airtable.project.writeback', 'project', o.aggregate_id, v_ref,
            p_result - 'verified', p_result ->> 'project_record_id', 'Project record written to Airtable, linked to its quote and read back', o.correlation_id);
  elsif o.topic = 'xero.create_draft_invoice' then
    -- Only proof read back from the pinned Xero DEMO tenant is accepted, and it must describe exactly the approved draft.
    if coalesce(o.payload ->> 'xero_tenant_id', '') = '' or p_result ->> 'tenant_id' is distinct from o.payload ->> 'xero_tenant_id' then
      raise exception 'xero proof is from tenant %, not the pinned Demo Company tenant', p_result ->> 'tenant_id' using errcode = 'check_violation';
    end if;
    if p_result ->> 'organisation_class' is distinct from 'DEMO' then
      raise exception 'refusing: the Xero organisation is not a Demo Company (Class=%)', p_result ->> 'organisation_class' using errcode = 'check_violation';
    end if;
    if coalesce(p_result ->> 'invoice_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or coalesce(p_result ->> 'contact_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'xero proof needs InvoiceID and ContactID' using errcode = 'check_violation';
    end if;
    if p_result ->> 'invoice_number' is distinct from o.payload ->> 'xero_invoice_number' or p_result ->> 'reference' is distinct from o.payload ->> 'reference' then
      raise exception 'xero invoice %/% does not carry number % and reference %', p_result ->> 'invoice_number', p_result ->> 'reference',
        o.payload ->> 'xero_invoice_number', o.payload ->> 'reference' using errcode = 'check_violation';
    end if;
    if p_result ->> 'status' is distinct from 'DRAFT' or p_result ->> 'type' is distinct from 'ACCREC' then
      raise exception 'xero invoice must be an ACCREC DRAFT, read back %/%', p_result ->> 'type', p_result ->> 'status' using errcode = 'check_violation';
    end if;
    if coalesce((p_result ->> 'amount_paid')::numeric, -1) <> 0 or coalesce((p_result ->> 'sent_to_contact')::boolean, true) then
      raise exception 'xero invoice must be unpaid and unsent' using errcode = 'check_violation';
    end if;
    if p_result ->> 'contact_number' is distinct from o.payload ->> 'xero_contact_number' then
      raise exception 'xero invoice contact % is not %', p_result ->> 'contact_number', o.payload ->> 'xero_contact_number' using errcode = 'check_violation';
    end if;
    if (p_result ->> 'total')::numeric is distinct from (o.payload ->> 'amount_inc_gst')::numeric
       or (p_result ->> 'total_tax')::numeric is distinct from (o.payload ->> 'gst_amount')::numeric then
      raise exception 'xero total %/GST % does not match the approved % / %', p_result ->> 'total', p_result ->> 'total_tax',
        o.payload ->> 'amount_inc_gst', o.payload ->> 'gst_amount' using errcode = 'check_violation';
    end if;
    if p_result ->> 'currency' is distinct from 'AUD' or p_result ->> 'line_amount_types' is distinct from 'Inclusive' then
      raise exception 'xero invoice must be AUD, GST inclusive' using errcode = 'check_violation';
    end if;
    if coalesce((p_result ->> 'matching_invoices')::int, 0) <> 1 then
      raise exception 'expected exactly one Xero invoice numbered %, found %', o.payload ->> 'xero_invoice_number', p_result ->> 'matching_invoices'
        using errcode = 'unique_violation';
    end if;
    select external_id into v_existing from external_links
     where provider = 'XERO' and entity_type = 'invoice' and entity_id = o.aggregate_id and external_type = 'Invoice';
    if v_existing is not null and v_existing <> p_result ->> 'invoice_id' then
      -- AC-14C B2: a supervised replacement (generation >= 2) whose predecessor generation is superseded may move the
      -- one current link to the new InvoiceID; anything else still refuses a second link.
      if o.generation >= 2 and exists (select 1 from invoice_xero_draft_generations g
             where g.invoice_id = o.aggregate_id and g.generation = o.generation - 1 and g.superseded_at is not null) then
        update external_links set external_id = p_result ->> 'invoice_id',
               external_url = 'https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=' || (p_result ->> 'invoice_id'),
               last_synced_at = now(), verified_at = now()
         where provider = 'XERO' and entity_type = 'invoice' and entity_id = o.aggregate_id and external_type = 'Invoice';
      else
        raise exception 'invoice % already linked to Xero invoice %, refusing a second %', v_ref, v_existing, p_result ->> 'invoice_id'
          using errcode = 'unique_violation';
      end if;
    end if;
    select external_id into v_existing from external_links
     where provider = 'XERO' and entity_type = 'customer' and entity_id = (o.payload ->> 'customer_id')::uuid and external_type = 'Contact';
    if v_existing is not null and v_existing <> p_result ->> 'contact_id' then
      raise exception 'customer % is linked to Xero contact %, not %', o.payload ->> 'customer_number', v_existing, p_result ->> 'contact_id'
        using errcode = 'unique_violation';
    end if;
    insert into external_links (provider, entity_type, entity_id, external_type, external_id, external_url, last_synced_at, verified_at)
    values ('XERO', 'invoice', o.aggregate_id, 'Invoice', p_result ->> 'invoice_id',
            'https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=' || (p_result ->> 'invoice_id'), now(), now()),
           ('XERO', 'customer', (o.payload ->> 'customer_id')::uuid, 'Contact', p_result ->> 'contact_id',
            'https://go.xero.com/Contacts/View/' || (p_result ->> 'contact_id'), now(), now())
    on conflict (provider, entity_type, entity_id, external_type) do update set verified_at = now(), last_synced_at = now();
    update invoices set sync_status = 'SYNCED' where id = o.aggregate_id;
    update approvals set status = 'EXECUTED', executed_at = now(), execution_result = p_result - 'verified'
     where id = (select approval_id from invoices where id = o.aggregate_id);
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, external_reference, reason, correlation_id)
    values ('INTEGRATION', 'xero', 'xero.invoice.draft_created', 'invoice', o.aggregate_id, v_ref,
            p_result - 'verified', p_result ->> 'invoice_id',
            'DRAFT invoice ' || (p_result ->> 'invoice_number') || ' created in the Xero Demo Company and read back', o.correlation_id);
  else
    raise exception 'unknown side-effect topic %', o.topic;
  end if;

  update outbox set status = 'DONE', dispatched_at = now(), locked_until = null, result = p_result where idempotency_key = p_key;
  perform wf_log_event(p_key || ':done:' || o.attempts, o.correlation_id, null, replace(o.topic, 'ensure_', '') || '.verified',
    'project', o.aggregate_id, v_ref, 'INTEGRATION', o.topic, 'n8n', 'SUCCEEDED', null,
    jsonb_build_object('attempt', o.attempts, 'external_id', coalesce(p_result ->> 'folder_id', p_result ->> 'project_record_id', p_result ->> 'invoice_id')), null);

  select id into v_run from workflow_runs where entity_id = o.aggregate_id order by started_at desc limit 1;
  insert into workflow_run_steps (run_id, attempt, seq, step_key, status, finished_at, detail)
  values (v_run, o.attempts, (select coalesce(max(seq), 0) + 1 from workflow_run_steps where run_id = v_run), o.topic, 'SUCCEEDED', now(),
          jsonb_build_object('attempt', o.attempts, 'external_id', coalesce(p_result ->> 'folder_id', p_result ->> 'project_record_id', p_result ->> 'invoice_id')));
  select count(*) into v_left from outbox where aggregate_id = o.aggregate_id and status <> 'DONE';
  if v_left = 0 then
    update workflow_runs set status = 'SUCCEEDED', finished_at = now() where id = v_run;
    update workflow_exceptions set resolution_status = 'RESOLVED', resolved_at = now(), resolved_by_system = 'workflow:' || (select workflow_key from workflow_runs where id = v_run),
           resolution_note = 'Auto-resolved: side effect succeeded on retry'
     where workflow_run_id = v_run and resolution_status in ('OPEN','RETRY_QUEUED');
  end if;
  return jsonb_build_object('status', 'RECORDED', 'key', p_key, 'remaining_side_effects', v_left);
end $$;

-- -----------------------------------------------------------------------------
-- 11. Privileges (the blanket revoke tail, role set unchanged).
-- -----------------------------------------------------------------------------
-- No new table: the ledger (invoice_xero_draft_generations) already has RLS enabled and no grants (B1a), and everything
-- here is reached through the SECURITY DEFINER functions above. create or replace keeps the privileges of the functions
-- that already existed, so the revokes below only reach what this migration adds; the role grants are restated as they
-- were left by 20261001160000. Nothing new is granted to roofops_workflow or roofops_dashboard: the reissue is not
-- callable from the workflow role (test/schema.test.ts pins the workflow allow-list at 21 functions).
revoke execute on all functions in schema public from public;
revoke execute on function invoice_reissue_generation(uuid), invoice_reissue_preview(uuid, text), invoice_reissue_preview_hash(jsonb),
  invoice_reissue_check(uuid), invoice_reissue_guard(), ops_reissue_request(uuid, text, text), ops_reissue_decide(text, text, text),
  invoice_void_guard(), wf_complete_side_effect_core(text, jsonb) from roofops_workflow, roofops_dashboard;
grant execute on function integrity_check() to roofops_dashboard;
grant execute on function wf_reconcile_targets(text), wf_reconcile_xero_uncertain(text, jsonb) to roofops_workflow;

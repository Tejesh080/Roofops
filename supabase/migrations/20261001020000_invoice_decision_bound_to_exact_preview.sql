-- AC-03 follow-up (docs/defect-ledger.md): bind an Airtable decision to the exact preview on the row, not to timing.
-- 20261001010000 counted a preview as shown when Postgres answered the Prepare, and never looked at what the row showed.
-- So an Approve still approved a preview 04 never managed to write to the row, a preview whose text a person had edited
-- on the row (another amount), and a preview a later outcome had already replaced on the row.
--
-- Rule: a preview is shown on a row only when n8n 04 wrote it and read it back, and reports that read-back text here
-- (wf_invoice_preview_verified); the text must carry the approval's marker (number and hash) and its amount. A decision
-- from Airtable carries the Invoice Preview text 04 read from the row just before deciding; it must show exactly the
-- pending approval (marker and amount), verified on that row before the decision was made.

alter table approval_presentations add column verified boolean not null default false;
alter table approval_presentations add column payload_hash text;
comment on column approval_presentations.presented_at is 'When 04''s read-back proved the preview was on the row (verified rows)';

-- What 04 writes for a preview (the first line of Invoice Preview), and the amount line it must show.
create or replace function invoice_preview_marker(p_approval approvals)
returns text language sql immutable set search_path = public, pg_temp as $$
  select 'PREVIEW ' || p_approval.approval_number || ' · #' || left(p_approval.payload_hash, 16)
$$;
create or replace function invoice_preview_amount_line(p_approval approvals)
returns text language sql immutable set search_path = public, pg_temp as $$
  select 'Amount: ' || to_char((p_approval.action_payload ->> 'amount_inc_gst')::numeric, 'FM$999,999,990.00') || ' inc GST'
$$;
-- Does this Invoice Preview text show exactly this approval (its marker and its amount)?
create or replace function invoice_preview_shows(p_text text, p_approval approvals)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select coalesce(position(invoice_preview_marker(p_approval) in p_text) > 0 and position(invoice_preview_amount_line(p_approval) in p_text) > 0, false)
$$;

-- Prepare: the marker is part of the answer; nothing counts as shown until 04 proves it.
create or replace function wf_invoice_prepare(p_event jsonb, p_worker text default 'n8n')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_res jsonb := wf_invoice_prepare_core(p_event, p_worker);
  v_inv uuid; v_ap approvals;
begin
  if v_res ->> 'outcome' = 'ALREADY_INVOICED' then
    select i.id into v_inv from invoices i join approvals a on a.id = i.approval_id where a.approval_number = v_res ->> 'approval_number';
    if v_inv is null then   -- already invoiced outside this approval flow (e.g. a FINAL invoice with no approval row)
      select i.id into v_inv from invoices i where i.invoice_type = 'FINAL'
         and i.project_id = (select id from projects where project_number = p_event -> 'payload' ->> 'project_number');
    end if;
    if v_inv is not null then v_res := v_res || jsonb_build_object('xero_state', invoice_xero_state(v_inv)); end if;
  end if;
  if v_res ->> 'outcome' in ('PREVIEW_READY', 'ALREADY_PENDING') then
    select * into v_ap from approvals where approval_number = v_res ->> 'approval_number';
    if v_ap.id is not null then v_res := v_res || jsonb_build_object('preview_marker', invoice_preview_marker(v_ap)); end if;
  end if;
  return v_res;
end $$;

-- n8n 04, after writing a row's invoice fields and reading them back: the read-back Invoice Preview text. Records the
-- preview as shown on that row only if the text shows a PENDING approval exactly, and that approval is what the Airtable
-- Prepare on that same row (p_event_key) returned.
create or replace function wf_invoice_preview_verified(p_event_key text, p_record_id text, p_readback text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_num text := substring(coalesce(p_readback, '') from 'PREVIEW (APR-[0-9]{4}-[0-9]{4}) · #'); v_ap approvals;
begin
  if v_num is null then return jsonb_build_object('recorded', false, 'reason', 'the row shows no invoice preview'); end if;
  select * into v_ap from approvals where approval_number = v_num;
  if v_ap.id is null or v_ap.status <> 'PENDING' then
    return jsonb_build_object('recorded', false, 'reason', v_num || ' is not a pending preview');
  end if;
  if not invoice_preview_shows(p_readback, v_ap) then
    return jsonb_build_object('recorded', false, 'reason', 'the row does not show ' || v_num || ' as prepared (marker or amount differs)');
  end if;
  if v_ap.entity_id is distinct from airtable_project_for_record(p_record_id) or not exists (
       select 1 from automation_events e join processed_events pe on pe.consumer = 'invoice_prepare@1' and pe.result ->> 'event_key' = e.event_key
        where e.event_key = p_event_key and e.event_type = 'invoice.prepare_requested' and e.source = 'airtable'
          and e.metadata ->> 'airtable_record_id' = p_record_id and pe.result ->> 'approval_number' = v_num) then
    return jsonb_build_object('recorded', false, 'reason', 'no Airtable Prepare on this row returned ' || v_num);
  end if;
  insert into approval_presentations (approval_id, airtable_record_id, event_key, verified, payload_hash)
  values (v_ap.id, p_record_id, p_event_key, true, v_ap.payload_hash)
  on conflict (approval_id, airtable_record_id) do update
    set verified = true, payload_hash = excluded.payload_hash, event_key = excluded.event_key,
        presented_at = case when approval_presentations.verified then approval_presentations.presented_at else now() end;
  return jsonb_build_object('recorded', true, 'approval_number', v_num);
end $$;

create or replace function wf_invoice_decide(p_event jsonb, p_worker text default 'n8n')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_res jsonb; v_event jsonb := p_event; v_payload jsonb := p_event -> 'payload';
  v_type text := p_event ->> 'event_type'; v_src text := p_event ->> 'source';
  v_cell text := p_event -> 'payload' ->> 'project_number'; v_rec text := p_event -> 'payload' ->> 'airtable_record_id';
  v_named text := nullif(p_event -> 'payload' ->> 'approval_number', ''); v_hash text := nullif(p_event -> 'payload' ->> 'payload_hash', '');
  v_at timestamptz; p projects; v_ap approvals; v_shown approval_presentations; v_amount text; v_prep_src text;
begin
  -- Only a well-formed decision is bound here; anything else gets the handler's own validation answer.
  if v_type in ('invoice.approved', 'invoice.rejected') and jsonb_typeof(v_payload) = 'object' and coalesce(v_cell, '') ~ '^PRJ-[0-9]{4}-[0-9]{4}$'
     and coalesce(v_src, '') <> '' and coalesce(p_event ->> 'actor_id', '') <> '' and coalesce(p_event ->> 'event_id', '') <> '' then
    if v_src = 'airtable' then
      -- 1. The project is the one whose Airtable record sent the decision, never the (editable) Project Number text.
      if coalesce(v_rec, '') = '' or airtable_project_for_record(v_rec) is null then
        return invoice_decision_refused(p_event, p_worker, null, 'NOT_FOUND',
          format('This Airtable row (%s) is not linked to a RoofOps project. Nothing was approved', coalesce(nullif(v_rec, ''), 'no record id')), null);
      end if;
      select * into p from projects where id = airtable_project_for_record(v_rec) for update;
      if p.project_number <> v_cell then
        return invoice_decision_refused(p_event, p_worker, p.id, 'RECONCILIATION_MISMATCH',
          format('This Airtable row is %s but its Project Number cell says %s. Nothing was approved; restore the Project Number and decide again', p.project_number, v_cell), null);
      end if;
      if v_payload ? 'project_uuid' and v_payload ->> 'project_uuid' is distinct from p.id::text then
        return invoice_decision_refused(p_event, p_worker, p.id, 'RECONCILIATION_MISMATCH',
          format('This Airtable row is %s but its RoofOps ID cell does not match. Nothing was approved; restore the RoofOps ID and decide again', p.project_number), null);
      end if;
    else
      select * into p from projects where project_number = v_cell for update;
      if p.id is not null and v_named is null then
        return invoice_decision_refused(p_event, p_worker, p.id, 'INVALID_STATE',
          format('A decision from %s must name the approval it decides. Nothing was approved', v_src), null);
      end if;
    end if;

    if p.id is not null then
      -- 2. The approval it decides: the one it names, else the one the handler would pick (pending first, newest).
      select * into v_ap from approvals a where a.action_type = 'CREATE_INVOICE' and a.entity_id = p.id and (v_named is null or a.approval_number = v_named)
       order by (a.status = 'PENDING') desc, a.created_at desc limit 1;
      if v_ap.id is not null and v_ap.status = 'PENDING' then
        if v_hash is not null and v_hash is distinct from v_ap.payload_hash then
          return invoice_decision_refused(p_event, p_worker, p.id, 'INVALID_STATE',
            format('The preview you decided is not %s as it stands now. Nothing was approved; prepare the preview again', v_ap.approval_number), v_ap.approval_number);
        end if;
        -- 3. From Airtable: only the exact preview 04 wrote to this row and read back, before the decision was made, and
        --    still shown on the row when the decision is processed.
        if v_src = 'airtable' then
          begin v_at := (p_event ->> 'occurred_at')::timestamptz; exception when others then v_at := null; end;
          v_amount := to_char((v_ap.action_payload ->> 'amount_inc_gst')::numeric, 'FM$999,999,990.00');
          select * into v_shown from approval_presentations where approval_id = v_ap.id and airtable_record_id = v_rec and verified;
          if v_shown.approval_id is null then
            select e.source into v_prep_src from automation_events e where 'approval:' || e.event_key = v_ap.idempotency_key;
            return invoice_decision_refused(p_event, p_worker, p.id, 'INVALID_STATE',
              case when v_prep_src is distinct from 'airtable' then
                format('%s (%s inc GST) was prepared in the RoofOps dashboard and has not been shown on this row. Nothing was approved; set Invoice Action = Prepare Xero draft invoice to show it, check it, then approve', v_ap.approval_number, v_amount)
              else
                format('%s (%s inc GST) was never confirmed on this row (its preview was not written to Airtable and read back). Nothing was approved; set Invoice Action = Prepare Xero draft invoice to show it, check it, then approve', v_ap.approval_number, v_amount)
              end, v_ap.approval_number);
          end if;
          if v_at is null or v_at <= v_shown.presented_at then
            return invoice_decision_refused(p_event, p_worker, p.id, 'INVALID_STATE',
              format('%s was shown on this row only after this decision was made. Nothing was approved; check the preview now shown and decide again', v_ap.approval_number), v_ap.approval_number);
          end if;
          if not (v_payload ? 'displayed_preview') or not invoice_preview_shows(v_payload ->> 'displayed_preview', v_ap) then
            return invoice_decision_refused(p_event, p_worker, p.id, 'INVALID_STATE',
              format('This row does not show %s (%s inc GST) exactly as prepared (it shows another preview or message, or the text was edited). Nothing was approved; set Invoice Action = Prepare Xero draft invoice to show it again, check it, then approve',
                     v_ap.approval_number, v_amount), v_ap.approval_number);
          end if;
        end if;
      end if;
      -- Bind the handler to exactly that approval (and that project).
      if v_ap.id is not null then
        v_event := jsonb_set(v_event, '{payload}', v_payload || jsonb_build_object('approval_number', v_ap.approval_number, 'project_number', p.project_number));
      end if;
    end if;
  else
    perform 1 from projects where project_number = v_cell for update;
  end if;

  v_res := wf_invoice_decide_core(v_event, p_worker);
  if v_res ->> 'outcome' = 'ALREADY_PROCESSED' and v_res ? 'invoice_id' then
    v_res := v_res || jsonb_build_object('xero_state', invoice_xero_state((v_res ->> 'invoice_id')::uuid));
  end if;
  return v_res;
end $$;

update field_contract set validation = 'state_transitions(approval); mapped approver; current hash; an Airtable decision binds to the sending record''s project and to the exact preview (marker, hash, amount) 04 wrote to that row and read back before the decision'
 where entity = 'approval' and field_key = 'status';
update field_contract set readback = '04 read-back; wf_invoice_preview_verified records the verified preview'
 where entity = 'project' and field_key = 'invoice_preview';

revoke execute on all functions in schema public from public;
revoke execute on function invoice_preview_marker(approvals), invoice_preview_amount_line(approvals), invoice_preview_shows(text, approvals)
  from roofops_workflow, roofops_dashboard;
grant execute on function wf_invoice_prepare(jsonb, text), wf_invoice_decide(jsonb, text), wf_invoice_preview_verified(text, text, text) to roofops_workflow;
grant execute on function wf_invoice_prepare(jsonb, text) to roofops_dashboard;

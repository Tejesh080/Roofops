-- AC-03 (docs/defect-ledger.md): an Airtable "Approve" approved an invoice preview the approver never saw.
-- n8n 04's decision event names no approval: payload = the row's Project Number cell, its record id and its RoofOps ID
-- cell. wf_invoice_decide found the project by the (editable) Project Number text and decided whichever CREATE_INVOICE
-- approval was PENDING when the event was processed. So an Approve could approve:
--  * a preview the dashboard/Copilot prepared after the Airtable one went stale (the Copilot never writes Airtable);
--  * another project's preview, from a row whose Project Number cell was edited;
--  * a preview prepared after the click (04 runs every Prepare of a batch before any Decide).
--
-- Rule: an Airtable decision applies only to the project whose Airtable record sent it, and only to the preview that an
-- Airtable Prepare on that same row showed (04 writes "PREVIEW APR-…" on the row for PREVIEW_READY / ALREADY_PENDING)
-- before the decision was made. A preview prepared in the dashboard is shown on the row by setting Invoice Action =
-- Prepare there (ALREADY_PENDING: the same preview, no new approval). A decision from any other source must name the
-- approval. A payload hash, when sent, must match. n8n is unchanged.

-- Where each preview was shown to an approver: the Airtable row a Prepare returned it to, and when.
create table approval_presentations (
  approval_id        uuid not null references approvals(id),
  airtable_record_id text not null,
  presented_at       timestamptz not null default now(),
  event_key          text not null,
  primary key (approval_id, airtable_record_id)
);
alter table approval_presentations enable row level security;
revoke all on approval_presentations from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on approval_presentations from anon, authenticated';
  end if;
end $$;

-- The RoofOps project an Airtable Projects record is linked to.
create or replace function airtable_project_for_record(p_record_id text)
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select entity_id from external_links
   where provider = 'AIRTABLE' and entity_type = 'project' and external_type = 'Record' and external_id = p_record_id
   order by verified_at desc nulls last limit 1
$$;

create or replace function wf_invoice_prepare(p_event jsonb, p_worker text default 'n8n')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_res jsonb := wf_invoice_prepare_core(p_event, p_worker);
  v_inv uuid; v_ap approvals; v_rec text := p_event -> 'payload' ->> 'airtable_record_id';
begin
  if v_res ->> 'outcome' = 'ALREADY_INVOICED' then
    select i.id into v_inv from invoices i join approvals a on a.id = i.approval_id where a.approval_number = v_res ->> 'approval_number';
    if v_inv is null then   -- already invoiced outside this approval flow (e.g. a FINAL invoice with no approval row)
      select i.id into v_inv from invoices i where i.invoice_type = 'FINAL'
         and i.project_id = (select id from projects where project_number = p_event -> 'payload' ->> 'project_number');
    end if;
    if v_inv is not null then v_res := v_res || jsonb_build_object('xero_state', invoice_xero_state(v_inv)); end if;
  end if;
  -- AC-03: n8n 04 shows this preview on the row that asked (a redelivery shows it again: the first showing counts).
  if p_event ->> 'source' = 'airtable' and coalesce(v_rec, '') <> '' and v_res ->> 'outcome' in ('PREVIEW_READY', 'ALREADY_PENDING') then
    select * into v_ap from approvals where approval_number = v_res ->> 'approval_number';
    if v_ap.id is not null and v_ap.entity_id = airtable_project_for_record(v_rec) then
      insert into approval_presentations (approval_id, airtable_record_id, event_key) values (v_ap.id, v_rec, p_event ->> 'event_id')
      on conflict do nothing;
    end if;
  end if;
  return v_res;
end $$;

-- A decision that is refused before any approval is touched: logged, one exception, and a reason 04 shows on the row.
create or replace function invoice_decision_refused(p_event jsonb, p_worker text, p_project uuid, p_class text, p_message text, p_approval text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare e record; v_exc text; v_prj text := p_event -> 'payload' ->> 'project_number';
begin
  select * into e from wf_invoice_log_event(p_event, p_event ->> 'event_type', p_worker);
  v_exc := wf_open_invoice_rejection(e.event_id, p_project, coalesce((select project_number from projects where id = p_project), v_prj), p_class, p_message);
  update automation_events set status = 'REJECTED', error_class = p_class, metadata = metadata || jsonb_build_object('reason', p_message)
   where event_id = e.event_id;
  return jsonb_strip_nulls(jsonb_build_object('outcome', 'INVALID_STATE', 'error_class', p_class, 'message', p_message, 'exception_number', v_exc,
    'approval_number', p_approval, 'project_number', coalesce((select project_number from projects where id = p_project), v_prj), 'nothing_approved', true));
end $$;

create or replace function wf_invoice_decide(p_event jsonb, p_worker text default 'n8n')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_res jsonb; v_event jsonb := p_event; v_payload jsonb := p_event -> 'payload';
  v_type text := p_event ->> 'event_type'; v_src text := p_event ->> 'source';
  v_cell text := p_event -> 'payload' ->> 'project_number'; v_rec text := p_event -> 'payload' ->> 'airtable_record_id';
  v_named text := nullif(p_event -> 'payload' ->> 'approval_number', ''); v_hash text := nullif(p_event -> 'payload' ->> 'payload_hash', '');
  v_at timestamptz; p projects; v_ap approvals; v_shown approval_presentations;
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
        -- 3. From Airtable: only a preview shown on this row before the decision was made.
        if v_src = 'airtable' then
          begin v_at := (p_event ->> 'occurred_at')::timestamptz; exception when others then v_at := null; end;
          select * into v_shown from approval_presentations where approval_id = v_ap.id and airtable_record_id = v_rec;
          if v_shown.approval_id is null then
            return invoice_decision_refused(p_event, p_worker, p.id, 'INVALID_STATE',
              format('%s (%s inc GST) was prepared in the RoofOps dashboard and has not been shown on this row. Nothing was approved; set Invoice Action = Prepare Xero draft invoice to show it, check it, then approve',
                     v_ap.approval_number, to_char((v_ap.action_payload ->> 'amount_inc_gst')::numeric, 'FM$999,999,990.00')), v_ap.approval_number);
          end if;
          if v_at is null or v_at <= v_shown.presented_at then
            return invoice_decision_refused(p_event, p_worker, p.id, 'INVALID_STATE',
              format('%s was shown on this row only after this decision was made. Nothing was approved; check the preview now shown and decide again', v_ap.approval_number), v_ap.approval_number);
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

update field_contract set validation = 'state_transitions(approval); mapped approver; current hash; an Airtable decision binds to the sending record''s project and to the preview a Prepare showed on that row before the decision'
 where entity = 'approval' and field_key = 'status';

revoke execute on all functions in schema public from public;
revoke execute on function airtable_project_for_record(text), invoice_decision_refused(jsonb, text, uuid, text, text, text) from roofops_workflow, roofops_dashboard;
grant execute on function wf_invoice_prepare(jsonb, text), wf_invoice_decide(jsonb, text) to roofops_workflow;
grant execute on function wf_invoice_prepare(jsonb, text) to roofops_dashboard;

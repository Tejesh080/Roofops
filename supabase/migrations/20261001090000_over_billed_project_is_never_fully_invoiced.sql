-- AC-08 (docs/defect-ledger.md): a project billed more than it is entitled to was labelled "Fully invoiced", with no
-- blocker and no attention flag, and could be CLOSED. invoice_final_preview answered "nothing left to invoice" for any
-- amount <= 0 (exactly billed and over-billed alike), the dashboard mapped that to FULLY_INVOICED, Prepare filed that
-- misleading message, and project_transition_guard let CLOSED through. Imported data (and hosted): PRJ-2026-0006 billed
-- 30,888.72 against 25,740.60 (the deposit billed twice), PRJ-2026-0008 59,687.64 against 49,739.70.
--
-- Rule (owner decisions 2026-10-04): billed <= entitled, always, at every stage. Entitled = the accepted quote version +
-- variations the customer approved (APPROVED or INVOICED). Billed = invoices APPROVED, ISSUED, PARTIALLY_PAID or PAID.
--  * Otherwise the project is OVER_BILLED, its own invoice status: it always needs attention and names the excess and
--    the invoices; the preview (so Prepare and the Copilot) says so, keeping its ARITHMETIC_MISMATCH class.
--  * CLOSED is refused while over-billed, until a person corrects the billing (there is no credit-note model).
--  * Exactly billed stays FULLY_INVOICED and closes as before.
-- invoice_final_preview, project_transition_guard and v_dashboard_projects are redefined in place from their current
-- definitions (so the view and the triggers keep using them); only the marked AC-08 parts are new.

-- 1. The one over-billing rule (null when not over-billed). Read-only; the dashboard view calls it like
--    invoice_final_preview, so it runs with the owner's rights and returns only this project's billing summary.
create or replace function project_over_billing(p_project uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with x as (
    select p.project_number, qv.total_inc_gst as quote,
           coalesce((select sum(v.amount_inc_gst) from variations v where v.project_id = p.id and v.status in ('APPROVED', 'INVOICED')), 0)::numeric(12,2) as variations,
           coalesce((select sum(i.total_inc_gst) from invoices i where i.project_id = p.id and i.status in ('APPROVED', 'ISSUED', 'PARTIALLY_PAID', 'PAID')), 0)::numeric(12,2) as billed,
           (select string_agg(i.invoice_number, ', ' order by i.invoice_number) from invoices i
             where i.project_id = p.id and i.status in ('APPROVED', 'ISSUED', 'PARTIALLY_PAID', 'PAID')) as invoices
      from projects p join quote_versions qv on qv.id = p.accepted_quote_version_id
     where p.id = p_project)
  select jsonb_build_object('billed', billed, 'quote', quote, 'variations', variations, 'entitled', quote + variations,
           'excess', billed - (quote + variations), 'invoices', invoices,
           'message', format('%s is over-billed: billed %s (%s) against quote %s + approved variations %s = %s; over by %s. Correct the billing before it can be closed (for example void the unpaid duplicate invoice)',
                             project_number, billed, invoices, quote, variations, quote + variations, billed - (quote + variations)))
    from x where billed > quote + variations
$$;

-- 2. create or replace function invoice_final_preview(p_project uuid)
create or replace function invoice_final_preview(p_project uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  p projects; c customers; pr properties; qv quote_versions; q quotes;
  v_billed numeric(12,2); v_var numeric(12,2); v_amount numeric(12,2); v_gst numeric(12,2);
  v_blocking text; v_billed_list jsonb; v_lines jsonb; v_rate numeric := 0.1; v_over jsonb;
  v_today date := app_today(); v_terms int := (select value::int from app_settings where key = 'invoice.payment_terms_days');
  v_inv_prefix text := (select value from app_settings where key = 'xero.invoice_number_prefix');
  v_con_prefix text := (select value from app_settings where key = 'xero.contact_number_prefix');
begin
  select * into p from projects where id = p_project;
  if not found then return jsonb_build_object('ok', false, 'error_class', 'NOT_FOUND', 'message', 'Project does not exist'); end if;
  if p.status <> 'COMPLETED' then
    return jsonb_build_object('ok', false, 'error_class', 'INVALID_STATE',
      'message', format('%s is %s; only a COMPLETED project can be final-invoiced', p.project_number, p.status));
  end if;
  if exists (select 1 from v_projects_missing_completion_docs v where v.id = p.id) then
    return jsonb_build_object('ok', false, 'error_class', 'MISSING_DOCUMENT',
      'message', format('%s is missing completion documents (%s); invoice after they are uploaded', p.project_number,
        (select string_agg(label, ', ' order by label) from v_projects_missing_completion_docs v where v.id = p.id)));
  end if;
  if exists (select 1 from invoices where project_id = p.id and invoice_type = 'FINAL' and status <> 'VOIDED') then
    return jsonb_build_object('ok', false, 'error_class', 'INVALID_STATE', 'already_invoiced', true,
      'message', format('%s already has a final invoice (%s)', p.project_number,
        (select string_agg(invoice_number, ', ') from invoices where project_id = p.id and invoice_type = 'FINAL' and status <> 'VOIDED')));
  end if;
  -- AC-05: one FINAL invoice per project, ever. After a void a person decides how to replace it: never "ready" again.
  if exists (select 1 from invoices where project_id = p.id and invoice_type = 'FINAL' and status = 'VOIDED') then
    return jsonb_build_object('ok', false, 'error_class', 'INVALID_STATE', 'final_voided', true,
      'message', format('%s: final invoice %s was voided (%s); a replacement final invoice needs a person (one final invoice per project)', p.project_number,
        (select string_agg(invoice_number, ', ' order by invoice_number) from invoices where project_id = p.id and invoice_type = 'FINAL' and status = 'VOIDED'),
        (select string_agg(coalesce(voided_reason, 'no reason given'), '; ') from invoices where project_id = p.id and invoice_type = 'FINAL' and status = 'VOIDED')));
  end if;
  select string_agg(invoice_number || ' (' || status || ')', ', ' order by invoice_number) into v_blocking
    from invoices where project_id = p.id and status in ('DRAFT', 'PENDING_APPROVAL');
  if v_blocking is not null then
    return jsonb_build_object('ok', false, 'error_class', 'INVALID_STATE',
      'message', format('%s has unapproved invoices %s; resolve them before the final invoice', p.project_number, v_blocking));
  end if;

  select * into qv from quote_versions where id = p.accepted_quote_version_id;
  select * into q from quotes where id = qv.quote_id;
  if qv.line_amount_type <> 'INCLUSIVE' then
    return jsonb_build_object('ok', false, 'error_class', 'SCHEMA_MISMATCH', 'message', 'accepted quote is not GST-inclusive; not supported yet');
  end if;
  select * into c from customers where id = p.customer_id;
  select * into pr from properties where id = p.property_id;

  select coalesce(sum(total_inc_gst), 0), coalesce(jsonb_agg(jsonb_build_object('invoice', invoice_number, 'status', status, 'total', total_inc_gst) order by invoice_number), '[]')
    into v_billed, v_billed_list
    from invoices where project_id = p.id and status in ('APPROVED', 'ISSUED', 'PARTIALLY_PAID', 'PAID');
  select coalesce(sum(amount_inc_gst), 0) into v_var from variations where project_id = p.id and status = 'APPROVED';
  -- AC-08: billed more than quote + approved/invoiced variations is over-billing, never "nothing left to invoice".
  v_over := project_over_billing(p.id);
  if v_over is not null then
    return jsonb_build_object('ok', false, 'error_class', 'ARITHMETIC_MISMATCH', 'over_billed', true, 'over_billed_by', v_over -> 'excess',
      'billed_inc_gst', v_over -> 'billed', 'entitled_inc_gst', v_over -> 'entitled', 'message', v_over ->> 'message');
  end if;
  v_amount := qv.total_inc_gst + v_var - v_billed;
  if v_amount <= 0 then
    return jsonb_build_object('ok', false, 'error_class', 'ARITHMETIC_MISMATCH',
      'message', format('%s: quote %s + variations %s - billed %s = %s; nothing left to invoice', p.project_number,
        qv.total_inc_gst, v_var, v_billed, v_amount));
  end if;
  v_gst := round(v_amount * v_rate / (1 + v_rate), 2);

  v_lines := jsonb_build_array(jsonb_build_object('line_no', 1,
      'description', format('Final invoice %s: %s roofing works at %s, %s (quote %s v%s, total %s inc GST, less %s already invoiced)',
                            p.project_number, initcap(replace(q.job_type, '_', ' ')), pr.address_line1, pr.suburb, q.quote_number, qv.version_number,
                            qv.total_inc_gst, v_billed),
      'quantity', 1, 'unit_amount', qv.total_inc_gst - v_billed, 'variation_id', null))
    || coalesce((select jsonb_agg(jsonb_build_object('line_no', 1 + v.rn, 'description', 'Variation ' || v.variation_number || ': ' || v.description,
                                         'quantity', 1, 'unit_amount', v.amount_inc_gst, 'variation_id', v.id) order by v.rn)
       from (select *, row_number() over (order by variation_number) rn from variations where project_id = p.id and status = 'APPROVED') v), '[]'::jsonb);

  return jsonb_build_object('ok', true, 'preview', jsonb_build_object(
    'project_id', p.id, 'project_number', p.project_number, 'project_record_version', p.record_version,
    'customer_id', c.id, 'customer_number', c.customer_number, 'customer_name', btrim(c.display_name), 'customer_email', c.email,
    'quote_number', q.quote_number, 'quote_version', qv.version_number, 'quote_total_inc_gst', qv.total_inc_gst,
    'approved_variations_inc_gst', v_var, 'billed_to_date_inc_gst', v_billed, 'billed_invoices', v_billed_list,
    'amount_inc_gst', v_amount, 'gst_amount', v_gst, 'amount_ex_gst', v_amount - v_gst, 'currency', 'AUD', 'line_amount_type', 'INCLUSIVE',
    'lines', v_lines, 'invoice_date', v_today, 'due_date', v_today + v_terms,
    'reference', p.project_number,
    'xero_contact_number', v_con_prefix || c.customer_number,
    'xero_contact_name', btrim(c.display_name) || ' [' || c.customer_number || ']',
    'xero_account_code', (select value from app_settings where key = 'xero.sales_account_code'),
    'xero_tax_type', (select value from app_settings where key = 'xero.sales_tax_type'),
    'xero_invoice_number_prefix', v_inv_prefix,
    'xero_tenant_name', (select value from app_settings where key = 'xero.demo_tenant_name')));
end $$;

-- 3. create or replace function project_transition_guard(p projects, p_to text)
create or replace function project_transition_guard(p projects, p_to text)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_final text; v_prev jsonb; v_over jsonb;
begin
  -- AC-08: an over-billed job is never closed; a person corrects the billing first (no credit-note model).
  if p_to = 'CLOSED' then
    v_over := project_over_billing(p.id);
    if v_over is not null then
      return format('%s cannot be closed: it is over-billed by %s (billed %s against %s: %s). Correct the billing first, for example void the unpaid duplicate invoice',
        p.project_number, v_over ->> 'excess', v_over ->> 'billed', v_over ->> 'entitled', v_over ->> 'invoices');
    end if;
  end if;
  if p_to = 'IN_PROGRESS' and p.status = 'SCHEDULED' and p.planned_start_date is null then
    return 'set a Planned Start before marking the job In Progress';
  end if;
  if p_to = 'IN_PROGRESS' and p.status = 'ON_HOLD' and p.actual_start_date is null then
    return 'this job never started; move it back to Scheduled instead of In Progress';
  end if;
  if p.status = 'COMPLETED' and p_to = 'CANCELLED' then
    select string_agg(invoice_number, ', ') into v_final from invoices where project_id = p.id and invoice_type = 'FINAL' and status <> 'VOIDED';
    if v_final is not null then
      return format('a final invoice (%s) already exists; void it first, then cancel', v_final);
    end if;
    if exists (select 1 from approvals where entity_id = p.id and action_type = 'CREATE_INVOICE' and status in ('EXECUTING', 'APPROVED')) then
      return 'a final invoice is being created in Xero right now; wait for it to finish';
    end if;
  end if;
  if p.status = 'COMPLETED' and p_to = 'CLOSED' then
    select string_agg(invoice_number || ' (' || lower(status) || ')', ', ' order by invoice_number) into v_final
      from invoices where project_id = p.id and status not in ('PAID', 'VOIDED');
    if v_final is not null then return format('not every invoice is paid yet: %s', v_final); end if;
    if not exists (select 1 from invoices where project_id = p.id and invoice_type = 'FINAL' and status <> 'VOIDED') then
      v_prev := invoice_final_preview(p.id);
      if coalesce(v_prev ->> 'error_class', '') <> 'ARITHMETIC_MISMATCH' then return 'the final invoice has not been raised yet'; end if;
    end if;
  end if;
  return null;
end $$;

-- 4. The dashboard read model.
create or replace view v_dashboard_projects as
with final_inv as (
  select distinct on (i.project_id) i.project_id, i.id as invoice_id, i.invoice_number, i.status, i.sync_status, i.total_inc_gst
  from invoices i where i.invoice_type = 'FINAL' and i.status <> 'VOIDED'
  order by i.project_id, i.created_at desc
), pending_approval as (
  select distinct on (a.entity_id) a.entity_id as project_id, a.approval_number,
         (a.action_payload ->> 'amount_inc_gst')::numeric(12,2) as amount_inc_gst, a.expires_at
  from approvals a where a.action_type = 'CREATE_INVOICE' and a.status = 'PENDING' and a.expires_at > now()
  order by a.entity_id, a.created_at desc
), readiness as (
  select p.id as project_id, invoice_final_preview(p.id) as x from projects p where p.status = 'COMPLETED'
), po as (
  select v.project_id, count(*) as n,
         count(*) filter (where v.status = 'DELIVERED') as delivered,
         count(*) filter (where v.status = 'PARTIALLY_DELIVERED') as part_delivered,
         count(*) filter (where v.status = 'ACKNOWLEDGED') as confirmed,
         count(*) filter (where v.status = 'SENT') as sent,
         count(*) filter (where v.status in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED')) as in_preparation,
         bool_or(v.ack_overdue) as ack_overdue,
         max(v.expected_delivery_date) filter (where v.status not in ('DELIVERED', 'CANCELLED')) as latest_open_eta
  from v_purchase_order_status v where v.project_id is not null and v.status <> 'CANCELLED'
  group by v.project_id
), bal as (
  select project_id, count(*) as invoices, bool_or(is_overdue) as has_overdue,
         coalesce(sum(outstanding) filter (where status in ('ISSUED', 'PARTIALLY_PAID')), 0) as outstanding
  from v_invoice_balances group by project_id
), exc as (
  select p.id as project_id, count(*) as open_exceptions
  from projects p join quotes q on q.id = p.quote_id
  join workflow_exceptions w on w.resolution_status in ('OPEN', 'RETRY_QUEUED')
   and (w.entity_id = p.id or w.business_reference in (p.project_number, q.quote_number))
  group by p.id
), overbill as (
  select p.id as project_id, project_over_billing(p.id) as x from projects p
)
select p.id, p.project_number, p.status, r.is_active,
       c.customer_number, btrim(c.display_name) as customer_name, c.customer_type,
       r.site_address, r.project_manager,
       q.quote_number, qv.version_number as quote_version, qv.total_inc_gst as quote_total_inc_gst, q.job_type, q.accepted_on,
       p.planned_start_date, p.planned_completion_date, p.actual_start_date, p.actual_completion_date,
       r.risk_level, r.risk_reasons, p.delay_reason,
       case
         when not r.is_active then 'JOB_COMPLETE'
         when po.n is null then case when exists (select 1 from tasks t where t.project_id = p.id and t.task_type = 'MATERIAL_REVIEW' and t.status = 'OPEN')
                                     then 'REVIEW_PENDING' else 'NOT_ORDERED' end
         when po.ack_overdue then 'CONFIRMATION_OVERDUE'
         when po.delivered = po.n then 'DELIVERED'
         when po.part_delivered > 0 then 'PART_DELIVERED'
         when po.sent > 0 then 'AWAITING_CONFIRMATION'
         when po.in_preparation > 0 then 'ORDER_IN_PREPARATION'
         else 'CONFIRMED'
       end as material_status,
       exists (select 1 from v_projects_waiting_on_materials w where w.project_number = p.project_number) as waiting_on_materials,
       po.latest_open_eta as material_eta, coalesce(po.n, 0) as purchase_orders,
       case
         when ob.x is not null then 'OVER_BILLED'
         when fi.invoice_id is not null then case fi.sync_status
                                               when 'SYNCED' then 'XERO_DRAFT_CREATED' when 'PENDING' then 'CREATING_IN_XERO'
                                               when 'UNKNOWN' then 'CHECKING_WITH_XERO' when 'FAILED' then 'XERO_FAILED_SAFELY'
                                               else 'FINAL_INVOICED' end
         when pa.approval_number is not null then 'AWAITING_APPROVAL'
         when (rd.x ->> 'ok')::boolean then 'READY_TO_INVOICE'
         when rd.x ->> 'error_class' = 'ARITHMETIC_MISMATCH' then 'FULLY_INVOICED'
         when rd.x is not null then 'NOT_READY'
         when bal.has_overdue then 'PAYMENT_OVERDUE'
         when bal.invoices > 0 then 'PROGRESS_INVOICED'
         else 'NOT_YET_DUE'
       end as invoice_status,
       case when ob.x is not null then ob.x ->> 'message'
            when rd.x is not null and not (rd.x ->> 'ok')::boolean and rd.x ->> 'error_class' <> 'ARITHMETIC_MISMATCH' and fi.invoice_id is null
            then rd.x ->> 'message' end as invoice_blocker,
       coalesce(fi.total_inc_gst, pa.amount_inc_gst, (rd.x -> 'preview' ->> 'amount_inc_gst')::numeric(12,2)) as invoice_amount_inc_gst,
       fi.invoice_number as final_invoice_number, fi.sync_status as final_invoice_sync,
       xi.external_id as xero_invoice_id,
       case when xi.external_id is not null then (select value from app_settings where key = 'xero.invoice_number_prefix') || fi.invoice_number end as xero_invoice_number,
       pa.approval_number as pending_approval_number,
       coalesce(bal.outstanding, 0) as outstanding_inc_gst, coalesce(bal.has_overdue, false) as has_overdue_invoice,
       coalesce(exc.open_exceptions, 0) as open_exceptions,
       drive.external_url as drive_folder_url,
       at.external_id as airtable_record_id,
       coalesce((r.is_active and r.risk_level = 'HIGH') or coalesce(exc.open_exceptions, 0) > 0 or coalesce(bal.has_overdue, false)
         or pa.approval_number is not null or fi.sync_status in ('UNKNOWN', 'FAILED') or ob.x is not null, false) as needs_attention
       ,
       coalesce((select x.last_source_at from external_field_versions x where x.entity_type = 'project' and x.entity_id = p.id and x.field_key = 'status'),
                p.updated_at) as status_changed_at,
       ao.value as airtable_status_seen, ao.observed_at as airtable_status_seen_at,
       (select count(*) from v_state_drift s where s.entity_type = 'project' and s.entity_id = p.id)::int as drift_fields,
       (select max(finished_at) from reconciliation_runs where status = 'COMPLETED') as last_reconciled_at
from projects p
join v_project_risk r on r.id = p.id
join customers c on c.id = p.customer_id
join quotes q on q.id = p.quote_id
left join quote_versions qv on qv.id = p.accepted_quote_version_id
left join po on po.project_id = p.id
left join final_inv fi on fi.project_id = p.id
left join pending_approval pa on pa.project_id = p.id
left join readiness rd on rd.project_id = p.id
left join overbill ob on ob.project_id = p.id
left join bal on bal.project_id = p.id
left join exc on exc.project_id = p.id
left join external_links xi on xi.provider = 'XERO' and xi.entity_type = 'invoice' and xi.external_type = 'Invoice'
                           and xi.entity_id = fi.invoice_id and xi.verified_at is not null
left join external_links drive on drive.provider = 'GOOGLE_DRIVE' and drive.entity_type = 'project' and drive.external_type = 'Folder'
                              and drive.entity_id = p.id and drive.verified_at is not null
left join external_links at on at.provider = 'AIRTABLE' and at.entity_type = 'project' and at.external_type = 'Record' and at.entity_id = p.id
left join airtable_observations ao on ao.table_id = 'tblvUPIoebC3zoacv' and ao.record_id = at.external_id and ao.field_id = 'fldi2Qwz1dAh2tcTE';

revoke execute on all functions in schema public from public;
revoke execute on function project_over_billing(uuid) from roofops_workflow;
grant execute on function project_over_billing(uuid) to roofops_dashboard;

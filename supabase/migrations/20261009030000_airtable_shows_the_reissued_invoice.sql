-- Airtable shows the reissued invoice (autonomous sprint, REISSUE-UI-01, part 2): after a supervised reissue, reconciliation
-- repaired the project's Xero Invoice ID, but Invoice Preview kept the text 04 wrote for generation 1 (the superseded
-- InvoiceID and the original approval), because that field was reconcile = IGNORE (Stage 3D found it on PRJ-2026-0002).
--
-- Rule: for a final invoice whose current draft generation is a reissue (>= 2, CREATED), the canonical Airtable projection
-- includes Invoice Preview with the CURRENT Xero identity (number, InvoiceID, the reissue approval and who requested and
-- approved it, the InvoiceID it replaces, the amount). Invoice Preview becomes reconcile = PROJECTION, so the reconciler
-- compares and repairs it exactly like Xero Invoice ID. It is compared ONLY where the projection carries it (reissued
-- finals): every other project is unchanged, and the preview 04 writes while an approval is pending (AC-03 binding) is
-- never touched, because a project with a final invoice cannot have a pending first-issue approval.
-- The view is copied from 20261001150000 unchanged except for that one expression.
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
      -- REISSUE-UI-01: a reissued final (current generation >= 2, created) shows its CURRENT Xero identity in Invoice Preview,
      -- replacing the generation-1 text 04 wrote. Plain SQL only (no SECURITY DEFINER calls: the dashboard role reads this view).
      || coalesce((select jsonb_build_object('fldt9KIOPXh3c3pGU',
           'XERO DRAFT ' || g.xero_invoice_number || ' (InvoiceID ' || g.xero_invoice_id || ') in ' || coalesce(nullif(btrim(ap.action_payload -> 'draft' ->> 'xero_tenant_name'), ''), 'the Xero Demo Company')
           || E'\nReissued under ' || ap.approval_number || ': requested by ' || coalesce(re.full_name, 'unknown') || ', approved by ' || coalesce(de.full_name, 'unknown')
           || E'\nReplaces InvoiceID ' || coalesce(prev.xero_invoice_id, 'unknown') || ', which is no longer a valid invoice in Xero'
           || E'\nProject: ' || p.project_number || '   Invoice: ' || fi.invoice_number
           || E'\nAmount: ' || to_char(fi.total_inc_gst, 'FM$999,999,990.00') || ' inc GST  (GST ' || to_char(fi.gst_amount, 'FM$999,999,990.00') || ')'
           || E'\nDraft only, in the Xero Demo Company: RoofOps never sends or pays it')
         from invoice_xero_draft_generations g
         join approvals ap on ap.id = g.approval_id
         left join employees re on re.id = ap.requested_by_employee_id
         left join employees de on de.id = ap.decided_by
         left join invoice_xero_draft_generations prev on prev.invoice_id = g.invoice_id and prev.generation = g.generation - 1
         where g.invoice_id = fi.id and g.superseded_at is null and g.generation >= 2 and g.status = 'CREATED'
           and g.xero_invoice_id is not null and g.xero_invoice_number is not null), '{}'::jsonb)   -- never a null (blank) preview
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

update field_contract set reconcile = 'PROJECTION',
  readback = '04 read-back (preview, decision); reconciliation for a reissued invoice (current Xero identity)'
 where entity = 'project' and field_key = 'invoice_preview';

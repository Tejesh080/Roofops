-- Rollback of 20261017000000_airtable_shows_dashboard_approved_invoice.sql (owner only; one transaction).
-- Restores v_airtable_expected exactly as hosted had it before (copied verbatim from the restored hosted dump
-- pre-release-ops-sales-20261017-000023) and the Invoice Preview read-back text. Effect: a dashboard-approved invoice's
-- Invoice Preview is no longer compared or repaired by reconciliation (it shows what 04 last wrote). Nothing else changes.
-- Roll back 20261017020000 and 20261017010000 first if they are applied.
-- Run: npx tsx scripts/sql.ts -f ops/rollback/20261017000000_airtable_shows_dashboard_approved_invoice.down.sql
begin;
create or replace view public.v_airtable_expected as
 SELECT 'tblvUPIoebC3zoacv'::text AS table_id,
    'project'::text AS entity_type,
    p.id AS entity_id,
    p.project_number AS business_key,
    l.external_id AS record_id,
    (jsonb_strip_nulls(jsonb_build_object('fldhhnQXlbuFaveK3', p.project_number, 'fld08eKCeuDCsJLjz', at_link('quote'::text, p.quote_id), 'fldG4mPoV6sUkA9rM', at_link('customer'::text, p.customer_id), 'fldi2Qwz1dAh2tcTE', sm_label('project'::text, p.status), 'fldc4T0AgU3zCmANC', p.id::text)) || jsonb_build_object('fldnZcRBxG7hTebD5', to_jsonb(e.full_name), 'fld8rf6RZLgfs6Ron', to_jsonb(p.planned_start_date::text), 'fldvZtiassZEgLMAN', to_jsonb(p.planned_completion_date::text), 'fldIje5e0a72cBfVD', to_jsonb(p.actual_start_date::text), 'fldWKRobTLlOjeN9j', to_jsonb(p.actual_completion_date::text), 'fldgVDT29UOOOtlqO', to_jsonb(( SELECT d.external_url
           FROM external_links d
          WHERE d.provider = 'GOOGLE_DRIVE'::text AND d.entity_type = 'project'::text AND d.external_type = 'Folder'::text AND d.entity_id = p.id AND d.verified_at IS NOT NULL)), 'fldbbksVL3dT6cqyS', to_jsonb(( SELECT checklist_at_label(ci.status) AS checklist_at_label
           FROM project_checklist_items ci
          WHERE ci.project_id = p.id AND ci.item_code = 'COMPLETION_PHOTOS'::text)), 'fldf7iJiyHFxOQgUy', to_jsonb(( SELECT checklist_at_label(ci.status) AS checklist_at_label
           FROM project_checklist_items ci
          WHERE ci.project_id = p.id AND ci.item_code = 'COMPLIANCE_CERTIFICATE'::text)))) ||
        CASE
            WHEN fi.sync_status = 'SYNCED'::text THEN jsonb_build_object('fldPuGgo27oWLKB5R', 'Xero draft created', 'fld5JDnWI3RFehQxA', fi.total_inc_gst, 'fldgkN0Vm6k1MZLJp', ( SELECT o.payload ->> 'xero_invoice_number'::text
               FROM outbox o
              WHERE o.topic = 'xero.create_draft_invoice'::text AND o.aggregate_id = fi.id
              ORDER BY o.generation DESC, o.created_at DESC, o.id DESC
             LIMIT 1), 'fld3sDI9LIX8Voo4u', ( SELECT external_links.external_id
               FROM external_links
              WHERE external_links.provider = 'XERO'::text AND external_links.external_type = 'Invoice'::text AND external_links.entity_id = fi.id AND external_links.verified_at IS NOT NULL)) || COALESCE(( SELECT jsonb_build_object('fldt9KIOPXh3c3pGU', ((((((((((((((((((((((('XERO DRAFT '::text || g.xero_invoice_number) || ' (InvoiceID '::text) || g.xero_invoice_id) || ') in '::text) || COALESCE(NULLIF(btrim((ap.action_payload -> 'draft'::text) ->> 'xero_tenant_name'::text), ''::text), 'the Xero Demo Company'::text)) || '
Reissued under '::text) || ap.approval_number) || ': requested by '::text) || COALESCE(re.full_name, 'unknown'::text)) || ', approved by '::text) || COALESCE(de.full_name, 'unknown'::text)) || '
Replaces InvoiceID '::text) || COALESCE(prev.xero_invoice_id, 'unknown'::text)) || ', which is no longer a valid invoice in Xero'::text) || '
Project: '::text) || p.project_number) || '   Invoice: '::text) || fi.invoice_number) || '
Amount: '::text) || to_char(fi.total_inc_gst, 'FM$999,999,990.00'::text)) || ' inc GST  (GST '::text) || to_char(fi.gst_amount, 'FM$999,999,990.00'::text)) || ')'::text) || '
Draft only, in the Xero Demo Company: RoofOps never sends or pays it'::text) AS jsonb_build_object
               FROM invoice_xero_draft_generations g
                 JOIN approvals ap ON ap.id = g.approval_id
                 LEFT JOIN employees re ON re.id = ap.requested_by_employee_id
                 LEFT JOIN employees de ON de.id = ap.decided_by
                 LEFT JOIN invoice_xero_draft_generations prev ON prev.invoice_id = g.invoice_id AND prev.generation = (g.generation - 1)
              WHERE g.invoice_id = fi.id AND g.superseded_at IS NULL AND g.generation >= 2 AND g.status = 'CREATED'::text AND g.xero_invoice_id IS NOT NULL AND g.xero_invoice_number IS NOT NULL), '{}'::jsonb)
            WHEN fi.id IS NOT NULL THEN '{}'::jsonb
            WHEN pa.id IS NOT NULL AND pa.created_at < (now() - '00:02:00'::interval) THEN jsonb_build_object('fldPuGgo27oWLKB5R', 'Awaiting approval', 'fld5JDnWI3RFehQxA', (pa.action_payload ->> 'amount_inc_gst'::text)::numeric, 'fldgkN0Vm6k1MZLJp', NULL::unknown, 'fld3sDI9LIX8Voo4u', NULL::unknown)
            WHEN pa.id IS NOT NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('fldPuGgo27oWLKB5R', jsonb_build_object('$not_in', jsonb_build_array('Awaiting approval', 'Xero draft created', 'Approved - creating in Xero'), '$repair', NULL::unknown), 'fldgkN0Vm6k1MZLJp', NULL::unknown, 'fld3sDI9LIX8Voo4u', NULL::unknown)
        END AS expected
   FROM projects p
     JOIN external_links l ON l.provider = 'AIRTABLE'::text AND l.entity_type = 'project'::text AND l.external_type = 'Record'::text AND l.entity_id = p.id
     LEFT JOIN employees e ON e.id = p.project_manager_id
     LEFT JOIN LATERAL ( SELECT i.id,
            i.invoice_number,
            i.project_id,
            i.customer_id,
            i.record_origin,
            i.invoice_type,
            i.status,
            i.sync_status,
            i.line_amount_type,
            i.gst_rate,
            i.subtotal_ex_gst,
            i.gst_amount,
            i.total_inc_gst,
            i.issue_date,
            i.due_date,
            i.approval_id,
            i.approved_by,
            i.approved_at,
            i.idempotency_key,
            i.voided_reason,
            i.created_at,
            i.updated_at,
            i.record_version
           FROM invoices i
          WHERE i.project_id = p.id AND i.invoice_type = 'FINAL'::text AND i.status <> 'VOIDED'::text
          ORDER BY i.created_at DESC
         LIMIT 1) fi ON true
     LEFT JOIN LATERAL ( SELECT a.id,
            a.approval_number,
            a.action_type,
            a.entity_type,
            a.entity_id,
            a.business_reference,
            a.requested_by_actor_type,
            a.requested_by_employee_id,
            a.requested_via_invocation_id,
            a.required_permission,
            a.action_payload,
            a.payload_hash,
            a.expected_record_version,
            a.idempotency_key,
            a.status,
            a.decided_by,
            a.decided_at,
            a.decision_reason,
            a.expires_at,
            a.executed_at,
            a.execution_result,
            a.created_at,
            a.updated_at,
            a.record_version
           FROM approvals a
          WHERE a.entity_id = p.id AND a.action_type = 'CREATE_INVOICE'::text AND a.status = 'PENDING'::text
          ORDER BY a.created_at DESC
         LIMIT 1) pa ON true
UNION ALL
 SELECT 'tblzenPRNVV5O7lZP'::text AS table_id,
    'quote'::text AS entity_type,
    q.id AS entity_id,
    q.quote_number AS business_key,
    l.external_id AS record_id,
    jsonb_build_object('fldyP20HNafS614d5', q.quote_number, 'fld4LsEu8c9EMFj0h', at_link('customer'::text, q.customer_id), 'fldisUv1ckHz2Detv', at_link('property'::text, q.property_id), 'fldQpTa5tvrzlNg1h', sm_label('quote'::text, q.status), 'fldEjEqlzE8Y0M1nf', qv.version_number, 'fldbfUE8DVh1Dwjfs', qv.total_inc_gst, 'fldOaXGsOgYHuWFYg',
        CASE q.job_type
            WHEN 'FULL_REROOF'::text THEN 'Full Re-roof'::text
            ELSE at_title(q.job_type)
        END, 'fldhY6d0ikMnsc7D3', at_title(i.roof_type), 'fldLjvBaV1EFB5RMG', i.roof_area_sqm, 'fld5Bz9FDhJSPibPk', est.full_name, 'flduF4QFGUWbkuR2d', at_title(q.lead_source), 'fldHSFkvwuVLfAS7J', q.created_on::text, 'fldMnoHiondm5jBWv', q.sent_on::text, 'fldfhsHggkGd8GKVq', q.accepted_on::text, 'fld1sZibwdMVnI4Hd', q.lost_reason, 'fldVUpqZkVKid3Fyy', q.id::text) AS expected
   FROM quotes q
     JOIN external_links l ON l.provider = 'AIRTABLE'::text AND l.entity_type = 'quote'::text AND l.external_type = 'Record'::text AND l.entity_id = q.id
     JOIN LATERAL ( SELECT v.id,
            v.quote_id,
            v.version_number,
            v.line_amount_type,
            v.gst_rate,
            v.subtotal_ex_gst,
            v.gst_amount,
            v.total_inc_gst,
            v.scope_summary,
            v.created_by,
            v.created_at
           FROM quote_versions v
          WHERE v.quote_id = q.id
          ORDER BY v.version_number DESC
         LIMIT 1) qv ON true
     LEFT JOIN inspections i ON i.id = q.inspection_id
     LEFT JOIN employees est ON est.id = q.estimator_id
UNION ALL
 SELECT 'tbluIbl4zpMiAlMVw'::text AS table_id,
    'purchase_order'::text AS entity_type,
    po.id AS entity_id,
    po.po_number AS business_key,
    l.external_id AS record_id,
    jsonb_build_object('fld1yW7kd8vY975Tj', po.po_number, 'fldDVMu2hgtSVuJyR', at_link('project'::text, po.project_id), 'fldnYTAgdcNXWUMfP', at_link('supplier'::text, po.supplier_id), 'fldMtDddp1Rm4tDHf', sm_label('purchase_order'::text, po.status), 'fldqNNcA85jAC9FxM', po.po_date::text, 'fldqkJourPRGAcJya', po.expected_delivery_date::text, 'fld8Muyf7XVB91CjK', po.subtotal_ex_gst, 'fldJ4Z5Rg5adnEFU0', po.supplier_reference, 'fldnzaXx4TTTjCakj', po.id::text) AS expected
   FROM purchase_orders po
     JOIN external_links l ON l.provider = 'AIRTABLE'::text AND l.entity_type = 'purchase_order'::text AND l.external_type = 'Record'::text AND l.entity_id = po.id
UNION ALL
 SELECT 'tblHKX79FJFHn5FDc'::text AS table_id,
    'customer'::text AS entity_type,
    c.id AS entity_id,
    c.customer_number AS business_key,
    l.external_id AS record_id,
    jsonb_build_object('fldzmWSHtLVZ4OTmZ', c.customer_number, 'fldI46VewtlNRnwui', c.display_name, 'fldNcSkEiFnb8m4XP', c.email, 'fldvBKPgd3UeIDYO4', c.phone, 'fldisVgB2WysksjwW', at_title(c.customer_type), 'fldfNc5n8m2kjiRcB',
        CASE
            WHEN c.preferred_contact = 'SMS'::text THEN 'SMS'::text
            ELSE at_title(c.preferred_contact)
        END, 'fldNu4bbDXjMbwmZ8', c.customer_since::text, 'fldPXNXPyYie2kKQk', ( SELECT b.customer_number
           FROM customer_match_candidates m
             JOIN customers b ON b.id =
                CASE
                    WHEN m.customer_id = c.id THEN m.candidate_customer_id
                    ELSE m.customer_id
                END
          WHERE (c.id = m.customer_id OR c.id = m.candidate_customer_id) AND c.customer_number > b.customer_number
         LIMIT 1), 'fldDClu1e0ffwnojn', c.id::text) AS expected
   FROM customers c
     JOIN external_links l ON l.provider = 'AIRTABLE'::text AND l.entity_type = 'customer'::text AND l.external_type = 'Record'::text AND l.entity_id = c.id
UNION ALL
 SELECT 'tblSYcCqId9wTMg3c'::text AS table_id,
    'property'::text AS entity_type,
    pr.id AS entity_id,
    pr.property_number AS business_key,
    l.external_id AS record_id,
    jsonb_build_object('fldIy8ab7Ky67jL31', pr.property_number, 'fldu0CsGG5uPOVbRN', pr.address_line1, 'fldl6gKbKuZSF9MJG', pr.suburb, 'fldYjfr3STs04XDZr', pr.state, 'flduw5J4VyRoOqEE2', pr.postcode, 'fldMH8wYXmkAYXCxe', at_title(pr.property_type), 'fldhsHUPCZ0pMbXeV', pr.storeys, 'fldP4PWGxdLZrA5ge', pr.access_notes, 'fldVpX0MOcA8TnGvo', ( SELECT at_link('customer'::text, cp.customer_id) AS at_link
           FROM customer_properties cp
          WHERE cp.property_id = pr.id AND cp.relationship = 'OWNER'::text
         LIMIT 1), 'fldm6rtleyV6yp8ZS', pr.id::text) AS expected
   FROM properties pr
     JOIN external_links l ON l.provider = 'AIRTABLE'::text AND l.entity_type = 'property'::text AND l.external_type = 'Record'::text AND l.entity_id = pr.id
UNION ALL
 SELECT 'tbloPJwCIcdIZQFVK'::text AS table_id,
    'supplier'::text AS entity_type,
    s.id AS entity_id,
    s.supplier_code AS business_key,
    l.external_id AS record_id,
    jsonb_build_object('fldNy5hhua9oCbrge', s.supplier_code, 'fldmyVulHN1hsCE8f', s.name, 'fldPtnT9heTBGTFEM', s.orders_email, 'fldtNq7DluPgIM1rn', s.phone, 'fldfXKzmQJYzbzgZY', s.default_lead_time_days, 'fldLNYP5FsVaR6TFk', s.id::text) AS expected
   FROM suppliers s
     JOIN external_links l ON l.provider = 'AIRTABLE'::text AND l.entity_type = 'supplier'::text AND l.external_type = 'Record'::text AND l.entity_id = s.id;

update field_contract set readback = '04 read-back (preview, decision); reconciliation for a reissued invoice (current Xero identity)'
 where entity = 'project' and field_key = 'invoice_preview';
delete from schema_migrations where version = '20261017000000_airtable_shows_dashboard_approved_invoice.sql';
commit;

-- Read-only release preflight (ops/release-phase1.md, steps B5 and 4). One statement, so it runs inside a READ ONLY
-- transaction that is always rolled back:
--   npx tsx scripts/sql.ts --read-only -f ops/release-preflight.sql
-- Expected values are in ops/release-phase1.md.
select 'migrations' k, count(*)::text || ' / head ' || max(version) v from schema_migrations
union all
select 'started_with_open_pre_start', coalesce(string_agg(p.project_number || ':' || ci.item_code || ':' || ci.status, ', '), '(none)')
  from projects p join project_checklist_items ci on ci.project_id = p.id
 where ci.stage = 'PRE_START' and ci.status not in ('DONE','WAIVED','NOT_APPLICABLE')
   and (p.actual_start_date is not null or p.status in ('IN_PROGRESS','COMPLETED','CLOSED'))
union all
select 'held_by_gate_after_deploy', coalesce(string_agg(distinct p.project_number || ' ' || p.status, ', '), '(none)')
  from projects p join project_checklist_items ci on ci.project_id = p.id
 where ci.stage = 'PRE_START' and ci.status not in ('DONE','WAIVED','NOT_APPLICABLE')
union all
select 'booked_visits_on_cancelled_closed', coalesce(string_agg(j.job_number || '/' || j.status || ' on ' || p.project_number || '/' || p.status, ', '), '(none)')
  from jobs j join projects p on p.id = j.project_id
 where p.status in ('CANCELLED','CLOSED') and j.status in ('SCHEDULED','WEATHER_DELAYED')
union all
select 'orders_on_cancelled_closed', coalesce(string_agg(po.po_number || '/' || po.status || ' on ' || p.project_number || '/' || p.status, ', '), '(none)')
  from purchase_orders po join projects p on p.id = po.project_id
 where p.status in ('CANCELLED','CLOSED') and po.status not in ('DELIVERED','CANCELLED')
union all
select 'imported_draft_orders', count(*)::text || ': ' || coalesce(string_agg(po_number || '/' || status, ', ' order by po_number), '')
  from purchase_orders where record_origin = 'IMPORT' and status in ('DRAFT','PENDING_APPROVAL')
union all
select 'fully_billed_not_closed', coalesce(string_agg(p.project_number || '/' || p.status, ', ' order by p.project_number), '(none)')
  from projects p
 where p.status not in ('CANCELLED','CLOSED')
   and exists (select 1 from invoices i where i.project_id = p.id and i.invoice_type = 'FINAL' and i.status <> 'VOIDED')
union all
select 'airtable_ping_mac', coalesce((select value from app_settings where key = 'airtable.ping_mac'), '(absent: migration 20261029120000 not applied)')
union all
select 'open_exceptions', count(*)::text || ': ' || coalesce(string_agg(exception_number, ', ' order by exception_number), '')
  from workflow_exceptions where resolution_status in ('OPEN', 'RETRY_QUEUED');

-- Rollback of 20261022040000_purchase_orders_follow_the_job.sql (owner only; one transaction): po_apply_change exactly as
-- 20260929001200_state_integrity.sql defined it, and the migration's record. No data changes.
-- Run: npx tsx scripts/sql.ts -f ops/rollback/20261022040000_purchase_orders_follow_the_job.down.sql
begin;

create or replace function po_apply_change(p_id uuid, p_field text, p_value text, p_current jsonb, p_actor text, p_event_key text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare po purchase_orders; v_to text; v_emp uuid; v_date date;
begin
  select * into po from purchase_orders where id = p_id;
  if p_field = 'status' then
    v_to := sm_state('purchase_order', p_value);
    if v_to is null then return format('"%s" is not a purchase-order status RoofOps knows', p_value); end if;
    if not state_transition_allowed('purchase_order', po.status, v_to) then
      return format('%s → %s is not an allowed purchase-order change%s', sm_label('purchase_order', po.status), sm_label('purchase_order', v_to),
                    case when po.status in ('DELIVERED', 'CANCELLED') then ' (' || sm_label('purchase_order', po.status) || ' is final)' else '' end);
    end if;
    select ei.employee_id into v_emp from employee_external_identities ei join employees e on e.id = ei.employee_id
     where ei.provider = 'AIRTABLE' and ei.external_id = p_actor and e.is_active;
    if v_to = 'APPROVED' and po.record_origin = 'ROOFOPS' and v_emp is null then
      return 'only a RoofOps approver can approve a purchase order';
    end if;
    update purchase_orders set status = v_to,
      approved_at = case when v_to in ('APPROVED','SENT','ACKNOWLEDGED','PARTIALLY_DELIVERED','DELIVERED') then coalesce(approved_at, now()) else approved_at end,
      approved_by = case when v_to in ('APPROVED','SENT','ACKNOWLEDGED','PARTIALLY_DELIVERED','DELIVERED') then coalesce(approved_by, v_emp) else approved_by end,
      sent_at = case when v_to in ('SENT','ACKNOWLEDGED','PARTIALLY_DELIVERED','DELIVERED') then coalesce(sent_at, now()) else sent_at end,
      acknowledged_at = case when v_to in ('ACKNOWLEDGED','PARTIALLY_DELIVERED','DELIVERED') and po.status in ('SENT','ACKNOWLEDGED')
                             then coalesce(acknowledged_at, now()) else acknowledged_at end,
      cancelled_reason = case when v_to = 'CANCELLED' then coalesce(cancelled_reason, 'Cancelled in Airtable by ' || p_actor) else cancelled_reason end
    where id = p_id;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
    values ('USER', p_actor, 'purchase_order.status.changed', 'purchase_order', p_id, po.po_number,
            jsonb_build_object('status', po.status), jsonb_build_object('status', v_to), 'Changed in Airtable [' || p_event_key || ']');
    return null;
  elsif p_field = 'expected_delivery_date' then
    if po.status in ('DELIVERED', 'CANCELLED') then return 'the delivery date is locked once an order is ' || lower(sm_label('purchase_order', po.status)); end if;
    begin v_date := p_value::date; exception when others then return format('"%s" is not a date', p_value); end;
    if v_date is not null and v_date < po.po_date then return format('Expected Delivery %s would be before the PO Date %s', v_date, po.po_date); end if;
    update purchase_orders set expected_delivery_date = v_date where id = p_id;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
    values ('USER', p_actor, 'purchase_order.expected_delivery_date.changed', 'purchase_order', p_id, po.po_number,
            jsonb_build_object('expected_delivery_date', po.expected_delivery_date), jsonb_build_object('expected_delivery_date', v_date), 'Changed in Airtable [' || p_event_key || ']');
    return null;
  elsif p_field = 'supplier_reference' then
    update purchase_orders set supplier_reference = nullif(btrim(coalesce(p_value, '')), '') where id = p_id;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
    values ('USER', p_actor, 'purchase_order.supplier_reference.changed', 'purchase_order', p_id, po.po_number,
            jsonb_build_object('supplier_reference', po.supplier_reference), jsonb_build_object('supplier_reference', p_value), 'Changed in Airtable [' || p_event_key || ']');
    return null;
  end if;
  return 'this field cannot be changed from Airtable';
end $$;

delete from schema_migrations where version = '20261022040000_purchase_orders_follow_the_job.sql';
commit;

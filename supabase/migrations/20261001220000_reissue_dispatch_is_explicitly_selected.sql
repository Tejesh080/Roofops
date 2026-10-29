-- AC-14C follow-up, release gate (P2-D1): n8n 08 dispatched every due, proven generation >= 2 write at once, so one
-- operator dispatch for one invoice could also send any other queued reissue to Xero. A dispatch now names exactly one
-- write - the invoice number and the generation the operator saw - and nothing else can be listed: no selection, a
-- generation-1 selection, a generation that is not the invoice's current one, a write that is not due, or an unproven
-- write is refused with nothing listed. 05's claim still re-proves the one write before any Xero call.

drop function if exists wf_reissue_dispatch(text, text);

create or replace function wf_reissue_dispatch(p_token text, p_invoice_number text, p_generation int, p_worker text default 'n8n')
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_hash text := (select value from app_settings where key = 'reissue.dispatch_token_sha256');
  v_sel jsonb := jsonb_build_object('invoice_number', p_invoice_number, 'generation', p_generation);
  i invoices; g invoice_xero_draft_generations; o outbox; v_problem text;
  refuse constant text := '{"ok": false, "writes": []}';
begin
  if coalesce(v_hash, '') = '' or encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex') <> v_hash then
    return refuse::jsonb || jsonb_build_object('code', 'TOKEN_REFUSED', 'detail', 'a reissue dispatch needs the operator token');
  end if;
  if coalesce(p_invoice_number, '') = '' or p_generation is null then
    return refuse::jsonb || jsonb_build_object('code', 'SELECTION_REQUIRED', 'selection', v_sel,
      'detail', 'a reissue dispatch names exactly one invoice number and generation');
  end if;
  if p_generation < 2 then
    return refuse::jsonb || jsonb_build_object('code', 'NOT_A_REISSUE', 'selection', v_sel, 'detail', 'generation 1 is dispatched by 04, never here');
  end if;
  select * into i from invoices where invoice_number = p_invoice_number;
  if i.id is null then
    return refuse::jsonb || jsonb_build_object('code', 'NOT_FOUND', 'selection', v_sel, 'detail', 'no invoice has that number');
  end if;
  select * into g from invoice_xero_draft_generations where invoice_id = i.id and superseded_at is null;
  if g.generation is distinct from p_generation then
    return refuse::jsonb || jsonb_build_object('code', 'NOT_CURRENT_GENERATION', 'selection', v_sel,
      'detail', format('the current generation of %s is %s', p_invoice_number, coalesce(g.generation::text, 'none')));
  end if;
  select * into o from outbox where idempotency_key = xero_draft_outbox_key(i.id, p_generation) and topic = 'xero.create_draft_invoice';
  if o.id is null then
    return refuse::jsonb || jsonb_build_object('code', 'NO_WRITE', 'selection', v_sel, 'detail', 'no draft write is queued for that generation');
  end if;
  if not (o.status = 'PENDING' or (o.status = 'FAILED' and o.next_attempt_at <> 'infinity')) or o.next_attempt_at > now() then
    return refuse::jsonb || jsonb_build_object('code', 'NOT_DUE', 'selection', v_sel,
      'detail', format('the write is %s%s', o.status, case when o.next_attempt_at = 'infinity' then ' (dead letter)' when o.next_attempt_at > now() then ' (not yet due)' else '' end));
  end if;
  v_problem := xero_reissue_proof(o);
  if v_problem is not null then
    return refuse::jsonb || jsonb_build_object('code', 'REISSUE_NOT_PROVEN', 'selection', v_sel, 'problem', v_problem, 'detail', v_problem);
  end if;
  return jsonb_build_object('ok', true, 'worker', p_worker, 'selection', v_sel,
    'writes', jsonb_build_array(jsonb_build_object('xero_key', o.idempotency_key, 'invoice_number', i.invoice_number, 'generation', o.generation)));
end $$;

revoke execute on all functions in schema public from public;
revoke execute on function wf_reissue_dispatch(text, text, int, text) from roofops_dashboard;
grant execute on function wf_reissue_dispatch(text, text, int, text) to roofops_workflow;

-- Staff sign-in (autonomous sprint, STAFF-AUTH-01): the dashboard had one shared demo login, and every attributed staff
-- action (resolve an exception, reissue) ran from an operator CLI where the employee code was typed, not proven.
--
-- Rule: a person signs in to the dashboard as themselves. The password is checked INSIDE Postgres (bcrypt via pgcrypto),
-- so no hash ever leaves the database and the web server cannot create a session without the person's password. A
-- successful sign-in returns a random session token (only its SHA-256 is stored); every staff action the dashboard
-- performs passes that token, and the database resolves it to the employee, checks the employee is still active, and
-- attributes the action to them. Five wrong passwords lock the login for 10 minutes. Accounts are created or reset by
-- the owner (ops_staff_set_password, owner-only); an account belongs to exactly one employee.

create extension if not exists pgcrypto;   -- Supabase: already installed (schema extensions); local/PGlite: public

insert into app_settings (key, value) values ('staff.session_hours', '12') on conflict (key) do nothing;

create table staff_accounts (
  employee_id      uuid primary key references employees(id),
  login            text not null unique check (login = lower(btrim(login)) and length(login) between 3 and 120),
  password_hash    text not null,
  failed_attempts  integer not null default 0,
  locked_until     timestamptz,
  password_set_at  timestamptz not null default now(),
  created_at       timestamptz not null default now()
);
comment on table staff_accounts is 'Dashboard sign-in per employee: bcrypt hash only (pgcrypto); written only by ops_staff_set_password and web_staff_sign_in';

create table staff_sessions (
  token_sha256  text primary key,
  employee_id   uuid not null references employees(id),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz
);
create index staff_sessions_employee on staff_sessions (employee_id) where revoked_at is null;
comment on table staff_sessions is 'Dashboard sessions: the SHA-256 of a random token; the token itself lives only in the signed session cookie';

alter table staff_accounts enable row level security;
alter table staff_sessions enable row level security;

-- Owner-only: create or reset one employee's dashboard login. The password is never stored or logged in clear.
create or replace function ops_staff_set_password(p_employee_code text, p_login text, p_password text)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_emp employees; v_login text := lower(btrim(coalesce(p_login, '')));
begin
  select * into v_emp from employees where employee_code = p_employee_code;
  if v_emp.id is null or not v_emp.is_active then
    return jsonb_build_object('ok', false, 'reason', coalesce(nullif(p_employee_code, ''), 'no employee code') || ' is not an active RoofOps employee');
  end if;
  if length(coalesce(p_password, '')) < 12 then
    return jsonb_build_object('ok', false, 'reason', 'a password needs at least 12 characters');
  end if;
  if length(v_login) < 3 then return jsonb_build_object('ok', false, 'reason', 'a login needs at least 3 characters'); end if;
  if exists (select 1 from staff_accounts where login = v_login and employee_id <> v_emp.id) then
    return jsonb_build_object('ok', false, 'reason', 'that login belongs to another employee');
  end if;
  insert into staff_accounts (employee_id, login, password_hash)
  values (v_emp.id, v_login, crypt(p_password, gen_salt('bf', 10)))
  on conflict (employee_id) do update set login = excluded.login, password_hash = excluded.password_hash,
    failed_attempts = 0, locked_until = null, password_set_at = now();
  update staff_sessions set revoked_at = now() where employee_id = v_emp.id and revoked_at is null;   -- a reset signs them out
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, reason)
  values ('SYSTEM', 'ops:staff', 'staff.password_set', 'employee', v_emp.id, v_emp.employee_code,
          jsonb_build_object('login', v_login), 'Dashboard login set by the owner (password not recorded)');
  return jsonb_build_object('ok', true, 'employee_code', v_emp.employee_code, 'login', v_login);
end $$;

-- The current employee behind a session token, or null (expired, revoked, unknown, or the employee is inactive).
create or replace function staff_session_employee(p_token text)
returns employees language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select e.* from staff_sessions s join employees e on e.id = s.employee_id
   where s.token_sha256 = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
     and s.revoked_at is null and s.expires_at > now() and e.is_active
$$;

create or replace function web_staff_sign_in(p_login text, p_password text)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare a staff_accounts; v_emp employees; v_token text; v_hours int; v_fail constant text := 'That login and password did not match.';
begin
  select * into a from staff_accounts where login = lower(btrim(coalesce(p_login, ''))) for update;
  if a.employee_id is null then
    perform crypt(coalesce(p_password, ''), gen_salt('bf', 10));   -- same work as a real check: no login enumeration by timing
    return jsonb_build_object('ok', false, 'reason', v_fail);
  end if;
  if a.locked_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'Too many attempts. Try again in a few minutes.');
  end if;
  select * into v_emp from employees where id = a.employee_id;
  if crypt(coalesce(p_password, ''), a.password_hash) <> a.password_hash or not v_emp.is_active then
    if a.failed_attempts + 1 >= 5 then
      update staff_accounts set failed_attempts = 0, locked_until = now() + interval '10 minutes' where employee_id = a.employee_id;
      insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, reason)
      values ('SYSTEM', 'web:sign-in', 'staff.login_locked', 'employee', v_emp.id, v_emp.employee_code, '5 failed sign-ins: locked for 10 minutes');
    else
      update staff_accounts set failed_attempts = failed_attempts + 1 where employee_id = a.employee_id;
    end if;
    return jsonb_build_object('ok', false, 'reason', v_fail);
  end if;
  v_hours := coalesce((select value::int from app_settings where key = 'staff.session_hours'), 12);
  v_token := encode(gen_random_bytes(32), 'hex');
  update staff_accounts set failed_attempts = 0, locked_until = null where employee_id = a.employee_id;
  insert into staff_sessions (token_sha256, employee_id, expires_at)
  values (encode(digest(v_token, 'sha256'), 'hex'), v_emp.id, now() + make_interval(hours => v_hours));
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, reason)
  values ('USER', v_emp.employee_code, 'staff.signed_in', 'employee', v_emp.id, v_emp.employee_code, 'Dashboard sign-in');
  return jsonb_build_object('ok', true, 'token', v_token, 'employee_code', v_emp.employee_code, 'name', v_emp.full_name,
                            'role', v_emp.role, 'expires_at', now() + make_interval(hours => v_hours));
end $$;

create or replace function web_staff_session(p_token text)
returns jsonb language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select case when e.id is null then null
              else jsonb_build_object('employee_code', e.employee_code, 'name', e.full_name, 'role', e.role,
                     'may_resolve_exceptions', e.role = any (string_to_array((select value from app_settings where key = 'exception.resolver_roles'), ',')))
         end
    from (select (staff_session_employee(p_token)).*) e
$$;

create or replace function web_staff_sign_out(p_token text)
returns void language sql security definer set search_path = public, extensions, pg_temp as $$
  update staff_sessions set revoked_at = now() where token_sha256 = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex') and revoked_at is null
$$;

-- Resolve an exception from the dashboard as the signed-in employee (the same rules as npm run exception:resolve).
create or replace function web_resolve_exception(p_token text, p_exception text, p_note text)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_emp employees := staff_session_employee(p_token);
begin
  if v_emp.id is null then
    return jsonb_build_object('resolved', false, 'reason', 'Your sign-in has ended. Sign in again as yourself to resolve this.');
  end if;
  return ops_resolve_exception(p_exception, v_emp.employee_code, p_note);
end $$;

-- Privileges: the dashboard role may sign in, read its own session, sign out and resolve as the session's employee.
-- Nothing reads the two tables directly; setting a password is owner-only.
revoke execute on all functions in schema public from public;
revoke execute on function ops_staff_set_password(text, text, text), staff_session_employee(text) from roofops_workflow, roofops_dashboard;
grant execute on function web_staff_sign_in(text, text), web_staff_session(text), web_staff_sign_out(text),
  web_resolve_exception(text, text, text) to roofops_dashboard;

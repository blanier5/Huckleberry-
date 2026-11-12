-- Napberry nap alerts (optional). Paste this whole file into Supabase -> SQL Editor -> Run,
-- after supabase/setup.sql. There is nothing in it to edit. Safe to run more than once, and it
-- never touches your sleep data.
--
-- How alerts work: when a phone logs a wake-up, Napberry works out when the nap sweet spot
-- starts and leaves a single note here ("tell this family at 12:52"). Every minute a small
-- schedule checks for notes that are due and, only then, wakes the Edge Function named
-- napberry-push, which sends the push notifications to the phones that turned alerts on.
--
-- Security model, same as setup.sql: tables are locked (row level security on, no grants).
-- Phones go through the functions below with the family code. The functions the Edge Function
-- uses are for the service role only and also need a secret that only this database knows.

create table if not exists public.naps_push_config (
  id            int primary key check (id = 1),
  vapid_public  text,   -- made by the Edge Function the first time it runs
  vapid_private text,
  tick_secret   text not null,
  project_url   text    -- told to us by the app, so the schedule knows where the function lives
);
alter table public.naps_push_config add column if not exists project_url text;
insert into public.naps_push_config (id, tick_secret)
values (1, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (id) do nothing;

create table if not exists public.naps_push_subs (
  family_id  text   not null,
  endpoint   text   not null,
  p256dh     text   not null,
  auth       text   not null,
  created_at bigint not null,
  primary key (family_id, endpoint)
);

create table if not exists public.naps_alerts (
  family_id text    not null,
  kind      text    not null check (kind in ('nap', 'test')),
  active    boolean not null default true,
  fire_at   bigint  not null,            -- ms since epoch
  title     text    not null,
  body      text    not null,
  basis     bigint  not null default 0,  -- newest data the note was worked out from; older notes never replace newer ones
  sent_at   bigint,
  primary key (family_id, kind)
);

alter table public.naps_push_config enable row level security;
alter table public.naps_push_subs   enable row level security;
alter table public.naps_alerts      enable row level security;
revoke all on public.naps_push_config from public, anon, authenticated;
revoke all on public.naps_push_subs   from public, anon, authenticated;
revoke all on public.naps_alerts      from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------
-- For the phones (public key + family code)
-- ---------------------------------------------------------------------------------------

-- The public half of the push key. Null until the Edge Function has run once.
create or replace function public.naps_push_key()
returns text
language sql
stable
security definer
set search_path = public
as $$ select vapid_public from public.naps_push_config where id = 1 $$;

-- The app tells the database which project this is (like https://abcdxyz.supabase.co), so the
-- schedule below knows where the Edge Function lives. It only accepts a supabase.co address.
create or replace function public.naps_push_set_url(p_family text, p_url text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_family is null or p_family !~ '^[A-Za-z0-9_-]{20,64}$' then
    raise exception 'invalid family code' using errcode = '22023';
  end if;
  if p_url is null or p_url !~ '^https://[a-z0-9]{10,40}\.supabase\.co$' then
    raise exception 'invalid project url' using errcode = '22023';
  end if;
  update naps_push_config set project_url = p_url where id = 1 and project_url is distinct from p_url;
  return jsonb_build_object('ok', true);
end;
$$;

-- A phone says "send my alerts here".
create or replace function public.naps_push_subscribe(p_family text, p_sub jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_endpoint text;
  v_p256dh text;
  v_auth text;
begin
  if p_family is null or p_family !~ '^[A-Za-z0-9_-]{20,64}$' then
    raise exception 'invalid family code' using errcode = '22023';
  end if;
  if p_sub is null or jsonb_typeof(p_sub) <> 'object' then
    raise exception 'invalid subscription' using errcode = '22023';
  end if;
  v_endpoint := p_sub ->> 'endpoint';
  v_p256dh := p_sub #>> '{keys,p256dh}';
  v_auth := p_sub #>> '{keys,auth}';
  if coalesce(v_endpoint, '') !~ '^https://[^[:space:]]+$'
     or length(v_endpoint) not between 20 and 600
     or coalesce(v_p256dh, '') !~ '^[A-Za-z0-9_-]{80,100}$'
     or coalesce(v_auth, '') !~ '^[A-Za-z0-9_-]{16,40}$' then
    raise exception 'invalid subscription' using errcode = '22023';
  end if;
  if not exists (select 1 from naps_push_subs where family_id = p_family and endpoint = v_endpoint)
     and (select count(*) from naps_push_subs where family_id = p_family) >= 10 then
    raise exception 'too many phones for one family' using errcode = '22023';
  end if;

  insert into naps_push_subs (family_id, endpoint, p256dh, auth, created_at)
  values (p_family, v_endpoint, v_p256dh, v_auth, (extract(epoch from clock_timestamp()) * 1000)::bigint)
  on conflict (family_id, endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.naps_push_unsubscribe(p_family text, p_endpoint text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_family is null or p_family !~ '^[A-Za-z0-9_-]{20,64}$' then
    raise exception 'invalid family code' using errcode = '22023';
  end if;
  delete from naps_push_subs where family_id = p_family and endpoint = p_endpoint;
  return jsonb_build_object('ok', true);
end;
$$;

-- "Tell this family at p_fire_at." One note per family and kind. A note worked out from older
-- data (smaller p_basis) never replaces one worked out from newer data, so a phone that has not
-- caught up yet cannot bring back an alert that was already cancelled.
create or replace function public.naps_alert_set(
  p_family text, p_kind text, p_fire_at bigint, p_title text, p_body text, p_basis bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  if p_family is null or p_family !~ '^[A-Za-z0-9_-]{20,64}$' then
    raise exception 'invalid family code' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('nap', 'test') then
    raise exception 'invalid alert kind' using errcode = '22023';
  end if;
  if p_fire_at is null or p_fire_at < v_now - 300000 or p_fire_at > v_now + 43200000 then
    raise exception 'alert time out of range' using errcode = '22023';
  end if;
  if coalesce(btrim(p_title), '') = '' or coalesce(btrim(p_body), '') = '' then
    raise exception 'alert needs a title and text' using errcode = '22023';
  end if;

  insert into naps_alerts (family_id, kind, active, fire_at, title, body, basis, sent_at)
  values (p_family, p_kind, true, p_fire_at, left(p_title, 100), left(p_body, 300), greatest(coalesce(p_basis, 0), 0), null)
  on conflict (family_id, kind) do update
    set sent_at = case when naps_alerts.fire_at = excluded.fire_at
                        and naps_alerts.title = excluded.title
                        and naps_alerts.body = excluded.body then naps_alerts.sent_at else null end,
        active = true,
        fire_at = excluded.fire_at,
        title = excluded.title,
        body = excluded.body,
        basis = excluded.basis
    where excluded.basis >= naps_alerts.basis;
  return jsonb_build_object('ok', true);
end;
$$;

-- "Nothing to tell this family any more" (she fell asleep, or no nap is next). The row stays,
-- inactive, so it still remembers how new the data behind it was.
create or replace function public.naps_alert_clear(p_family text, p_kind text, p_basis bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_family is null or p_family !~ '^[A-Za-z0-9_-]{20,64}$' then
    raise exception 'invalid family code' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('nap', 'test') then
    raise exception 'invalid alert kind' using errcode = '22023';
  end if;
  insert into naps_alerts (family_id, kind, active, fire_at, title, body, basis, sent_at)
  values (p_family, p_kind, false, 0, '', '', greatest(coalesce(p_basis, 0), 0), null)
  on conflict (family_id, kind) do update
    set active = false, basis = excluded.basis
    where excluded.basis >= naps_alerts.basis;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- For the Edge Function (service role + secret only)
-- ---------------------------------------------------------------------------------------

-- Takes the alerts that are due (once: they are marked sent as they are taken) together with
-- the phones to send them to. Alerts more than 15 minutes late are dropped, not sent.
create or replace function public.naps_alerts_claim(p_secret text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg public.naps_push_config%rowtype;
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_alerts jsonb;
begin
  select * into v_cfg from naps_push_config where id = 1;
  if p_secret is null or v_cfg.tick_secret is null or p_secret <> v_cfg.tick_secret then
    return jsonb_build_object('ok', false);
  end if;
  if v_cfg.vapid_public is null or v_cfg.vapid_private is null then
    return jsonb_build_object('ok', true, 'needsKeys', true, 'alerts', '[]'::jsonb);
  end if;

  with due as (
    select family_id, kind from naps_alerts
     where active and sent_at is null and fire_at <= v_now and fire_at > v_now - 900000
       for update skip locked
  ), marked as (
    update naps_alerts a set sent_at = v_now
      from due where a.family_id = due.family_id and a.kind = due.kind
    returning a.family_id, a.kind, a.title, a.body
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'family', m.family_id, 'kind', m.kind, 'title', m.title, 'body', m.body,
           'subs', (select coalesce(jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
                      from naps_push_subs s where s.family_id = m.family_id))), '[]'::jsonb)
    into v_alerts
    from marked m;

  return jsonb_build_object('ok', true, 'vapid', jsonb_build_object('public', v_cfg.vapid_public, 'private', v_cfg.vapid_private), 'alerts', v_alerts);
end;
$$;

-- The Edge Function makes the push key the first time it runs and keeps it here. Set once.
create or replace function public.naps_push_keys_set(p_secret text, p_public text, p_private text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_done int;
begin
  update naps_push_config set vapid_public = p_public, vapid_private = p_private
   where id = 1 and tick_secret = p_secret and vapid_public is null
     and coalesce(p_public, '') ~ '^[A-Za-z0-9_-]{80,100}$' and coalesce(p_private, '') ~ '^[A-Za-z0-9_-]{40,50}$';
  get diagnostics v_done = row_count;
  return jsonb_build_object('ok', v_done = 1);
end;
$$;

-- Phones whose push service says they are gone (app removed, alerts turned off) are dropped.
create or replace function public.naps_push_forget(p_secret text, p_endpoints jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_done int;
begin
  if p_endpoints is null or jsonb_typeof(p_endpoints) <> 'array'
     or not exists (select 1 from naps_push_config where id = 1 and tick_secret = p_secret) then
    return jsonb_build_object('ok', false);
  end if;
  delete from naps_push_subs where endpoint in (select jsonb_array_elements_text(p_endpoints));
  get diagnostics v_done = row_count;
  return jsonb_build_object('ok', true, 'removed', v_done);
end;
$$;

revoke all on function public.naps_push_key() from public;
revoke all on function public.naps_push_set_url(text, text) from public;
revoke all on function public.naps_push_subscribe(text, jsonb) from public;
revoke all on function public.naps_push_unsubscribe(text, text) from public;
revoke all on function public.naps_alert_set(text, text, bigint, text, text, bigint) from public;
revoke all on function public.naps_alert_clear(text, text, bigint) from public;
revoke all on function public.naps_alerts_claim(text) from public, anon, authenticated;
revoke all on function public.naps_push_keys_set(text, text, text) from public, anon, authenticated;
revoke all on function public.naps_push_forget(text, jsonb) from public, anon, authenticated;
grant execute on function public.naps_push_key() to anon, authenticated;
grant execute on function public.naps_push_set_url(text, text) to anon, authenticated;
grant execute on function public.naps_push_subscribe(text, jsonb) to anon, authenticated;
grant execute on function public.naps_push_unsubscribe(text, text) to anon, authenticated;
grant execute on function public.naps_alert_set(text, text, bigint, text, text, bigint) to anon, authenticated;
grant execute on function public.naps_alert_clear(text, text, bigint) to anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.naps_alerts_claim(text) to service_role;
    grant execute on function public.naps_push_keys_set(text, text, text) to service_role;
    grant execute on function public.naps_push_forget(text, jsonb) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------------------
-- The schedule: every minute, wake the Edge Function, but only if something is due (or the
-- push key still has to be made), and only once the app has said which project this is.
-- Needs the pg_cron and pg_net extensions, which this tries to turn on.
-- ---------------------------------------------------------------------------------------
do $$
begin
  begin
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
  exception when others then
    raise warning 'Napberry: could not turn on pg_cron / pg_net (%). Turn them on under Database -> Extensions, then run this script again.', sqlerrm;
  end;

  perform cron.schedule(
    'napberry-alerts',
    '* * * * *',
    $job$select net.http_post(
           url := c.project_url || '/functions/v1/napberry-push',
           headers := jsonb_build_object('Content-Type', 'application/json', 'x-napberry-secret', c.tick_secret),
           body := '{}'::jsonb,
           timeout_milliseconds := 30000)
         from public.naps_push_config c
         where c.id = 1
           and c.project_url is not null
           and (c.vapid_public is null
                or exists (select 1 from public.naps_alerts
                            where active and sent_at is null
                              and fire_at <= (extract(epoch from clock_timestamp()) * 1000)::bigint
                              and fire_at >  (extract(epoch from clock_timestamp()) * 1000)::bigint - 900000))$job$
  );
exception when others then
  raise warning 'Napberry: the schedule was not created (%). Turn on pg_cron and pg_net under Database -> Extensions, then run this script again.', sqlerrm;
end $$;

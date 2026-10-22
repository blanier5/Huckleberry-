-- Napberry sync backend. Paste this whole file into Supabase -> SQL Editor -> Run.
-- Safe to run more than once.
--
-- Security model: the tables are locked down (row level security on, no policies, no
-- grants), so the public API key cannot read or write them directly. The only way in is
-- the two functions at the bottom, and each one needs a "family code": a long random
-- string that only your own devices know. Without the code there is no way to list,
-- guess or fetch anyone's data.

create sequence if not exists public.naps_seq;

create table if not exists public.naps_profiles (
  family_id  text primary key,
  data       jsonb  not null,
  updated_at bigint not null
);

create table if not exists public.naps_sleeps (
  family_id  text    not null,
  id         text    not null,
  start_ms   bigint,
  end_ms     bigint,
  kind       text,
  notes      text,
  source     text,
  deleted    boolean not null default false,
  updated_at bigint  not null,              -- when a person last changed it (device clock)
  seq        bigint  not null default nextval('public.naps_seq'),  -- server order, used as the sync cursor
  primary key (family_id, id)
);

-- Added later ("fell asleep early" notes). Safe to run on a database that already has the table.
alter table public.naps_sleeps add column if not exists flags jsonb;

create index if not exists naps_sleeps_family_seq on public.naps_sleeps (family_id, seq);

alter table public.naps_profiles enable row level security;
alter table public.naps_sleeps   enable row level security;
revoke all on public.naps_profiles from public, anon, authenticated;
revoke all on public.naps_sleeps   from public, anon, authenticated;
revoke all on sequence public.naps_seq from public, anon, authenticated;

-- Returns everything that changed after `p_cursor` plus the baby profile.
create or replace function public.naps_pull(p_family text, p_cursor bigint default 0)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sleeps jsonb;
  v_cursor bigint;
  v_profile jsonb;
begin
  if p_family is null or p_family !~ '^[A-Za-z0-9_-]{20,64}$' then
    raise exception 'invalid family code' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'start', start_ms, 'end', end_ms, 'kind', kind, 'notes', notes,
           'source', source, 'flags', flags, 'deleted', deleted, 'updatedAt', updated_at) order by seq), '[]'::jsonb),
         coalesce(max(seq), coalesce(p_cursor, 0))
    into v_sleeps, v_cursor
    from naps_sleeps
   where family_id = p_family and seq > coalesce(p_cursor, 0);

  select data || jsonb_build_object('updatedAt', updated_at)
    into v_profile
    from naps_profiles
   where family_id = p_family;

  return jsonb_build_object('profile', v_profile, 'sleeps', v_sleeps, 'cursor', v_cursor);
end;
$$;

-- Stores profile and sleeps. Per record, the most recent change (by updatedAt) wins, so a
-- phone that was offline can never overwrite a newer edit made somewhere else.
create or replace function public.naps_push(p_family text, p_profile jsonb default null, p_sleeps jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_saved int := 0;
  v_skipped int := 0;
begin
  if p_family is null or p_family !~ '^[A-Za-z0-9_-]{20,64}$' then
    raise exception 'invalid family code' using errcode = '22023';
  end if;
  if p_sleeps is not null and jsonb_typeof(p_sleeps) <> 'array' then
    raise exception 'sleeps must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p_sleeps, '[]'::jsonb)) > 1000 then
    raise exception 'too many sleeps in one push' using errcode = '22023';
  end if;

  -- One writer per family at a time, so seq order always matches commit order.
  perform pg_advisory_xact_lock(hashtextextended(p_family, 0));

  if p_profile is not null and jsonb_typeof(p_profile) = 'object'
     and (p_profile ->> 'updatedAt') ~ '^\d{1,15}$'
     and length(p_profile::text) < 4000 then
    insert into naps_profiles (family_id, data, updated_at)
    values (p_family, p_profile - 'updatedAt', (p_profile ->> 'updatedAt')::bigint)
    on conflict (family_id) do update
      set data = excluded.data, updated_at = excluded.updated_at
      where excluded.updated_at > naps_profiles.updated_at;
  end if;

  with incoming as (
    select * from jsonb_to_recordset(coalesce(p_sleeps, '[]'::jsonb))
      as x(id text, start bigint, "end" bigint, kind text, notes text, source text, flags jsonb, deleted boolean, "updatedAt" bigint)
  ), valid as (
    select id,
           start,
           "end",
           kind,
           left(notes, 500) as notes,
           left(source, 40) as source,
           case when jsonb_typeof(flags) = 'object' and length(flags::text) < 200 then flags else null end as flags,
           coalesce(deleted, false) as deleted,
           "updatedAt" as updated_at
      from incoming
     where id ~ '^[A-Za-z0-9_-]{1,64}$'
       and "updatedAt" between 0 and 4000000000000
       and (
         coalesce(deleted, false)
         or (
           kind in ('nap', 'night')
           and start between 0 and 4000000000000
           and ("end" is null or ("end" > start and "end" <= 4000000000000))
         )
       )
  ), written as (
    insert into naps_sleeps (family_id, id, start_ms, end_ms, kind, notes, source, flags, deleted, updated_at)
    select p_family, id, start, "end", kind, notes, source, flags, deleted, updated_at from valid
    on conflict (family_id, id) do update
      set start_ms = excluded.start_ms, end_ms = excluded.end_ms, kind = excluded.kind,
          notes = excluded.notes, source = excluded.source, flags = excluded.flags, deleted = excluded.deleted,
          updated_at = excluded.updated_at, seq = nextval('public.naps_seq')
      where excluded.updated_at > naps_sleeps.updated_at
    returning 1
  )
  select (select count(*) from written), (select count(*) from incoming) - (select count(*) from valid)
    into v_saved, v_skipped;

  return jsonb_build_object('saved', v_saved, 'skipped', v_skipped);
end;
$$;

revoke all on function public.naps_pull(text, bigint) from public;
revoke all on function public.naps_push(text, jsonb, jsonb) from public;
grant execute on function public.naps_pull(text, bigint) to anon, authenticated;
grant execute on function public.naps_push(text, jsonb, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';

-- Run in the SQL Editor of a FREE Supabase project. No extensions or paid services.
create table if not exists public.fridge_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null,
  revision bigint not null default 1 check (revision > 0),
  mutation_id uuid not null,
  updated_at timestamptz not null default now(),
  constraint fridge_state_size check (octet_length(state::text) <= 200000)
);
alter table public.fridge_accounts enable row level security;
revoke all on public.fridge_accounts from public,anon,authenticated;
grant select on public.fridge_accounts to authenticated;
drop policy if exists own_fridge_read on public.fridge_accounts;
create policy own_fridge_read on public.fridge_accounts for select to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.save_fridge_state(p_state jsonb,p_expected_revision bigint,p_mutation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  account_id uuid := auth.uid();
  prior public.fridge_accounts%rowtype;
  saved public.fridge_accounts%rowtype;
  kitchen jsonb;
  entry jsonb;
  collection text;
begin
  if account_id is null then raise exception 'NOT_AUTHENTICATED' using errcode='42501'; end if;
  if p_mutation_id is null or p_expected_revision is null or p_expected_revision<0 then raise exception 'INVALID_REQUEST'; end if;
  if p_state is null or jsonb_typeof(p_state)<>'object' or p_state->>'version' is distinct from '1'
    or jsonb_typeof(p_state->'profiles') is distinct from 'array' then raise exception 'INVALID_STATE'; end if;
  if octet_length(p_state::text)>200000 or jsonb_array_length(p_state->'profiles') not between 1 and 100 then raise exception 'INVALID_STATE'; end if;
  for kitchen in select value from jsonb_array_elements(p_state->'profiles') loop
    if jsonb_typeof(kitchen)<>'object' or jsonb_typeof(kitchen->'id') is distinct from 'string'
      or length(kitchen->>'id') not between 1 and 200 or jsonb_typeof(kitchen->'name') is distinct from 'string'
      or length(trim(kitchen->>'name'))=0 then raise exception 'INVALID_STATE'; end if;
    foreach collection in array array['fridge','shopping','purchases'] loop
      if jsonb_typeof(kitchen->collection) is distinct from 'array' then raise exception 'INVALID_STATE'; end if;
      for entry in select value from jsonb_array_elements(kitchen->collection) loop
        if jsonb_typeof(entry)<>'object' or jsonb_typeof(entry->'id') is distinct from 'string'
          or length(entry->>'id') not between 1 and 200 then raise exception 'INVALID_STATE'; end if;
      end loop;
      if (select count(*) from jsonb_array_elements(kitchen->collection)) <>
        (select count(distinct value->>'id') from jsonb_array_elements(kitchen->collection)) then raise exception 'INVALID_STATE'; end if;
    end loop;
  end loop;
  if (select count(*) from jsonb_array_elements(p_state->'profiles')) <>
    (select count(distinct value->>'id') from jsonb_array_elements(p_state->'profiles')) then raise exception 'INVALID_STATE'; end if;

  -- Serialize first insert and updates for this authenticated account only.
  perform pg_advisory_xact_lock(hashtextextended(account_id::text,0));
  select * into prior from public.fridge_accounts where user_id=account_id for update;
  if found and prior.mutation_id=p_mutation_id then return to_jsonb(prior); end if;
  if coalesce(prior.revision,0)<>p_expected_revision then raise exception 'VERSION_CONFLICT'; end if;
  insert into public.fridge_accounts(user_id,state,revision,mutation_id)
    values(account_id,p_state,1,p_mutation_id)
    on conflict(user_id) do update set state=excluded.state,revision=fridge_accounts.revision+1,
      mutation_id=excluded.mutation_id,updated_at=now()
    returning * into saved;
  return to_jsonb(saved);
end;
$$;
revoke all on function public.save_fridge_state(jsonb,bigint,uuid) from public,anon;
grant execute on function public.save_fridge_state(jsonb,bigint,uuid) to authenticated;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='fridge_accounts') then
    alter publication supabase_realtime add table public.fridge_accounts;
  end if;
end $$;

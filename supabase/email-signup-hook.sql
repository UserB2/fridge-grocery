-- Allow password accounts only in a reserved namespace. Never auto-link
-- an email chosen at signup with a real Google account's address.
create or replace function public.check_fridge_signup(event jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  provider text := event->'user'->'app_metadata'->>'provider';
  email text := coalesce(event->'user'->>'email', '');
  password_account boolean := email ~ '^[0-9a-f]{64}@password[.]fridge[.]invalid$';
begin
  if (provider is not distinct from 'email') <> password_account then
    return jsonb_build_object(
      'error', jsonb_build_object('http_code', 403, 'message', 'Use the fridge website to create an account.')
    );
  end if;
  return '{}'::jsonb;
end;
$$;

revoke execute on function public.check_fridge_signup(jsonb) from public, anon, authenticated;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.check_fridge_signup(jsonb) to supabase_auth_admin;

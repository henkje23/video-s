-- Run this file once in the Supabase SQL Editor for your project.

create table if not exists public.shorts_likes (
  short_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (short_id, user_id)
);

create table if not exists public.shorts_comments (
  id uuid primary key default gen_random_uuid(),
  short_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  display_name text not null
    check (char_length(display_name) between 1 and 40),
  body text not null
    check (char_length(trim(body)) between 1 and 500),
  created_at timestamptz not null default now()
);

create index if not exists shorts_comments_short_created_idx
  on public.shorts_comments (short_id, created_at desc);

alter table public.shorts_likes enable row level security;
alter table public.shorts_comments enable row level security;

drop policy if exists "Users can read their own likes"
  on public.shorts_likes;
create policy "Users can read their own likes"
  on public.shorts_likes for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can like as themselves"
  on public.shorts_likes;
create policy "Users can like as themselves"
  on public.shorts_likes for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can remove their own likes"
  on public.shorts_likes;
create policy "Users can remove their own likes"
  on public.shorts_likes for delete to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Anyone can read comments"
  on public.shorts_comments;
create policy "Anyone can read comments"
  on public.shorts_comments for select to anon, authenticated
  using (true);

drop policy if exists "Users can comment as themselves"
  on public.shorts_comments;
create policy "Users can comment as themselves"
  on public.shorts_comments for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and char_length(trim(body)) between 1 and 500
    and char_length(display_name) between 1 and 40
  );

drop policy if exists "Users can delete their own comments"
  on public.shorts_comments;
create policy "Users can delete their own comments"
  on public.shorts_comments for delete to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, delete on public.shorts_likes to authenticated;
grant select, insert, delete on public.shorts_comments to anon, authenticated;

create or replace function public.get_short_like_counts()
returns table (short_id text, like_count bigint)
language sql
security definer
set search_path = ''
as $$
  select likes.short_id, count(*)
  from public.shorts_likes as likes
  group by likes.short_id;
$$;

revoke all on function public.get_short_like_counts() from public;
grant execute on function public.get_short_like_counts() to anon, authenticated;

create table if not exists public.shorts_recovery_codes (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 5),
  locked_until timestamptz,
  reservation_id uuid,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.shorts_recovery_codes enable row level security;
revoke all on public.shorts_recovery_codes from anon, authenticated;
grant select, insert, update, delete on public.shorts_recovery_codes to service_role;

create or replace function public.reserve_shorts_recovery_code(
  p_email text,
  p_code_hash text,
  p_reservation_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  recovery public.shorts_recovery_codes%rowtype;
begin
  select *
    into recovery
    from public.shorts_recovery_codes
    where email = lower(trim(p_email))
    for update;

  if not found then
    return null;
  end if;

  if recovery.expires_at <= now() then
    delete from public.shorts_recovery_codes where user_id = recovery.user_id;
    return null;
  end if;

  if recovery.reservation_id is not null then
    if recovery.locked_until > now() then
      return null;
    end if;
    delete from public.shorts_recovery_codes where user_id = recovery.user_id;
    return null;
  end if;

  if recovery.locked_until > now() then
    return null;
  end if;

  if recovery.failed_attempts >= 5 then
    update public.shorts_recovery_codes
      set failed_attempts = 0, locked_until = null
      where user_id = recovery.user_id;
    recovery.failed_attempts := 0;
  end if;

  if recovery.code_hash <> lower(p_code_hash) then
    update public.shorts_recovery_codes
      set failed_attempts = failed_attempts + 1,
          locked_until = case
            when failed_attempts + 1 >= 5 then now() + interval '15 minutes'
            else null
          end
      where user_id = recovery.user_id;
    return null;
  end if;

  update public.shorts_recovery_codes
    set reservation_id = p_reservation_id,
        locked_until = now() + interval '5 minutes'
    where user_id = recovery.user_id;

  return recovery.user_id;
end;
$$;

create or replace function public.complete_shorts_recovery_code(
  p_user_id uuid,
  p_reservation_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.shorts_recovery_codes
    where user_id = p_user_id
      and reservation_id = p_reservation_id;
  return found;
end;
$$;

create or replace function public.release_shorts_recovery_code(
  p_user_id uuid,
  p_reservation_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.shorts_recovery_codes
    set reservation_id = null, locked_until = null
    where user_id = p_user_id
      and reservation_id = p_reservation_id;
  return found;
end;
$$;

revoke all on function public.reserve_shorts_recovery_code(text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.complete_shorts_recovery_code(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.release_shorts_recovery_code(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.reserve_shorts_recovery_code(text, text, uuid)
  to service_role;
grant execute on function public.complete_shorts_recovery_code(uuid, uuid)
  to service_role;
grant execute on function public.release_shorts_recovery_code(uuid, uuid)
  to service_role;

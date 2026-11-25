-- ===========================================================================
-- The Sharkive: one owner (super-user) who alone manages reviewers
-- Run in Supabase → SQL Editor AFTER scale-2026-11.sql and population-2026-11.sql.
-- Safe to re-run. If you ever re-run scale-2026-11.sql, run this file again
-- afterwards (scale-2026-11.sql puts the old "any admin" rules back).
--
-- What changes
--   * reviewers.owner: true for exactly one person. Only the owner can add,
--     approve, deactivate or remove reviewers, or change anyone's role.
--   * Admins keep every other admin power (blocking phones, deleting visits,
--     expert decisions); they just can't manage people any more.
--   * The owner's own row can't be changed or removed from the app, so the
--     owner can't lock themselves out by accident. Changing the owner is done
--     here, in the SQL Editor, only.
--   * add_reviewer(email, role, name): the owner adds someone who has already
--     created an account on the review page, with no request needed.
--   * user_id_by_email(email): used only by the manage-users Edge Function
--     (supabase/functions/manage-users), which lets the owner create accounts,
--     reset passwords and delete accounts from the review page.
-- ===========================================================================

-- >>> EDIT THIS LINE: the email you sign in to the review page with <<<
do $$
declare
  owner_email text := 'YOUR-EMAIL@example.com';
  uid uuid;
begin
  alter table public.reviewers add column if not exists owner boolean not null default false;

  if exists (select 1 from public.reviewers where owner) then
    raise notice 'Owner already set; leaving it as it is.';
    return;
  end if;
  if owner_email = 'YOUR-EMAIL@example.com' then
    raise exception 'Edit owner_email near the top of this file first. Current admins: %',
      (select string_agg(coalesce(email, user_id::text), ', ') from public.reviewers where role = 'admin');
  end if;

  select id into uid from auth.users where lower(email) = lower(owner_email) and not coalesce(is_anonymous, false);
  if uid is null then raise exception 'No account with email %. Sign up on the review page first.', owner_email; end if;

  insert into public.reviewers (user_id, email, role, active, owner)
       values (uid, owner_email, 'admin', true, true)
  on conflict (user_id) do update set role = 'admin', active = true, owner = true;
end $$;

-- At most one owner.
create unique index if not exists reviewers_one_owner on public.reviewers ((true)) where owner;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.reviewers where user_id = auth.uid() and active and owner);
$$;
grant execute on function public.is_owner() to anon, authenticated;

-- ---------- guard: who may write reviewer rows from the app ----------
create or replace function public.reviewers_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_app_request() then
    -- Nobody changes the owner flag, or the owner's row, from the app.
    if tg_op = 'UPDATE' and (old.owner or new.owner is distinct from old.owner) then
      raise exception 'the owner''s account can only be changed in the Supabase SQL Editor';
    end if;
    if tg_op = 'INSERT' and new.owner then
      raise exception 'the owner can only be set in the Supabase SQL Editor';
    end if;

    if not public.is_owner() then
      if tg_op = 'UPDATE' then raise exception 'only the owner can change reviewers'; end if;
      -- Everyone else may only ask for access for themselves.
      if new.user_id is distinct from auth.uid() or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
        raise exception 'sign in with an email account to request access';
      end if;
      new.active := false;
      new.role := 'reviewer';
      new.requested_at := now();
    end if;
  end if;
  if new.email is null then select email into new.email from auth.users where id = new.user_id; end if;
  return new;
end $$;
drop trigger if exists reviewers_guard on public.reviewers;
create trigger reviewers_guard before insert or update on public.reviewers
  for each row execute function public.reviewers_guard();

-- Deleting: the owner only, and never the owner's own row.
create or replace function public.reviewers_delete_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_app_request() and old.owner then
    raise exception 'the owner''s account can only be removed in the Supabase SQL Editor';
  end if;
  return old;
end $$;
drop trigger if exists reviewers_delete_guard on public.reviewers;
create trigger reviewers_delete_guard before delete on public.reviewers
  for each row execute function public.reviewers_delete_guard();

-- ---------- policies ----------
drop policy if exists "see own reviewer row"    on public.reviewers;
drop policy if exists "request reviewer access" on public.reviewers;
drop policy if exists "admins manage reviewers" on public.reviewers;
drop policy if exists "admins remove reviewers" on public.reviewers;
drop policy if exists "owner manages reviewers" on public.reviewers;
drop policy if exists "owner removes reviewers" on public.reviewers;
create policy "see own reviewer row"    on public.reviewers for select to authenticated using (user_id = auth.uid() or public.is_reviewer());
create policy "request reviewer access" on public.reviewers for insert to authenticated with check (user_id = auth.uid() or public.is_owner());
create policy "owner manages reviewers" on public.reviewers for update to authenticated using (public.is_owner()) with check (public.is_owner());
create policy "owner removes reviewers" on public.reviewers for delete to authenticated using (public.is_owner());

-- ---------- owner's people list ----------
drop function if exists public.reviewer_stats();
create or replace function public.reviewer_stats()
returns table (user_id uuid, name text, email text, role text, active boolean, owner boolean, requested_at timestamptz,
               request_note text, decisions_30d bigint, decisions_total bigint, last_decision timestamptz,
               last_sign_in timestamptz, must_change_password boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'only the owner can manage people'; end if;
  return query
    select r.user_id, r.name, r.email, r.role, r.active, r.owner, r.requested_at, r.request_note,
           count(e.id) filter (where e.at > now() - interval '30 days'),
           count(e.id), max(e.at),
           u.last_sign_in_at, coalesce((u.raw_user_meta_data ->> 'must_change_password')::boolean, false)
      from public.reviewers r
      left join auth.users u on u.id = r.user_id
      left join public.review_events e on e.actor = r.user_id and e.action <> 'deleted'
     group by r.user_id, u.id
     order by r.owner desc, r.active, r.requested_at desc nulls last, r.name;
end $$;
grant execute on function public.reviewer_stats() to authenticated;

-- ---------- owner adds a reviewer directly ----------
-- The person must already have an account (review page → "Create an account").
create or replace function public.add_reviewer(p_email text, p_role text default 'reviewer', p_name text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid; was_there boolean;
begin
  if not public.is_owner() then raise exception 'only the owner can add reviewers'; end if;
  if p_role not in ('reviewer', 'expert', 'admin') then raise exception 'unknown role %', p_role; end if;
  select id into uid from auth.users
   where lower(email) = lower(trim(p_email)) and not coalesce(is_anonymous, false) and deleted_at is null;
  if uid is null then
    raise exception 'No account uses %. Ask them to create one on the review page first, then add them again.', trim(p_email);
  end if;
  if exists (select 1 from public.reviewers where user_id = uid and owner) then
    raise exception 'that is the owner''s account';
  end if;
  select exists (select 1 from public.reviewers where user_id = uid) into was_there;
  insert into public.reviewers (user_id, name, role, active)
       values (uid, nullif(trim(p_name), ''), p_role, true)
  on conflict (user_id) do update
       set role = excluded.role, active = true, name = coalesce(excluded.name, reviewers.name);
  return jsonb_build_object('user_id', uid, 'updated', was_there);
end $$;
revoke execute on function public.add_reviewer(text, text, text) from public, anon;
grant execute on function public.add_reviewer(text, text, text) to authenticated;

-- ---------- helper for the manage-users Edge Function (secret key only) ----------
create or replace function public.user_id_by_email(p_email text) returns uuid
language sql stable security definer set search_path = public as $$
  select id from auth.users
   where lower(email) = lower(trim(p_email)) and not coalesce(is_anonymous, false) and deleted_at is null
   limit 1;
$$;
revoke execute on function public.user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.user_id_by_email(text) to service_role;
grant select, insert, update, delete on public.reviewers to service_role;  -- Supabase grants this already; kept explicit

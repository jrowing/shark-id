-- ===========================================================================
-- The Sharkive — scaling migration (November 2026)
-- Run once in Supabase → SQL Editor, AFTER schema.sql and the add-*.sql files.
-- Safe to re-run. See SCALING.md for the dashboard settings that go with it.
--
--   5. Abuse protection   contributors sign in anonymously (with a CAPTCHA),
--                         per-device rate limits, uploads tied to the uploader,
--                         bucket size and type limits
--   1. Photos             thumbnail column (resizing happens on the phone)
--   2. Matching           pgvector + HNSW index; phones ask the server for
--                         nearest neighbours instead of downloading the library
--   3. Records            paging helpers: summary, map points
--   4. Reviewers          roles, claiming, expert queue, history, access requests
--   6. Moderation         pending photos in a private bucket (public only once
--                         approved), on-phone screening results, blocked phones
-- ===========================================================================

create extension if not exists vector with schema extensions;

-- Is this a request from the app (anon / signed-in user), rather than the SQL
-- editor or the service role? Checks below only apply to app requests.
create or replace function public.is_app_request() returns boolean
language sql stable as $$
  select coalesce(auth.jwt() ->> 'role', '') in ('anon', 'authenticated');
$$;

-- Tunable limits. Change with e.g.:
--   update public.settings set value = 100 where key = 'max_submissions_per_day';
create table if not exists public.settings (key text primary key, value int not null, note text);
alter table public.settings enable row level security;   -- no policies: functions only
insert into public.settings (key, value, note) values
  ('max_submissions_per_hour', 20, 'per contributor (device)'),
  ('max_submissions_per_day',  60, 'per contributor (device)'),
  ('max_uploads_per_hour',     50, 'photo files per contributor, incl. thumbnails'),
  ('claim_minutes',            15, 'how long a reviewer holds a claimed record')
on conflict (key) do nothing;

create or replace function public.setting(k text) returns int
language sql stable security definer set search_path = public as $$
  select value from public.settings where key = k;
$$;

-- ===========================================================================
-- 4a. Reviewer roles (needed by the guard trigger below)
-- ===========================================================================
alter table public.reviewers add column if not exists email  text;
alter table public.reviewers add column if not exists active boolean not null default true;
alter table public.reviewers add column if not exists role   text;
update public.reviewers set role = 'admin' where role is null;   -- existing reviewers become admins
alter table public.reviewers alter column role set default 'reviewer';
alter table public.reviewers alter column role set not null;
alter table public.reviewers drop constraint if exists reviewers_role_check;
alter table public.reviewers add constraint reviewers_role_check check (role in ('reviewer', 'expert', 'admin'));
alter table public.reviewers add column if not exists requested_at timestamptz;
alter table public.reviewers add column if not exists request_note text check (char_length(request_note) <= 500);

create or replace function public.is_reviewer() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.reviewers where user_id = auth.uid() and active);
$$;
create or replace function public.is_expert() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.reviewers where user_id = auth.uid() and active and role in ('expert', 'admin'));
$$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.reviewers where user_id = auth.uid() and active and role = 'admin');
$$;
grant execute on function public.is_reviewer(), public.is_expert(), public.is_admin() to anon, authenticated;

-- Species that only an expert (or admin) may confirm.
do $$ begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'species' and column_name = 'expert_only') then
    alter table public.species add column expert_only boolean not null default false;
    -- first run: Critically Endangered and provisional species need an expert
    update public.species set expert_only = true where iucn_status = 'CR' or id = 'humani-whaler';
  end if;
end $$;

-- ===========================================================================
-- New submission columns
-- ===========================================================================
alter table public.submissions add column if not exists submitted_by    uuid references auth.users on delete set null;
alter table public.submissions add column if not exists thumb_path      text;
alter table public.submissions add column if not exists embedding_v     extensions.vector(1280);
alter table public.submissions add column if not exists claimed_by      uuid references auth.users on delete set null;
alter table public.submissions add column if not exists claimed_at      timestamptz;
alter table public.submissions add column if not exists needs_expert    boolean not null default false;
alter table public.submissions add column if not exists escalation_note text check (char_length(escalation_note) <= 500);
-- On-phone screening result (explicit-image and "is it a fish" checks). Advisory
-- only: it comes from the phone, so it is never trusted to approve anything.
alter table public.submissions add column if not exists screening       jsonb;

-- Is the photo in the public bucket? Only approved records' photos are.
-- Photos uploaded before this migration are all public, so existing rows start true.
do $$ begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'submissions' and column_name = 'photo_public') then
    alter table public.submissions add column photo_public boolean not null default true;
    alter table public.submissions alter column photo_public set default false;
  end if;
end $$;

-- Phones that may no longer upload.
create table if not exists public.blocked_contributors (
  user_id    uuid primary key,
  blocked_at timestamptz not null default now(),
  blocked_by uuid default auth.uid(),
  reason     text check (char_length(reason) <= 500)
);
alter table public.blocked_contributors enable row level security;
create or replace function public.is_blocked() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.blocked_contributors where user_id = auth.uid());
$$;
grant execute on function public.is_blocked() to authenticated;

create index if not exists submissions_submitter_idx on public.submissions (submitted_by, created_at);
create index if not exists submissions_queue_idx     on public.submissions (needs_expert, created_at) where status = 'pending';
create index if not exists submissions_public_idx    on public.submissions (taken_at desc) where status = 'approved';

alter table public.reference_images add column if not exists embedding_v extensions.vector(1280);
alter table public.reference_images alter column embedding drop not null;

-- Move existing fingerprints into vector columns (real[] kept empty from now on).
update public.submissions set embedding_v = embedding::extensions.vector, embedding = null
  where embedding is not null and array_length(embedding, 1) = 1280;
update public.reference_images set embedding_v = embedding::extensions.vector, embedding = null
  where embedding is not null and array_length(embedding, 1) = 1280;

create index if not exists submissions_embedding_hnsw on public.submissions
  using hnsw (embedding_v extensions.vector_cosine_ops) where status in ('approved', 'reference');
create index if not exists reference_images_embedding_hnsw on public.reference_images
  using hnsw (embedding_v extensions.vector_cosine_ops);

-- ===========================================================================
-- Guard trigger (replaces the one in schema.sql)
-- ===========================================================================
create or replace function public.submissions_guard() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  n_hour int; n_day int;
  claim_ttl interval := make_interval(mins => coalesce(public.setting('claim_minutes'), 15));
  decision_changed boolean;
begin
  -- fingerprints arrive as plain arrays; store them as vectors
  if new.embedding is not null then
    if array_length(new.embedding, 1) = 1280 then new.embedding_v := new.embedding::vector; end if;
    new.embedding := null;
  end if;

  if tg_op = 'INSERT' then
    new.created_at := now();
    if new.taken_at > now() + interval '10 minutes' then raise exception 'taken_at is in the future'; end if;
    if new.taken_at < timestamptz '2000-01-01' then raise exception 'taken_at is implausibly old'; end if;

    if public.is_app_request() then
      if auth.uid() is null then
        raise exception 'Please reload the app: submissions now need a (free, automatic) sign-in.';
      end if;
      new.submitted_by := auth.uid();
      new.photo_public := false;           -- new photos start in the private bucket
      if public.is_blocked() then
        raise exception 'This phone has been blocked from uploading to The Sharkive.' using errcode = 'P0423';
      end if;
      if not public.is_reviewer() then
        -- photos must live in the uploader's own folder
        if new.photo_path not like 'submissions/' || auth.uid()::text || '/%'
           or (new.thumb_path is not null and new.thumb_path not like 'submissions/' || auth.uid()::text || '/%') then
          raise exception 'photo path does not belong to this contributor';
        end if;
        -- per-contributor rate limits
        select count(*) filter (where created_at > now() - interval '1 hour'), count(*)
          into n_hour, n_day
          from public.submissions
          where submitted_by = auth.uid() and created_at > now() - interval '1 day';
        if n_hour >= public.setting('max_submissions_per_hour') or n_day >= public.setting('max_submissions_per_day') then
          raise exception 'Too many records from this phone for now. Please try again later.' using errcode = 'P0429';
        end if;
        -- contributors can't set review fields
        new.status := 'pending';
        new.confirmed_species_id := null;
        new.review_notes := null;
        new.reviewed_by := null;
        new.reviewed_at := null;
        new.embedding_v := null;
        new.embedding_model := null;
        new.claimed_by := null;
        new.claimed_at := null;
        new.needs_expert := false;
        new.escalation_note := null;
      end if;
    end if;

  elsif tg_op = 'UPDATE' then
    if (new.taken_at, new.local_offset_min, new.time_source, new.tz_source, new.lat, new.lon,
        new.location_source, new.photo_path, new.thumb_path, new.capture_method, new.created_at, new.submitted_by)
       is distinct from
       (old.taken_at, old.local_offset_min, old.time_source, old.tz_source, old.lat, old.lon,
        old.location_source, old.photo_path, old.thumb_path, old.capture_method, old.created_at, old.submitted_by) then
      raise exception 'capture time/location cannot be edited';
    end if;

    decision_changed := new.status is distinct from old.status
                     or new.confirmed_species_id is distinct from old.confirmed_species_id
                     or new.needs_expert is distinct from old.needs_expert;

    -- the photo is public exactly when the record is approved (the app moves the files first)
    if public.is_app_request()
       and (new.status is distinct from old.status or new.photo_public is distinct from old.photo_public)
       and new.photo_public is distinct from (new.status = 'approved') then
      raise exception 'Photo and status are out of step: publish the photo when approving, and unpublish it otherwise.';
    end if;

    if public.is_app_request() and decision_changed then
      -- someone else is reviewing this record right now
      if old.claimed_by is not null and old.claimed_by <> auth.uid()
         and old.claimed_at > now() - claim_ttl and not public.is_admin() then
        raise exception 'Another reviewer is working on this record. It has been left for them.' using errcode = 'P0409';
      end if;
      -- expert-only decisions
      if new.status in ('approved', 'reference') and not public.is_expert()
         and (new.needs_expert
              or exists (select 1 from public.species where id = new.confirmed_species_id and expert_only)) then
        raise exception 'This species or record needs an expert reviewer. Use "Needs expert" instead.' using errcode = 'P0403';
      end if;
    end if;

    if new.status is distinct from old.status
       or new.confirmed_species_id is distinct from old.confirmed_species_id then
      new.reviewed_by := auth.uid();
      new.reviewed_at := now();
    end if;
    if decision_changed then          -- a decision releases the claim
      new.claimed_by := null;
      new.claimed_at := null;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists submissions_guard on public.submissions;
create trigger submissions_guard before insert or update on public.submissions
  for each row execute function public.submissions_guard();

create or replace function public.reference_images_vec() returns trigger
language plpgsql set search_path = public, extensions as $$
begin
  if new.embedding is not null then
    if array_length(new.embedding, 1) = 1280 then new.embedding_v := new.embedding::vector; end if;
    new.embedding := null;
  end if;
  return new;
end $$;
drop trigger if exists reference_images_vec on public.reference_images;
create trigger reference_images_vec before insert or update on public.reference_images
  for each row execute function public.reference_images_vec();

-- ===========================================================================
-- 5. Who may submit and upload
-- ===========================================================================
drop policy if exists "anyone can submit" on public.submissions;
drop policy if exists "signed-in contributors submit" on public.submissions;
create policy "signed-in contributors submit" on public.submissions
  for insert to authenticated with check (auth.uid() is not null);
revoke insert on public.submissions from anon;

-- The uploader's photo count in the last hour (security definer: storage.objects is private).
create or replace function public.upload_allowed() returns boolean
language sql stable security definer set search_path = public, storage as $$
  select public.is_reviewer()
      or (select count(*) from storage.objects
           where owner_id = auth.uid()::text and created_at > now() - interval '1 hour')
         < public.setting('max_uploads_per_hour');
$$;
grant execute on function public.upload_allowed() to authenticated;

update storage.buckets
   set file_size_limit = 3 * 1024 * 1024,              -- resized photos are ~0.2–0.6 MB
       allowed_mime_types = array['image/jpeg']
 where id = 'shark-photos';

-- Private bucket for photos that haven't been approved. Contributors can add to
-- their own folder but never read it back; reviewers see it through signed links.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('shark-pending', 'shark-pending', false, 3 * 1024 * 1024, array['image/jpeg'])
  on conflict (id) do update set public = false,
    file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Contributors can no longer write to the public bucket at all.
drop policy if exists "public uploads submissions" on storage.objects;
drop policy if exists "contributors upload own photos" on storage.objects;
drop policy if exists "contributors upload own pending photos" on storage.objects;
create policy "contributors upload own pending photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'shark-pending'
              and (storage.foldername(name))[1] = 'submissions'
              and (storage.foldername(name))[2] = auth.uid()::text
              and not public.is_blocked()
              and public.upload_allowed());
drop policy if exists "reviewers manage pending photos" on storage.objects;
create policy "reviewers manage pending photos" on storage.objects for all to authenticated
  using (bucket_id = 'shark-pending' and public.is_reviewer())
  with check (bucket_id = 'shark-pending' and public.is_reviewer());

-- ===========================================================================
-- 1 + 3. Public view, summary and map points
-- ===========================================================================
create or replace view public.public_records as
  select s.id, s.taken_at, s.local_offset_min, s.time_source, s.tz_source,
         s.lat, s.lon, s.location_accuracy_m, s.location_source, s.capture_method,
         s.site_name, s.length_cm, s.price, s.notes, s.photo_path, s.ai_suggestions, s.ai_model,
         s.reviewed_at,
         sp.id as species_id, sp.common_name, sp.scientific_name, sp.family,
         sp.iucn_status, sp.max_length_cm, sp.id_features,
         s.shark_count,
         s.thumb_path
  from public.submissions s
  join public.species sp on sp.id = s.confirmed_species_id
  where s.status = 'approved' and s.photo_public;
grant select on public.public_records to anon, authenticated;

-- Headline numbers + per-species counts for the Records page, computed in the database.
create or replace function public.records_summary() returns jsonb
language sql stable security definer set search_path = public as $$
  with r as (select * from public.public_records)
  select jsonb_build_object(
    'records',    (select count(*) from r),
    'sharks',     (select coalesce(sum(shark_count), 0) from r),
    'species',    (select count(distinct species_id) from r),
    'threatened', (select count(*) from r where iucn_status in ('CR', 'EN', 'VU')),
    'sites',      (select count(distinct site_name) from r where site_name is not null),
    'by_species', (select coalesce(jsonb_agg(jsonb_build_object('species_id', species_id, 'common_name', common_name, 'n', n)
                                             order by common_name), '[]')
                     from (select species_id, common_name, count(*) n from r group by 1, 2) x));
$$;
grant execute on function public.records_summary() to anon, authenticated;

-- Compact map points: [[id, lat, lon, species_id, shark_count, taken_at], …], newest first.
create or replace function public.record_points(p_species text default null, p_limit int default 20000) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_array(id, round(lat::numeric, 5), round(lon::numeric, 5), species_id, shark_count, taken_at)), '[]')
  from (select id, lat, lon, species_id, shark_count, taken_at from public.public_records
         where p_species is null or species_id = p_species
         order by taken_at desc limit least(p_limit, 50000)) x;
$$;
grant execute on function public.record_points(text, int) to anon, authenticated;

-- ===========================================================================
-- 2. Species matching on the server
-- ===========================================================================
drop view if exists public.reference_library;   -- replaced: phones no longer download the library

create or replace view public.reference_vectors as
  select confirmed_species_id as species_id, embedding_model, embedding_v
    from public.submissions where status in ('approved', 'reference') and embedding_v is not null
  union all
  select species_id, embedding_model, embedding_v from public.reference_images where embedding_v is not null;
revoke all on public.reference_vectors from anon, authenticated;

-- Nearest confirmed photos to a fingerprint. Returns
-- { neighbours: [{species_id, sim}], library_size, species_in_library }
create or replace function public.match_species(p_embedding real[], p_model text, p_k int default 7) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  q vector(1280);
  k int := greatest(1, least(coalesce(p_k, 7), 50));
  nn jsonb; n int; nsp int;
begin
  if coalesce(array_length(p_embedding, 1), 0) <> 1280 then raise exception 'expected a 1280-number fingerprint'; end if;
  q := p_embedding::vector;
  select coalesce(jsonb_agg(jsonb_build_object('species_id', species_id, 'sim', round(sim::numeric, 4)) order by sim desc), '[]')
    into nn
    from (select species_id, sim from (
            (select confirmed_species_id as species_id, 1 - (embedding_v <=> q) as sim
               from public.submissions
              where status in ('approved', 'reference') and embedding_v is not null and embedding_model = p_model
              order by embedding_v <=> q limit k * 3)
            union all
            (select species_id, 1 - (embedding_v <=> q)
               from public.reference_images
              where embedding_v is not null and embedding_model = p_model
              order by embedding_v <=> q limit k * 3)
          ) u order by sim desc limit k) t;
  select count(*), count(distinct species_id) into n, nsp from public.reference_vectors where embedding_model = p_model;
  return jsonb_build_object('neighbours', nn, 'library_size', n, 'species_in_library', nsp);
end $$;
grant execute on function public.match_species(real[], text, int) to anon, authenticated;

-- One average fingerprint per species: a small download (~0.5 MB) the phone
-- caches for rough offline suggestions.
create or replace function public.species_centroids(p_model text) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('species_id', species_id, 'n', n, 'embedding', c)), '[]')
  from (select species_id, count(*) n, avg(embedding_v)::real[] c
          from public.reference_vectors where embedding_model = p_model group by species_id) x;
$$;
grant execute on function public.species_centroids(text) to anon, authenticated;

-- Photos per species in the library (reviewer "Library coverage" table).
create or replace function public.library_counts(p_model text) returns table (species_id text, n bigint)
language sql stable security definer set search_path = public as $$
  select species_id, count(*) from public.reference_vectors where embedding_model = p_model group by 1;
$$;
grant execute on function public.library_counts(text) to authenticated;

-- ===========================================================================
-- 4b. Claiming: each reviewer gets their own records, never someone else's
-- ===========================================================================
create or replace function public.claim_batch(p_queue text default 'pending', p_n int default 5)
returns setof public.submissions
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  claim_ttl interval := make_interval(mins => coalesce(public.setting('claim_minutes'), 15));
begin
  if not public.is_reviewer() then raise exception 'reviewers only'; end if;
  if p_queue = 'expert' and not public.is_expert() then raise exception 'experts only'; end if;
  return query
    with picked as (
      select s.id from public.submissions s
       where s.status = 'pending'
         and s.needs_expert = (p_queue = 'expert')
         and (s.claimed_by is null or s.claimed_by = me or s.claimed_at < now() - claim_ttl)
       order by (s.claimed_by is not distinct from me) desc, s.created_at
       limit greatest(1, least(coalesce(p_n, 5), 20))
       for update skip locked)
    update public.submissions s set claimed_by = me, claimed_at = now()
      from picked where s.id = picked.id
    returning s.*;
end $$;
grant execute on function public.claim_batch(text, int) to authenticated;

create or replace function public.release_claim(p_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.submissions set claimed_by = null, claimed_at = null
   where id = p_id and claimed_by = auth.uid();
$$;
grant execute on function public.release_claim(uuid) to authenticated;

-- Queue sizes for the tab badges.
create or replace function public.queue_counts() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.is_reviewer() then jsonb_build_object(
    'pending', (select count(*) from public.submissions where status = 'pending' and not needs_expert),
    'expert',  (select count(*) from public.submissions where status = 'pending' and needs_expert)) end;
$$;
grant execute on function public.queue_counts() to authenticated;

-- ===========================================================================
-- 4c. History: every decision is logged, even if the record is later deleted
-- ===========================================================================
create table if not exists public.review_events (
  id            bigint generated always as identity primary key,
  submission_id uuid not null,
  at            timestamptz not null default now(),
  actor         uuid,
  action        text not null,              -- status change, 'species', 'escalated', 'deleted'
  old_status    text, new_status text,
  old_species   text, new_species text,
  note          text
);
create index if not exists review_events_submission_idx on public.review_events (submission_id, at);
create index if not exists review_events_actor_idx      on public.review_events (actor, at);
alter table public.review_events enable row level security;
drop policy if exists "reviewers read history" on public.review_events;
create policy "reviewers read history" on public.review_events for select to authenticated using (public.is_reviewer());
grant select on public.review_events to authenticated;

create or replace function public.log_review_event() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    insert into public.review_events (submission_id, actor, action, old_status, old_species)
      values (old.id, auth.uid(), 'deleted', old.status, old.confirmed_species_id);
    return old;
  end if;
  if new.status is distinct from old.status or new.confirmed_species_id is distinct from old.confirmed_species_id then
    insert into public.review_events (submission_id, actor, action, old_status, new_status, old_species, new_species, note)
      values (new.id, auth.uid(),
              case when new.status is distinct from old.status then new.status else 'species' end,
              old.status, new.status, old.confirmed_species_id, new.confirmed_species_id, new.review_notes);
  end if;
  if new.needs_expert and not old.needs_expert then
    insert into public.review_events (submission_id, actor, action, old_status, new_status, note)
      values (new.id, auth.uid(), 'escalated', old.status, new.status, new.escalation_note);
  end if;
  return new;
end $$;
drop trigger if exists log_review_event on public.submissions;
create trigger log_review_event after update or delete on public.submissions
  for each row execute function public.log_review_event();

-- ===========================================================================
-- 4d. Reviewer access requests and admin management
-- ===========================================================================
-- Anyone with a (non-anonymous) account can ask to become a reviewer; an admin approves.
create or replace function public.reviewers_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_app_request() and not public.is_admin() then
    if tg_op = 'UPDATE' then raise exception 'only admins can change reviewers'; end if;
    if new.user_id is distinct from auth.uid() or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
      raise exception 'sign in with an email account to request access';
    end if;
    new.active := false;
    new.role := 'reviewer';
    new.requested_at := now();
  end if;
  if new.email is null then select email into new.email from auth.users where id = new.user_id; end if;
  return new;
end $$;
drop trigger if exists reviewers_guard on public.reviewers;
create trigger reviewers_guard before insert or update on public.reviewers
  for each row execute function public.reviewers_guard();

update public.reviewers r set email = u.email from auth.users u where u.id = r.user_id and r.email is null;

drop policy if exists "reviewers see reviewers" on public.reviewers;
drop policy if exists "see own reviewer row"    on public.reviewers;
drop policy if exists "request reviewer access" on public.reviewers;
drop policy if exists "admins manage reviewers" on public.reviewers;
drop policy if exists "admins remove reviewers" on public.reviewers;
create policy "see own reviewer row"    on public.reviewers for select to authenticated using (user_id = auth.uid() or public.is_reviewer());
create policy "request reviewer access" on public.reviewers for insert to authenticated with check (user_id = auth.uid() or public.is_admin());
create policy "admins manage reviewers" on public.reviewers for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins remove reviewers" on public.reviewers for delete to authenticated using (public.is_admin());
grant select, insert, update, delete on public.reviewers to authenticated;

-- Admin overview: everyone with a reviewer row, plus their activity.
create or replace function public.reviewer_stats()
returns table (user_id uuid, name text, email text, role text, active boolean, requested_at timestamptz,
               request_note text, decisions_30d bigint, decisions_total bigint, last_decision timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  return query
    select r.user_id, r.name, r.email, r.role, r.active, r.requested_at, r.request_note,
           count(e.id) filter (where e.at > now() - interval '30 days'),
           count(e.id), max(e.at)
      from public.reviewers r
      left join public.review_events e on e.actor = r.user_id and e.action <> 'deleted'
     group by r.user_id
     order by r.active, r.requested_at desc nulls last, r.name;
end $$;
grant execute on function public.reviewer_stats() to authenticated;

-- Make sure the API roles can use the new columns.
grant select, update, delete on public.submissions to authenticated;
grant insert on public.submissions to authenticated;

-- ===========================================================================
-- 6. Blocking a phone (admins)
-- ===========================================================================
drop policy if exists "admins manage blocks" on public.blocked_contributors;
create policy "admins manage blocks" on public.blocked_contributors for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.blocked_contributors to authenticated;

-- Blocks a phone and deletes everything it sent that isn't already approved.
-- Returns { deleted, files: [{bucket, path}] } so the app can remove the photos.
create or replace function public.block_contributor(p_user uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare gone jsonb; n int;
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  if p_user is null then raise exception 'no contributor on this record'; end if;
  if exists (select 1 from public.reviewers where user_id = p_user and active) then
    raise exception 'That account is a reviewer. Deactivate it on the People tab instead.';
  end if;
  insert into public.blocked_contributors (user_id, reason) values (p_user, p_reason)
    on conflict (user_id) do update set reason = excluded.reason, blocked_at = now(), blocked_by = auth.uid();
  with d as (
         delete from public.submissions where submitted_by = p_user and status <> 'approved'
         returning photo_path, thumb_path, photo_public),
       f as (
         select jsonb_build_object('bucket', case when d.photo_public then 'shark-photos' else 'shark-pending' end, 'path', v.p) as file
           from d cross join lateral (values (d.photo_path), (d.thumb_path)) v(p)
          where v.p is not null)
  select (select count(*) from d), (select coalesce(jsonb_agg(file), '[]') from f) into n, gone;
  return jsonb_build_object('deleted', n, 'files', gone);
end $$;
grant execute on function public.block_contributor(uuid, text) to authenticated;

-- Blocked phones with how many records each had approved.
create or replace function public.blocked_list()
returns table (user_id uuid, blocked_at timestamptz, reason text, blocked_by_name text, approved_records bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  return query
    select b.user_id, b.blocked_at, b.reason, r.name,
           (select count(*) from public.submissions s where s.submitted_by = b.user_id and s.status = 'approved')
      from public.blocked_contributors b
      left join public.reviewers r on r.user_id = b.blocked_by
     order by b.blocked_at desc;
end $$;
grant execute on function public.blocked_list() to authenticated;

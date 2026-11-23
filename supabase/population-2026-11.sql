-- ===========================================================================
-- The Sharkive — population data update (November 2026)
-- Run once in Supabase → SQL Editor, AFTER scale-2026-11.sql. Safe to re-run.
--
--   1. Rays            ray species, shark/ray group, size measure (TL / DW)
--   2. Nothing-here    zero records: a market or roadside seller checked and
--                      no sharks or rays found (one moment; table `visits`).
--   3. Sightings       context (market / in water / shallows), market-visit link, sex,
--                      life stage, depth, habitat, measured length
--   4. Photo-ID        individuals catalogue + ORB features (reviewers only)
--   5. Research grade  second-opinion ID confirmations and a quality grade
--   6. Public views    public_records (extended), public_visits, public_individuals
-- ===========================================================================

-- ===========================================================================
-- 1. Species: group, size measure, local name, photo-ID, rays
-- ===========================================================================
alter table public.species add column if not exists grp               text not null default 'shark';
alter table public.species add column if not exists size_measure      text not null default 'TL';
alter table public.species add column if not exists local_name        text;
alter table public.species add column if not exists photo_id_suitable boolean not null default false;
alter table public.species add column if not exists maturity_cm       int;   -- size at maturity (fill in from the literature)
alter table public.species drop constraint if exists species_grp_check;
alter table public.species add constraint species_grp_check check (grp in ('shark', 'ray'));
alter table public.species drop constraint if exists species_size_measure_check;
alter table public.species add constraint species_size_measure_check check (size_measure in ('TL', 'FL', 'DW'));

-- Rays seen in western Indian Ocean landings and on reefs. IUCN categories and
-- sizes are approximate (global assessments): check against the current Red List.
-- max_length_cm is total length (TL) for wedgefishes and guitarfishes, and disc
-- width (DW) for stingrays, eagle rays and mantas.
insert into public.species (id, common_name, scientific_name, family, iucn_status, max_length_cm, id_features, grp, size_measure) values
 ('bottlenose-wedgefish','Bottlenose wedgefish','Rhynchobatus australiae','Rhinidae','CR',300,'Shark-like ray: pointed wedge-shaped snout, large shark-like dorsal fins and tail; white spots on the back and a black spot (ringed with white spots) on each pectoral fin. Very hard to separate from whitespotted and smoothnose wedgefish from photos.','ray','TL'),
 ('whitespotted-wedgefish','Whitespotted wedgefish','Rhynchobatus djiddensis','Rhinidae','CR',310,'Shark-like ray with a wedge-shaped snout and shark-like fins; rows of white spots on the back; black pectoral spot. Western Indian Ocean form of the complex; compare bottlenose wedgefish.','ray','TL'),
 ('smoothnose-wedgefish','Smoothnose wedgefish','Rhynchobatus laevis','Rhinidae','CR',300,'Wedgefish with a smooth snout and a dark spot on the pectoral fin; white spots on the back. Part of the R. djiddensis species complex: photos often can''t separate them.','ray','TL'),
 ('bowmouth-guitarfish','Bowmouth guitarfish (shark ray)','Rhina ancylostomus','Rhinidae','CR',270,'Broad, rounded head with ridges of thorns over the eyes and on the back; wide W-shaped mouth; big shark-like dorsal fins; white spots on a grey-brown back. Unmistakable.','ray','TL'),
 ('halavi-guitarfish','Halavi guitarfish','Glaucostegus halavi','Glaucostegidae','CR',180,'Guitarfish: long, flattened, guitar-shaped body with a pointed translucent snout; plain sandy-brown back; dorsal fins set well back on the tail. Compare other giant guitarfishes.','ray','TL'),
 ('spotted-eagle-ray','Ocellated (spotted) eagle ray','Aetobatus ocellatus','Aetobatidae','VU',300,'Diamond-shaped disc with pointed wings; dark back covered in white spots or rings; distinct head with a duck-bill snout; very long whip-like tail with spines at the base. Size is disc width.','ray','DW'),
 ('honeycomb-whipray','Honeycomb (reticulate) whipray','Himantura uarnak','Dasyatidae','EN',200,'Large stingray with a rhomboid disc; dense network of dark brown reticulations (honeycomb) on a pale back; very long whip-like banded tail. Size is disc width.','ray','DW'),
 ('pink-whipray','Pink whipray','Pateobatis fai','Dasyatidae','VU',180,'Large stingray with a plain grey-pink back and white underside; long thin tail with no fin fold. Size is disc width.','ray','DW'),
 ('blotched-fantail','Blotched fantail ray (round ribbontail)','Taeniurops meyeni','Dasyatidae','VU',180,'Very large round disc with black blotches on grey; short thick tail with a deep fin fold below. Size is disc width.','ray','DW'),
 ('bluespotted-ribbontail','Bluespotted ribbontail ray','Taeniura lymma','Dasyatidae','LC',35,'Small oval stingray; bright blue spots on a yellow-brown back; blue stripes along the tail. Size is disc width.','ray','DW'),
 ('mangrove-whipray','Mangrove whipray','Urogymnus granulatus','Dasyatidae','EN',140,'Oval disc, dark brown with small white flecks; tail white towards the tip. Shallow lagoons and mangroves. Size is disc width.','ray','DW'),
 ('porcupine-ray','Porcupine ray','Urogymnus asperrimus','Dasyatidae','EN',115,'Thick, oval disc covered in sharp thorns; plain grey-brown; thick tail with no sting. Size is disc width.','ray','DW'),
 ('reef-manta','Reef manta ray','Mobula alfredi','Mobulidae','VU',500,'Huge diamond-shaped disc with head fins (cephalic lobes); white shoulder patches that run parallel to the head; belly spots unique to each animal. Size is disc width.','ray','DW'),
 ('oceanic-manta','Oceanic (giant) manta ray','Mobula birostris','Mobulidae','EN',700,'Huge disc; T-shaped white shoulder patches; dark mouth; belly spots concentrated low on the belly. Size is disc width.','ray','DW'),
 ('unidentified-ray','Ray — not identified','Batoidea','','NE',null,'Use when a reviewer cannot confirm the species of a ray from the photo. The record still counts towards totals.','ray','TL')
on conflict (id) do update set
  common_name = excluded.common_name, scientific_name = excluded.scientific_name, family = excluded.family,
  iucn_status = excluded.iucn_status, max_length_cm = excluded.max_length_cm, id_features = excluded.id_features,
  grp = excluded.grp, size_measure = excluded.size_measure;

-- Critically endangered rays need an expert (as for sharks).
update public.species set expert_only = true
 where id in ('bottlenose-wedgefish','whitespotted-wedgefish','smoothnose-wedgefish','bowmouth-guitarfish','halavi-guitarfish');

-- Species whose markings let individuals be recognised from photos.
update public.species set photo_id_suitable = true
 where id in ('zebra','tawny-nurse','whale','spotted-eagle-ray','honeycomb-whipray','blotched-fantail','reef-manta','oceanic-manta','bowmouth-guitarfish');

-- ===========================================================================
-- 2. "Nothing here" checks (zero records) at markets and roadside sellers.
--    The app records one moment (started_at = ended_at). The table can also
--    hold timed visits, and submissions.visit_id can link sightings to one,
--    but the app doesn't use that at the moment.
-- ===========================================================================
insert into public.settings (key, value, note) values
  ('max_visits_per_hour', 20, 'visits per contributor (device)'),
  ('max_visits_per_day',  60, 'visits per contributor (device)')
on conflict (key) do nothing;

create table if not exists public.visits (
  id                  uuid primary key,                  -- made on the phone
  created_at          timestamptz not null default now(),
  submitted_by        uuid references auth.users on delete set null,
  kind                text not null check (kind in ('market', 'roadside')),
  -- WHEN: device clock at start and finish (never typed in)
  started_at          timestamptz not null,
  ended_at            timestamptz not null,
  local_offset_min    int check (local_offset_min between -840 and 840),
  -- WHERE: live GPS when the visit started
  lat                 double precision not null check (lat between -90 and 90),
  lon                 double precision not null check (lon between -180 and 180),
  location_accuracy_m real,
  site_name           text check (char_length(site_name) <= 120),
  sightings_logged    int not null default 0 check (sightings_logged between 0 and 1000),
  auto_closed         boolean not null default false,    -- not finished on the phone; closed automatically
  notes               text check (char_length(notes) <= 1000),
  device_info         text,
  status              text not null default 'ok' check (status in ('ok', 'hidden')),
  hidden_reason       text,
  constraint visit_times check (ended_at >= started_at and ended_at - started_at <= interval '24 hours')
);
create index if not exists visits_started_idx on public.visits (started_at);
create index if not exists visits_kind_idx    on public.visits (kind, started_at);

create or replace function public.visits_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare n_hour int; n_day int;
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    if new.ended_at > now() + interval '10 minutes' then raise exception 'visit end time is in the future'; end if;
    if new.started_at < timestamptz '2000-01-01' then raise exception 'visit time is implausibly old'; end if;
    if public.is_app_request() then
      if auth.uid() is null then raise exception 'Please reload the app: visits need a (free, automatic) sign-in.'; end if;
      new.submitted_by := auth.uid();
      if public.is_blocked() then
        raise exception 'This phone has been blocked from uploading to The Sharkive.' using errcode = 'P0423';
      end if;
      if not public.is_reviewer() then
        select count(*) filter (where created_at > now() - interval '1 hour'), count(*)
          into n_hour, n_day
          from public.visits where submitted_by = auth.uid() and created_at > now() - interval '1 day';
        if n_hour >= public.setting('max_visits_per_hour') or n_day >= public.setting('max_visits_per_day') then
          raise exception 'Too many visits from this phone for now. Please try again later.' using errcode = 'P0429';
        end if;
        new.status := 'ok';
        new.hidden_reason := null;
      end if;
    end if;
  elsif tg_op = 'UPDATE' then
    if (new.id, new.kind, new.started_at, new.ended_at, new.local_offset_min, new.lat, new.lon, new.submitted_by, new.created_at)
       is distinct from
       (old.id, old.kind, old.started_at, old.ended_at, old.local_offset_min, old.lat, old.lon, old.submitted_by, old.created_at) then
      raise exception 'visit time/location cannot be edited';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists visits_guard on public.visits;
create trigger visits_guard before insert or update on public.visits
  for each row execute function public.visits_guard();

alter table public.visits enable row level security;
drop policy if exists "contributors add visits" on public.visits;
drop policy if exists "reviewers read visits"   on public.visits;
drop policy if exists "reviewers update visits" on public.visits;
drop policy if exists "reviewers delete visits" on public.visits;
create policy "contributors add visits" on public.visits for insert to authenticated with check (auth.uid() is not null);
create policy "reviewers read visits"   on public.visits for select to authenticated using (public.is_reviewer());
create policy "reviewers update visits" on public.visits for update to authenticated using (public.is_reviewer()) with check (public.is_reviewer());
create policy "reviewers delete visits" on public.visits for delete to authenticated using (public.is_admin());
grant insert, select, update, delete on public.visits to authenticated;

-- ===========================================================================
-- 3. Sighting fields
-- ===========================================================================
alter table public.submissions add column if not exists context            text not null default 'market';
alter table public.submissions add column if not exists visit_id           uuid;          -- no FK: a visit uploads after its sightings
alter table public.submissions add column if not exists sex                text;          -- submitter's call
alter table public.submissions add column if not exists confirmed_sex      text;          -- reviewer's call
alter table public.submissions add column if not exists life_stage         text;
alter table public.submissions add column if not exists depth_m            real;
alter table public.submissions add column if not exists habitat            text;
alter table public.submissions add column if not exists measurement        jsonb;         -- photo measurement points + reference
alter table public.submissions add column if not exists measured_length_cm real;
alter table public.submissions add column if not exists measured_by        text;

alter table public.submissions drop constraint if exists submissions_context_check;
alter table public.submissions add constraint submissions_context_check check (context in ('market', 'in_water', 'shallows'));
alter table public.submissions drop constraint if exists submissions_sex_check;
alter table public.submissions add constraint submissions_sex_check check (sex in ('male', 'female', 'unknown'));
alter table public.submissions drop constraint if exists submissions_confirmed_sex_check;
alter table public.submissions add constraint submissions_confirmed_sex_check check (confirmed_sex in ('male', 'female', 'unknown'));
alter table public.submissions drop constraint if exists submissions_life_stage_check;
alter table public.submissions add constraint submissions_life_stage_check check (life_stage in ('neonate', 'juvenile', 'adult', 'unknown'));
alter table public.submissions drop constraint if exists submissions_depth_check;
alter table public.submissions add constraint submissions_depth_check check (depth_m between 0 and 200);
alter table public.submissions drop constraint if exists submissions_habitat_check;
alter table public.submissions add constraint submissions_habitat_check
  check (habitat in ('reef', 'sand', 'seagrass', 'mangrove', 'lagoon', 'beach', 'open_water', 'other'));
alter table public.submissions drop constraint if exists submissions_measured_check;
alter table public.submissions add constraint submissions_measured_check check (measured_length_cm between 1 and 2000);
alter table public.submissions drop constraint if exists submissions_measured_by_check;
alter table public.submissions add constraint submissions_measured_by_check check (measured_by in ('submitter', 'reviewer'));


create index if not exists submissions_visit_idx on public.submissions (visit_id) where visit_id is not null;

-- Extra checks for the new fields (runs after submissions_guard).
create or replace function public.submissions_guard_population() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_app_request() and not public.is_reviewer() then
    if tg_op = 'INSERT' then
      new.confirmed_sex := null;
      new.individual_id := null;
      new.measured_by := case when new.measured_length_cm is null then null else 'submitter' end;
      if new.context = 'market' then new.depth_m := null; end if;
      if new.context <> 'market' and new.visit_id is not null then
        raise exception 'visits are only for markets and roadside sellers';
      end if;
    end if;
  end if;
  if tg_op = 'UPDATE' and (new.context, new.visit_id) is distinct from (old.context, old.visit_id) and not public.is_admin() then
    raise exception 'context and visit cannot be changed';
  end if;
  return new;
end $$;

-- ===========================================================================
-- 4. Photo-ID: individuals and their ORB features
-- ===========================================================================
create table if not exists public.individuals (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Z0-9-]{3,20}$'),   -- e.g. ZEB-0001
  species_id  text not null references public.species(id),
  nickname    text check (char_length(nickname) <= 60),
  sex         text check (sex in ('male', 'female', 'unknown')),
  notes       text check (char_length(notes) <= 1000),
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users default auth.uid()
);
alter table public.submissions add column if not exists individual_id uuid references public.individuals(id) on delete set null;
create index if not exists submissions_individual_idx on public.submissions (individual_id) where individual_id is not null;

-- Features for matching. One row per catalogued photo region (e.g. left flank).
create table if not exists public.photoid_features (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users default auth.uid(),
  individual_id uuid not null references public.individuals(id) on delete cascade,
  submission_id uuid references public.submissions(id) on delete cascade,
  species_id    text not null references public.species(id),
  side          text not null check (side in ('left', 'right', 'dorsal', 'ventral', 'other')),
  crop          jsonb not null,               -- {x, y, w, h} in photo pixels
  model         text not null,                -- e.g. 'orb-v1'
  n_keypoints   int not null check (n_keypoints between 0 and 2000),
  keypoints     jsonb not null,               -- [[x, y], …] in crop pixels
  descriptors   text not null                 -- base64, 32 bytes per keypoint
);
create index if not exists photoid_features_species_idx on public.photoid_features (species_id, model, side);

-- Next free code for a species, e.g. ZEB-0007.
create or replace function public.next_individual_code(p_species text) returns text
language plpgsql stable security definer set search_path = public as $$
declare pre text; n int;
begin
  if not public.is_reviewer() then raise exception 'reviewers only'; end if;
  pre := upper(left(regexp_replace(p_species, '[^a-z]', '', 'g'), 3));
  select coalesce(max(substring(code from '-(\d+)$')::int), 0) + 1 into n
    from public.individuals where code like pre || '-%';
  return pre || '-' || lpad(n::text, 4, '0');
end $$;
grant execute on function public.next_individual_code(text) to authenticated;

alter table public.individuals      enable row level security;
alter table public.photoid_features enable row level security;
drop policy if exists "individuals readable"          on public.individuals;
drop policy if exists "reviewers manage individuals"  on public.individuals;
drop policy if exists "reviewers manage photoid"      on public.photoid_features;
create policy "individuals readable"         on public.individuals for select to anon, authenticated using (true);
create policy "reviewers manage individuals" on public.individuals for all to authenticated using (public.is_reviewer()) with check (public.is_reviewer());
create policy "reviewers manage photoid"     on public.photoid_features for all to authenticated using (public.is_reviewer()) with check (public.is_reviewer());
grant select on public.individuals to anon, authenticated;
grant insert, update, delete on public.individuals to authenticated;
grant select, insert, update, delete on public.photoid_features to authenticated;

-- (trigger created here because it references individual_id)
drop trigger if exists submissions_guard_population on public.submissions;
create trigger submissions_guard_population before insert or update on public.submissions
  for each row execute function public.submissions_guard_population();

-- ===========================================================================
-- 5. Research grade: second opinions
-- ===========================================================================
create table if not exists public.id_confirmations (
  submission_id uuid not null references public.submissions(id) on delete cascade,
  reviewer      uuid not null default auth.uid() references auth.users on delete cascade,
  species_id    text not null references public.species(id),
  agrees        boolean not null,
  note          text check (char_length(note) <= 500),
  at            timestamptz not null default now(),
  primary key (submission_id, reviewer)
);
create or replace function public.id_confirmations_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare s public.submissions;
begin
  if public.is_app_request() then
    new.reviewer := auth.uid();
    new.at := now();
    select * into s from public.submissions where id = new.submission_id;
    if s.status <> 'approved' then raise exception 'only approved records get second opinions'; end if;
    if s.reviewed_by = auth.uid() then raise exception 'You approved this record, so someone else needs to give the second opinion.'; end if;
    new.agrees := (new.species_id = s.confirmed_species_id);
  end if;
  return new;
end $$;
drop trigger if exists id_confirmations_guard on public.id_confirmations;
create trigger id_confirmations_guard before insert or update on public.id_confirmations
  for each row execute function public.id_confirmations_guard();

alter table public.id_confirmations enable row level security;
drop policy if exists "reviewers read confirmations" on public.id_confirmations;
drop policy if exists "reviewers add confirmations"  on public.id_confirmations;
drop policy if exists "reviewers edit own confirmations" on public.id_confirmations;
create policy "reviewers read confirmations" on public.id_confirmations for select to authenticated using (public.is_reviewer());
create policy "reviewers add confirmations"  on public.id_confirmations for insert to authenticated with check (public.is_reviewer());
create policy "reviewers edit own confirmations" on public.id_confirmations for update to authenticated
  using (public.is_reviewer() and reviewer = auth.uid()) with check (public.is_reviewer() and reviewer = auth.uid());
grant select, insert, update on public.id_confirmations to authenticated;

-- 'research': approved; ID confirmed by an expert or by a second reviewer (and
-- nobody has disagreed since the last decision); species identified; time and
-- place from trustworthy sources. Agreement is compared with the current ID, so
-- a record re-identified by an expert is judged afresh.
-- 'verified': approved by one reviewer. null: not approved.
create or replace function public.quality_grade(s public.submissions) returns text
language sql stable security definer set search_path = public as $$
  select case
    when s.status <> 'approved' then null
    when s.confirmed_species_id in ('unidentified', 'unidentified-ray') then 'verified'
    when s.location_source = 'live_gps_at_upload' then 'verified'
    when s.time_source = 'exif' and s.tz_source = 'device' then 'verified'
    when exists (select 1 from public.id_confirmations c
                  where c.submission_id = s.id and c.species_id <> s.confirmed_species_id and c.at > coalesce(s.reviewed_at, '-infinity'))
      then 'verified'                                           -- someone disagrees with the current ID
    when exists (select 1 from public.reviewers r where r.user_id = s.reviewed_by and r.role in ('expert', 'admin'))
      or exists (select 1 from public.id_confirmations c
                  where c.submission_id = s.id and c.species_id = s.confirmed_species_id and c.reviewer <> s.reviewed_by)
      then 'research'
    else 'verified' end;
$$;

-- Approved records that still need a second opinion (not approved by me, not
-- yet seen by me, approver not an expert), oldest first.
create or replace function public.second_opinion_batch(p_n int default 5) returns setof public.submissions
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_reviewer() then raise exception 'reviewers only'; end if;
  return query
    select s.* from public.submissions s
     where s.status = 'approved'
       and s.reviewed_by is distinct from auth.uid()
       and public.quality_grade(s) = 'verified'
       and s.confirmed_species_id not in ('unidentified', 'unidentified-ray')
       and not exists (select 1 from public.id_confirmations c where c.submission_id = s.id)
     order by s.reviewed_at nulls first
     limit greatest(1, least(coalesce(p_n, 5), 20));
end $$;
grant execute on function public.second_opinion_batch(int) to authenticated;

create or replace function public.queue_counts() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.is_reviewer() then jsonb_build_object(
    'pending', (select count(*) from public.submissions where status = 'pending' and not needs_expert),
    'expert',  (select count(*) from public.submissions where status = 'pending' and needs_expert),
    'second',  (select count(*) from public.submissions s
                 where s.status = 'approved' and s.reviewed_by is distinct from auth.uid()
                   and s.confirmed_species_id not in ('unidentified', 'unidentified-ray')
                   and public.quality_grade(s) = 'verified'
                   and not exists (select 1 from public.id_confirmations c where c.submission_id = s.id))) end;
$$;
grant execute on function public.queue_counts() to authenticated;

-- ===========================================================================
-- 6. Public views and summaries
-- ===========================================================================
-- The existing columns keep their order; new ones are added at the end.
create or replace view public.public_records as
  select s.id, s.taken_at, s.local_offset_min, s.time_source, s.tz_source,
         s.lat, s.lon, s.location_accuracy_m, s.location_source, s.capture_method,
         s.site_name, s.length_cm, s.price, s.notes, s.photo_path, s.ai_suggestions, s.ai_model,
         s.reviewed_at,
         sp.id as species_id, sp.common_name, sp.scientific_name, sp.family,
         sp.iucn_status, sp.max_length_cm, sp.id_features,
         s.shark_count,
         s.thumb_path,
         s.context, s.visit_id,
         coalesce(s.confirmed_sex, s.sex) as sex, (s.confirmed_sex is not null) as sex_confirmed,
         s.life_stage, s.depth_m, s.habitat,
         s.measured_length_cm, s.measured_by, s.measurement,
         s.individual_id, i.code as individual_code,
         sp.grp, sp.size_measure, sp.maturity_cm,
         public.quality_grade(s) as quality_grade
  from public.submissions s
  join public.species sp on sp.id = s.confirmed_species_id
  left join public.individuals i on i.id = s.individual_id
  where s.status = 'approved' and s.photo_public;
grant select on public.public_records to anon, authenticated;

-- Visits without device info. approved_sightings counts only reviewer-approved
-- records, so a visit whose only photo was rejected counts as a zero visit.
create or replace view public.public_visits as
  select v.id, v.kind, v.started_at, v.ended_at, v.local_offset_min,
         v.lat, v.lon, v.location_accuracy_m, v.site_name,
         v.sightings_logged, v.auto_closed,
         round(extract(epoch from (v.ended_at - v.started_at)) / 60)::int as duration_min,
         (select count(*) from public.submissions s where s.visit_id = v.id and s.status = 'approved')::int as approved_sightings,
         (select coalesce(sum(s.shark_count), 0) from public.submissions s where s.visit_id = v.id and s.status = 'approved')::int as animals
    from public.visits v
   where v.status = 'ok';
grant select on public.public_visits to anon, authenticated;

create or replace view public.public_individuals as
  select i.id, i.code, i.species_id, sp.common_name, sp.scientific_name, i.nickname, i.sex,
         count(r.id)::int as sightings, min(r.taken_at) as first_seen, max(r.taken_at) as last_seen,
         (array_agg(r.thumb_path order by r.taken_at desc) filter (where r.thumb_path is not null))[1] as thumb_path,
         (array_agg(r.photo_path order by r.taken_at desc))[1] as photo_path
    from public.individuals i
    join public.species sp on sp.id = i.species_id
    left join public.public_records r on r.individual_id = i.id
   group by i.id, sp.common_name, sp.scientific_name;
grant select on public.public_individuals to anon, authenticated;

create or replace function public.records_summary() returns jsonb
language sql stable security definer set search_path = public as $$
  with r as (select * from public.public_records), v as (select * from public.public_visits)
  select jsonb_build_object(
    'records',    (select count(*) from r),
    'sharks',     (select coalesce(sum(shark_count), 0) from r where grp = 'shark'),
    'rays',       (select coalesce(sum(shark_count), 0) from r where grp = 'ray'),
    'species',    (select count(distinct species_id) from r where species_id not in ('unidentified', 'unidentified-ray')),
    'threatened', (select count(*) from r where iucn_status in ('CR', 'EN', 'VU')),
    'research',   (select count(*) from r where quality_grade = 'research'),
    'sites',      (select count(distinct site_name) from r where site_name is not null),
    'visits',     (select count(*) from v),
    'zero_visits',(select count(*) from v where approved_sightings = 0),
    'individuals',(select count(*) from public.individuals),
    'by_species', (select coalesce(jsonb_agg(jsonb_build_object('species_id', species_id, 'common_name', common_name, 'grp', grp, 'n', n)
                                             order by grp desc, common_name), '[]')
                     from (select species_id, common_name, grp, count(*) n from r group by 1, 2, 3) x));
$$;
grant execute on function public.records_summary() to anon, authenticated;

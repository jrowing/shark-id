-- ===========================================================================
-- Shark ID — Supabase schema
-- Run once in Supabase → SQL editor. Safe to re-run (idempotent where possible).
-- ===========================================================================

create extension if not exists pgcrypto;

-- ---------- species reference table ----------
create table if not exists public.species (
  id              text primary key,             -- slug, e.g. 'blacktip-reef'
  common_name     text not null,
  scientific_name text not null,
  family          text,
  iucn_status     text check (iucn_status in ('CR','EN','VU','NT','LC','DD','NE')),
  max_length_cm   int,
  id_features     text,
  notes           text
);

-- ---------- reviewers ----------
create table if not exists public.reviewers (
  user_id uuid primary key references auth.users on delete cascade,
  name    text,
  added_at timestamptz not null default now()
);

create or replace function public.is_reviewer() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.reviewers where user_id = auth.uid());
$$;
grant execute on function public.is_reviewer() to anon, authenticated;

-- ---------- submissions ----------
create table if not exists public.submissions (
  id                   uuid primary key default gen_random_uuid(),
  created_at           timestamptz not null default now(),
  photo_path           text not null,
  capture_method       text not null check (capture_method in ('in_app_camera','file')),

  -- WHEN (from the shutter or the photo's EXIF; never typed in)
  taken_at             timestamptz not null,
  local_offset_min     int check (local_offset_min between -840 and 840),
  time_source          text not null check (time_source in ('live_capture','exif')),
  tz_source            text not null check (tz_source in ('device','exif_offset','gps_utc')),

  -- WHERE
  lat                  double precision not null check (lat between -90 and 90),
  lon                  double precision not null check (lon between -180 and 180),
  location_accuracy_m  real,
  location_source      text not null check (location_source in ('live_gps','exif','live_gps_at_upload')),

  exif                 jsonb,
  device_info          text,

  -- AI suggestion (non-generative kNN on image embeddings)
  ai_model             text,
  ai_suggestions       jsonb,

  -- submitter's own input
  submitter_species_id text references public.species(id),
  site_name            text check (char_length(site_name) <= 120),
  length_cm            int check (length_cm between 1 and 2000),
  price                numeric check (price >= 0),
  notes                text check (char_length(notes) <= 2000),
  shark_count          int not null default 1 check (shark_count between 1 and 500),

  -- human review
  status               text not null default 'pending' check (status in ('pending','approved','rejected','reference')),
  confirmed_species_id text references public.species(id),
  review_notes         text,
  reviewed_by          uuid references auth.users,
  reviewed_at          timestamptz,

  -- embedding added at approval → becomes part of the reference library
  embedding            real[],
  embedding_model      text,

  constraint approved_needs_species check (status not in ('approved','reference') or confirmed_species_id is not null)
);
create index if not exists submissions_status_idx  on public.submissions (status, created_at);
create index if not exists submissions_species_idx on public.submissions (confirmed_species_id, taken_at);

-- Guards: sanitize public inserts, make capture data immutable, stamp reviews.
create or replace function public.submissions_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    if new.taken_at > now() + interval '10 minutes' then
      raise exception 'taken_at is in the future';
    end if;
    if new.taken_at < timestamptz '2000-01-01' then
      raise exception 'taken_at is implausibly old';
    end if;
    if not public.is_reviewer() then
      new.status := 'pending';
      new.confirmed_species_id := null;
      new.review_notes := null;
      new.reviewed_by := null;
      new.reviewed_at := null;
      new.embedding := null;
      new.embedding_model := null;
    end if;
  elsif tg_op = 'UPDATE' then
    if (new.taken_at, new.local_offset_min, new.time_source, new.tz_source, new.lat, new.lon,
        new.location_source, new.photo_path, new.capture_method, new.created_at)
       is distinct from
       (old.taken_at, old.local_offset_min, old.time_source, old.tz_source, old.lat, old.lon,
        old.location_source, old.photo_path, old.capture_method, old.created_at) then
      raise exception 'capture time/location cannot be edited';
    end if;
    if new.status is distinct from old.status
       or new.confirmed_species_id is distinct from old.confirmed_species_id then
      new.reviewed_by := auth.uid();
      new.reviewed_at := now();
    end if;
  end if;
  return new;
end $$;

drop trigger if exists submissions_guard on public.submissions;
create trigger submissions_guard before insert or update on public.submissions
  for each row execute function public.submissions_guard();

-- ---------- reference images (seed photos for the identifier) ----------
create table if not exists public.reference_images (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  species_id      text not null references public.species(id),
  photo_path      text not null,
  credit          text,
  embedding       real[] not null,
  embedding_model text not null,
  added_by        uuid references auth.users default auth.uid()
);

-- ---------- Data API grants ----------
-- Since 2026, new Supabase projects don't expose tables to the API automatically.
-- These grants say WHICH operations each role may attempt; the RLS policies
-- below then decide WHICH ROWS. Both are needed.
grant usage on schema public to anon, authenticated;
grant select                         on public.species          to anon, authenticated;
grant insert, update, delete         on public.species          to authenticated;
grant select                         on public.reviewers        to authenticated;
grant insert                         on public.submissions      to anon, authenticated;
grant select, update, delete         on public.submissions      to authenticated;
grant select, insert, update, delete on public.reference_images to authenticated;

-- ---------- row level security ----------
alter table public.species          enable row level security;
alter table public.reviewers        enable row level security;
alter table public.submissions      enable row level security;
alter table public.reference_images enable row level security;

drop policy if exists "species readable"      on public.species;
drop policy if exists "reviewers edit species" on public.species;
create policy "species readable"       on public.species for select to anon, authenticated using (true);
create policy "reviewers edit species" on public.species for all to authenticated using (public.is_reviewer()) with check (public.is_reviewer());

drop policy if exists "reviewers see reviewers" on public.reviewers;
create policy "reviewers see reviewers" on public.reviewers for select to authenticated using (public.is_reviewer());

drop policy if exists "anyone can submit"     on public.submissions;
drop policy if exists "reviewers read all"    on public.submissions;
drop policy if exists "reviewers update"      on public.submissions;
drop policy if exists "reviewers delete"      on public.submissions;
create policy "anyone can submit"  on public.submissions for insert to anon, authenticated with check (true); -- trigger sanitizes
create policy "reviewers read all" on public.submissions for select to authenticated using (public.is_reviewer());
create policy "reviewers update"   on public.submissions for update to authenticated using (public.is_reviewer()) with check (public.is_reviewer());
create policy "reviewers delete"   on public.submissions for delete to authenticated using (public.is_reviewer());

drop policy if exists "reviewers manage references" on public.reference_images;
create policy "reviewers manage references" on public.reference_images for all to authenticated
  using (public.is_reviewer()) with check (public.is_reviewer());

-- ---------- public views (expose approved data only; no device info / raw EXIF) ----------
create or replace view public.public_records as
  select s.id, s.taken_at, s.local_offset_min, s.time_source, s.tz_source,
         s.lat, s.lon, s.location_accuracy_m, s.location_source, s.capture_method,
         s.site_name, s.length_cm, s.price, s.notes, s.photo_path, s.ai_suggestions, s.ai_model,
         s.reviewed_at,
         sp.id as species_id, sp.common_name, sp.scientific_name, sp.family,
         sp.iucn_status, sp.max_length_cm, sp.id_features,
         s.shark_count
  from public.submissions s
  join public.species sp on sp.id = s.confirmed_species_id
  where s.status = 'approved';

create or replace view public.reference_library as
  select confirmed_species_id as species_id, embedding, embedding_model
    from public.submissions where status in ('approved','reference') and embedding is not null
  union all
  select species_id, embedding, embedding_model from public.reference_images;

grant select on public.public_records, public.reference_library to anon, authenticated;

-- ---------- storage bucket ----------
insert into storage.buckets (id, name, public) values ('shark-photos', 'shark-photos', true)
  on conflict (id) do nothing;

drop policy if exists "public uploads submissions" on storage.objects;
drop policy if exists "reviewers manage photos"    on storage.objects;
create policy "public uploads submissions" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'shark-photos' and (storage.foldername(name))[1] = 'submissions');
create policy "reviewers manage photos" on storage.objects for all to authenticated
  using (bucket_id = 'shark-photos' and public.is_reviewer())
  with check (bucket_id = 'shark-photos' and public.is_reviewer());

-- ---------- seed species (verify IUCN categories before launch) ----------
insert into public.species (id, common_name, scientific_name, family, iucn_status, max_length_cm, id_features) values
 ('tiger','Tiger shark','Galeocerdo cuvier','Galeocerdonidae','NT',550,'Very blunt, square snout; dark vertical bars on the back (fade in large adults); cockscomb-shaped serrated teeth; long pointed upper tail lobe.'),
 ('bull','Bull shark','Carcharhinus leucas','Carcharhinidae','VU',340,'Heavy, stout body; short, broad, rounded snout; large triangular first dorsal; no ridge between the dorsal fins; small eyes.'),
 ('blacktip-reef','Blacktip reef shark','Carcharhinus melanopterus','Carcharhinidae','VU',200,'Bold black tip on the first dorsal, set off by a pale band below it; black tips on all other fins; short rounded snout.'),
 ('whitetip-reef','Whitetip reef shark','Triaenodon obesus','Carcharhinidae','VU',210,'Slender body; bright white tips on the first dorsal and upper tail lobe; very short blunt snout with tube-like nasal flaps.'),
 ('grey-reef','Grey reef shark','Carcharhinus amblyrhynchos','Carcharhinidae','EN',255,'Broad black trailing edge along the whole tail fin; first dorsal plain grey or with a narrow pale tip; no interdorsal ridge.'),
 ('silvertip','Silvertip shark','Carcharhinus albimarginatus','Carcharhinidae','VU',300,'Conspicuous white tips and trailing edges on all fins; interdorsal ridge present.'),
 ('silky','Silky shark','Carcharhinus falciformis','Carcharhinidae','VU',350,'Small first dorsal set behind the pectoral fins; very long free rear tip on the second dorsal; interdorsal ridge; smooth, silky skin.'),
 ('oceanic-whitetip','Oceanic whitetip shark','Carcharhinus longimanus','Carcharhinidae','CR',350,'Huge rounded first dorsal and very long paddle-like pectorals, both with mottled white tips; blunt rounded snout.'),
 ('spinner','Spinner shark','Carcharhinus brevipinna','Carcharhinidae','VU',300,'Long, pointed snout; small eyes; first dorsal set slightly behind the pectorals; black tips on most fins in adults.'),
 ('spottail','Spot-tail shark','Carcharhinus sorrah','Carcharhinidae','NT',160,'Black tips on the second dorsal, pectorals and lower tail lobe; first dorsal mostly plain; interdorsal ridge.'),
 ('sandbar','Sandbar shark','Carcharhinus plumbeus','Carcharhinidae','EN',250,'Very tall first dorsal set far forward, over the pectoral bases; interdorsal ridge; plain brownish-grey fins.'),
 ('milk','Milk shark','Rhizoprionodon acutus','Carcharhinidae','VU',175,'Small, slender shark; long pointed snout; large eyes; long furrows at the mouth corners; second dorsal starts behind the anal fin.'),
 ('sicklefin-lemon','Sicklefin lemon shark','Negaprion acutidens','Carcharhinidae','EN',310,'Two dorsal fins of almost equal size, both strongly sickle-shaped; yellowish-brown body; short broad snout.'),
 ('blue','Blue shark','Prionace glauca','Carcharhinidae','NT',380,'Slim body; long, narrow pointed snout; very long pectoral fins; vivid indigo-blue back (fades after death).'),
 ('scalloped-hammerhead','Scalloped hammerhead','Sphyrna lewini','Sphyrnidae','CR',430,'Hammer-shaped head with a central notch and a scalloped (wavy) front edge; first dorsal moderately tall.'),
 ('great-hammerhead','Great hammerhead','Sphyrna mokarran','Sphyrnidae','CR',610,'Hammer with an almost straight front edge and a central notch; extremely tall, sickle-shaped first dorsal.'),
 ('shortfin-mako','Shortfin mako','Isurus oxyrinchus','Lamnidae','EN',400,'Conical pointed snout; crescent-shaped tail with a strong keel at its base; long smooth-edged teeth visible; white underside of the snout.'),
 ('pelagic-thresher','Pelagic thresher','Alopias pelagicus','Alopiidae','EN',380,'Upper tail lobe about as long as the rest of the body; small mouth and moderately large eyes.'),
 ('tawny-nurse','Tawny nurse shark','Nebrius ferrugineus','Ginglymostomatidae','VU',320,'Two rounded dorsal fins of similar size set far back; short barbels by the nostrils; small mouth; plain sandy-brown colour.'),
 ('zebra','Zebra (leopard) shark','Stegostoma tigrinum','Stegostomatidae','EN',250,'Very long tail about half the body length; ridges along the body; dark spots on a pale background (stripes in juveniles).'),
 ('blacktip','Blacktip shark','Carcharhinus limbatus','Carcharhinidae','VU',275,'Black tips on most fins (anal fin usually plain; fade in adults); moderately long pointed snout; pale band along the flank; no interdorsal ridge. Compare spinner shark.'),
 ('dusky','Dusky shark','Carcharhinus obscurus','Carcharhinidae','EN',420,'Large, slender; short broadly rounded snout; fairly low, slightly hooked first dorsal set over the pectoral rear tips; low interdorsal ridge; fins plain or dusky-tipped.'),
 ('bignose','Bignose shark','Carcharhinus altimus','Carcharhinidae','NT',300,'Long, broad rounded snout with prominent nasal flaps; tall first dorsal set over the pectoral bases; interdorsal ridge; plain grey fins with dusky tips. Deep-water; compare sandbar.'),
 ('pigeye','Pigeye (Java) shark','Carcharhinus amboinensis','Carcharhinidae','VU',280,'Very like the bull shark: heavy body, very short blunt snout, tiny eyes, no interdorsal ridge; first dorsal about three times the height of the second.'),
 ('humani-whaler','Human''s whaler shark','Carcharhinus cf. humani','Carcharhinidae','DD',90,'Small whaler shark (under about 1 m). Provisional ID (cf.) on Seatizens — confirm with an expert before approving records as this species.'),
 ('snaggletooth','Snaggletooth shark','Hemipristis elongata','Hemigaleidae','VU',240,'Long snout; hooked, serrated upper teeth and long lower teeth that stick out of the mouth even when closed; second dorsal about two-thirds the size of the first.'),
 ('sliteye','Sliteye shark','Loxodon macrorhinus','Carcharhinidae','NT',100,'Small, very slim shark; long narrow snout; large slit-like eyes with a notch at the rear; small second dorsal set behind the start of the anal fin.'),
 ('whale','Whale shark','Rhincodon typus','Rhincodontidae','EN',1800,'Enormous; very wide flat head with a terminal mouth; checkerboard of white spots and stripes on a dark back; ridges along the flanks.'),
 ('smooth-hammerhead','Smooth hammerhead','Sphyrna zygaena','Sphyrnidae','VU',500,'Hammer with a smoothly curved front edge and NO central notch; first dorsal moderately tall.'),
 ('roughskin-spurdog','Roughskin spurdog','Cirrhigaleus asper','Squalidae','DD',120,'Stout dogfish; a large spine in front of each dorsal fin; no anal fin; white margins on the fins; very rough skin; broadly rounded snout. Deep water.'),
 ('unidentified','Shark — not identified','Selachimorpha','','NE',null,'Use when a reviewer cannot confirm the species from the photo. The record still counts towards totals.')
on conflict (id) do update set
  common_name = excluded.common_name, scientific_name = excluded.scientific_name, family = excluded.family,
  iucn_status = excluded.iucn_status, max_length_cm = excluded.max_length_cm, id_features = excluded.id_features;

-- ---------- make yourself a reviewer ----------
-- 1. Authentication → Users → "Add user" (email + password)
-- 2. insert into public.reviewers (user_id, name) values ('<that user''s uuid>', 'Joe');

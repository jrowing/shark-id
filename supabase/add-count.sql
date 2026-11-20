-- Adds "number of sharks in the photo". Run once in Supabase → SQL Editor.
alter table public.submissions
  add column if not exists shark_count int not null default 1 check (shark_count between 1 and 500);

-- Re-create the public view with the new column added at the end.
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
grant select on public.public_records to anon, authenticated;

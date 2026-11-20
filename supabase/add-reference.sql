-- Adds the 'reference' status: photos used to train the identifier but hidden from Records.
-- Run once in Supabase → SQL Editor.
alter table public.submissions drop constraint if exists submissions_status_check;
alter table public.submissions add constraint submissions_status_check
  check (status in ('pending','approved','rejected','reference'));

alter table public.submissions drop constraint if exists approved_needs_species;
alter table public.submissions add constraint approved_needs_species
  check (status not in ('approved','reference') or confirmed_species_id is not null);

-- public_records already shows only status = 'approved', so reference photos stay hidden.
create or replace view public.reference_library as
  select confirmed_species_id as species_id, embedding, embedding_model
    from public.submissions where status in ('approved','reference') and embedding is not null
  union all
  select species_id, embedding, embedding_model from public.reference_images;
grant select on public.reference_library to anon, authenticated;

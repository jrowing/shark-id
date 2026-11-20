-- Lets reviewers delete submissions (run once in Supabase → SQL Editor).
-- Photos are removed by the existing "reviewers manage photos" storage policy.
grant delete on public.submissions to authenticated;
drop policy if exists "reviewers delete" on public.submissions;
create policy "reviewers delete" on public.submissions for delete to authenticated using (public.is_reviewer());

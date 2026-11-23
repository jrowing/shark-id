# Scaling update (November 2026): setup

This update prepares The Sharkive for thousands of contributors and a few dozen reviewers.

| Area | What changed |
|---|---|
| **Abuse protection** | Each phone gets an invisible anonymous account the first time it uploads, after an optional Cloudflare Turnstile check. Uploads must go in that phone's own folder. Limits per phone: 20 records an hour, 60 a day and 50 photo files an hour. The bucket accepts only JPEGs of 3 MB or less. |
| **Photos** | Photos are resized on the phone to 1600 px (about 0.2–0.6 MB) with the capture time and GPS written back into the EXIF, plus a 400 px thumbnail. Lists and the map use thumbnails. |
| **Matching** | Fingerprints are stored with pgvector and an HNSW index. The phone asks the server for the nearest matches (`match_species`) instead of downloading the whole library. Offline, it falls back to one cached average fingerprint per species. |
| **Records** | The Records page loads 48 records at a time with **Load more**. Headline numbers come from the database (`records_summary`) and map points come in one compact call (`record_points`). The CSV is fetched 1000 rows at a time, so nothing is cut off at 1000. |
| **Moderation** | <ul><li>Photos go to a **private** bucket (`shark-pending`). Reviewers see them through signed links that work for an hour. A photo moves to the public bucket only when its record is approved, and moves back if the record is un-approved.</li><li>Before upload, the phone runs two checks. An explicit-image check (NSFW.js, ~2.6 MB, hosted in `models/nsfw`) refuses clearly explicit photos and flags borderline ones. A "does this look like a shark or fish?" check asks the contributor to confirm before sending, and flags the record.</li><li>Reviewers see flagged and unchecked photos blurred until they tap to show them, with the reason shown.</li><li>Admins can **Block this phone** from any record it sent. That stops its uploads and deletes everything it sent that isn't approved. You can unblock phones on the People tab.</li></ul> |
| **Reviewers** | <ul><li>Each reviewer claims a batch of 5 records for 15 minutes, so no one else can decide those records in that time. **Skip** hands a record back.</li><li>There are three roles: *reviewer*, *expert* and *admin*. Critically endangered and provisional species need an expert, and there is a **Needs expert** queue.</li><li>Every decision is logged in `review_events`.</li><li>New reviewers create an account and request access, and an admin approves them on the **People** tab.</li></ul> |

## 1. Supabase dashboard (before running the SQL)

1. **Turn on anonymous sign-ins:** Authentication → Sign In / Providers → **Allow anonymous sign-ins**.
2. **Turn on the CAPTCHA (recommended):**
   1. Cloudflare dashboard → Turnstile → **Add widget**. Add `jrowing.com` and `localhost` as hostnames and choose the *Managed* mode.
   2. Copy the **secret key** into Supabase → Authentication → Attack Protection → **Enable CAPTCHA protection** → provider Turnstile.
   3. Put the **site key** in `js/config.js` → `TURNSTILE_SITE_KEY`.

   The CAPTCHA protects reviewer sign-in and sign-up too. The app handles that.
3. **Set the confirmation-email links:** Authentication → URL Configuration → Site URL `https://www.jrowing.com/shark-id/`, so the links in confirmation emails come back to the app.
4. **Email (when you have more than a handful of reviewers):** Supabase's built-in email sender only sends a few emails an hour. Add custom SMTP (Authentication → Emails → SMTP settings) before inviting many reviewers.
5. **Rate limits:** Authentication → Rate Limits → *anonymous sign-ins* defaults to 30 an hour per IP address. If a whole school or market shares one connection, raise it.
6. **Plan:** move to **Pro** before a public launch. Free projects pause after a week with no activity, and Free has 1 GB of photo storage and 5 GB of downloads a month.

## 2. Run the SQL

Supabase → SQL Editor → paste and run **`supabase/scale-2026-11.sql`**. It's safe to run again.

- Existing reviewers become **admins**.
- Existing fingerprints move into the new vector columns.
- **It creates the private `shark-pending` bucket.** Photos already in the public bucket stay there and keep working. From now on, contributors can only upload to the private bucket.
- **Critically endangered species and Human's whaler shark are marked expert-only.** To change that:
  `update species set expert_only = true where id = 'sandbar';`
- **The limits live in the `settings` table.** For example:
  `update settings set value = 100 where key = 'max_submissions_per_day';`

If pgvector was already enabled in a schema other than `extensions`, the script stops with a "type extensions.vector does not exist" error. Move it with `alter extension vector set schema extensions;` and run the script again.

## 3. Deploy the app

Push the repo straight after running the SQL. The SQL stops older copies of the app from uploading, because their uploads have no sign-in. Anything they queued stays on the phone and uploads once the phone loads the new version, which it does automatically on its next visit.

## Reviewer workflow

- **Pending:** you're given 5 records at a time. Decide each one, or press **Skip** to hand it back. When the batch is done, the next batch loads.
- **Needs expert:** write the question in *Review notes* and press **Needs expert**. The record moves to the expert queue, which only experts and admins can see.
- **People (admins):** approve access requests, change roles, deactivate or remove reviewers, and see how many decisions each person has made in the last 30 days and in total.
- **History:** open *History* on any decided record to see who decided what, and when.

## Moderation notes

- **The phone checks can be skipped** by someone calling the API directly. What actually stops inappropriate photos from being seen is that pending photos are private and nothing is public until a person approves it. The checks stop casual misuse and wrong-photo mistakes, and they tell reviewers which photos to open with care.
- **The thresholds** are in `RULES` in `js/screen.js`. By default it blocks at 85% explicit, flags at 30% explicit or 60% suggestive, and flags "not a shark" when under 10% of the photo looks like a fish *and* it's unlike every confirmed shark photo.
- **A blocked person can get a new anonymous ID** by clearing the app's data. The CAPTCHA and rate limits slow that down. If it becomes a pattern, the next step is server-side moderation, for example a Supabase Edge Function calling a moderation API on each upload.

## Notes

- Photos uploaded before this update stay where they are and have no thumbnail. The app uses the full photo for those.
- Anonymous contributor accounts build up in Authentication → Users. They're harmless, and you can delete old ones in bulk if the list gets long.

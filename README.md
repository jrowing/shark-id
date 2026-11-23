# The Sharkive: market shark survey

A phone web app (PWA) for logging dead sharks at fish markets and roadside stalls.

1. **Photo**: taken with the in-app camera, or an original photo from the camera roll.
2. **When and where come from the photo, never from the user.** Capture time comes from the shutter press or from the photo's EXIF data. Location comes from GPS at the shutter or from the photo's EXIF GPS. Photos without a trustworthy capture time are **refused**. Once saved, time and location can't be edited, even by reviewers (a database trigger enforces this).
3. **Species suggestion (non-generative)**: MobileNet V2 turns the photo into an image fingerprint (embedding) on the phone. The server finds the nearest reviewer-confirmed photos (pgvector). Offline, the phone compares the fingerprint with a cached average for each species.
4. **Human review**: every submission waits in a queue until a reviewer approves it (with the confirmed species) or rejects it. Each approved photo is added to the reference library, so suggestions get better over time.
5. **Records**: approved records (paged, 48 at a time) show the species (scientific name, family, IUCN status, ID features), when (local time with UTC offset, plus where that came from), where (coordinates, accuracy, site name, map), and length/price/notes. A CSV export is included.


**Setting up or upgrading a live project:** run `supabase/schema.sql`, then follow [SCALING.md](SCALING.md) (anonymous sign-ins, Turnstile, `supabase/scale-2026-11.sql`).

## How the capture-data rules work

| Photo source | Time | Time zone | Location | Refused if |
|---|---|---|---|---|
| In-app camera | Shutter press (device clock) | Device | GPS fix within 2 min of the shutter, ±150 m (up to ±1000 m with a warning after 30 s) | No GPS fix |
| Existing photo | EXIF `DateTimeOriginal` (or `CreateDate`). Never `ModifyDate` or file dates | EXIF offset → else derived from the EXIF GPS UTC clock → else device (with a warning) | EXIF GPS → else live GPS **only if the photo is under 30 min old** (flagged) | No EXIF capture time; time in the future or before 2000; no location and photo older than 30 min |

The in-app camera also writes EXIF (`DateTimeOriginal`, GPS position and GPS UTC time) into the JPEG, so the stored file carries its own data. Each record stores *where* its time and location came from (`time_source`, `tz_source`, `location_source`) so analysis can filter by data quality. The review card flags anomalies: uploads long after capture, submitter vs AI disagreement, and assumed time zones.

All limits are in `RULES` in `js/config.js`.

**Phone gotchas worth telling users:**
- **WhatsApp/Messenger/Facebook strip EXIF.** Photos forwarded through them will be refused.
- **iPhone:** the camera app only records GPS if *Settings → Privacy → Location Services → Camera* is on. Safari may also strip location from photos picked from the library. The in-app camera avoids both problems, so encourage it.
- The in-app camera trusts the phone clock. If a phone's clock is badly wrong, the review card makes it visible by comparing capture time with upload time.

## Files

```
index.html  records.html  review.html   pages
js/capture.js     log flow (camera / file → metadata → AI → submit)
js/metadata.js    EXIF reading, time-zone resolution, validation rules, EXIF writing
js/camera.js      in-app camera + GPS watch
js/classifier.js  MobileNet embeddings + ranking of nearest neighbours
js/image.js       resize to 1600 px + 400 px thumbnail, re-stamp EXIF
js/captcha.js     Cloudflare Turnstile check before a phone's first upload
js/screen.js      on-phone screening: explicit-image check (models/nsfw) + "is it a fish?" check
js/store.js       data layer (Supabase or IndexedDB demo)
js/queue.js       offline upload queue
js/review.js      claimed review batches, expert queue, history, people, reference library
js/records.js     public records, detail page, CSV
sw.js             offline caching
supabase/schema.sql          base schema
supabase/scale-2026-11.sql   sign-in, limits, pgvector, reviewer roles (run after schema.sql)
```

## Security model

- Contributors sign in anonymously (after a Turnstile check) the first time they upload. They can **insert** submissions and upload JPEGs (3 MB at most) only to `submissions/<their id>/`, within per-phone rate limits (`settings` table). They can't read pending records or set review fields. The trigger forces `status = 'pending'` and clears the review and embedding fields.
- The public can read only `public_records` (approved rows, without device info or raw EXIF), plus the `records_summary`, `record_points`, `match_species` and `species_centroids` functions. Raw fingerprints aren't readable.
- Only active users in `reviewers` can read the queue. A reviewer claims records before deciding them, and someone else's claim blocks a decision for 15 minutes. Expert-only species and escalated records need the `expert` or `admin` role. Every decision is logged in `review_events`.
- Photos are uploaded to the private `shark-pending` bucket. Reviewers see them through one-hour signed links, and a photo moves to the public `shark-photos` bucket only when its record is approved (the database refuses an approval whose photo isn't public, and vice versa).
- Before upload, the phone screens each photo (`js/screen.js`): clearly explicit photos are refused, and borderline or "not a shark" photos are flagged and blurred for reviewers. Admins can block a phone, which stops its uploads and deletes its unapproved records.
- Photos at markets often show vendors' faces. Consider a note on the log page asking users to frame just the shark, and blur faces before any public display.

## Next steps

- **Fine-tuned model**: once there are a few hundred approved records, export images and labels and fine-tune EfficientNet/MobileNet in Python, convert it to TF.js, then change `MODEL_ID` and `embed()` in `classifier.js` (or swap kNN for the model's softmax output). Old embeddings are tagged with their model, so nothing gets mixed up.
- **Rays**: wedgefish and guitarfish (often Critically Endangered) are often sold alongside sharks. Add them to `species`.
- **Seychelles Creole names**: add a `local_name` column to `species` and show it on the log page.
- **Verify the IUCN categories and maximum lengths** in the seed data against the current Red List before launch.

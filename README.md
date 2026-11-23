# The Sharkive: shark and ray survey

A phone web app (PWA) for logging sharks and rays: dead ones at fish markets and roadside stalls, and live ones seen in the water or the shallows.

**Market visits.** At a market or roadside seller, the contributor starts a *visit* (phone clock + live GPS), logs every shark or ray they photograph, then finishes it. A visit with no sightings is a **zero record**. One tap ("Nothing here today") records a visit and finishes it straight away. Visits are what make "how often do sharks turn up for sale" answerable. Live sightings (in the water, in the shallows) have no visits: they're opportunistic photo records.

1. **Photo**: taken with the in-app camera, or an original photo from the camera roll.
2. **When and where come from the photo, never from the user.** Capture time comes from the shutter press or from the photo's EXIF data. Location comes from GPS at the shutter or from the photo's EXIF GPS. Photos without a trustworthy capture time are **refused**. Once saved, time and location can't be edited, even by reviewers (a database trigger enforces this).
3. **Species suggestion (non-generative)**: MobileNet V2 turns the photo into an image fingerprint (embedding) on the phone. The server finds the nearest reviewer-confirmed photos (pgvector). Offline, the phone compares the fingerprint with a cached average for each species.
4. **Human review**: every submission waits in a queue until a reviewer approves it (with the confirmed species) or rejects it. Each approved photo is added to the reference library, so suggestions get better over time.
5. **Records**: approved records (paged, 48 at a time) show the species (scientific name, family, IUCN status, ID features), when (local time with UTC offset, plus where that came from), where (coordinates, accuracy, site name, map), and length/price/notes. A CSV export is included.

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
js/records.js     public records, detail page, CSV, Darwin Core, market-visit effort table
js/visits.js      market visits and zero records (start, finish, auto-close after 6 h idle)
js/measure.js     size from a photo: reference of known length + two points on the animal
js/photoid.js     photo-ID screen for reviewers (crop, match, link / new individual)
js/photoid-core.js ORB features + RANSAC matching (OpenCV.js, loaded on demand, ~10 MB)
js/dwc.js         Darwin Core Archive builder (occurrence core + meta.xml + eml.xml)
js/individuals.js public catalogue of recognised individuals
individuals.html  scale-card.html (printable 20 cm card, A4 landscape)
sw.js             offline caching
supabase/schema.sql          base schema
supabase/add-*.sql           shark count, delete/purge, reference-only, extra species
supabase/scale-2026-11.sql   sign-in, limits, pgvector, reviewer roles, private bucket
supabase/population-2026-11.sql  rays, market visits, sighting fields, photo-ID, research grade (run last)
```

## Security model

- Contributors sign in anonymously (after a Turnstile check) the first time they upload. They can **insert** submissions and upload JPEGs (3 MB at most) only to `submissions/<their id>/`, within per-phone rate limits (`settings` table). They can't read pending records or set review fields. The trigger forces `status = 'pending'` and clears the review and embedding fields.
- The public can read only `public_records` (approved rows, without device info or raw EXIF), plus the `records_summary`, `record_points`, `match_species` and `species_centroids` functions. Raw fingerprints aren't readable.
- Only active users in `reviewers` can read the queue. A reviewer claims records before deciding them, and someone else's claim blocks a decision for 15 minutes. Expert-only species and escalated records need the `expert` or `admin` role. Every decision is logged in `review_events`.
- Photos are uploaded to the private `shark-pending` bucket. Reviewers see them through one-hour signed links, and a photo moves to the public `shark-photos` bucket only when its record is approved (the database refuses an approval whose photo isn't public, and vice versa).
- Before upload, the phone screens each photo (`js/screen.js`): clearly explicit photos are refused, and borderline or "not a shark" photos are flagged and blurred for reviewers. Admins can block a phone, which stops its uploads and deletes its unapproved records.
- Photos at markets often show vendors' faces. Consider a note on the log page asking users to frame just the shark, and blur faces before any public display.

## Population data update (November 2026)

Run `supabase/population-2026-11.sql` in the SQL Editor after `scale-2026-11.sql`, then deploy the app. It's safe to re-run.

| Feature | What it does |
|---|---|
| **Rays** | 14 ray species plus "Ray — not identified". `species.grp` is `shark` or `ray`; `size_measure` is `TL` (total length) or `DW` (disc width). Critically endangered rays are expert-only. |
| **Market visits** | `visits` table (market / roadside only). Contributors insert; only reviewers read raw rows. `public_visits` adds duration and the number of *approved* sightings, so a visit whose only photo was rejected counts as a zero visit. Rate limits: `max_visits_per_hour`, `max_visits_per_day` in `settings`. |
| **Sightings** | `submissions.context` (`market`, `in_water`, `shallows`), `visit_id` (market only, enforced), `sex` (submitter) and `confirmed_sex` (reviewer), `life_stage`, `depth_m`, `habitat`, and `measurement` / `measured_length_cm` / `measured_by` from the photo measuring tool. |
| **Size from photos** | Points are stored as fractions of the photo, so they survive resizing. Print the card from `scale-card.html` at 100% and check the bar is 20 cm. Fill in `species.maturity_cm` (size at maturity) from the literature to show "below/above maturity" on records. |
| **Photo-ID** | `individuals` (public) and `photoid_features` (reviewers only). Reviewers crop the markings, the browser computes ORB features and compares them with every catalogued photo of that species and side (RANSAC inliers). They then link or create an individual (`ZEB-0001`, …). Only species with `photo_id_suitable` show the button. The score bands (`STRONG = 25`, `POSSIBLE = 12` inliers in `photoid-core.js`) were tuned on synthetic tests: **check them against real photos**, and always confirm a match by eye. |
| **Research grade** | `quality_grade()`: *research* = approved, and the ID was confirmed by an expert/admin or agreed by a second reviewer, nobody has disagreed since, the species is identified, and time/place came from trusted sources. Otherwise *verified*. The **Second opinion** review tab serves records that need one. Disagreeing sends the record back to the expert queue. |
| **Darwin Core** | Records → *Darwin Core* downloads a DwC-A zip (occurrence core) for GBIF/OBIS. Zero visits become `absent` occurrences of Elasmobranchii. Dataset title, contact and **licence** are in `DATASET` in `js/config.js`: choose the licence before publishing. |

## Next steps

- **Fine-tuned model**: once there are a few hundred approved records, export images and labels and fine-tune EfficientNet/MobileNet in Python, convert it to TF.js, then change `MODEL_ID` and `embed()` in `classifier.js` (or swap kNN for the model's softmax output). Old embeddings are tagged with their model, so nothing gets mixed up.
- **Calibrate photo-ID** on real photos of known repeat animals (adjust `STRONG`/`POSSIBLE`), and add `maturity_cm` values per species.
- **Seychelles Creole names**: add a `local_name` column to `species` and show it on the log page.
- **Verify the IUCN categories and maximum lengths** in the seed data (sharks and rays) against the current Red List before launch.

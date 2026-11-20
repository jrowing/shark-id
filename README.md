# The Sharkive: market shark survey

A phone web app (PWA) for logging dead sharks at fish markets and roadside stalls.

1. **Photo**: taken with the in-app camera, or an original photo from the camera roll.
2. **When and where come from the photo, never from the user.** Capture time comes from the shutter press or from the photo's EXIF data. Location comes from GPS at the shutter or from the photo's EXIF GPS. Photos without a trustworthy capture time are **refused**. Once saved, time and location can't be edited, even by reviewers (a database trigger enforces this).
3. **Species suggestion (non-generative)**: MobileNet V2 turns the photo into an image fingerprint (embedding), which is compared by k-nearest-neighbours with reviewer-confirmed photos. This runs on the phone and works offline once the model has been cached.
4. **Human review**: every submission waits in a queue until a reviewer approves it (with the confirmed species) or rejects it. Each approved photo is added to the reference library, so suggestions get better over time.
5. **Records**: approved records show the species (scientific name, family, IUCN status, ID features), when (local time with UTC offset, plus where that came from), where (coordinates, accuracy, site name, map), and length/price/notes. A CSV export is included.


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
js/classifier.js  MobileNet embeddings + kNN ranking
js/store.js       data layer (Supabase or IndexedDB demo)
js/queue.js       offline upload queue
js/review.js      reviewer queue + reference library
js/records.js     public records, detail page, CSV
sw.js             offline caching
supabase/schema.sql
```

## Security model

- The public (`anon` key) can **insert** submissions and upload photos to `submissions/`, but can't read pending records or set review fields. The trigger forces `status = 'pending'` and clears review and embedding fields.
- The public can read only `public_records` (approved rows, without device info or raw EXIF) and `reference_library` (embeddings only).
- Only users listed in `reviewers` can read the queue, approve or reject, and manage reference photos.
- The photo bucket is public-read with random UUID file names. If pending photos need to stay private, switch to a private bucket with signed URLs.
- Photos at markets often show vendors' faces. Consider a note on the log page asking users to frame just the shark, and blur faces before any public display.

## Next steps

- **Fine-tuned model**: once there are a few hundred approved records, export images and labels and fine-tune EfficientNet/MobileNet in Python, convert it to TF.js, then change `MODEL_ID` and `embed()` in `classifier.js` (or swap kNN for the model's softmax output). Old embeddings are tagged with their model, so nothing gets mixed up.
- **Rays**: wedgefish and guitarfish (often Critically Endangered) are often sold alongside sharks. Add them to `species`.
- **Seychelles Creole names**: add a `local_name` column to `species` and show it on the log page.
- **Verify the IUCN categories and maximum lengths** in the seed data against the current Red List before launch.

// ---------------------------------------------------------------------------
// Shark ID — configuration
// Leave SUPABASE_URL blank to run in DEMO MODE (everything stored in this
// browser only, review page open without login). Fill both values in to go live.
// ---------------------------------------------------------------------------
export const SUPABASE_URL = 'https://necwzuqhwmmupuxlywar.supabase.co';        // e.g. 'https://abcd1234.supabase.co'
export const SUPABASE_ANON_KEY = 'sb_publishable_2i5IcVe-OUUsFIGS1z1Hng_A8-D4dms';   // the public "anon" key (safe to publish)
export const PHOTO_BUCKET = 'shark-photos';

// Rules for the capture data. Submissions that break a rule are blocked.
export const RULES = {
  maxGpsAccuracyM: 150,          // in-app camera: wanted accuracy of the GPS fix
  maxGpsAccuracyFallbackM: 1000, // accepted after waiting, with a warning
  maxGpsFixGapMs: 120000,        // fix must be within 2 min of the shutter
  gpsWaitAfterShutterMs: 30000,  // how long to wait for a fix after the shutter
  maxFallbackPhotoAgeMin: 30,    // gallery photo with no GPS: live GPS only allowed if photo is this fresh
  maxFutureSkewMin: 10,          // reject photos timestamped in the future
  earliestYear: 2000,
};

// Species-suggestion model (non-generative: image embeddings + nearest neighbours)
export const AI = {
  k: 7,                // neighbours consulted
  temperature: 0.05,   // softmax sharpness over cosine similarity
  // Optional: self-host MobileNet V2 (model.json + shards) and put its URL here
  // if the default TF Hub/Kaggle download is blocked or slow.
  modelUrl: '',
};

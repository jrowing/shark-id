// Data layer. Same interface for Supabase (live) and IndexedDB (demo mode).
import { SUPABASE_URL, SUPABASE_ANON_KEY, PHOTO_BUCKET, PENDING_BUCKET } from './config.js?v=16';
import { SPECIES } from './species-data.js?v=16';
import { captchaToken } from './captcha.js?v=16';
import { prepareUpload, resizePhoto } from './image.js?v=16';
import * as idb from './idb.js?v=16';

export const isDemo = !SUPABASE_URL;
export const PAGE_SIZE = 48;

let sbPromise;
function sb() {
  return (sbPromise ??= import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm')
    .then(({ createClient }) => createClient(SUPABASE_URL, SUPABASE_ANON_KEY)));
}
function check({ data, error }) { if (error) throw error; return data; }

const objectUrls = new Map();
function blobUrl(id, blob) {
  if (!blob) return '';
  if (!objectUrls.has(id)) objectUrls.set(id, URL.createObjectURL(blob));
  return objectUrls.get(id);
}
let bucketBase = '';
async function publicUrl(path) {
  if (!path) return '';
  if (!bucketBase) {
    const client = await sb();
    bucketBase = client.storage.from(PHOTO_BUCKET).getPublicUrl('x').data.publicUrl.slice(0, -1);
  }
  return bucketBase + path.split('/').map(encodeURIComponent).join('/');
}
async function withUrls(r) {
  const [photo_url, thumb_url] = await Promise.all([publicUrl(r.photo_path), publicUrl(r.thumb_path)]);
  return { ...r, photo_url, thumb_url: thumb_url || photo_url };
}
// Reviewer rows: approved photos are public; everything else is in the private
// bucket and gets a signed link that works for an hour.
const SIGNED_FOR_S = 3600;
async function withReviewUrls(rows) {
  const priv = rows.filter(r => r.photo_public === false);
  const paths = priv.flatMap(r => [r.photo_path, r.thumb_path]).filter(Boolean);
  const signed = {};
  if (paths.length) {
    const client = await sb();
    const data = check(await client.storage.from(PENDING_BUCKET).createSignedUrls(paths, SIGNED_FOR_S));
    for (const d of data) if (d.signedUrl) signed[d.path] = d.signedUrl;
  }
  return Promise.all(rows.map(async r => {
    if (r.photo_public !== false) return withUrls(r);
    const photo_url = signed[r.photo_path] || '';
    return { ...r, photo_url, thumb_url: signed[r.thumb_path] || photo_url };
  }));
}

// Move a record's photo (and thumbnail) between the private and public buckets.
// Safe to repeat: a file that has already moved is skipped.
async function movePhotos(r, toPublic) {
  const client = await sb();
  const [from, to] = toPublic ? [PENDING_BUCKET, PHOTO_BUCKET] : [PHOTO_BUCKET, PENDING_BUCKET];
  for (const path of [r.photo_path, r.thumb_path].filter(Boolean)) {
    const mv = await client.storage.from(from).move(path, path, { destinationBucket: to });
    if (!mv.error) continue;
    if (/not.?found/i.test(mv.error.message || '')) continue;               // already moved
    // Fallback for older storage servers: copy by download + upload, then delete.
    const dl = await client.storage.from(from).download(path);
    if (dl.error) throw new Error(`Could not move photo ${path}: ${mv.error.message}`);
    const up = await client.storage.from(to).upload(path, dl.data, { contentType: 'image/jpeg', upsert: true });
    if (up.error) throw up.error;
    await client.storage.from(from).remove([path]);
  }
}

// Every column a reviewer needs, without the 1280-number fingerprint.
const REVIEW_COLS = 'id,created_at,photo_path,thumb_path,capture_method,taken_at,local_offset_min,time_source,tz_source,' +
  'lat,lon,location_accuracy_m,location_source,exif,device_info,ai_model,ai_suggestions,submitter_species_id,site_name,' +
  'length_cm,price,notes,shark_count,status,confirmed_species_id,review_notes,reviewed_by,reviewed_at,embedding_model,' +
  'submitted_by,claimed_by,claimed_at,needs_expert,escalation_note,screening,photo_public,' +
  'context,visit_id,sex,confirmed_sex,life_stage,depth_m,habitat,measurement,measured_length_cm,measured_by,individual_id';

// ---------------- species ----------------
export async function listSpecies() {
  if (isDemo) return SPECIES;
  try {
    const client = await sb();
    const data = check(await client.from('species').select('*').order('common_name'));
    idb.put('cache', { id: 'species', data }).catch(() => {});
    return data;
  } catch (e) {
    const cached = await idb.get('cache', 'species').catch(() => null);
    return cached?.data ?? SPECIES;
  }
}
export async function speciesMap() {
  return Object.fromEntries((await listSpecies()).map(s => [s.id, s]));
}

// ---------------- contributors ----------------
// Each phone gets a free, invisible anonymous account the first time it uploads
// (after a CAPTCHA, if configured). Rate limits and upload folders hang off it.
let signingIn = null;
async function ensureSignedIn() {
  const client = await sb();
  const { data: { session } } = await client.auth.getSession();
  if (session) return session;
  return (signingIn ??= (async () => {
    const token = await captchaToken();
    const { data, error } = await client.auth.signInAnonymously(token ? { options: { captchaToken: token } } : undefined);
    if (error) {
      if (/anonymous sign-ins are disabled/i.test(error.message)) throw new Error('Uploads are switched off on the server (anonymous sign-ins disabled). Please tell the Sharkive team.');
      throw error;
    }
    return data.session;
  })().finally(() => { signingIn = null; }));
}

// ---------------- submissions ----------------
// record: capture + user fields (see schema). id is the client-generated uuid.
// blob/thumb: prepared JPEGs (see image.js). Items queued by older versions of
// the app have no thumb; they are resized here.
export async function submit(record, blob, thumb) {
  if (!thumb) ({ full: blob, thumb } = await prepareUpload(record, blob));
  if (isDemo) {
    await idb.put('demo_submissions', {
      ...record, photo: blob, thumb, photo_path: `demo/${record.id}`,
      created_at: new Date().toISOString(), status: 'pending', needs_expert: false,
    });
    return;
  }
  const session = await ensureSignedIn();
  const client = await sb();
  const dir = `submissions/${session.user.id}`;
  const path = `${dir}/${record.id}.jpg`, thumbPath = `${dir}/${record.id}_t.jpg`;
  const opts = { contentType: 'image/jpeg', upsert: false, cacheControl: '31536000' };
  for (const [p, b] of [[path, blob], [thumbPath, thumb]]) {
    const up = await client.storage.from(PENDING_BUCKET).upload(p, b, opts);   // private until approved
    if (up.error && !/exists|duplicate/i.test(up.error.message || '')) throw up.error; // retry after partial success is fine
  }
  const ins = await client.from('submissions').insert({ ...record, photo_path: path, thumb_path: thumbPath });
  if (ins.error && ins.error.code !== '23505') throw ins.error; // 23505 = already inserted on an earlier attempt
}

// Demo-mode stand-in for the database's quality_grade(): the demo reviewer is an admin.
function demoGrade(r) {
  if (r.status !== 'approved') return null;
  if (['unidentified', 'unidentified-ray'].includes(r.confirmed_species_id)) return 'verified';
  if (r.location_source === 'live_gps_at_upload' || (r.time_source === 'exif' && r.tz_source === 'device')) return 'verified';
  return 'research';
}
function joinSpecies(row, map, individuals = {}) {
  const sp = map[row.confirmed_species_id] || {};
  return {
    ...row, species_id: row.confirmed_species_id,
    common_name: sp.common_name, scientific_name: sp.scientific_name, family: sp.family,
    iucn_status: sp.iucn_status, max_length_cm: sp.max_length_cm, id_features: sp.id_features,
    grp: sp.grp || 'shark', size_measure: sp.size_measure || 'TL', maturity_cm: sp.maturity_cm ?? null,
    context: row.context || 'market', sex: row.confirmed_sex ?? row.sex ?? null, sex_confirmed: row.confirmed_sex != null,
    individual_code: individuals[row.individual_id]?.code ?? null, quality_grade: demoGrade(row),
  };
}
// Optional record filters: { context: 'market' | 'live', research: true }
function applyFilters(q, f = {}) {
  if (f.context === 'market') q = q.eq('context', 'market');
  else if (f.context === 'live') q = q.neq('context', 'market');
  if (f.research) q = q.eq('quality_grade', 'research');
  return q;
}
const demoFilter = (f = {}) => r =>
  (!f.context || (f.context === 'market' ? r.context === 'market' : r.context !== 'market')) && (!f.research || r.quality_grade === 'research');
async function demoApproved(speciesId) {
  const map = await speciesMap();
  const inds = Object.fromEntries((await idb.all('demo_individuals')).map(i => [i.id, i]));
  return (await idb.all('demo_submissions'))
    .filter(r => r.status === 'approved' && (!speciesId || r.confirmed_species_id === speciesId))
    .map(r => ({ ...joinSpecies(r, map, inds), photo_url: blobUrl(r.id, r.photo), thumb_url: blobUrl(r.id + '_t', r.thumb || r.photo) }))
    .sort((a, b) => b.taken_at.localeCompare(a.taken_at));
}

// One page of public records, newest first. Returns { rows, more }.
export async function listPublicRecords({ speciesId = '', offset = 0, limit = PAGE_SIZE, filters = {} } = {}) {
  if (isDemo) {
    const all = (await demoApproved(speciesId)).filter(demoFilter(filters));
    return { rows: all.slice(offset, offset + limit), more: all.length > offset + limit };
  }
  const client = await sb();
  let q = applyFilters(client.from('public_records').select('*').order('taken_at', { ascending: false }).order('id').range(offset, offset + limit), filters);
  if (speciesId) q = q.eq('species_id', speciesId);
  const rows = check(await q);
  const more = rows.length > limit;
  return { rows: await Promise.all(rows.slice(0, limit).map(withUrls)), more };
}

// Every public record (for CSV), fetched 1000 at a time.
export async function allPublicRecords(speciesId = '', onProgress = () => {}, filters = {}) {
  if (isDemo) return (await demoApproved(speciesId)).filter(demoFilter(filters));
  const client = await sb();
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = applyFilters(client.from('public_records').select('*').order('taken_at', { ascending: false }).order('id').range(from, from + 999), filters);
    if (speciesId) q = q.eq('species_id', speciesId);
    const rows = check(await q);
    out.push(...await Promise.all(rows.map(withUrls)));
    onProgress(out.length);
    if (rows.length < 1000) return out;
  }
}

// Headline numbers for the Records page.
export async function recordsSummary() {
  if (isDemo) {
    const all = await demoApproved();
    const visits = await demoVisits();
    const by = {};
    for (const r of all) (by[r.species_id] ??= { species_id: r.species_id, common_name: r.common_name, grp: r.grp, n: 0 }).n++;
    const animals = grp => all.filter(r => r.grp === grp).reduce((s, r) => s + (r.shark_count ?? 1), 0);
    return {
      records: all.length, sharks: animals('shark'), rays: animals('ray'),
      species: Object.keys(by).filter(id => !id.startsWith('unidentified')).length,
      research: all.filter(r => r.quality_grade === 'research').length,
      visits: visits.length, zero_visits: visits.filter(v => !v.approved_sightings).length,
      individuals: (await idb.all('demo_individuals')).length,
      threatened: all.filter(r => ['CR', 'EN', 'VU'].includes(r.iucn_status)).length,
      sites: new Set(all.map(r => r.site_name).filter(Boolean)).size,
      by_species: Object.values(by).sort((a, b) => String(b.grp).localeCompare(String(a.grp)) || String(a.common_name).localeCompare(b.common_name)),
    };
  }
  const client = await sb();
  return check(await client.rpc('records_summary'));
}

// Map points: [{ id, lat, lon, species_id, shark_count, taken_at }]
export async function recordPoints(speciesId = '') {
  if (isDemo) return demoApproved(speciesId);
  const client = await sb();
  const rows = check(await client.rpc('record_points', { p_species: speciesId || null }));
  return rows.map(([id, lat, lon, species_id, shark_count, taken_at]) => ({ id, lat, lon, species_id, shark_count, taken_at }));
}

export async function getPublicRecord(id) {
  if (isDemo) {
    const r = await idb.get('demo_submissions', id);
    if (!r || r.status !== 'approved') return null;
    const inds = Object.fromEntries((await idb.all('demo_individuals')).map(i => [i.id, i]));
    return { ...joinSpecies(r, await speciesMap(), inds), photo_url: blobUrl(r.id, r.photo) };
  }
  const client = await sb();
  const rows = check(await client.from('public_records').select('*').eq('id', id).limit(1));
  return rows[0] ? withUrls(rows[0]) : null;
}

// ---------------- reviewer: queues ----------------
const demoRow = r => ({ ...r, photo_url: blobUrl(r.id, r.photo), thumb_url: blobUrl(r.id + '_t', r.thumb || r.photo) });

// Claim up to n pending records for this reviewer (queue: 'pending' | 'expert').
// Nobody else can decide them for the next 15 minutes.
export async function claimBatch(queue = 'pending', n = 5) {
  if (isDemo) {
    return (await idb.all('demo_submissions'))
      .filter(r => r.status === 'pending' && !!r.needs_expert === (queue === 'expert'))
      .sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, n).map(demoRow);
  }
  const client = await sb();
  const rows = check(await client.rpc('claim_batch', { p_queue: queue, p_n: n }));
  rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return withReviewUrls(rows.map(({ embedding_v, embedding, ...r }) => r));
}
export async function releaseClaim(id) {
  if (isDemo) return;
  const client = await sb();
  check(await client.rpc('release_claim', { p_id: id }));
}
export async function queueCounts() {
  if (isDemo) {
    const p = (await idb.all('demo_submissions')).filter(r => r.status === 'pending');
    return { pending: p.filter(r => !r.needs_expert).length, expert: p.filter(r => r.needs_expert).length, second: 0 };
  }
  const client = await sb();
  return check(await client.rpc('queue_counts')) || { pending: 0, expert: 0 };
}

// Decided records (approved / reference / rejected), most recently reviewed first.
export async function listForReview(status, { offset = 0, limit = 30 } = {}) {
  if (isDemo) {
    const all = (await idb.all('demo_submissions')).filter(r => r.status === status)
      .sort((a, b) => String(b.reviewed_at).localeCompare(String(a.reviewed_at)));
    return { rows: all.slice(offset, offset + limit).map(demoRow), more: all.length > offset + limit };
  }
  const client = await sb();
  const rows = check(await client.from('submissions').select(REVIEW_COLS).eq('status', status)
    .order('reviewed_at', { ascending: false, nullsFirst: false }).order('id').range(offset, offset + limit));
  return { rows: await withReviewUrls(rows.slice(0, limit)), more: rows.length > limit };
}

export async function reviewHistory(id) {
  if (isDemo) return [];
  const client = await sb();
  return check(await client.from('review_events').select('at,actor,action,old_status,new_status,old_species,new_species,note')
    .eq('submission_id', id).order('at'));
}

// r: the record as loaded. patch: { status, confirmed_species_id, review_notes, embedding,
// embedding_model, needs_expert, escalation_note }. A photo is public exactly when its
// record is approved, so a status change moves the files first (and back if saving fails).
export async function reviewSubmission(r, patch) {
  if (isDemo) {
    const cur = await idb.get('demo_submissions', r.id);
    await idb.put('demo_submissions', { ...cur, ...patch, reviewed_at: new Date().toISOString() });
    return;
  }
  const client = await sb();
  const status = patch.status ?? r.status;
  const wantPublic = status === 'approved';
  const moving = patch.status !== undefined && wantPublic !== (r.photo_public !== false);
  if (moving) { await movePhotos(r, wantPublic); patch = { ...patch, photo_public: wantPublic }; }
  try {
    const res = await client.from('submissions').update(patch).eq('id', r.id).select('id');
    check(res);
    if (!res.data?.length) throw new Error('Not saved: this record was changed or removed by someone else. Reload the queue.');
  } catch (e) {
    if (moving) await movePhotos(r, !wantPublic).catch(err => console.warn('Could not move photo back', err));
    throw e;
  }
}

// Permanently removes a submission and its photos (reviewers only).
export async function deleteSubmission(r) {
  if (isDemo) { await idb.del('demo_submissions', r.id); return; }
  const client = await sb();
  const del = await client.from('submissions').delete().eq('id', r.id).select('id');
  if (del.error) throw del.error;
  if (!del.data?.length) throw new Error('Not deleted: Supabase is missing the reviewer delete permission. Run supabase/add-delete.sql in the SQL Editor.');
  const paths = [r.photo_path, r.thumb_path].filter(Boolean);
  if (paths.length) {
    const rm = await client.storage.from(r.photo_public === false ? PENDING_BUCKET : PHOTO_BUCKET).remove(paths);
    if (rm.error) console.warn('Record deleted but photo not removed', rm.error);
  }
}

// Permanently removes ALL rejected submissions and their photos. Returns the number removed.
export async function purgeRejected() {
  if (isDemo) {
    const rows = (await idb.all('demo_submissions')).filter(r => r.status === 'rejected');
    for (const r of rows) await idb.del('demo_submissions', r.id);
    return rows.length;
  }
  const client = await sb();
  const del = await client.from('submissions').delete().eq('status', 'rejected').select('id, photo_path, thumb_path, photo_public');
  if (del.error) throw del.error;
  await removeFiles(del.data.flatMap(r => [r.photo_path, r.thumb_path].filter(Boolean)
    .map(path => ({ bucket: r.photo_public === false ? PENDING_BUCKET : PHOTO_BUCKET, path }))));
  return del.data.length;
}

async function removeFiles(files) {
  const client = await sb();
  const byBucket = {};
  for (const f of files) (byBucket[f.bucket] ??= []).push(f.path);
  for (const [bucket, paths] of Object.entries(byBucket)) {
    for (let i = 0; i < paths.length; i += 100) {
      const rm = await client.storage.from(bucket).remove(paths.slice(i, i + 100));
      if (rm.error) console.warn('Some photos not removed', rm.error);
    }
  }
}

// ---------------- reference library / matching ----------------
export async function addReference({ species_id, blob, credit, embedding, embedding_model }) {
  const id = crypto.randomUUID();
  const { full } = await resizePhoto(blob);
  if (isDemo) {
    await idb.put('demo_references', { id, species_id, credit, embedding, embedding_model, photo: full, created_at: new Date().toISOString() });
    return;
  }
  const client = await sb();
  const path = `references/${id}.jpg`;
  check(await client.storage.from(PHOTO_BUCKET).upload(path, full, { contentType: 'image/jpeg' }));
  check(await client.from('reference_images').insert({ id, species_id, credit, embedding, embedding_model, photo_path: path }));
}

async function demoLibrary() {
  const subs = (await idb.all('demo_submissions')).filter(r => (r.status === 'approved' || r.status === 'reference') && r.embedding)
    .map(r => ({ species_id: r.confirmed_species_id, embedding: r.embedding, embedding_model: r.embedding_model }));
  const refs = (await idb.all('demo_references')).map(r => ({ species_id: r.species_id, embedding: r.embedding, embedding_model: r.embedding_model }));
  return [...subs, ...refs];
}

// Nearest confirmed photos, found by the server.
// Returns { neighbours: [{species_id, sim}], library_size, species_in_library }.
export async function matchSpecies(embedding, model, k) {
  if (isDemo) {
    const lib = (await demoLibrary()).filter(r => r.embedding_model === model);
    const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
    return {
      neighbours: lib.map(r => ({ species_id: r.species_id, sim: dot(embedding, r.embedding) })).sort((a, b) => b.sim - a.sim).slice(0, k),
      library_size: lib.length, species_in_library: new Set(lib.map(r => r.species_id)).size,
    };
  }
  const client = await sb();
  return check(await client.rpc('match_species', { p_embedding: embedding, p_model: model, p_k: k }));
}

// One average fingerprint per species, cached on the phone for offline suggestions.
// [{ species_id, n, embedding }]
export async function speciesCentroids(model, { maxAgeMs = 24 * 3600e3 } = {}) {
  const key = `centroids:${model}`;
  const cached = await idb.get('cache', key).catch(() => null);
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.data;
  try {
    let data;
    if (isDemo) {
      const by = {};
      for (const r of (await demoLibrary()).filter(r => r.embedding_model === model)) {
        const c = (by[r.species_id] ??= { species_id: r.species_id, n: 0, embedding: new Array(r.embedding.length).fill(0) });
        c.n++; r.embedding.forEach((v, i) => { c.embedding[i] += v; });
      }
      data = Object.values(by).map(c => ({ ...c, embedding: c.embedding.map(v => v / c.n) }));
    } else {
      const client = await sb();
      data = check(await client.rpc('species_centroids', { p_model: model }));
    }
    idb.put('cache', { id: key, at: Date.now(), data }).catch(() => {});
    return data;
  } catch (e) {
    return cached?.data ?? [];
  }
}

// { species_id: count } for the reviewer "Library coverage" table.
export async function libraryCounts(model) {
  if (isDemo) {
    const out = {};
    for (const r of await demoLibrary()) if (r.embedding_model === model) out[r.species_id] = (out[r.species_id] || 0) + 1;
    return out;
  }
  const client = await sb();
  return Object.fromEntries(check(await client.rpc('library_counts', { p_model: model })).map(r => [r.species_id, r.n]));
}

// ---------------- auth / reviewers ----------------
// The signed-in reviewer account, or null. A contributor's anonymous session doesn't count.
export async function getSession() {
  if (isDemo) return { user: { id: 'demo', email: 'demo mode' } };
  const client = await sb();
  const session = (await client.auth.getSession()).data.session;
  return session && !session.user.is_anonymous ? session : null;
}
export async function signIn(email, password) {
  const client = await sb();
  const token = await captchaToken();
  check(await client.auth.signInWithPassword({ email, password, options: token ? { captchaToken: token } : undefined }));
}
// Returns true if signed in straight away, false if an email confirmation is needed first.
export async function signUp(email, password) {
  const client = await sb();
  const token = await captchaToken();
  const data = check(await client.auth.signUp({ email, password, options: { emailRedirectTo: location.href.split('?')[0], ...(token ? { captchaToken: token } : {}) } }));
  return !!data.session;
}
export async function signOut() {
  if (isDemo) return;
  const client = await sb();
  await client.auth.signOut();
}
// This account's reviewer row ({ role, active, requested_at, … }) or null.
export async function myReviewer() {
  if (isDemo) return { role: 'admin', active: true, owner: true, name: 'Demo' };
  const client = await sb();
  const session = await getSession();
  if (!session) return null;
  const rows = check(await client.from('reviewers').select('*').eq('user_id', session.user.id).limit(1));
  return rows[0] || null;
}
export async function isReviewer() {
  return !!(await myReviewer())?.active;
}
export async function requestAccess(name, note) {
  const client = await sb();
  const session = await getSession();
  check(await client.from('reviewers').insert({ user_id: session.user.id, name, request_note: note || null }));
}
// Admin: every reviewer and applicant with their activity.
export async function reviewerStats() {
  if (isDemo) return [];
  const client = await sb();
  return check(await client.rpc('reviewer_stats'));
}
// Owner: add someone who already has an account, by email, straight in with a role.
export async function addReviewer(email, role, name) {
  const client = await sb();
  return check(await client.rpc('add_reviewer', { p_email: email, p_role: role, p_name: name || null }));
}
export async function updateReviewer(user_id, patch) {
  const client = await sb();
  check(await client.from('reviewers').update(patch).eq('user_id', user_id));
}
export async function removeReviewer(user_id) {
  const client = await sb();
  check(await client.from('reviewers').delete().eq('user_id', user_id));
}

// user_id → display name, for history lines (reviewers only).
export async function reviewerNames() {
  if (isDemo) return {};
  const client = await sb();
  const rows = check(await client.from('reviewers').select('user_id,name,email'));
  return Object.fromEntries(rows.map(r => [r.user_id, r.name || r.email || 'reviewer']));
}

// ---------------- blocking (admins) ----------------
// Blocks the phone that sent a record and deletes everything it sent that isn't
// approved. Returns the number of records deleted.
export async function blockContributor(userId, reason) {
  if (isDemo) {
    const rows = (await idb.all('demo_submissions')).filter(r => r.submitted_by === userId && r.status !== 'approved');
    for (const r of rows) await idb.del('demo_submissions', r.id);
    return rows.length;
  }
  const client = await sb();
  const res = check(await client.rpc('block_contributor', { p_user: userId, p_reason: reason || null }));
  await removeFiles(res.files || []);
  return res.deleted;
}
export async function blockedList() {
  if (isDemo) return [];
  const client = await sb();
  return check(await client.rpc('blocked_list'));
}
export async function unblockContributor(userId) {
  const client = await sb();
  check(await client.from('blocked_contributors').delete().eq('user_id', userId));
}

// ---------------- visits (survey effort, zero records) ----------------
export async function submitVisit(v) {
  if (isDemo) { await idb.put('demo_visits', { ...v, created_at: new Date().toISOString(), status: 'ok' }); return; }
  await ensureSignedIn();
  const client = await sb();
  const ins = await client.from('visits').insert(v);
  if (ins.error && ins.error.code !== '23505') throw ins.error;   // 23505 = already uploaded
}
async function demoVisits() {
  const subs = (await idb.all('demo_submissions')).filter(r => r.status === 'approved' && r.visit_id);
  return (await idb.all('demo_visits')).filter(v => v.status !== 'hidden').map(v => {
    const mine = subs.filter(r => r.visit_id === v.id);
    return { ...v, duration_min: Math.round((Date.parse(v.ended_at) - Date.parse(v.started_at)) / 60000),
      approved_sightings: mine.length, animals: mine.reduce((n, r) => n + (r.shark_count ?? 1), 0) };
  }).sort((a, b) => b.started_at.localeCompare(a.started_at));
}
// Every public visit (for the effort table and Darwin Core absences), 1000 at a time.
export async function allPublicVisits(onProgress = () => {}) {
  if (isDemo) return demoVisits();
  const client = await sb();
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = check(await client.from('public_visits').select('*').order('started_at', { ascending: false }).order('id').range(from, from + 999));
    out.push(...rows);
    onProgress(out.length);
    if (rows.length < 1000) return out;
  }
}

// ---------------- photo-ID: individuals ----------------
export async function listIndividuals() {
  if (isDemo) {
    const recs = await demoApproved();
    return (await idb.all('demo_individuals')).map(i => {
      const mine = recs.filter(r => r.individual_id === i.id).sort((a, b) => b.taken_at.localeCompare(a.taken_at));
      return { ...i, common_name: mine[0]?.common_name, sightings: mine.length, first_seen: mine.at(-1)?.taken_at, last_seen: mine[0]?.taken_at,
        thumb_url: mine[0]?.thumb_url || '' };
    }).sort((a, b) => a.code.localeCompare(b.code));
  }
  const client = await sb();
  const rows = check(await client.from('public_individuals').select('*').order('code').limit(2000));
  return Promise.all(rows.map(withUrls));
}
export async function individualRecords(individualId) {
  if (isDemo) return (await demoApproved()).filter(r => r.individual_id === individualId);
  const client = await sb();
  const rows = check(await client.from('public_records').select('*').eq('individual_id', individualId).order('taken_at', { ascending: false }).limit(500));
  return Promise.all(rows.map(withUrls));
}
// Reviewer: features already catalogued for a species (and side). Each row comes
// with a small photo of the catalogued animal.
export async function photoidFeatures(speciesId, side, model) {
  if (isDemo) {
    const inds = Object.fromEntries((await idb.all('demo_individuals')).map(i => [i.id, i]));
    const subs = Object.fromEntries((await idb.all('demo_submissions')).map(r => [r.id, r]));
    return (await idb.all('demo_features')).filter(f => f.species_id === speciesId && f.side === side && f.model === model)
      .map(f => ({ ...f, code: inds[f.individual_id]?.code, thumb_url: subs[f.submission_id] ? blobUrl(f.submission_id + '_t', subs[f.submission_id].thumb || subs[f.submission_id].photo) : '' }));
  }
  const client = await sb();
  const rows = check(await client.from('photoid_features')
    .select('id,individual_id,submission_id,species_id,side,crop,model,n_keypoints,keypoints,descriptors,individuals(code)')
    .eq('species_id', speciesId).eq('side', side).eq('model', model).limit(5000));
  const ids = [...new Set(rows.map(r => r.submission_id).filter(Boolean))];
  const photos = {};
  for (let i = 0; i < ids.length; i += 200) {
    const subs = check(await client.from('submissions').select('id,photo_path,thumb_path,photo_public').in('id', ids.slice(i, i + 200)));
    for (const r of await withReviewUrls(subs)) photos[r.id] = r.thumb_url;
  }
  return rows.map(({ individuals, ...f }) => ({ ...f, code: individuals?.code, thumb_url: photos[f.submission_id] || '' }));
}
export async function nextIndividualCode(speciesId) {
  if (isDemo) {
    const pre = speciesId.replace(/[^a-z]/g, '').slice(0, 3).toUpperCase();
    const n = (await idb.all('demo_individuals')).filter(i => i.code.startsWith(pre + '-')).length + 1;
    return `${pre}-${String(n).padStart(4, '0')}`;
  }
  const client = await sb();
  return check(await client.rpc('next_individual_code', { p_species: speciesId }));
}
export async function createIndividual({ species_id, nickname = null, sex = null }) {
  const code = await nextIndividualCode(species_id);
  const row = { id: crypto.randomUUID(), code, species_id, nickname, sex };
  if (isDemo) { await idb.put('demo_individuals', { ...row, created_at: new Date().toISOString() }); return row; }
  const client = await sb();
  check(await client.from('individuals').insert(row));
  return row;
}
// Saves the features of a photo region and links the record to the individual.
export async function catalogueSighting(r, { individual_id, species_id, side, crop, model, keypoints, descriptors }) {
  const f = { id: crypto.randomUUID(), individual_id, submission_id: r.id, species_id, side, crop, model, n_keypoints: keypoints.length, keypoints, descriptors };
  if (isDemo) {
    await idb.put('demo_features', f);
    const cur = await idb.get('demo_submissions', r.id);
    await idb.put('demo_submissions', { ...cur, individual_id });
    return;
  }
  const client = await sb();
  check(await client.from('photoid_features').insert(f));
  check(await client.from('submissions').update({ individual_id }).eq('id', r.id));
}

// ---------------- second opinions (research grade) ----------------
export async function secondOpinionBatch(n = 5) {
  if (isDemo) return [];
  const client = await sb();
  const rows = check(await client.rpc('second_opinion_batch', { p_n: n }));
  return withReviewUrls(rows.map(({ embedding_v, embedding, ...r }) => r));
}
export async function addConfirmation(submissionId, speciesId, note = null) {
  if (isDemo) { await idb.put('demo_confirmations', { id: submissionId, species_id: speciesId, note, at: new Date().toISOString() }); return; }
  const client = await sb();
  check(await client.from('id_confirmations').upsert({ submission_id: submissionId, species_id: speciesId, agrees: true, note }, { onConflict: 'submission_id,reviewer' }));
}
export async function confirmationsFor(submissionId) {
  if (isDemo) return [];
  const client = await sb();
  return check(await client.from('id_confirmations').select('reviewer,species_id,agrees,note,at').eq('submission_id', submissionId).order('at'));
}

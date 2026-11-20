// Data layer. Same interface for Supabase (live) and IndexedDB (demo mode).
import { SUPABASE_URL, SUPABASE_ANON_KEY, PHOTO_BUCKET } from './config.js';
import { SPECIES } from './species-data.js';
import * as idb from './idb.js';

export const isDemo = !SUPABASE_URL;

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
async function publicUrl(path) {
  const client = await sb();
  return client.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl;
}
const extFor = (blob) => (blob.type === 'image/png' ? 'png' : blob.type === 'image/heic' ? 'heic' : 'jpg');

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

// ---------------- submissions ----------------
// record: capture + user fields (see schema). id is the client-generated uuid.
export async function submit(record, blob) {
  if (isDemo) {
    await idb.put('demo_submissions', {
      ...record, photo: blob, photo_path: `demo/${record.id}`,
      created_at: new Date().toISOString(), status: 'pending',
    });
    return;
  }
  const client = await sb();
  const path = `submissions/${record.id}.${extFor(blob)}`;
  const up = await client.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: false });
  if (up.error && !/exists|duplicate/i.test(up.error.message || '')) throw up.error; // retry after partial success is fine
  const ins = await client.from('submissions').insert({ ...record, photo_path: path });
  if (ins.error && ins.error.code !== '23505') throw ins.error; // 23505 = already inserted on an earlier attempt
}

function joinSpecies(row, map) {
  const sp = map[row.confirmed_species_id] || {};
  return {
    ...row, species_id: row.confirmed_species_id,
    common_name: sp.common_name, scientific_name: sp.scientific_name, family: sp.family,
    iucn_status: sp.iucn_status, max_length_cm: sp.max_length_cm, id_features: sp.id_features,
  };
}

export async function listPublicRecords() {
  if (isDemo) {
    const map = await speciesMap();
    return (await idb.all('demo_submissions'))
      .filter(r => r.status === 'approved')
      .map(r => ({ ...joinSpecies(r, map), photo_url: blobUrl(r.id, r.photo) }))
      .sort((a, b) => b.taken_at.localeCompare(a.taken_at));
  }
  const client = await sb();
  const rows = check(await client.from('public_records').select('*').order('taken_at', { ascending: false }));
  return Promise.all(rows.map(async r => ({ ...r, photo_url: await publicUrl(r.photo_path) })));
}

export async function getPublicRecord(id) {
  if (isDemo) {
    const r = await idb.get('demo_submissions', id);
    if (!r || r.status !== 'approved') return null;
    return { ...joinSpecies(r, await speciesMap()), photo_url: blobUrl(r.id, r.photo) };
  }
  const client = await sb();
  const rows = check(await client.from('public_records').select('*').eq('id', id).limit(1));
  return rows[0] ? { ...rows[0], photo_url: await publicUrl(rows[0].photo_path) } : null;
}

// ---------------- reviewer ----------------
export async function listForReview(status = 'pending') {
  if (isDemo) {
    return (await idb.all('demo_submissions'))
      .filter(r => r.status === status)
      .map(r => ({ ...r, photo_url: blobUrl(r.id, r.photo) }))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  const client = await sb();
  const rows = check(await client.from('submissions').select('*').eq('status', status).order('created_at').limit(200));
  return Promise.all(rows.map(async r => ({ ...r, photo_url: await publicUrl(r.photo_path) })));
}

// patch: { status, confirmed_species_id, review_notes, embedding, embedding_model }
export async function reviewSubmission(id, patch) {
  if (isDemo) {
    const r = await idb.get('demo_submissions', id);
    await idb.put('demo_submissions', { ...r, ...patch, reviewed_at: new Date().toISOString() });
    return;
  }
  const client = await sb();
  check(await client.from('submissions').update(patch).eq('id', id));
}

// Permanently removes a submission and its photo (reviewers only).
export async function deleteSubmission(r) {
  if (isDemo) { await idb.del('demo_submissions', r.id); return; }
  const client = await sb();
  const del = await client.from('submissions').delete().eq('id', r.id).select('id');
  if (del.error) throw del.error;
  if (!del.data?.length) throw new Error('Not deleted: Supabase is missing the reviewer delete permission. Run supabase/add-delete.sql in the SQL Editor.');
  if (r.photo_path) {
    const rm = await client.storage.from(PHOTO_BUCKET).remove([r.photo_path]);
    if (rm.error) console.warn('Record deleted but photo not removed', rm.error);
  }
}

export async function addReference({ species_id, blob, credit, embedding, embedding_model }) {
  const id = crypto.randomUUID();
  if (isDemo) {
    await idb.put('demo_references', { id, species_id, credit, embedding, embedding_model, photo: blob, created_at: new Date().toISOString() });
    return;
  }
  const client = await sb();
  const path = `references/${id}.${extFor(blob)}`;
  check(await client.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: blob.type || 'image/jpeg' }));
  check(await client.from('reference_images').insert({ id, species_id, credit, embedding, embedding_model, photo_path: path }));
}

// [{ species_id, embedding, embedding_model }] — approved records + reference photos
export async function getReferenceLibrary() {
  if (isDemo) {
    const subs = (await idb.all('demo_submissions')).filter(r => r.status === 'approved' && r.embedding)
      .map(r => ({ species_id: r.confirmed_species_id, embedding: r.embedding, embedding_model: r.embedding_model }));
    const refs = (await idb.all('demo_references')).map(r => ({ species_id: r.species_id, embedding: r.embedding, embedding_model: r.embedding_model }));
    return [...subs, ...refs];
  }
  try {
    const client = await sb();
    const data = check(await client.from('reference_library').select('species_id, embedding, embedding_model').limit(10000));
    idb.put('cache', { id: 'library', data }).catch(() => {});
    return data;
  } catch (e) {
    const cached = await idb.get('cache', 'library').catch(() => null);
    return cached?.data ?? [];
  }
}

// ---------------- auth ----------------
export async function getSession() {
  if (isDemo) return { user: { id: 'demo', email: 'demo mode' } };
  const client = await sb();
  return (await client.auth.getSession()).data.session;
}
export async function signIn(email, password) {
  const client = await sb();
  check(await client.auth.signInWithPassword({ email, password }));
}
export async function signOut() {
  if (isDemo) return;
  const client = await sb();
  await client.auth.signOut();
}
export async function isReviewer() {
  if (isDemo) return true;
  const client = await sb();
  return !!check(await client.rpc('is_reviewer'));
}

// Market visits: the survey effort behind market sightings.
// A visit is one check of a market or roadside seller for sharks and rays. Its
// start time and place come
// from the phone (clock + live GPS), never typed in. Sightings logged during it
// carry its id. A visit with no sightings is a ZERO RECORD: it says "we looked
// here and saw none", which is what lets the data show how often sharks turn up.
import { currentPosition } from './metadata.js';
import { enqueueVisit } from './queue.js';

// Visits are only for markets and roadside sellers. Live animals (in the water,
// in the shallows) are logged as photo records with no visit.
export const KINDS = {
  market:   { label: 'Market or fish stall', icon: '🐟' },
  roadside: { label: 'Roadside seller',      icon: '🛻' },
};

export const HABITATS = {
  reef: 'Coral reef', sand: 'Sand', seagrass: 'Seagrass', mangrove: 'Mangrove', lagoon: 'Lagoon',
  beach: 'Beach / surf zone', open_water: 'Open water', other: 'Other',
};

const KEY = 'sharkive_visit';          // the open visit (one at a time)
const RECENT = 'sharkive_recent_visits'; // finished visits kept for 48 h (photos logged a little later)
const AUTO_CLOSE_MS = 6 * 3600e3;      // no activity for 6 h: close it automatically
const RECENT_MS = 48 * 3600e3;
export const PHOTO_WINDOW_MS = 15 * 60e3; // photo may be this far outside the visit and still count towards it

const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));

export function current() {
  const v = read(KEY, null);
  if (v && Date.now() - (v.last_activity || Date.parse(v.started_at)) > AUTO_CLOSE_MS) {
    // Left open by mistake: close it at the last thing that happened.
    finishVisit({ auto: true }).catch(e => console.warn('Could not auto-close visit', e));
    return null;
  }
  return v;
}

export function recent() {
  const list = read(RECENT, []).filter(v => Date.now() - Date.parse(v.ended_at) < RECENT_MS);
  write(RECENT, list);
  return list;
}

// Starts a visit here and now. Needs a live GPS fix.
export async function startVisit({ kind, site_name = null }) {
  if (!KINDS[kind]) throw new Error('Unknown visit type');
  if (current()) throw new Error('Finish the current visit first.');
  let pos;
  try { pos = await currentPosition(30000); }
  catch (e) { throw new Error(e.code === 1 ? 'Allow location access so the visit knows where it is.' : 'Could not get a GPS fix. Move into the open and try again.'); }
  const now = new Date();
  const v = {
    id: crypto.randomUUID(), kind, site_name: site_name || null,
    started_at: now.toISOString(), local_offset_min: -now.getTimezoneOffset(),
    lat: pos.coords.latitude, lon: pos.coords.longitude, location_accuracy_m: Math.round(pos.coords.accuracy),
    sightings_logged: 0, last_activity: now.getTime(),
  };
  write(KEY, v);
  window.dispatchEvent(new CustomEvent('visit-changed'));
  return v;
}

export function noteSighting(visitId) {
  const v = read(KEY, null);
  if (v?.id === visitId) {
    v.sightings_logged++; v.last_activity = Date.now(); write(KEY, v);
  } else {
    const list = read(RECENT, []);
    const r = list.find(x => x.id === visitId);
    if (r) { r.late_sightings = (r.late_sightings || 0) + 1; write(RECENT, list); }
  }
  window.dispatchEvent(new CustomEvent('visit-changed'));
}

export function updateCurrent(patch) {
  const v = read(KEY, null);
  if (!v) return;
  write(KEY, { ...v, ...patch });
  window.dispatchEvent(new CustomEvent('visit-changed'));
}

// Finishes the open visit and queues it for upload.
export async function finishVisit({ notes = null, auto = false } = {}) {
  const v = read(KEY, null);
  if (!v) return null;
  const end = auto ? new Date(Math.max(v.last_activity || 0, Date.parse(v.started_at))) : new Date();
  const record = {
    id: v.id, kind: v.kind, started_at: v.started_at, ended_at: end.toISOString(), local_offset_min: v.local_offset_min,
    lat: v.lat, lon: v.lon, location_accuracy_m: v.location_accuracy_m,
    site_name: v.site_name,
    sightings_logged: v.sightings_logged, auto_closed: auto,
    notes: notes || null, device_info: navigator.userAgent.slice(0, 300),
  };
  await enqueueVisit(record);
  localStorage.removeItem(KEY);
  write(RECENT, [record, ...recent()].slice(0, 20));
  window.dispatchEvent(new CustomEvent('visit-changed'));
  return record;
}

// One tap: "I checked here and saw nothing". Start and finish in one go.
export async function nothingSeen({ kind, site_name, notes }) {
  await startVisit({ kind, site_name });
  return finishVisit({ notes });
}

export function cancelVisit() {
  localStorage.removeItem(KEY);
  window.dispatchEvent(new CustomEvent('visit-changed'));
}

// The visit (open or recently finished) whose time span contains this photo time.
export function visitForPhoto(takenAtIso) {
  const t = Date.parse(takenAtIso);
  const cands = [current(), ...recent()].filter(Boolean);
  return cands.find(v => {
    const s = Date.parse(v.started_at), e = v.ended_at ? Date.parse(v.ended_at) : Date.now();
    return t >= s - PHOTO_WINDOW_MS && t <= e + PHOTO_WINDOW_MS;
  }) || null;
}

// Pure helper for tests: minutes, rounded.
export const durationMin = v => Math.round((Date.parse(v.ended_at || new Date().toISOString()) - Date.parse(v.started_at)) / 60000);

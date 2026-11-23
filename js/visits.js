// "Nothing here" checks: zero records for markets and roadside sellers.
// When someone checks a market or roadside seller and there are no sharks or
// rays for sale, one tap records that check: the time (phone clock) and place
// (live GPS) of a moment when there were none. Checks where sharks or rays WERE
// found are the ordinary photo records, so together they show how often sharks
// and rays turn up for sale.
// (Stored in the `visits` table, with the start and end time the same.)
import { currentPosition } from './metadata.js?v=15';
import { enqueueVisit } from './queue.js?v=15';

export const KINDS = {
  market:   { label: 'Market or fish stall', icon: '🐟' },
  roadside: { label: 'Roadside seller',      icon: '🛻' },
};

// A fresh GPS fix, with a friendly error.
export async function fix() {
  try { return await currentPosition(30000); }
  catch (e) { throw new Error(e.code === 1 ? 'Allow location access so the record knows where it is.' : 'Could not get a GPS fix. Move into the open and try again.'); }
}

// Records "nothing here" now, at this spot. Uses the fix shown on screen if it's
// under 2 minutes old, otherwise takes a new one.
export async function nothingHere({ kind, site_name = null, notes = null, position = null }) {
  if (!KINDS[kind]) throw new Error('Choose market or roadside seller');
  const pos = position && Date.now() - position.timestamp < 120000 ? position : await fix();
  const now = new Date();
  const record = {
    id: crypto.randomUUID(), kind,
    started_at: now.toISOString(), ended_at: now.toISOString(), local_offset_min: -now.getTimezoneOffset(),
    lat: pos.coords.latitude, lon: pos.coords.longitude, location_accuracy_m: Math.round(pos.coords.accuracy),
    site_name: site_name || null, sightings_logged: 0, auto_closed: false,
    notes: notes || null, device_info: navigator.userAgent.slice(0, 300),
  };
  await enqueueVisit(record);
  return record;
}

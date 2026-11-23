// Public catalogue of individually recognised animals.
import { initShell, fmtTaken, fmtCoord, showMap, toast } from './app.js';
import { $, esc } from './util.js';
import * as store from './store.js';

initShell('records');

let list = [];
(async () => {
  const box = $('#ind-list');
  box.innerHTML = '<p class="muted"><span class="spinner"></span> Loading…</p>';
  try { list = await store.listIndividuals(); }
  catch (e) { box.innerHTML = `<p class="errors">${esc(e.message)}</p>`; return; }
  if (!list.length) { box.innerHTML = '<div class="card center muted">No individuals catalogued yet.</div>'; return; }
  box.innerHTML = list.map(i => `
    <a class="record-card" href="#${encodeURIComponent(i.code)}">
      ${i.thumb_url ? `<img src="${esc(i.thumb_url)}" alt="" loading="lazy">` : '<img alt="">'}
      <div>
        <strong>${esc(i.code)}${i.nickname ? ` · ${esc(i.nickname)}` : ''}</strong>
        <span class="small">${esc(i.common_name || i.species_id)}</span>
        <span class="small muted">${i.sightings} sighting${i.sightings === 1 ? '' : 's'}${i.last_seen ? ` · last seen ${esc(new Date(i.last_seen).toLocaleDateString())}` : ''}</span>
      </div>
    </a>`).join('');
  window.addEventListener('hashchange', showHash);
  showHash();
})();

async function showHash() {
  const code = decodeURIComponent(location.hash.slice(1));
  const box = $('#ind-detail');
  const ind = list.find(i => i.code === code);
  if (!ind) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = '<p class="muted"><span class="spinner"></span> Loading…</p>';
  box.scrollIntoView({ behavior: 'smooth' });
  let recs;
  try { recs = await store.individualRecords(ind.id); } catch (e) { toast(e.message, 'err'); return; }
  box.innerHTML = `
    <h2>${esc(ind.code)}${ind.nickname ? ` · ${esc(ind.nickname)}` : ''} <span class="muted small">${esc(ind.common_name || '')}${ind.sex && ind.sex !== 'unknown' ? ` · ${esc(ind.sex)}` : ''}</span></h2>
    <p class="small muted">First seen ${ind.first_seen ? esc(new Date(ind.first_seen).toLocaleDateString()) : '—'}, last seen ${ind.last_seen ? esc(new Date(ind.last_seen).toLocaleDateString()) : '—'}.</p>
    <div id="ind-map" class="map"></div>
    <div class="record-grid" style="margin-top:1rem">${recs.map(r => `
      <a class="record-card" href="records.html?id=${encodeURIComponent(r.id)}">
        <img src="${esc(r.thumb_url)}" alt="" loading="lazy">
        <div>
          <strong>${esc(fmtTaken(r.taken_at, r.local_offset_min, { withZone: false }))}</strong>
          <span class="small">${esc(r.site_name || fmtCoord(r.lat, r.lon))}</span>
          ${r.measured_length_cm ? `<span class="small muted">${r.measured_length_cm} cm (measured)</span>` : ''}
        </div>
      </a>`).join('')}</div>`;
  showMap($('#ind-map'), recs.map(r => ({ lat: r.lat, lon: r.lon, popup: esc(new Date(r.taken_at).toLocaleDateString()) })));
}

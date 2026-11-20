// Public records: list, map, per-record detail, CSV export.
import { initShell, fmtTaken, fmtCoord, showMap, iucnChip, toast } from './app.js';
import { $, esc } from './util.js';
import { LABELS } from './metadata.js';
import * as store from './store.js';

initShell('records');

let all = [];
const id = new URLSearchParams(location.search).get('id');
if (id) showDetail(id); else showList();

async function showDetail(recordId) {
  $('#detail-view').hidden = false;
  const box = $('#detail');
  box.innerHTML = '<p class="muted"><span class="spinner"></span> Loading…</p>';
  let r;
  try { r = await store.getPublicRecord(recordId); } catch (e) { box.innerHTML = `<p class="errors">${esc(e.message)}</p>`; return; }
  if (!r) { box.innerHTML = '<div class="card">Record not found, or not yet approved.</div>'; return; }
  document.title = `${r.common_name} · ${fmtTaken(r.taken_at, r.local_offset_min, { withZone: false })} — Shark ID`;
  const ai = r.ai_suggestions?.results?.[0];
  const names = await store.speciesMap();
  if (ai) ai.species_id = names[ai.species_id]?.common_name || ai.species_id;
  box.innerHTML = `
    <div class="detail-grid">
      <div>
        <a href="${esc(r.photo_url)}" target="_blank" rel="noopener"><img class="preview big" src="${esc(r.photo_url)}" alt="${esc(r.common_name)}"></a>
      </div>
      <div>
        <div class="card species-card">
          <h1>${esc(r.common_name)}</h1>
          <p class="sci"><i>${esc(r.scientific_name)}</i>${r.family ? ` · ${esc(r.family)}` : ''}</p>
          ${iucnChip(r.iucn_status)}
          ${r.max_length_cm ? `<p class="small">Grows to about ${r.max_length_cm} cm.</p>` : ''}
          ${r.id_features ? `<h3>How to recognise it</h3><p>${esc(r.id_features)}</p>` : ''}
        </div>
        <div class="card">
          <h2>When</h2>
          <p class="big-text">${esc(fmtTaken(r.taken_at, r.local_offset_min))}</p>
          <p class="small muted">From ${esc(LABELS.time_source[r.time_source])}; time zone from ${esc(LABELS.tz_source[r.tz_source])}.</p>
          <h2>Where</h2>
          <p class="big-text">${esc(r.site_name || 'Unnamed site')}</p>
          <p class="small muted">${esc(fmtCoord(r.lat, r.lon))}${r.location_accuracy_m ? ` (±${Math.round(r.location_accuracy_m)} m)` : ''} · ${esc(LABELS.location_source[r.location_source])}</p>
          <div id="detail-map" class="map"></div>
        </div>
        <div class="card">
          <h2>Details</h2>
          <div class="kv"><span>Estimated length</span><strong>${r.length_cm ? r.length_cm + ' cm' : '—'}</strong></div>
          <div class="kv"><span>Price</span><strong>${r.price != null ? 'SCR ' + r.price : '—'}</strong></div>
          ${r.notes ? `<div class="kv"><span>Notes</span><strong>${esc(r.notes)}</strong></div>` : ''}
          <div class="kv"><span>AI suggestion</span><strong>${ai ? `${esc(ai.species_id)} (${Math.round(ai.confidence * 100)}%)` : '—'}</strong></div>
          <div class="kv"><span>Confirmed by reviewer</span><strong>${r.reviewed_at ? esc(new Date(r.reviewed_at).toLocaleDateString()) : '✓'}</strong></div>
          <div class="kv"><span>Record ID</span><strong class="mono small">${esc(r.id)}</strong></div>
        </div>
      </div>
    </div>`;
  showMap($('#detail-map'), [{ lat: r.lat, lon: r.lon, accuracy: r.location_accuracy_m }]);
}

async function showList() {
  $('#list-view').hidden = false;
  try { all = await store.listPublicRecords(); }
  catch (e) { $('#record-grid').innerHTML = `<p class="errors">${esc(e.message)}</p>`; return; }
  const present = [...new Map(all.map(r => [r.species_id, r.common_name])).entries()].sort((a, b) => String(a[1]).localeCompare(b[1]));
  $('#filter-species').innerHTML = '<option value="">All species</option>' + present.map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
  $('#filter-species').addEventListener('change', render);
  render();
}

function filtered() {
  const f = $('#filter-species').value;
  return f ? all.filter(r => r.species_id === f) : all;
}

function render() {
  const rows = filtered();
  const bySpecies = {};
  for (const r of all) bySpecies[r.species_id] = (bySpecies[r.species_id] || 0) + 1;
  const threatened = all.filter(r => ['CR', 'EN', 'VU'].includes(r.iucn_status)).length;
  const sites = new Set(all.map(r => r.site_name).filter(Boolean)).size;
  $('#stats').innerHTML = `
    <div class="stat"><b>${all.length}</b><span>confirmed records</span></div>
    <div class="stat"><b>${Object.keys(bySpecies).length}</b><span>species</span></div>
    <div class="stat"><b>${all.length ? Math.round(100 * threatened / all.length) : 0}%</b><span>threatened (CR/EN/VU)</span></div>
    <div class="stat"><b>${sites}</b><span>named sites</span></div>`;
  showMap($('#all-map'), rows.map(r => ({
    lat: r.lat, lon: r.lon,
    popup: `<a href="records.html?id=${encodeURIComponent(r.id)}"><b>${esc(r.common_name)}</b></a><br>${esc(fmtTaken(r.taken_at, r.local_offset_min, { withZone: false }))}<br>${esc(r.site_name || '')}`,
  })));
  $('#record-grid').innerHTML = rows.length ? rows.map(r => `
    <a class="record-card" href="records.html?id=${encodeURIComponent(r.id)}">
      <img src="${esc(r.photo_url)}" alt="" loading="lazy">
      <div>
        <strong>${esc(r.common_name)}</strong>
        <span class="small muted">${esc(fmtTaken(r.taken_at, r.local_offset_min, { withZone: false }))}</span>
        <span class="small">${esc(r.site_name || fmtCoord(r.lat, r.lon))}</span>
        ${iucnChip(r.iucn_status)}
      </div>
    </a>`).join('') : '<div class="card center muted">No confirmed records yet.</div>';
}

$('#btn-csv').addEventListener('click', () => {
  const rows = filtered();
  if (!rows.length) return toast('Nothing to export', 'warn');
  const cols = ['id', 'taken_at', 'local_offset_min', 'time_source', 'tz_source', 'lat', 'lon', 'location_accuracy_m', 'location_source',
    'site_name', 'species_id', 'common_name', 'scientific_name', 'family', 'iucn_status', 'length_cm', 'price', 'notes', 'photo_url'];
  const q = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => q(r[c])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `shark-records-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
});

// Public records: list, map, per-record detail, CSV export.
import { initShell, fmtTaken, fmtCoord, showMap, iucnChip, toast } from './app.js';
import { $, esc } from './util.js';
import { LABELS } from './metadata.js';
import * as store from './store.js';
import { DATASET } from './config.js';

const chips = r => `<span class="chips">${r.quality_grade ? `<span class="chip chip-${esc(r.quality_grade)}" title="${r.quality_grade === 'research' ? 'Identification confirmed by an expert or a second reviewer' : 'Identification confirmed by one reviewer'}">${esc(LABELS.quality[r.quality_grade])}</span>` : ''}${r.grp === 'ray' ? '<span class="chip chip-ray">Ray</span>' : ''}${r.context && r.context !== 'market' ? '<span class="chip chip-live">Live</span>' : ''}${r.individual_code ? `<span class="chip">${esc(r.individual_code)}</span>` : ''}</span>`;

initShell('records');

const id = new URLSearchParams(location.search).get('id');
if (id) showDetail(id); else showList();

async function showDetail(recordId) {
  $('#detail-view').hidden = false;
  const box = $('#detail');
  box.innerHTML = '<p class="muted"><span class="spinner"></span> Loading…</p>';
  let r;
  try { r = await store.getPublicRecord(recordId); } catch (e) { box.innerHTML = `<p class="errors">${esc(e.message)}</p>`; return; }
  if (!r) { box.innerHTML = '<div class="card">Record not found, or not yet approved.</div>'; return; }
  document.title = `${r.common_name} · ${fmtTaken(r.taken_at, r.local_offset_min, { withZone: false })} — The Sharkive`;
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
          ${chips(r)}
          <div class="kv"><span>Type</span><strong>${esc(LABELS.context[r.context || 'market'])}</strong>${r.visit_id ? '<em>logged during a market visit</em>' : ''}</div>
          <div class="kv"><span>Number of animals</span><strong>${r.shark_count ?? 1}</strong></div>
          <div class="kv"><span>Estimated ${r.size_measure === 'DW' ? 'disc width' : 'length'}</span><strong>${r.length_cm ? r.length_cm + ' cm' : '—'}</strong></div>
          <div class="kv"><span>Measured from photo</span><strong>${r.measured_length_cm ? `${r.measured_length_cm} cm` : '—'}</strong>${r.measured_length_cm ? `<em>${esc(LABELS.measure[r.measurement?.measure] || '')}, against a ${esc(r.measurement?.ref_kind === 'card' ? 'Sharkive scale card' : r.measurement?.ref_kind === 'a4' ? 'sheet of A4' : r.measurement?.ref_kind === 'bank' ? 'bank card' : 'reference')} (by the ${esc(r.measured_by || 'submitter')})</em>` : ''}</div>
          ${r.maturity_cm && (r.measured_length_cm || r.length_cm) ? `<div class="kv"><span>Maturity</span><strong>${(r.measured_length_cm || r.length_cm) < r.maturity_cm ? 'Below' : 'Above'} the usual size at maturity (${r.maturity_cm} cm)</strong></div>` : ''}
          <div class="kv"><span>Sex</span><strong>${r.sex && r.sex !== 'unknown' ? esc(r.sex) : '—'}</strong>${r.sex && r.sex !== 'unknown' ? `<em>${r.sex_confirmed ? 'confirmed by a reviewer' : 'as reported, not confirmed'}</em>` : ''}</div>
          <div class="kv"><span>Life stage</span><strong>${esc(LABELS.life_stage[r.life_stage] || '—')}</strong></div>
          ${r.context && r.context !== 'market' ? `<div class="kv"><span>Depth / habitat</span><strong>${r.depth_m != null ? r.depth_m + ' m' : '—'} / ${esc(r.habitat || '—')}</strong></div>` : `<div class="kv"><span>Price</span><strong>${r.price != null ? 'SCR ' + r.price : '—'}</strong></div>`}
          ${r.individual_code ? `<div class="kv"><span>Individual</span><strong><a href="individuals.html#${encodeURIComponent(r.individual_code)}">${esc(r.individual_code)}</a></strong><em>recognised from its markings</em></div>` : ''}
          ${r.notes ? `<div class="kv"><span>Notes</span><strong>${esc(r.notes)}</strong></div>` : ''}
          <div class="kv"><span>AI suggestion</span><strong>${ai ? `${esc(ai.species_id)} (${Math.round(ai.confidence * 100)}%)` : '—'}</strong></div>
          <div class="kv"><span>Confirmed by reviewer</span><strong>${r.reviewed_at ? esc(new Date(r.reviewed_at).toLocaleDateString()) : 'Yes'}</strong></div>
          <div class="kv"><span>Record ID</span><strong class="mono small">${esc(r.id)}</strong></div>
        </div>
      </div>
    </div>`;
  showMap($('#detail-map'), [{ lat: r.lat, lon: r.lon, accuracy: r.location_accuracy_m }]);
}

async function showList() {
  $('#list-view').hidden = false;
  let summary;
  try { summary = await store.recordsSummary(); }
  catch (e) { $('#record-grid').innerHTML = `<p class="errors">${esc(e.message)}</p>`; return; }
  names = Object.fromEntries(summary.by_species.map(s => [s.species_id, s.common_name]));
  const opts = grp => summary.by_species.filter(s => (s.grp || 'shark') === grp).map(s => `<option value="${esc(s.species_id)}">${esc(s.common_name)} (${s.n})</option>`).join('');
  $('#filter-species').innerHTML = `<option value="">All species (${summary.records})</option>` +
    `<optgroup label="Sharks">${opts('shark')}</optgroup><optgroup label="Rays">${opts('ray')}</optgroup>`;
  $('#filter-species').addEventListener('change', () => { renderMap(); loadPage(true); });
  for (const id of ['#filter-context', '#filter-research']) $(id).addEventListener('change', () => loadPage(true));
  const pct = (a, b) => (b ? Math.round(100 * a / b) : 0) + '%';
  $('#stats').innerHTML = `
    <div class="stat"><b>${summary.sharks}</b><span>sharks counted</span></div>
    <div class="stat"><b>${summary.rays ?? 0}</b><span>rays counted</span></div>
    <div class="stat"><b>${summary.records}</b><span>confirmed records</span></div>
    <div class="stat"><b>${summary.species}</b><span>species</span></div>
    <div class="stat"><b>${pct(summary.threatened, summary.records)}</b><span>threatened (CR/EN/VU)</span></div>
    <div class="stat"><b>${pct(summary.research ?? 0, summary.records)}</b><span>research grade</span></div>
    <div class="stat"><b>${summary.visits ?? 0}</b><span>market visits</span></div>
    <div class="stat"><b>${pct((summary.visits ?? 0) - (summary.zero_visits ?? 0), summary.visits)}</b><span>visits with sharks or rays</span></div>`;
  renderEffort();
  $('#btn-more').addEventListener('click', () => loadPage(false));
  renderMap();
  loadPage(true);
}

let names = {};
let offset = 0;
const species = () => $('#filter-species').value;
const filters = () => ({ context: $('#filter-context').value || undefined, research: $('#filter-research').checked || undefined });
const filterKey = () => species() + JSON.stringify(filters());

async function renderMap() {
  const want = species();
  let pts;
  try { pts = await store.recordPoints(want); } catch (e) { console.warn(e); return; }
  if (want !== species()) return;
  showMap($('#all-map'), pts.map(r => ({
    lat: r.lat, lon: r.lon,
    popup: () => `<a href="records.html?id=${encodeURIComponent(r.id)}"><b>${esc(names[r.species_id] || r.species_id)}${(r.shark_count ?? 1) > 1 ? ` × ${r.shark_count}` : ''}</b></a><br>${esc(new Date(r.taken_at).toLocaleDateString())}`,
  })));
}

async function loadPage(reset) {
  const grid = $('#record-grid'), more = $('#btn-more');
  const want = filterKey();
  if (reset) { offset = 0; grid.innerHTML = '<p class="muted"><span class="spinner"></span> Loading…</p>'; }
  more.disabled = true;
  let page;
  try { page = await store.listPublicRecords({ speciesId: species(), offset, filters: filters() }); }
  catch (e) { grid.innerHTML = `<p class="errors">${esc(e.message)}</p>`; return; }
  if (want !== filterKey()) return;
  if (reset) grid.innerHTML = '';
  offset += page.rows.length;
  grid.insertAdjacentHTML('beforeend', page.rows.map(r => `
    <a class="record-card" href="records.html?id=${encodeURIComponent(r.id)}">
      <img src="${esc(r.thumb_url)}" alt="" loading="lazy">
      <div>
        <strong>${esc(r.common_name)}${(r.shark_count ?? 1) > 1 ? ` × ${r.shark_count}` : ''}</strong>
        ${chips(r)}
        <span class="small muted">${esc(fmtTaken(r.taken_at, r.local_offset_min, { withZone: false }))}</span>
        <span class="small">${esc(r.site_name || fmtCoord(r.lat, r.lon))}</span>
        ${iucnChip(r.iucn_status)}
      </div>
    </a>`).join(''));
  if (!offset) grid.innerHTML = '<div class="card center muted">No confirmed records match.</div>';
  more.hidden = !page.more;
  more.disabled = false;
}

$('#btn-csv').addEventListener('click', async () => {
  const btn = $('#btn-csv');
  btn.disabled = true;
  let rows;
  try { rows = await store.allPublicRecords(species(), n => { btn.textContent = `CSV (${n}…)`; }, filters()); }
  catch (e) { toast(e.message, 'err'); return; }
  finally { btn.disabled = false; btn.textContent = 'CSV'; }
  if (!rows.length) return toast('Nothing to export', 'warn');
  const cols = ['id', 'taken_at', 'local_offset_min', 'time_source', 'tz_source', 'lat', 'lon', 'location_accuracy_m', 'location_source',
    'site_name', 'shark_count', 'species_id', 'common_name', 'scientific_name', 'family', 'grp', 'iucn_status', 'length_cm', 'price', 'notes', 'photo_url',
    'context', 'visit_id', 'quality_grade', 'sex', 'sex_confirmed', 'life_stage', 'depth_m', 'habitat', 'measured_length_cm', 'size_measure', 'measured_by', 'individual_code'];
  downloadCsv(cols, rows, `shark-records-${new Date().toISOString().slice(0, 10)}.csv`);
});

function downloadCsv(cols, rows, name) {
  const q = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => q(r[c])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = name;
  a.click();
}

$('#btn-dwc').addEventListener('click', async () => {
  const btn = $('#btn-dwc');
  btn.disabled = true;
  try {
    const recs = await store.allPublicRecords('', n => { btn.textContent = `Darwin Core (${n}…)`; });
    const visits = await store.allPublicVisits();
    const { downloadDwcA } = await import('./dwc.js');
    const n = await downloadDwcA(recs, visits, DATASET);
    toast(`Darwin Core Archive: ${n.occurrences} records and ${n.absences} absences`);
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = 'Darwin Core'; }
});

// ---------- market visits (effort) ----------
let visitRows = [];
async function renderEffort() {
  const box = $('#effort-table');
  try { visitRows = await store.allPublicVisits(); }
  catch (e) { box.innerHTML = `<p class="small muted">${esc(e.message)}</p>`; return; }
  if (!visitRows.length) { box.innerHTML = '<p class="muted small">No market visits recorded yet.</p>'; return; }
  const by = {};
  for (const v of visitRows) {
    const key = v.site_name || 'Unnamed site';
    const g = (by[key] ??= { site: key, visits: 0, with: 0, animals: 0, minutes: 0, last: '' });
    g.visits++; g.with += v.approved_sightings > 0 ? 1 : 0; g.animals += v.animals || 0;
    g.minutes += v.duration_min || 0; if (v.started_at > g.last) g.last = v.started_at;
  }
  const groups = Object.values(by).sort((a, b) => b.visits - a.visits);
  const tot = groups.reduce((t, g) => ({ visits: t.visits + g.visits, with: t.with + g.with, animals: t.animals + g.animals }), { visits: 0, with: 0, animals: 0 });
  const row = (g, strong) => `<tr${strong ? ' class="total"' : ''}><td>${esc(g.site)}</td><td>${g.last ? esc(new Date(g.last).toLocaleDateString()) : ''}</td><td>${g.visits}</td><td>${g.with}</td><td>${g.visits ? Math.round(100 * g.with / g.visits) : 0}%</td><td>${g.animals}</td></tr>`;
  box.innerHTML = `<table class="table effort-table"><thead><tr><th>Site</th><th>Last visit</th><th>Visits</th><th>With sharks/rays</th><th>%</th><th>Animals</th></tr></thead><tbody>${
    groups.slice(0, 50).map(g => row(g)).join('')}${row({ site: 'All sites', ...tot }, true)}</tbody></table>
    <p class="small muted">Only sightings a reviewer has approved count. Sites are grouped by the name contributors typed, so spelling variants show separately.</p>`;
}
$('#btn-visits-csv').addEventListener('click', () => {
  if (!visitRows.length) return toast('No visits yet', 'warn');
  downloadCsv(['id', 'kind', 'started_at', 'ended_at', 'local_offset_min', 'duration_min', 'lat', 'lon', 'location_accuracy_m', 'site_name',
    'sightings_logged', 'approved_sightings', 'animals', 'auto_closed'], visitRows, `sharkive-visits-${new Date().toISOString().slice(0, 10)}.csv`);
});

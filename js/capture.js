// "Log a shark" page.
import { initShell, fmtTaken, fmtCoord, showMap, iucnChip, toast } from './app.js';
import { $, esc, loadImage } from './util.js';
import { Camera } from './camera.js';
import { readFileMetadata, currentPosition, checkTime, LABELS } from './metadata.js';
import { embed, aggregate, rankCentroids, MODEL_ID } from './classifier.js';
import { AI } from './config.js';
import { listSpecies, matchSpecies, speciesCentroids, isDemo } from './store.js';
import { prepareUpload } from './image.js';
import { screenPhoto, NOT_SCREENED } from './screen.js';
import { enqueue } from './queue.js';

initShell('log');
const submitLabel = $('#btn-submit').textContent;

let species = [];
let speciesById = {};
let state = null; // { blob, url, meta, ai }
let camera = null;

(async () => {
  species = await listSpecies();
  speciesById = Object.fromEntries(species.map(s => [s.id, s]));
  $('#species-select').innerHTML = '<option value="">Not sure</option>' +
    species.map(s => `<option value="${esc(s.id)}">${esc(s.common_name)} — ${esc(s.scientific_name)}</option>`).join('');
  const sites = JSON.parse(localStorage.getItem('sharkid_sites') || '[]');
  $('#site-list').innerHTML = sites.map(s => `<option value="${esc(s)}">`).join('');
})();

// ---------- camera path ----------
$('#btn-camera').addEventListener('click', async () => {
  $('#camera').hidden = false;
  camera = new Camera($('#video'), s => {
    const el = $('#gps-status');
    el.textContent = s.text;
    el.className = 'gps ' + (s.ok ? 'ok' : 'wait');
  });
  try {
    await camera.open();
  } catch (e) {
    closeCamera();
    toast(e.message || 'Could not open the camera', 'err');
  }
});
$('#btn-cancel-cam').addEventListener('click', closeCamera);
function closeCamera() { camera?.close(); camera = null; $('#camera').hidden = true; }

$('#btn-shutter').addEventListener('click', async () => {
  if (!camera) return;
  const btn = $('#btn-shutter');
  btn.disabled = true;
  try {
    const { blob, meta } = await camera.shutter();
    closeCamera();
    await startReview(blob, meta);
  } catch (e) {
    toast(e.message, 'err');
  } finally { btn.disabled = false; }
});

// ---------- existing-photo path ----------
$('#file-input').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  const meta = await readFileMetadata(file);
  if (meta.needsLiveGps) {
    try {
      toast('No GPS in the photo. Getting your location (the photo is recent)…');
      const pos = await currentPosition();
      Object.assign(meta, {
        lat: pos.coords.latitude, lon: pos.coords.longitude,
        location_accuracy_m: Math.round(pos.coords.accuracy), location_source: 'live_gps_at_upload',
      });
      meta.warnings.push('Location comes from this phone\'s GPS now, not from the photo. Only accepted because the photo is very recent.');
    } catch (e) {
      meta.errors.push('This photo has no location data and this phone\'s location could not be read. Allow location access and try again.');
    }
    delete meta.needsLiveGps;
  }
  await startReview(file, meta);
});

// ---------- review + AI ----------
async function startReview(blob, meta) {
  if (state?.url) URL.revokeObjectURL(state.url);
  state = { blob, url: URL.createObjectURL(blob), meta, ai: null };
  $('#step-photo').hidden = true;
  $('#done').hidden = true;
  for (const id of ['#step-review', '#step-id', '#step-details']) $(id).hidden = false;
  $('#preview').src = state.url;
  renderMeta();
  updateSubmit();
  state.aiPromise = runAI();
  state.screenPromise = runScreening(state);
  if (meta.lat != null) showMap($('#meta-map'), [{ lat: meta.lat, lon: meta.lon, accuracy: meta.location_accuracy_m }]);
  else $('#meta-map').innerHTML = '';
  $('#step-review').scrollIntoView({ behavior: 'smooth' });
}

function renderMeta() {
  const m = state.meta;
  const row = (k, v, src) => `<div class="kv"><span>${k}</span><strong>${v}</strong>${src ? `<em>${src}</em>` : ''}</div>`;
  let html = '';
  html += row('When', m.taken_at ? esc(fmtTaken(m.taken_at, m.local_offset_min)) : '<span class="bad">missing</span>',
    m.time_source ? `${LABELS.time_source[m.time_source]} · time zone from ${LABELS.tz_source[m.tz_source]}` : '');
  html += row('Where', m.lat != null ? esc(fmtCoord(m.lat, m.lon)) + (m.location_accuracy_m ? ` <span class="muted">±${m.location_accuracy_m} m</span>` : '') : '<span class="bad">missing</span>',
    m.location_source ? LABELS.location_source[m.location_source] : '');
  html += row('How', LABELS.capture_method[m.capture_method]);
  if (m.errors.length) html += `<div class="errors">${m.errors.map(e => `<p>${esc(e)}</p>`).join('')}</div>`;
  if (m.warnings.length) html += `<div class="warnings">${m.warnings.map(e => `<p>${esc(e)}</p>`).join('')}</div>`;
  $('#meta-box').innerHTML = html;
}

async function runAI() {
  const box = $('#ai-box');
  box.innerHTML = '<p class="muted"><span class="spinner"></span> Identifying… (first run downloads the model, about 14 MB)</p>';
  const mine = state;
  try {
    const img = await loadImage(mine.url);
    const vec = await embed(img);
    if (mine !== state) return;
    let r;
    try {
      if (!navigator.onLine) throw new Error('offline');
      const m = await matchSpecies(vec, MODEL_ID, AI.k);
      r = aggregate(m.neighbours, m);
      speciesCentroids(MODEL_ID).catch(() => {});   // keep the offline fallback fresh
    } catch (e) {
      r = rankCentroids(vec, await speciesCentroids(MODEL_ID, { maxAgeMs: Infinity }));
    }
    if (mine !== state) return;
    state.ai = { model: MODEL_ID, ...r };
    if (r.status === 'no_library') {
      box.innerHTML = '<p class="muted">The reference library is still empty, so there\'s no automatic suggestion yet. A reviewer will identify this shark, and each confirmed photo teaches the app.</p>';
      return;
    }
    box.innerHTML = `<p class="small muted">${r.source === 'offline'
        ? `Offline: rough suggestions from saved averages of ${r.species_in_library} species.`
        : `Suggestions from ${r.library_size} confirmed photos of ${r.species_in_library} species.`} Tap one to use it.</p>` +
      r.results.map(x => {
        const s = speciesById[x.species_id] || { common_name: x.species_id, scientific_name: '' };
        const pct = Math.round(x.confidence * 100);
        return `<button class="ai-choice" data-id="${esc(x.species_id)}">
          <span class="ai-name">${esc(s.common_name)} <i>${esc(s.scientific_name)}</i></span>
          <span class="bar"><span style="width:${pct}%"></span></span><span class="pct">${pct}%</span>
          ${s.iucn_status ? iucnChip(s.iucn_status) : ''}
        </button>`;
      }).join('') +
      (r.results[0].best_similarity < 0.6 ? '<p class="small warn-text">Low similarity to anything in the library. Treat these as a rough guess.</p>' : '');
    box.querySelectorAll('.ai-choice').forEach(b => b.addEventListener('click', () => {
      $('#species-select').value = b.dataset.id;
      box.querySelectorAll('.ai-choice').forEach(x => x.classList.toggle('chosen', x === b));
    }));
  } catch (e) {
    console.warn(e);
    if (mine === state) {
      state.ai = { model: MODEL_ID, status: 'error', results: [] };
      box.innerHTML = '<p class="muted">Automatic identification isn\'t available right now (offline, or the model couldn\'t load). You can still submit; a reviewer will identify it.</p>';
    }
  }
}

// Explicit-image and "is it a shark?" checks, on the phone, before upload.
async function runScreening(mine) {
  let result;
  try {
    const img = await loadImage(mine.url);
    await mine.aiPromise?.catch(() => {});
    result = await screenPhoto(img, { bestSimilarity: mine.ai?.results?.[0]?.best_similarity ?? null });
  } catch (e) {
    console.warn('Screening failed', e);
    result = NOT_SCREENED;
  }
  if (mine !== state) return result;
  state.screen = result;
  const box = $('#screen-box');
  if (result.block) {
    box.hidden = false; box.className = 'errors';
    box.innerHTML = '<p><strong>This photo can\'t be uploaded.</strong> It looks like it may be explicit. If it\'s a photo of a shark, please take another one.</p>';
  } else if (result.flags.includes('not_shark')) {
    box.hidden = false; box.className = 'warnings';
    box.innerHTML = '<p><strong>This doesn\'t look like a shark or a fish.</strong> If it is one, you can still send it and a reviewer will check it.</p>';
  } else { box.hidden = true; box.innerHTML = ''; }
  updateSubmit();
  return result;
}

function updateSubmit() {
  const errs = state?.meta.errors || [];
  const blocked = !!state?.screen?.block;
  $('#btn-submit').disabled = !state || blocked || errs.length > 0 || !state.meta.taken_at || state.meta.lat == null;
  delete $('#btn-submit').dataset.armed;
  const box = $('#submit-errors');
  box.hidden = !errs.length;
  box.innerHTML = errs.length ? '<p>This photo can\'t be submitted because its capture time or location is missing or invalid (see above).</p>' : '';
}

const withTimeout = (p, ms, fallback) => Promise.race([p, new Promise(res => setTimeout(() => res(fallback), ms))]);

$('#btn-retake').addEventListener('click', reset);
$('#btn-another').addEventListener('click', reset);
function reset() {
  if (state?.url) URL.revokeObjectURL(state.url);
  state = null;
  for (const id of ['#step-review', '#step-id', '#step-details', '#done']) $(id).hidden = true;
  $('#step-photo').hidden = false;
  for (const id of ['#length', '#price', '#notes']) $(id).value = '';
  $('#shark-count').value = '1';
  $('#species-select').value = '';
  $('#screen-box').hidden = true;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$('#btn-submit').addEventListener('click', async () => {
  if (!state) return;
  const btn = $('#btn-submit');
  if (!btn.dataset.armed) {
    btn.disabled = true; btn.textContent = 'Checking photo…';
    const screen = await withTimeout(state.screenPromise, 20000, NOT_SCREENED);
    btn.textContent = submitLabel;
    if (!state) return;
    state.screen = screen;
    updateSubmit();
    if (screen.block) return;
    if (screen.flags.includes('not_shark')) {   // ask once: first tap warns, second tap sends
      btn.dataset.armed = '1'; btn.textContent = 'It is a shark: send anyway';
      $('#screen-box').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
  }
  const m = state.meta;
  checkTime({ ...m, errors: m.errors, warnings: [] }); // re-check right before submitting
  if (m.errors.length || !m.taken_at || m.lat == null) { renderMeta(); updateSubmit(); return; }
  const num = v => (v === '' || v == null ? null : Number(v));
  const site = $('#site-name').value.trim();
  const record = {
    id: crypto.randomUUID(),
    capture_method: m.capture_method,
    taken_at: m.taken_at, local_offset_min: m.local_offset_min, time_source: m.time_source, tz_source: m.tz_source,
    lat: m.lat, lon: m.lon, location_accuracy_m: m.location_accuracy_m ?? null, location_source: m.location_source,
    exif: { ...m.exif, warnings: m.warnings },
    device_info: navigator.userAgent.slice(0, 300),
    ai_model: state.ai?.model ?? null,
    ai_suggestions: state.ai ? { status: state.ai.status, results: state.ai.results, library_size: state.ai.library_size ?? 0 } : null,
    submitter_species_id: $('#species-select').value || null,
    shark_count: Math.min(500, Math.max(1, Math.round(num($('#shark-count').value) || 1))),
    site_name: site || null,
    length_cm: num($('#length').value), price: num($('#price').value),
    notes: $('#notes').value.trim() || null,
    screening: (({ block, ...rest }) => rest)(state.screen || NOT_SCREENED),
  };
  if (site) {
    const sites = [site, ...JSON.parse(localStorage.getItem('sharkid_sites') || '[]').filter(s => s !== site)].slice(0, 20);
    localStorage.setItem('sharkid_sites', JSON.stringify(sites));
  }
  $('#btn-submit').disabled = true;
  $('#btn-submit').textContent = 'Saving…';
  try {
    const { full, thumb } = await prepareUpload(record, state.blob);
    await enqueue(record, full, thumb);
    for (const id of ['#step-review', '#step-id', '#step-details']) $(id).hidden = true;
    $('#done').hidden = false;
    $('#done-text').textContent = navigator.onLine || isDemo
      ? 'Your record has been sent for review. Once a reviewer confirms the species it will appear in Records.'
      : 'You\'re offline, so the record is saved on this phone and will upload automatically when you have signal.';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    toast('Could not save: ' + e.message, 'err');
    $('#btn-submit').disabled = false;
  } finally {
    $('#btn-submit').textContent = submitLabel;
  }
});

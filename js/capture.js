// "Log a shark" page.
import { initShell, fmtTaken, fmtCoord, showMap, iucnChip, toast } from './app.js?v=15';
import { $, $$, esc, loadImage } from './util.js?v=15';
import { Camera } from './camera.js?v=15';
import { readFileMetadata, currentPosition, checkTime, LABELS } from './metadata.js?v=15';
import * as visits from './visits.js?v=15';
import { openMeasure } from './measure.js?v=15';
import { embed, aggregate, rankCentroids, MODEL_ID } from './classifier.js?v=15';
import { AI } from './config.js?v=15';
import { listSpecies, matchSpecies, speciesCentroids, isDemo } from './store.js?v=15';
import { prepareUpload } from './image.js?v=15';
import { screenPhoto, NOT_SCREENED } from './screen.js?v=15';
import { enqueue } from './queue.js?v=15';

initShell('log');
const submitLabel = $('#btn-submit').textContent;

let species = [];
let speciesById = {};
let state = null; // { blob, url, meta, ai, measurement }
let camera = null;
let context = null;   // what is being logged: 'market', 'in_water' or 'shallows'

(async () => {
  species = await listSpecies();
  speciesById = Object.fromEntries(species.map(s => [s.id, s]));
  const opt = s => `<option value="${esc(s.id)}">${esc(s.common_name)} — ${esc(s.scientific_name)}</option>`;
  $('#species-select').innerHTML = '<option value="">Not sure</option>' +
    `<optgroup label="Sharks">${species.filter(s => (s.grp || 'shark') === 'shark').map(opt).join('')}</optgroup>` +
    `<optgroup label="Rays">${species.filter(s => s.grp === 'ray').map(opt).join('')}</optgroup>`;
  const sites = JSON.parse(localStorage.getItem('sharkid_sites') || '[]');
  $('#site-list').innerHTML = sites.map(s => `<option value="${esc(s)}">`).join('');
})();

// ---------- what are you logging? ----------
const HABITATS = {
  reef: 'Coral reef', sand: 'Sand', seagrass: 'Seagrass', mangrove: 'Mangrove', lagoon: 'Lagoon',
  beach: 'Beach / surf zone', open_water: 'Open water', other: 'Other',
};
$('#habitat').innerHTML = '<option value="">Not sure</option>' + Object.entries(HABITATS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
$$('.ctx-btn').forEach(b => b.addEventListener('click', () => { context = b.dataset.context; renderMode(); }));
$('#btn-back-visit').addEventListener('click', () => { context = null; renderMode(); });

// "Nothing for sale here": a zero record, saved in one tap.
let nothingPos = null;
async function locateNothing() {
  const box = $('#nothing-where');
  box.innerHTML = '<span class="spinner"></span> Getting your location…';
  try {
    nothingPos = await visits.fix();
    const c = nothingPos.coords, acc = Math.round(c.accuracy);
    box.innerHTML = `<strong>${esc(fmtCoord(c.latitude, c.longitude))}</strong> <span class="muted">±${acc} m</span>` +
      (acc > 150 ? ' <span class="warn-text">Weak GPS: move into the open if you can.</span>' : '') +
      ' <button class="linklike" id="btn-relocate" type="button">Update</button>';
    $('#btn-relocate').addEventListener('click', locateNothing);
    showMap($('#nothing-map'), [{ lat: c.latitude, lon: c.longitude, accuracy: acc, color: '#8a939b' }], { zoom: 16 });
  } catch (e) {
    nothingPos = null;
    box.innerHTML = `<span class="warn-text">${esc(e.message)}</span> <button class="linklike" id="btn-relocate" type="button">Try again</button>`;
    $('#btn-relocate').addEventListener('click', locateNothing);
  }
}
$('#btn-show-nothing').addEventListener('click', () => {
  $('#nothing-form').hidden = !$('#nothing-form').hidden;
  $('#btn-show-nothing').classList.toggle('chosen', !$('#nothing-form').hidden);
  if (!$('#nothing-form').hidden) { locateNothing(); $('#nothing-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
});
$('#btn-nothing').addEventListener('click', async () => {
  const btn = $('#btn-nothing'), label = btn.textContent;
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Getting GPS…';
  try {
    const site_name = $('#nothing-site').value.trim() || null;
    if (site_name) rememberSite(site_name);
    const kind = document.querySelector('input[name="nothing-kind"]:checked')?.value || 'market';
    const v = await visits.nothingHere({ kind, site_name, notes: $('#nothing-notes').value.trim() || null, position: nothingPos });
    toast(`Saved: no sharks or rays at ${site_name || fmtCoord(v.lat, v.lon)}. Thank you, zero records count too!`);
    nothingPos = null;
    $('#nothing-site').value = ''; $('#nothing-notes').value = '';
    $('#nothing-form').hidden = true; $('#btn-show-nothing').classList.remove('chosen');
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = label; }
});

function renderMode() {
  const inFlow = !!state || !$('#done').hidden;
  $('#step-visit').hidden = !!context || inFlow;
  $('#step-photo').hidden = !context || inFlow;
  $('#no-visit-note').hidden = !context;
  $('#no-visit-text').textContent = { market: 'Logging a shark or ray landed or for sale.', in_water: 'Logging a live shark or ray in the water.', shallows: 'Logging a live shark or ray in the shallows.' }[context] || '';
  $('#step-photo h1').textContent = context && context !== 'market' ? 'Log a live shark or ray' : 'Log a shark or ray';
  document.querySelector('.about-link').hidden = inFlow;
}
renderMode();

let lastContext = null;
function applyContext(ctx) {
  const live = ctx !== 'market';
  if (lastContext && lastContext !== ctx) $('#site-name').value = '';   // don't carry a market name to a reef
  lastContext = ctx;
  $$('.live-only').forEach(el => (el.hidden = !live));
  $$('.market-only').forEach(el => (el.hidden = live));
  $('#depth-wrap').hidden = ctx !== 'in_water';
  $('#notes').placeholder = live
    ? 'Behaviour, how close, swimming or resting, any tags or injuries?'
    : 'How many were for sale, whole or cut up, fins removed, caught locally?';
  $('#site-name').placeholder = live ? 'e.g. Anse Lazio reef, Curieuse mangroves' : 'e.g. Baie Ste Anne market, roadside Grand Anse';
}
function sizeMeasure() { return speciesById[$('#species-select').value]?.size_measure || 'TL'; }
$('#species-select').addEventListener('change', () => {
  $('#length-label').textContent = sizeMeasure() === 'DW' ? 'Estimated disc width (cm)' : 'Estimated length (cm)';
});
$('#btn-measure').addEventListener('click', async () => {
  if (!state) return;
  const m = await openMeasure(state.url, { measure: sizeMeasure(), existing: state.measurement });
  if (!m) return;
  state.measurement = m;
  renderMeasure();
});
function renderMeasure() {
  const m = state?.measurement;
  $('#measure-result').innerHTML = m
    ? `Measured: <strong>${m.value_cm} cm</strong> ${esc(m.measure)} <button class="linklike" id="btn-measure-clear">remove</button>` +
      (m.warnings?.length ? `<br><span class="warn-text">${esc(m.warnings[0])}</span>` : '')
    : '';
  $('#btn-measure').textContent = m ? 'Measure again' : 'Measure from the photo';
  $('#btn-measure-clear')?.addEventListener('click', () => { state.measurement = null; renderMeasure(); });
}
function rememberSite(site) {
  const sites = [site, ...JSON.parse(localStorage.getItem('sharkid_sites') || '[]').filter(s => s !== site)].slice(0, 20);
  localStorage.setItem('sharkid_sites', JSON.stringify(sites));
}

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
  state = { blob, url: URL.createObjectURL(blob), meta, ai: null, measurement: null };
  state.context = context || 'market';
  applyContext(state.context);
  renderMeasure();
  $('#step-photo').hidden = true;
  $('#step-visit').hidden = true;
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
  if (state.context) html += row('Type', esc(LABELS.context[state.context]));
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
  for (const id of ['#length', '#price', '#notes', '#depth', '#habitat', '#life-stage']) $(id).value = '';
  $('#shark-count').value = '1';
  $('#species-select').value = '';
  $('#length-label').textContent = 'Estimated length (cm)';
  document.querySelector('input[name="sex"][value="unknown"]').checked = true;
  $('#screen-box').hidden = true;
  renderMode();
  renderMeasure();
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
  const c = { context: state.context };
  const live = c.context !== 'market';
  const sex = document.querySelector('input[name="sex"]:checked')?.value || 'unknown';
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
    length_cm: num($('#length').value), price: live ? null : num($('#price').value),
    notes: $('#notes').value.trim() || null,
    context: c.context,
    sex, life_stage: $('#life-stage').value || null,
    depth_m: c.context === 'in_water' ? num($('#depth').value) : null,
    habitat: live ? ($('#habitat').value || null) : null,
    measurement: state.measurement ? (({ warnings, ...rest }) => rest)(state.measurement) : null,
    measured_length_cm: state.measurement?.value_cm ?? null,
    screening: (({ block, ...rest }) => rest)(state.screen || NOT_SCREENED),
  };
  if (site) rememberSite(site);
  $('#btn-submit').disabled = true;
  $('#btn-submit').textContent = 'Saving…';
  try {
    const { full, thumb } = await prepareUpload(record, state.blob);
    await enqueue(record, full, thumb);
    for (const id of ['#step-review', '#step-id', '#step-details']) $(id).hidden = true;
    if (state?.url) URL.revokeObjectURL(state.url);
    state = null;
    $('#done').hidden = false;
    renderMode();
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

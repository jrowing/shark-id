// Reviewer page: approve / correct / reject submissions, manage reference library.
import { initShell, fmtTaken, fmtCoord, showMap, iucnChip, toast, ago } from './app.js';
import { $, $$, esc, loadImage } from './util.js';
import { LABELS } from './metadata.js';
import { embed, MODEL_ID } from './classifier.js';
import * as store from './store.js';

initShell('review');

let species = [], speciesById = {};
let currentTab = 'pending';

async function boot() {
  species = await store.listSpecies();
  speciesById = Object.fromEntries(species.map(s => [s.id, s]));
  const session = await store.getSession();
  if (!session) { $('#login').hidden = false; return; }
  if (!(await store.isReviewer())) {
    $('#not-reviewer').hidden = false;
    $('#uid-sql').textContent = `insert into reviewers (user_id, name) values ('${session.user.id}', '${session.user.email}');`;
    return;
  }
  $('#panel').hidden = false;
  $('#who').textContent = session.user.email;
  $('#ref-species').innerHTML = speciesOptions();
  showTab('pending');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#login-msg');
  try {
    await store.signIn($('#email').value, $('#password').value);
    $('#login').hidden = true;
    boot();
  } catch (err) { msg.hidden = false; msg.textContent = err.message; }
});
for (const id of ['#btn-signout', '#btn-signout-2']) $(id).addEventListener('click', async () => { await store.signOut(); location.reload(); });

$$('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
function showTab(tab) {
  currentTab = tab;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $('#tab-queue').hidden = tab === 'library';
  $('#tab-library').hidden = tab !== 'library';
  if (tab === 'library') renderLibrary(); else renderQueue(tab);
}

const speciesOptions = (selected = '') =>
  '<option value="">— choose species —</option>' +
  species.map(s => `<option value="${esc(s.id)}" ${s.id === selected ? 'selected' : ''}>${esc(s.common_name)} — ${esc(s.scientific_name)}</option>`).join('');

async function renderQueue(status) {
  const box = $('#tab-queue');
  box.innerHTML = '<p class="muted"><span class="spinner"></span> Loading…</p>';
  let rows;
  try { rows = await store.listForReview(status); }
  catch (e) { box.innerHTML = `<p class="errors">${esc(e.message)}</p>`; return; }
  if (status === 'pending') $('#n-pending').textContent = rows.length || '';
  if (!rows.length) { box.innerHTML = `<div class="card center muted">Nothing ${status === 'pending' ? 'waiting for review' : 'here'}. </div>`; return; }
  box.innerHTML = (status === 'rejected'
      ? `<div class="card purge-bar"><span>${rows.length} rejected record${rows.length === 1 ? '' : 's'}. Purging deletes them and their photos permanently.</span>
         <button id="btn-purge" class="btn danger">Purge all rejected</button></div>`
      : '') + rows.map(cardHtml).join('');
  for (const r of rows) wireCard(r);
  const purge = $('#btn-purge');
  purge?.addEventListener('click', async () => {
    if (!purge.dataset.armed) {   // first tap arms, second tap purges
      purge.dataset.armed = '1';
      purge.textContent = `Tap again to permanently delete ${rows.length}`;
      setTimeout(() => { if (purge.isConnected && !purge.disabled) { delete purge.dataset.armed; purge.textContent = 'Purge all rejected'; } }, 5000);
      return;
    }
    purge.disabled = true; purge.textContent = 'Purging…';
    try {
      const n = await store.purgeRejected();
      toast(n ? `Purged ${n} rejected record${n === 1 ? '' : 's'}` : 'Nothing purged: check the delete permission (supabase/add-delete.sql)', n ? 'ok' : 'err');
    } catch (e) { toast(e.message, 'err'); }
    renderQueue('rejected');
  });
}

function cardHtml(r) {
  const ai = r.ai_suggestions?.results || [];
  const aiTop = ai[0]?.species_id;
  const preselect = aiTop || r.submitter_species_id || '';
  const delay = Date.parse(r.created_at) - Date.parse(r.taken_at);
  const flags = [...(r.exif?.warnings || [])];
  if (r.capture_method === 'in_app_camera' && delay > 6 * 3600e3) flags.push(`Uploaded ${ago(delay)} after capture (queued offline, or device clock wrong?)`);
  if (r.submitter_species_id && aiTop && r.submitter_species_id !== aiTop) flags.push('Submitter and AI disagree');
  const sub = r.submitter_species_id ? speciesById[r.submitter_species_id]?.common_name : 'not sure';
  return `
  <article class="card review-card" id="c-${r.id}">
    <div class="review-grid">
      <a href="${esc(r.photo_url)}" target="_blank" rel="noopener"><img class="preview" src="${esc(r.photo_url)}" alt="Submitted photo" loading="lazy"></a>
      <div>
        <div class="kv"><span>Taken</span><strong>${esc(fmtTaken(r.taken_at, r.local_offset_min))}</strong><em>${esc(LABELS.time_source[r.time_source])} · tz: ${esc(LABELS.tz_source[r.tz_source])}</em></div>
        <div class="kv"><span>Where</span><strong>${esc(fmtCoord(r.lat, r.lon))}${r.location_accuracy_m ? ` ±${Math.round(r.location_accuracy_m)} m` : ''}</strong><em>${esc(LABELS.location_source[r.location_source])}</em></div>
        <div class="kv"><span>Site</span><strong>${esc(r.site_name || '—')}</strong></div>
        <div class="kv"><span>Sharks in photo</span><strong>${r.shark_count ?? 1}</strong></div>
        <div class="kv"><span>Length / price</span><strong>${r.length_cm ? r.length_cm + ' cm' : '—'} / ${r.price != null ? 'SCR ' + r.price : '—'}</strong></div>
        ${r.notes ? `<div class="kv"><span>Notes</span><strong>${esc(r.notes)}</strong></div>` : ''}
        <div class="kv"><span>Submitted</span><strong>${esc(new Date(r.created_at).toLocaleString())}</strong><em>${esc(LABELS.capture_method[r.capture_method])}</em></div>
        ${flags.length ? `<div class="warnings">${flags.map(f => `<p>${esc(f)}</p>`).join('')}</div>` : ''}
        <details class="small"><summary>Raw photo data</summary><pre>${esc(JSON.stringify(r.exif, null, 2))}</pre></details>
      </div>
      <div>
        <div class="map small-map" id="m-${r.id}"></div>
        <h3>Identification</h3>
        <p class="small">Submitter: <strong>${esc(sub)}</strong></p>
        ${ai.length ? `<ol class="ai-list">${ai.map(a => `<li>${esc(speciesById[a.species_id]?.common_name || a.species_id)} <span class="muted">${Math.round(a.confidence * 100)}% · sim ${a.best_similarity}</span></li>`).join('')}</ol>`
                    : `<p class="small muted">No AI suggestion (${esc(r.ai_suggestions?.status || 'none')}).</p>`}
        ${r.status === 'pending' ? `
        <label class="field">Confirmed species <select class="sel-species">${speciesOptions(preselect)}</select></label>
        <div class="species-hint small muted"></div>
        <label class="field">Number of sharks <input class="count-input" type="number" min="1" max="500" value="${r.shark_count ?? 1}"></label>
        <label class="field">Review notes <input class="review-notes" type="text" maxlength="500" placeholder="Optional; required when rejecting"></label>` : `
        <p class="small">Status: <strong>${esc(r.status)}</strong>${r.confirmed_species_id ? ` as <strong>${esc(speciesById[r.confirmed_species_id]?.common_name || r.confirmed_species_id)}</strong>` : ''}${r.reviewed_at ? ` on ${esc(new Date(r.reviewed_at).toLocaleDateString())}` : ''}</p>
        ${r.review_notes ? `<p class="small muted">Notes: ${esc(r.review_notes)}</p>` : ''}`}
        <div class="btn-row">
          ${r.status === 'pending' ? `<button class="btn primary btn-approve">Approve</button>
          <button class="btn btn-reference" title="Train the identifier with this photo, but don't show it in Records">Reference only</button>
          <button class="btn danger btn-reject">Reject</button>` : ''}
          ${r.status === 'approved' ? `<button class="btn btn-to-reference" title="Remove from Records, keep for training">Make reference only</button>` : ''}
          ${r.status === 'reference' ? `<button class="btn btn-to-approved">Publish as record</button>` : ''}
          <button class="btn ghost btn-delete">Delete</button>
        </div>
      </div>
    </div>
  </article>`;
}

function wireCard(r) {
  const card = $(`#c-${CSS.escape(r.id)}`);
  showMap($(`#m-${CSS.escape(r.id)}`), [{ lat: r.lat, lon: r.lon, accuracy: r.location_accuracy_m }], { zoom: 14 });
  const del = $('.btn-delete', card);
  del.addEventListener('click', async () => {
    if (!del.dataset.armed) {   // first tap arms, second tap deletes
      del.dataset.armed = '1';
      del.textContent = 'Tap again to delete permanently';
      del.classList.replace('ghost', 'danger');
      setTimeout(() => { if (del.isConnected && !del.disabled) { delete del.dataset.armed; del.textContent = 'Delete'; del.classList.replace('danger', 'ghost'); } }, 5000);
      return;
    }
    setBusy(card, true);
    try { await store.deleteSubmission(r); card.remove(); toast('Deleted'); bumpCount(); }
    catch (e) { toast(e.message, 'err'); setBusy(card, false); }
  });
  const move = async (status, msg) => {
    setBusy(card, true);
    try {
      const patch = { status };
      if (!r.embedding) {
        try { patch.embedding = await embed(await loadImage(r.photo_url, true)); patch.embedding_model = MODEL_ID; }
        catch (e) { console.warn('No embedding', e); }
      }
      await store.reviewSubmission(r.id, patch);
      card.remove(); toast(msg); bumpCount();
    } catch (e) { toast(e.message, 'err'); setBusy(card, false); }
  };
  $('.btn-to-reference', card)?.addEventListener('click', () => move('reference', 'Moved to reference only (hidden from Records)'));
  $('.btn-to-approved', card)?.addEventListener('click', () => move('approved', 'Published to Records'));
  if (r.status !== 'pending') return;

  const sel = $('.sel-species', card);
  const hint = () => {
    const s = speciesById[sel.value];
    $('.species-hint', card).innerHTML = s ? `${iucnChip(s.iucn_status)} ${esc(s.id_features || '')}` : '';
  };
  sel.addEventListener('change', hint); hint();

  const accept = async (status) => {
    if (!sel.value) return toast('Choose the confirmed species first', 'err');
    setBusy(card, true);
    let embedding = null;
    try { embedding = await embed(await loadImage(r.photo_url, true)); }
    catch (e) { console.warn(e); toast('Approved without adding to the AI library (model or image unavailable)', 'warn'); }
    try {
      await store.reviewSubmission(r.id, {
        status, confirmed_species_id: sel.value,
        shark_count: Math.min(500, Math.max(1, parseInt($('.count-input', card).value, 10) || 1)),
        review_notes: $('.review-notes', card).value.trim() || null,
        embedding, embedding_model: embedding ? MODEL_ID : null,
      });
      card.remove(); toast(status === 'approved' ? 'Approved' : 'Added as reference only (hidden from Records)'); bumpCount();
    } catch (e) { toast(e.message, 'err'); setBusy(card, false); }
  };
  $('.btn-approve', card).addEventListener('click', () => accept('approved'));
  $('.btn-reference', card).addEventListener('click', () => accept('reference'));

  $('.btn-reject', card).addEventListener('click', async () => {
    const notes = $('.review-notes', card).value.trim();
    if (!notes) return toast('Add a short reason in review notes (e.g. "not a shark", "duplicate", "photo unclear")', 'err');
    setBusy(card, true);
    try {
      await store.reviewSubmission(r.id, { status: 'rejected', review_notes: notes });
      card.remove(); toast('Rejected'); bumpCount();
    } catch (e) { toast(e.message, 'err'); setBusy(card, false); }
  });
}
function setBusy(card, busy) { $$('button', card).forEach(b => (b.disabled = busy)); }
function bumpCount() {
  const n = $$('#tab-queue .review-card').length;
  if (currentTab === 'pending') $('#n-pending').textContent = n || '';
  if (!n) renderQueue(currentTab);
}

// ---------- reference library ----------
async function renderLibrary() {
  const lib = await store.getReferenceLibrary();
  const counts = {};
  for (const r of lib) if (r.embedding_model === MODEL_ID) counts[r.species_id] = (counts[r.species_id] || 0) + 1;
  $('#library-table').innerHTML = `<table class="table"><thead><tr><th>Species</th><th>IUCN</th><th>Photos in library</th></tr></thead><tbody>${
    species.filter(s => s.id !== 'unidentified').map(s => {
      const n = counts[s.id] || 0;
      return `<tr><td>${esc(s.common_name)} <i class="muted">${esc(s.scientific_name)}</i></td><td>${iucnChip(s.iucn_status)}</td><td><span class="${n < 5 ? 'warn-text' : ''}">${n}</span></td></tr>`;
    }).join('')}</tbody></table><p class="small muted">Aim for 5–10+ varied photos per species (different angles, sizes, lighting). Species with fewer than 5 are highlighted.</p>`;
}

$('#btn-add-refs').addEventListener('click', async () => {
  const sp = $('#ref-species').value, files = [...$('#ref-files').files];
  if (!sp || !files.length) return toast('Choose a species and at least one photo', 'err');
  const prog = $('#ref-progress');
  $('#btn-add-refs').disabled = true;
  let done = 0;
  for (const f of files) {
    prog.textContent = `Processing ${done + 1} of ${files.length}…`;
    const url = URL.createObjectURL(f);
    try {
      const embedding = await embed(await loadImage(url));
      await store.addReference({ species_id: sp, blob: f, credit: $('#ref-credit').value.trim() || null, embedding, embedding_model: MODEL_ID });
      done++;
    } catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
    finally { URL.revokeObjectURL(url); }
  }
  prog.textContent = `Added ${done} photo${done === 1 ? '' : 's'}.`;
  $('#ref-files').value = '';
  $('#btn-add-refs').disabled = false;
  renderLibrary();
});

boot();

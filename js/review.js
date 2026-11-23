// Reviewer page: approve / correct / reject submissions, manage reference library.
import { initShell, fmtTaken, fmtCoord, showMap, iucnChip, toast, ago } from './app.js';
import { $, $$, esc, loadImage } from './util.js';
import { LABELS } from './metadata.js';
import { embed, MODEL_ID } from './classifier.js';
import * as store from './store.js';
import { FLAG_LABELS } from './screen.js';

initShell('review');

let species = [], speciesById = {};
let currentTab = 'pending';
let me = null;          // reviewer row: { role, active, … }
let names = {};         // user_id → name
const isExpert = () => ['expert', 'admin'].includes(me?.role);
const CLAIM_BATCH = 5;

async function boot() {
  species = await store.listSpecies();
  speciesById = Object.fromEntries(species.map(s => [s.id, s]));
  const session = await store.getSession();
  if (!session) { $('#login').hidden = false; return; }
  try { me = await store.myReviewer(); } catch (e) { toast(e.message, 'err'); }
  if (!me?.active) {
    $('#not-reviewer').hidden = false;
    $$('.me-email').forEach(el => (el.textContent = session.user.email));
    $('#request-form-box').hidden = !!me;
    $('#request-waiting').hidden = !me;
    return;
  }
  $('#panel').hidden = false;
  $('#who').textContent = `${session.user.email} · ${me.role}`;
  $('[data-tab="expert"]').hidden = !isExpert();
  $('[data-tab="people"]').hidden = me.role !== 'admin';
  $('#ref-species').innerHTML = speciesOptions();
  store.reviewerNames().then(n => (names = n)).catch(() => {});
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
$('#signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#signup-msg');
  msg.hidden = false; msg.className = 'small';
  try {
    const signedIn = await store.signUp($('#su-email').value, $('#su-password').value);
    if (signedIn) { $('#login').hidden = true; boot(); return; }
    msg.textContent = 'Check your email and click the confirmation link, then sign in here and request reviewer access.';
  } catch (err) { msg.className = 'small errors'; msg.textContent = err.message; }
});
$('#request-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await store.requestAccess($('#rq-name').value.trim(), $('#rq-note').value.trim());
    $('#request-form-box').hidden = true; $('#request-waiting').hidden = false;
  } catch (err) { toast(err.message, 'err'); }
});
for (const id of ['#btn-signout', '#btn-signout-2']) $(id).addEventListener('click', async () => { await store.signOut(); location.reload(); });

$$('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
function showTab(tab) {
  currentTab = tab;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $('#tab-queue').hidden = ['library', 'people'].includes(tab);
  $('#tab-library').hidden = tab !== 'library';
  $('#tab-people').hidden = tab !== 'people';
  if (tab === 'library') renderLibrary();
  else if (tab === 'people') renderPeople();
  else renderQueue(tab);
  refreshCounts();
}

async function refreshCounts() {
  try {
    const c = await store.queueCounts();
    $('#n-pending').textContent = c.pending || '';
    $('#n-expert').textContent = c.expert || '';
  } catch (e) { /* badges are cosmetic */ }
}

const speciesOptions = (selected = '') =>
  '<option value="">— choose species —</option>' +
  species.map(s => `<option value="${esc(s.id)}" ${s.id === selected ? 'selected' : ''}>${esc(s.common_name)} — ${esc(s.scientific_name)}${s.expert_only ? ' (expert)' : ''}</option>`).join('');

const isQueue = tab => tab === 'pending' || tab === 'expert';
let decidedOffset = 0;

async function renderQueue(tab) {
  const box = $('#tab-queue');
  box.innerHTML = '<p class="muted"><span class="spinner"></span> Loading…</p>';
  let rows, more = false;
  try {
    if (isQueue(tab)) rows = await store.claimBatch(tab, CLAIM_BATCH);
    else { decidedOffset = 0; ({ rows, more } = await store.listForReview(tab)); decidedOffset = rows.length; }
  } catch (e) { box.innerHTML = `<p class="errors">${esc(e.message)}</p>`; return; }
  if (tab !== currentTab) return;
  if (!rows.length) { box.innerHTML = `<div class="card center muted">Nothing ${isQueue(tab) ? 'waiting for review' : 'here'}.</div>`; return; }
  box.innerHTML = (isQueue(tab)
      ? `<div class="card claim-bar small"><span>These ${rows.length} record${rows.length === 1 ? ' is' : 's are'} held for you for 15 minutes, so no one else reviews ${rows.length === 1 ? 'it' : 'them'}. <strong>Skip</strong> hands a record back.</span></div>`
      : tab === 'rejected'
        ? `<div class="card purge-bar"><span>Purging deletes every rejected record and its photos permanently.</span>
           <button id="btn-purge" class="btn danger">Purge all rejected</button></div>`
        : '') + rows.map(cardHtml).join('') +
    (more ? '<p class="center"><button id="btn-more-decided" class="btn">Load more</button></p>' : '');
  for (const r of rows) wireCard(r);
  $('#btn-more-decided')?.addEventListener('click', loadMoreDecided);
  const purge = $('#btn-purge');
  purge?.addEventListener('click', async () => {
    if (!purge.dataset.armed) {   // first tap arms, second tap purges
      purge.dataset.armed = '1';
      purge.textContent = 'Tap again to delete all rejected permanently';
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

async function loadMoreDecided() {
  const btn = $('#btn-more-decided');
  btn.disabled = true;
  try {
    const { rows, more } = await store.listForReview(currentTab, { offset: decidedOffset });
    decidedOffset += rows.length;
    btn.parentElement.insertAdjacentHTML('beforebegin', rows.map(cardHtml).join(''));
    for (const r of rows) wireCard(r);
    if (more) btn.disabled = false; else btn.parentElement.remove();
  } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
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
  // Screening flags from the phone. Pending photos that were flagged or never
  // checked are blurred until a reviewer chooses to look.
  const sflags = r.screening?.flags ?? (r.status === 'pending' ? ['not_screened'] : []);
  const blur = sflags.includes('explicit') || (r.status === 'pending' && sflags.length > 0);
  const why = sflags.map(f => FLAG_LABELS[f] || f);
  return `
  <article class="card review-card" id="c-${r.id}">
    <div class="review-grid">
      <div class="photo-wrap ${blur ? 'blurred' : ''}">
        <a href="${esc(r.photo_url)}" target="_blank" rel="noopener"><img class="preview" src="${esc(r.photo_url)}" alt="Submitted photo" loading="lazy"></a>
        ${blur ? `<button class="reveal" type="button"><strong>${esc(why[0] || 'Flagged')}</strong><span>Tap to show the photo</span></button>` : ''}
      </div>
      <div>
        <div class="kv"><span>Taken</span><strong>${esc(fmtTaken(r.taken_at, r.local_offset_min))}</strong><em>${esc(LABELS.time_source[r.time_source])} · tz: ${esc(LABELS.tz_source[r.tz_source])}</em></div>
        <div class="kv"><span>Where</span><strong>${esc(fmtCoord(r.lat, r.lon))}${r.location_accuracy_m ? ` ±${Math.round(r.location_accuracy_m)} m` : ''}</strong><em>${esc(LABELS.location_source[r.location_source])}</em></div>
        <div class="kv"><span>Site</span><strong>${esc(r.site_name || '—')}</strong></div>
        <div class="kv"><span>Sharks in photo</span><strong>${r.shark_count ?? 1}</strong></div>
        <div class="kv"><span>Length / price</span><strong>${r.length_cm ? r.length_cm + ' cm' : '—'} / ${r.price != null ? 'SCR ' + r.price : '—'}</strong></div>
        ${r.notes ? `<div class="kv"><span>Notes</span><strong>${esc(r.notes)}</strong></div>` : ''}
        <div class="kv"><span>Submitted</span><strong>${esc(new Date(r.created_at).toLocaleString())}</strong><em>${esc(LABELS.capture_method[r.capture_method])}</em></div>
        ${why.length ? `<div class="warnings screen-flags">${why.map(w => `<p>⚑ ${esc(w)}</p>`).join('')}</div>` : ''}
        ${r.needs_expert ? `<div class="warnings"><p><strong>Sent to an expert</strong>${r.escalation_note ? `: ${esc(r.escalation_note)}` : ''}</p></div>` : ''}
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
        <label class="field">Review notes <input class="review-notes" type="text" maxlength="500" placeholder="Optional; required when rejecting or sending to an expert"></label>` : `
        <p class="small">Status: <strong>${esc(r.status)}</strong>${r.confirmed_species_id ? ` as <strong>${esc(speciesById[r.confirmed_species_id]?.common_name || r.confirmed_species_id)}</strong>` : ''}${r.reviewed_at ? ` on ${esc(new Date(r.reviewed_at).toLocaleDateString())}` : ''}</p>
        ${r.review_notes ? `<p class="small muted">Notes: ${esc(r.review_notes)}</p>` : ''}`}
        <div class="btn-row">
          ${r.status === 'pending' ? `<button class="btn primary btn-approve">Approve</button>
          <button class="btn btn-reference" title="Train the identifier with this photo, but don't show it in Records">Reference only</button>
          ${!r.needs_expert ? '<button class="btn btn-escalate" title="Send to the expert queue. Put the reason in Review notes.">Needs expert</button>' : ''}
          <button class="btn ghost btn-skip" title="Hand this record back for someone else">Skip</button>
          <button class="btn danger btn-reject">Reject</button>` : ''}
          ${r.status === 'approved' ? `<button class="btn btn-to-reference" title="Remove from Records, keep for training">Make reference only</button>` : ''}
          ${r.status === 'reference' ? `<button class="btn btn-to-approved">Publish as record</button>` : ''}
          <button class="btn ghost btn-delete">Delete</button>
          ${me?.role === 'admin' && r.submitted_by && r.status !== 'approved' ? '<button class="btn ghost btn-block" title="Stop this phone uploading, and delete everything it has sent that isn\'t approved">Block this phone</button>' : ''}
        </div>
        ${r.status !== 'pending' ? '<details class="small history"><summary>History</summary><div class="muted">Loading…</div></details>' : ''}
      </div>
    </div>
  </article>`;
}

// A failed decision: if someone else holds the record, drop it from this list.
function failed(card, e) {
  toast(e.message, 'err');
  if (e?.code === 'P0409') { card.remove(); bumpCount(); } else setBusy(card, false);
}

function wireCard(r) {
  const card = $(`#c-${CSS.escape(r.id)}`);
  $('.reveal', card)?.addEventListener('click', e => { e.currentTarget.parentElement.classList.remove('blurred'); e.currentTarget.remove(); });
  const blk = $('.btn-block', card);
  blk?.addEventListener('click', async () => {
    if (!blk.dataset.armed) {   // first tap arms, second tap blocks
      blk.dataset.armed = '1';
      blk.textContent = 'Tap again: block and delete its unapproved records';
      blk.classList.replace('ghost', 'danger');
      setTimeout(() => { if (blk.isConnected && !blk.disabled) { delete blk.dataset.armed; blk.textContent = 'Block this phone'; blk.classList.replace('danger', 'ghost'); } }, 6000);
      return;
    }
    setBusy(card, true);
    try {
      const reason = $('.review-notes', card)?.value.trim() || null;
      const n = await store.blockContributor(r.submitted_by, reason);
      toast(`Phone blocked. ${n} unapproved record${n === 1 ? '' : 's'} deleted.`);
      renderQueue(currentTab); refreshCounts();
    } catch (e) { failed(card, e); }
  });
  const hist = $('.history', card);
  hist?.addEventListener('toggle', async () => {
    if (!hist.open || hist.dataset.loaded) return;
    hist.dataset.loaded = '1';
    const box = hist.lastElementChild;
    try {
      const ev = await store.reviewHistory(r.id);
      const sp = id => speciesById[id]?.common_name || id || '';
      box.innerHTML = ev.length ? `<ul>${ev.map(e => `<li>${esc(new Date(e.at).toLocaleString())} · <strong>${esc(names[e.actor] || 'unknown')}</strong>: ${esc(e.action)}${e.new_species ? ` as ${esc(sp(e.new_species))}` : ''}${e.old_species && e.old_species !== e.new_species ? ` (was ${esc(sp(e.old_species))})` : ''}${e.note ? ` · “${esc(e.note)}”` : ''}</li>`).join('')}</ul>` : 'No history recorded (decided before history was switched on).';
    } catch (e) { box.textContent = e.message; }
  });
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
    catch (e) { failed(card, e); }
  });
  const move = async (status, msg) => {
    setBusy(card, true);
    try {
      const patch = { status };
      if (!r.embedding_model) {
        try { patch.embedding = await embed(await loadImage(r.photo_url, true)); patch.embedding_model = MODEL_ID; }
        catch (e) { console.warn('No embedding', e); }
      }
      await store.reviewSubmission(r, patch);
      card.remove(); toast(msg); bumpCount();
    } catch (e) { failed(card, e); }
  };
  $('.btn-to-reference', card)?.addEventListener('click', () => move('reference', 'Moved to reference only (hidden from Records)'));
  $('.btn-to-approved', card)?.addEventListener('click', () => move('approved', 'Published to Records'));
  if (r.status !== 'pending') return;

  const sel = $('.sel-species', card);
  const hint = () => {
    const s = speciesById[sel.value];
    $('.species-hint', card).innerHTML = s ? `${iucnChip(s.iucn_status)} ${esc(s.id_features || '')}` +
      (s.expert_only && !isExpert() ? '<p class="warn-text">Only an expert can confirm this species. Use <strong>Needs expert</strong>.</p>' : '') : '';
  };
  sel.addEventListener('change', hint); hint();

  const accept = async (status) => {
    if (!sel.value) return toast('Choose the confirmed species first', 'err');
    setBusy(card, true);
    let embedding = null;
    try { embedding = await embed(await loadImage(r.photo_url, true)); }
    catch (e) { console.warn(e); toast('Approved without adding to the AI library (model or image unavailable)', 'warn'); }
    try {
      await store.reviewSubmission(r, {
        status, confirmed_species_id: sel.value,
        shark_count: Math.min(500, Math.max(1, parseInt($('.count-input', card).value, 10) || 1)),
        review_notes: $('.review-notes', card).value.trim() || null,
        embedding, embedding_model: embedding ? MODEL_ID : null,
      });
      card.remove(); toast(status === 'approved' ? 'Approved' : 'Added as reference only (hidden from Records)'); bumpCount();
    } catch (e) { failed(card, e); }
  };
  $('.btn-approve', card).addEventListener('click', () => accept('approved'));
  $('.btn-reference', card).addEventListener('click', () => accept('reference'));

  $('.btn-skip', card).addEventListener('click', async () => {
    setBusy(card, true);
    try { await store.releaseClaim(r.id); } catch (e) { console.warn(e); }
    card.remove(); bumpCount();
  });
  $('.btn-escalate', card)?.addEventListener('click', async () => {
    const note = $('.review-notes', card).value.trim();
    if (!note) return toast('Say what the expert should check in Review notes (e.g. "hammerhead: scalloped or great?")', 'err');
    setBusy(card, true);
    try {
      await store.reviewSubmission(r, { needs_expert: true, escalation_note: note });
      card.remove(); toast('Sent to the expert queue'); bumpCount();
    } catch (e) { failed(card, e); }
  });

  $('.btn-reject', card).addEventListener('click', async () => {
    const notes = $('.review-notes', card).value.trim();
    if (!notes) return toast('Add a short reason in review notes (e.g. "not a shark", "duplicate", "photo unclear")', 'err');
    setBusy(card, true);
    try {
      await store.reviewSubmission(r, { status: 'rejected', review_notes: notes });
      card.remove(); toast('Rejected'); bumpCount();
    } catch (e) { failed(card, e); }
  });
}
function setBusy(card, busy) { $$('button', card).forEach(b => (b.disabled = busy)); }
function bumpCount() {
  refreshCounts();
  if (!$$('#tab-queue .review-card').length) renderQueue(currentTab);   // queue tabs: claim the next batch
}

// ---------- reference library ----------
async function renderLibrary() {
  let counts = {};
  try { counts = await store.libraryCounts(MODEL_ID); }
  catch (e) { $('#library-table').innerHTML = `<p class="errors">${esc(e.message)}</p>`; return; }
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


// ---------- batch import: species ID taken from the file name ----------
// "<species-id>__anything.jpg" → species-id. Unknown IDs are skipped.
function bulkPlan() {
  const ids = new Set(species.map(s => s.id));
  return [...$('#bulk-files').files].map(f => {
    const id = f.name.split('__')[0].toLowerCase();
    return { f, id: ids.has(id) ? id : null };
  });
}
$('#bulk-files').addEventListener('change', () => {
  const plan = bulkPlan(), ok = plan.filter(p => p.id);
  const name = id => species.find(s => s.id === id)?.common_name || id;
  $('#bulk-preview').innerHTML = plan.length ? `<p>${ok.length} of ${plan.length} files matched a species.</p><ul>${
    plan.map(p => `<li>${esc(p.f.name)} → ${p.id ? esc(name(p.id)) : '<span class="warn-text">no matching species — skipped</span>'}</li>`).join('')}</ul>` : '';
  $('#btn-bulk-refs').disabled = !ok.length;
});
$('#btn-bulk-refs').addEventListener('click', async () => {
  const plan = bulkPlan().filter(p => p.id);
  if (!plan.length) return;
  const prog = $('#bulk-progress'), credit = $('#bulk-credit').value.trim() || null;
  $('#btn-bulk-refs').disabled = true;
  let done = 0;
  for (const [i, { f, id }] of plan.entries()) {
    prog.textContent = `Processing ${i + 1} of ${plan.length}…`;
    const url = URL.createObjectURL(f);
    try {
      const embedding = await embed(await loadImage(url));
      await store.addReference({ species_id: id, blob: f, credit, embedding, embedding_model: MODEL_ID });
      done++;
    } catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
    finally { URL.revokeObjectURL(url); }
  }
  prog.textContent = `Imported ${done} of ${plan.length} photo${plan.length === 1 ? '' : 's'}.`;
  $('#bulk-files').value = ''; $('#bulk-preview').innerHTML = '';
  renderLibrary();
});

// ---------- people (admins) ----------
async function renderBlocked() {
  const box = $('#blocked-table');
  let rows;
  try { rows = await store.blockedList(); } catch (e) { box.innerHTML = `<p class="errors">${esc(e.message)}</p>`; return; }
  box.innerHTML = rows.length ? `<table class="table"><thead><tr><th>Phone (anonymous ID)</th><th>Blocked</th><th>Reason</th><th>Approved records kept</th><th></th></tr></thead><tbody>${
    rows.map(b => `<tr data-id="${esc(b.user_id)}"><td class="mono small">${esc(b.user_id.slice(0, 8))}…</td>
      <td>${esc(new Date(b.blocked_at).toLocaleDateString())}${b.blocked_by_name ? ` by ${esc(b.blocked_by_name)}` : ''}</td>
      <td>${esc(b.reason || '—')}</td><td>${b.approved_records}</td>
      <td><button class="btn ghost btn-unblock">Unblock</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">No blocked phones.</p>';
  $$('.btn-unblock', box).forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await store.unblockContributor(b.closest('tr').dataset.id); toast('Unblocked'); } catch (e) { toast(e.message, 'err'); }
    renderBlocked();
  }));
}

async function renderPeople() {
  renderBlocked();
  const box = $('#people-table');
  box.innerHTML = '<p class="muted"><span class="spinner"></span> Loading…</p>';
  let rows;
  try { rows = await store.reviewerStats(); } catch (e) { box.innerHTML = `<p class="errors">${esc(e.message)}</p>`; return; }
  const when = d => (d ? new Date(d).toLocaleDateString() : '—');
  box.innerHTML = rows.length ? `<table class="table"><thead><tr><th>Person</th><th>Status</th><th>Role</th><th>Decisions (30 days / all)</th><th>Last decision</th><th></th></tr></thead><tbody>${
    rows.map(p => `<tr data-id="${esc(p.user_id)}">
      <td><strong>${esc(p.name || '—')}</strong><br><span class="small muted">${esc(p.email || '')}</span>${p.request_note ? `<br><span class="small">“${esc(p.request_note)}”</span>` : ''}</td>
      <td>${p.active ? 'Active' : p.requested_at ? `<span class="warn-text">Requested ${esc(when(p.requested_at))}</span>` : 'Inactive'}</td>
      <td><select class="sel-role">${['reviewer', 'expert', 'admin'].map(r => `<option ${r === p.role ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
      <td>${p.decisions_30d} / ${p.decisions_total}</td>
      <td>${esc(when(p.last_decision))}</td>
      <td class="btn-row">${p.active ? '<button class="btn ghost btn-deactivate">Deactivate</button>' : '<button class="btn primary btn-activate">Approve</button>'}
        <button class="btn ghost btn-remove">Remove</button></td>
    </tr>`).join('')}</tbody></table>` : '<p class="muted">No reviewers yet.</p>';
  $$('tr[data-id]', box).forEach(tr => {
    const id = tr.dataset.id;
    const save = async (patch, msg) => {
      $$('button,select', tr).forEach(b => (b.disabled = true));
      try { await store.updateReviewer(id, patch); toast(msg); } catch (e) { toast(e.message, 'err'); }
      renderPeople();
    };
    $('.sel-role', tr)?.addEventListener('change', e => save({ role: e.target.value }, 'Role changed'));
    $('.btn-activate', tr)?.addEventListener('click', () => save({ active: true }, 'Reviewer approved'));
    $('.btn-deactivate', tr)?.addEventListener('click', () => save({ active: false }, 'Reviewer deactivated'));
    const rm = $('.btn-remove', tr);
    rm.addEventListener('click', async () => {
      if (!rm.dataset.armed) { rm.dataset.armed = '1'; rm.textContent = 'Tap again to remove'; rm.classList.replace('ghost', 'danger'); return; }
      try { await store.removeReviewer(id); toast('Removed'); } catch (e) { toast(e.message, 'err'); }
      renderPeople();
    });
  });
}


boot();

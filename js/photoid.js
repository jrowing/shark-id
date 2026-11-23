// Photo-ID screen (reviewers): crop the flank (or back/belly) of an animal with
// individual markings, compare it with every catalogued photo of that species
// and side, then link the record to a known individual or start a new one.
import { loadScript, esc, loadImage } from './util.js?v=12';
import * as core from './photoid-core.js?v=12';
import * as store from './store.js?v=12';

const CV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@5.0.0-release.1/dist/opencv.js';
let cvPromise;
export function loadCV() {
  return (cvPromise ??= (async () => {
    await loadScript(CV_URL);
    let cv = window.cv;
    if (cv instanceof Promise) cv = await cv;
    else if (!cv?.Mat) await new Promise(res => { cv.onRuntimeInitialized = res; });
    window.cv = cv;
    return cv;
  })().catch(e => { cvPromise = null; throw e; }));
}

export const SIDES = { left: 'Left flank', right: 'Right flank', dorsal: 'Back (from above)', ventral: 'Belly (from below)', other: 'Other' };

// Pixels of a region of an image, scaled so its longest side is at most maxDim.
function regionPixels(img, crop, maxDim = core.PARAMS.maxDim) {
  const s = Math.min(1, maxDim / Math.max(crop.w, crop.h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(crop.w * s)); c.height = Math.max(1, Math.round(crop.h * s));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height);
}

// Best score per individual, strongest first.
export function rankIndividuals(scored) {
  const best = new Map();
  for (const s of scored) {
    const cur = best.get(s.individual_id);
    if (!cur || s.inliers > cur.inliers) best.set(s.individual_id, s);
  }
  return [...best.values()].sort((a, b) => b.inliers - a.inliers);
}

// r: record (needs id, photo_url). speciesId: confirmed species.
// Resolves { individual_id, code } when linked, or null.
export function openPhotoId(r, speciesId, speciesName) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'measure-overlay';
    ov.innerHTML = `
      <div class="measure-top">
        <div class="measure-step"><strong>Photo-ID: ${esc(speciesName)}.</strong> Drag a tight box around the markings (e.g. the flank between the gills and the tail), choose the side, then find matches.</div>
        <div class="measure-controls">
          <label>Side <select class="p-side">${Object.entries(SIDES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
          <button class="btn p-find">Find matches</button>
        </div>
      </div>
      <div class="measure-stage"><canvas></canvas></div>
      <div class="measure-bottom">
        <div class="p-status small"></div>
        <div class="pid-panel"><div class="pid-results"></div></div>
        <div class="btn-row">
          <button class="btn ghost p-cancel">Cancel</button>
          <button class="btn p-new" disabled>New individual</button>
          <button class="btn primary p-link" disabled>Link to selected</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    document.body.classList.add('no-scroll');
    const $ = s => ov.querySelector(s);
    const canvas = $('.measure-stage > canvas'), ctx = canvas.getContext('2d');
    let img, view = {}, crop = null, dragStart = null, feats = null, chosen = null;
    const status = (html) => { $('.p-status').innerHTML = html; };

    function layout() {
      const st = $('.measure-stage'), W = st.clientWidth, H = st.clientHeight, dpr = window.devicePixelRatio || 1;
      canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      const s = Math.min(W / img.naturalWidth, H / img.naturalHeight);
      view = { s, ox: (W - img.naturalWidth * s) / 2, oy: (H - img.naturalHeight * s) / 2, dpr };
      draw();
    }
    function draw() {
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, view.ox, view.oy, img.naturalWidth * view.s, img.naturalHeight * view.s);
      if (crop) {
        const x = view.ox + crop.x * view.s, y = view.oy + crop.y * view.s, w = crop.w * view.s, h = crop.h * view.s;
        ctx.fillStyle = 'rgba(0,0,0,.45)';
        ctx.fillRect(0, 0, canvas.clientWidth, y); ctx.fillRect(0, y + h, canvas.clientWidth, canvas.clientHeight);
        ctx.fillRect(0, y, x, h); ctx.fillRect(x + w, y, canvas.clientWidth, h);
        ctx.strokeStyle = '#2dd4bf'; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
      }
    }
    const toImg = e => {
      const b = canvas.getBoundingClientRect();
      return [Math.min(img.naturalWidth, Math.max(0, (e.clientX - b.left - view.ox) / view.s)),
              Math.min(img.naturalHeight, Math.max(0, (e.clientY - b.top - view.oy) / view.s))];
    };
    canvas.addEventListener('pointerdown', e => { e.preventDefault(); canvas.setPointerCapture(e.pointerId); dragStart = toImg(e); });
    canvas.addEventListener('pointermove', e => {
      if (!dragStart) return;
      const [x, y] = toImg(e);
      crop = { x: Math.round(Math.min(x, dragStart[0])), y: Math.round(Math.min(y, dragStart[1])),
               w: Math.round(Math.abs(x - dragStart[0])), h: Math.round(Math.abs(y - dragStart[1])) };
      draw();
    });
    canvas.addEventListener('pointerup', () => { dragStart = null; if (crop && (crop.w < 40 || crop.h < 40)) crop = null; draw(); });

    const close = val => { window.removeEventListener('resize', layout); document.body.classList.remove('no-scroll'); ov.remove(); resolve(val); };
    $('.p-cancel').addEventListener('click', () => close(null));
    window.addEventListener('resize', layout);

    $('.p-find').addEventListener('click', async () => {
      const btn = $('.p-find');
      if (!crop) { status('<span class="warn-text">Drag a box around the markings first. Keep it tight: leave out the background, people, and any scale card or ruler (those look the same in every photo and cause false matches).</span>'); return; }
      btn.disabled = true; chosen = null; $('.p-link').disabled = true;
      try {
        status('<span class="spinner"></span> Loading the matcher (about 10 MB the first time)…');
        const cv = await loadCV();
        const c = crop;
        status('<span class="spinner"></span> Finding markings…');
        await new Promise(r => setTimeout(r, 20));
        const f = core.extract(cv, regionPixels(img, c));
        feats = { ...f, crop: c, side: $('.p-side').value };
        if (f.keypoints.length < 30) {
          status(`<span class="warn-text">Only ${f.keypoints.length} features found. Use a sharper photo or a box that's tighter on the markings.</span>`);
        }
        status('<span class="spinner"></span> Comparing with the catalogue…');
        const cat = await store.photoidFeatures(speciesId, feats.side, core.MODEL);
        const scored = [];
        for (const k of cat) {
          if (k.submission_id === r.id) continue;
          const s = core.score(cv, f, { keypoints: k.keypoints, descriptors: core.fromBase64(k.descriptors) });
          scored.push({ ...s, individual_id: k.individual_id, code: k.code, thumb_url: k.thumb_url });
        }
        const ranked = rankIndividuals(scored).slice(0, 8);
        const top = ranked[0];
        status(cat.length
          ? `${f.keypoints.length} features. Compared with ${cat.length} catalogued photo${cat.length === 1 ? '' : 's'} of this side. ` +
            (top && core.band(top.inliers) === 'strong' ? '<strong>Strong match found.</strong> Check the markings by eye before linking.'
              : top && core.band(top.inliers) === 'possible' ? 'Possible match: compare the photos carefully.'
              : 'No convincing match: this may be a new individual.')
          : 'Nothing catalogued for this species and side yet. Start a new individual.');
        $('.pid-results').innerHTML = ranked.map(x => `
          <button class="pid-result ${core.band(x.inliers)}" data-id="${esc(x.individual_id)}" data-code="${esc(x.code || '')}">
            ${x.thumb_url ? `<img src="${esc(x.thumb_url)}" alt="">` : ''}
            <strong>${esc(x.code || 'individual')}</strong><br>${x.inliers} matching points · ${esc(core.band(x.inliers))}
          </button>`).join('');
        ov.querySelectorAll('.pid-result').forEach(b => b.addEventListener('click', () => {
          chosen = { individual_id: b.dataset.id, code: b.dataset.code };
          ov.querySelectorAll('.pid-result').forEach(x => x.classList.toggle('chosen', x === b));
          $('.p-link').disabled = false;
          $('.p-link').textContent = `Link to ${chosen.code}`;
        }));
        $('.p-new').disabled = false;
        layout();   // the results panel took space from the photo
      } catch (e) {
        status(`<span class="warn-text">${esc(e.message || String(e))}</span>`);
      } finally { btn.disabled = false; }
    });

    async function save(individual_id, code) {
      for (const b of ov.querySelectorAll('button')) b.disabled = true;
      try {
        await store.catalogueSighting(r, {
          individual_id, species_id: speciesId, side: feats.side, crop: feats.crop, model: core.MODEL,
          keypoints: feats.keypoints, descriptors: core.toBase64(feats.descriptors),
        });
        close({ individual_id, code });
      } catch (e) {
        status(`<span class="warn-text">${esc(e.message)}</span>`);
        for (const b of ov.querySelectorAll('button')) b.disabled = false;
      }
    }
    $('.p-link').addEventListener('click', () => chosen && save(chosen.individual_id, chosen.code));
    $('.p-new').addEventListener('click', async () => {
      try {
        const ind = await store.createIndividual({ species_id: speciesId });
        await save(ind.id, ind.code);
      } catch (e) { status(`<span class="warn-text">${esc(e.message)}</span>`); }
    });

    loadImage(r.photo_url, true).then(i => { img = i; layout(); status('Drag a tight box around the markings. Leave out any scale card, ruler or background.'); })
      .catch(() => { status('<span class="warn-text">Could not load the photo.</span>'); });
  });
}

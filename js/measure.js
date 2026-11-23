// Size from a photo. The user taps the two ends of a reference of known length
// lying beside the animal (a Sharkive scale card, a tape, a sheet of A4…), then
// the two ends of the animal. Length = animal pixels × (reference cm / reference pixels).
// Points are stored as fractions of the photo's width and height, so they still
// fit after the photo is resized for upload.
//
// This is only fair when the reference is flat, right next to the animal and the
// same distance from the camera, with the camera looking straight down or
// straight at the side. The tool says so, and records what was used.
import { esc } from './util.js?v=15';

export const REFERENCES = {
  card:  { label: 'Sharkive scale card (20 cm bar)', cm: 20 },
  a4:    { label: 'A4 sheet, long edge (29.7 cm)', cm: 29.7 },
  bank:  { label: 'Bank card, long edge (8.56 cm)', cm: 8.56 },
  other: { label: 'Something else (enter its length)', cm: null },
};
export const MEASURES = {
  TL: 'Tip of the snout → tip of the tail',
  FL: 'Tip of the snout → fork of the tail',
  DW: 'Wing tip → wing tip (across the disc)',
};
export const MODEL = 'photo-ref-v1';

// ---------- pure maths (unit-tested) ----------
export function distPx([ax, ay], [bx, by], w, h) {
  return Math.hypot((bx - ax) * w, (by - ay) * h);
}
// m: { ref: [[x,y],[x,y]], body: [[x,y],[x,y]], ref_cm, image_w, image_h } with fractional points.
export function computeLength(m) {
  if (m?.ref?.length !== 2 || m?.body?.length !== 2 || !(m.ref_cm > 0)) return null;
  const r = distPx(m.ref[0], m.ref[1], m.image_w, m.image_h);
  const b = distPx(m.body[0], m.body[1], m.image_w, m.image_h);
  if (r < 4) return null;
  return Math.round((b * m.ref_cm / r) * 10) / 10;
}
// Warnings that make the number less trustworthy.
export function measureWarnings(m) {
  const w = [];
  const r = distPx(m.ref[0], m.ref[1], m.image_w, m.image_h);
  const b = distPx(m.body[0], m.body[1], m.image_w, m.image_h);
  if (r < 40) w.push('The reference is very small in the photo, so a small tapping error changes the length a lot. Move closer.');
  if (b > 0 && r / b < 0.08) w.push('The reference is much shorter than the animal. A longer reference (or a tape along the body) gives a better estimate.');
  return w;
}

// ---------- the measuring screen ----------
// Opens a full-screen measuring tool on an image URL. Resolves with the
// measurement object, or null if cancelled.
// opts: { measure: 'TL'|'FL'|'DW', existing }
export function openMeasure(imageUrl, { measure = 'TL', existing = null } = {}) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'measure-overlay';
    ov.innerHTML = `
      <div class="measure-top">
        <div class="measure-step"></div>
        <div class="measure-controls">
          <label>Reference <select class="m-ref">${Object.entries(REFERENCES).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select></label>
          <label class="m-other" hidden>Length (cm) <input class="m-ref-cm" type="number" min="1" max="500" step="0.1" inputmode="decimal"></label>
          <label>Measure <select class="m-measure">${Object.entries(MEASURES).map(([k, v]) => `<option value="${k}">${esc(k)}: ${esc(v)}</option>`).join('')}</select></label>
        </div>
      </div>
      <div class="measure-stage"><canvas></canvas><div class="loupe" hidden><canvas width="140" height="140"></canvas></div></div>
      <div class="measure-bottom">
        <div class="m-result"></div>
        <div class="btn-row">
          <button class="btn ghost m-cancel">Cancel</button>
          <button class="btn m-undo">Undo point</button>
          <button class="btn primary m-done" disabled>Use this length</button>
        </div>
        <p class="small muted">Only works if the reference is flat, right beside the animal and the camera is square-on. Drag a point to fine-tune it.</p>
      </div>`;
    document.body.appendChild(ov);
    document.body.classList.add('no-scroll');
    const $ = s => ov.querySelector(s);
    const canvas = $('.measure-stage > canvas'), ctx = canvas.getContext('2d');
    const loupe = $('.loupe'), lctx = $('.loupe canvas').getContext('2d');
    $('.m-measure').value = existing?.measure || measure;
    if (existing) {
      $('.m-ref').value = existing.ref_kind in REFERENCES ? existing.ref_kind : 'other';
      $('.m-ref-cm').value = existing.ref_cm;
    }
    const img = new Image();
    let pts = existing ? [...existing.ref, ...existing.body].map(p => [...p]) : [];
    let view = { s: 1, ox: 0, oy: 0 };
    let drag = -1;

    const refCm = () => {
      const k = $('.m-ref').value;
      $('.m-other').hidden = k !== 'other';
      return k === 'other' ? Number($('.m-ref-cm').value) : REFERENCES[k].cm;
    };
    const current = () => ({
      model: MODEL, ref_kind: $('.m-ref').value, ref_cm: refCm(), measure: $('.m-measure').value,
      ref: pts.slice(0, 2), body: pts.slice(2, 4), image_w: img.naturalWidth, image_h: img.naturalHeight,
    });

    function layout() {
      const stage = $('.measure-stage');
      const W = stage.clientWidth, H = stage.clientHeight, dpr = window.devicePixelRatio || 1;
      canvas.width = W * dpr; canvas.height = H * dpr;
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      const s = Math.min(W / img.naturalWidth, H / img.naturalHeight);
      view = { s, ox: (W - img.naturalWidth * s) / 2, oy: (H - img.naturalHeight * s) / 2, dpr };
      draw();
    }
    const toScreen = ([fx, fy]) => [view.ox + fx * img.naturalWidth * view.s, view.oy + fy * img.naturalHeight * view.s];
    const toFrac = (x, y) => [
      Math.min(1, Math.max(0, (x - view.ox) / (img.naturalWidth * view.s))),
      Math.min(1, Math.max(0, (y - view.oy) / (img.naturalHeight * view.s)))];

    function draw() {
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, view.ox, view.oy, img.naturalWidth * view.s, img.naturalHeight * view.s);
      const line = (a, b, colour) => {
        if (!a || !b) return;
        const [ax, ay] = toScreen(a), [bx, by] = toScreen(b);
        ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        ctx.strokeStyle = colour; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      };
      line(pts[0], pts[1], '#f5a524');
      line(pts[2], pts[3], '#2dd4bf');
      pts.forEach((p, i) => {
        const [x, y] = toScreen(p);
        ctx.fillStyle = i < 2 ? '#f5a524' : '#2dd4bf';
        ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      });
      const steps = ['Tap one end of the reference', 'Tap the other end of the reference',
        `Tap the start: ${MEASURES[$('.m-measure').value].split(' → ')[0].toLowerCase()}`, `Tap the end: ${MEASURES[$('.m-measure').value].split(' → ')[1]?.toLowerCase() || ''}`];
      $('.measure-step').innerHTML = pts.length < 4
        ? `<strong>Step ${pts.length + 1} of 4.</strong> ${esc(steps[pts.length])}`
        : '<strong>Done.</strong> Drag any point to adjust it.';
      const m = current();
      const len = pts.length === 4 ? computeLength(m) : null;
      const warn = len ? measureWarnings(m) : [];
      $('.m-result').innerHTML = len ? `<span class="m-len">${len} cm</span> <span class="muted small">${esc(m.measure)}</span>` +
        warn.map(w => `<p class="small warn-text">${esc(w)}</p>`).join('') : (m.ref_cm > 0 ? '' : '<p class="small warn-text">Enter the length of the reference.</p>');
      $('.m-done').disabled = !len;
    }
    function showLoupe(x, y) {
      const [fx, fy] = toFrac(x, y);
      const sx = fx * img.naturalWidth, sy = fy * img.naturalHeight, r = 35;
      lctx.clearRect(0, 0, 140, 140);
      lctx.drawImage(img, sx - r, sy - r, r * 2, r * 2, 0, 0, 140, 140);
      lctx.strokeStyle = '#fff'; lctx.lineWidth = 1;
      lctx.beginPath(); lctx.moveTo(70, 0); lctx.lineTo(70, 140); lctx.moveTo(0, 70); lctx.lineTo(140, 70); lctx.stroke();
      loupe.hidden = false;
      loupe.style.left = (x < canvas.clientWidth / 2 ? canvas.clientWidth - 150 : 10) + 'px';
      loupe.style.top = '10px';
    }
    const pos = e => { const b = canvas.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    canvas.addEventListener('pointerdown', e => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const [x, y] = pos(e);
      drag = pts.findIndex(p => { const [px, py] = toScreen(p); return Math.hypot(px - x, py - y) < 24; });
      if (drag < 0 && pts.length < 4) { pts.push(toFrac(x, y)); drag = pts.length - 1; }
      showLoupe(x, y); draw();
    });
    canvas.addEventListener('pointermove', e => {
      if (drag < 0) return;
      const [x, y] = pos(e);
      pts[drag] = toFrac(x, y);
      showLoupe(x, y); draw();
    });
    const up = () => { drag = -1; loupe.hidden = true; };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);

    for (const sel of ['.m-ref', '.m-ref-cm', '.m-measure']) $(sel).addEventListener('input', draw);
    $('.m-undo').addEventListener('click', () => { pts.pop(); draw(); });
    const close = val => { window.removeEventListener('resize', layout); document.body.classList.remove('no-scroll'); ov.remove(); resolve(val); };
    $('.m-cancel').addEventListener('click', () => close(null));
    $('.m-done').addEventListener('click', () => {
      const m = current();
      close({ ...m, value_cm: computeLength(m), warnings: measureWarnings(m) });
    });
    window.addEventListener('resize', layout);
    img.onload = () => { refCm(); layout(); };
    img.onerror = () => { close(null); };
    img.src = imageUrl;
  });
}

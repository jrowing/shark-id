// Shared page shell: nav, connection/queue status, service worker, formatting, maps.
import { isDemo } from './store.js';
import { count as queueCount, flush } from './queue.js';
import { $, esc, loadScript, loadCss } from './util.js';

export const IUCN = {
  CR: ['Critically Endangered', 'cr'], EN: ['Endangered', 'en'], VU: ['Vulnerable', 'vu'],
  NT: ['Near Threatened', 'nt'], LC: ['Least Concern', 'lc'], DD: ['Data Deficient', 'dd'], NE: ['Not evaluated', 'ne'],
};
export function iucnChip(code) {
  const [label, cls] = IUCN[code] || IUCN.NE;
  return `<span class="iucn iucn-${cls}" title="IUCN Red List: ${label}">${esc(code || 'NE')} · ${label}</span>`;
}

export function fmtOffset(min) {
  const a = Math.abs(min);
  return `UTC${min >= 0 ? '+' : '−'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
// Shows the time as it was on the clock where the photo was taken.
export function fmtTaken(iso, offsetMin, { withZone = true } = {}) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (offsetMin == null) return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const local = new Date(d.getTime() + offsetMin * 60000);
  const s = local.toLocaleString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return withZone ? `${s} (${fmtOffset(offsetMin)})` : s;
}
export function fmtCoord(lat, lon) {
  if (lat == null || lon == null) return '—';
  return `${Math.abs(lat).toFixed(5)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(5)}°${lon >= 0 ? 'E' : 'W'}`;
}
export function ago(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

export async function loadLeaflet() {
  loadCss('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css');
  await loadScript('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js');
  return window.L;
}
export async function showMap(el, points, { zoom = 15 } = {}) {
  try {
    const L = await loadLeaflet();
    if (el._map) el._map.remove();
    const map = L.map(el, { scrollWheelZoom: false });
    el._map = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
    const pts = points.filter(p => p.lat != null && p.lon != null);
    for (const p of pts) {
      const m = L.circleMarker([p.lat, p.lon], { radius: 7, weight: 2, color: '#0b3d5c', fillColor: '#2bb3a3', fillOpacity: 0.9 }).addTo(map);
      if (p.accuracy) L.circle([p.lat, p.lon], { radius: p.accuracy, weight: 1, color: '#2bb3a3', fillOpacity: 0.08 }).addTo(map);
      if (p.popup) m.bindPopup(p.popup);
    }
    if (pts.length === 1) map.setView([pts[0].lat, pts[0].lon], zoom);
    else if (pts.length) map.fitBounds(pts.map(p => [p.lat, p.lon]), { padding: [24, 24], maxZoom: 14 });
    else map.setView([-4.33, 55.73], 10); // Praslin
    return map;
  } catch (e) {
    el.innerHTML = '<p class="muted small">Map unavailable offline.</p>';
  }
}

export function initShell(active) {
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.page === active));
  if (isDemo) {
    const b = document.createElement('div');
    b.className = 'demo-banner';
    b.innerHTML = '<strong>Demo mode</strong> — data stays in this browser. Add your Supabase keys in <code>js/config.js</code> to go live.';
    document.body.prepend(b);
  }
  const pill = $('#status');
  async function refresh() {
    if (!pill) return;
    const n = await queueCount().catch(() => 0);
    const online = navigator.onLine;
    pill.className = 'status ' + (online ? 'online' : 'offline');
    pill.textContent = (online ? 'Online' : 'Offline') + (n ? ` · ${n} waiting to upload` : '');
  }
  window.addEventListener('online', () => { flush(); refresh(); });
  window.addEventListener('offline', refresh);
  window.addEventListener('queue-changed', refresh);
  refresh();
  flush();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

export function toast(msg, kind = 'ok') {
  const t = document.createElement('div');
  t.className = `toast toast-${kind}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 4000);
}

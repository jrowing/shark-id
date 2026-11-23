// Capture metadata: WHEN and WHERE a photo was taken.
// Rule: the capture time always comes from the photo itself (EXIF) or from the
// in-app shutter — never typed in by the user, never the file's modified date.
// Photos without a trustworthy capture time are rejected.
import { RULES } from './config.js?v=12';
import { loadScript } from './util.js?v=12';

const EXIFR_URL = 'https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.esm.mjs';
const PIEXIF_URL = 'https://cdn.jsdelivr.net/npm/piexifjs@1.0.6/piexif.js';
let exifrPromise;
const exifr = () => (exifrPromise ??= import(EXIFR_URL).then(m => m.default));

// ---------- parsing helpers (pure, unit-testable) ----------
export function parseExifDate(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s ?? ''));
  return m ? m.slice(1).map(Number) : null;
}
export function parseOffset(s) {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(String(s ?? '').trim());
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : null;
}
export function gpsUtcMs(dateStamp, timeStamp) {
  const d = /^(\d{4})[:-](\d{2})[:-](\d{2})/.exec(String(dateStamp ?? ''));
  if (!d) return null;
  let h, mi, s;
  if (Array.isArray(timeStamp)) [h, mi, s] = timeStamp.map(Number);
  else {
    const t = /^(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(String(timeStamp ?? ''));
    if (!t) return null;
    [h, mi, s] = [+t[1], +t[2], +t[3]];
  }
  if (![h, mi, s].every(Number.isFinite)) return null;
  return Date.UTC(+d[1], +d[2] - 1, +d[3], h, mi, Math.floor(s));
}

// Works out the absolute capture instant from EXIF tags.
// Returns { taken_at, local_offset_min, tz_source } or null if no capture time.
export function resolveCaptureTime(tags) {
  const parts = parseExifDate(tags?.DateTimeOriginal ?? tags?.CreateDate);
  if (!parts) return null;
  const [Y, M, D, h, mi, s] = parts;
  const wallAsUtc = Date.UTC(Y, M - 1, D, h, mi, s);

  let offset = parseOffset(tags.OffsetTimeOriginal ?? tags.OffsetTimeDigitized ?? tags.OffsetTime);
  let tz_source = 'exif_offset';
  if (offset == null) {
    const g = gpsUtcMs(tags.GPSDateStamp, tags.GPSTimeStamp); // GPS time is always UTC
    if (g != null) {
      const diff = (wallAsUtc - g) / 60000;
      const rounded = Math.round(diff / 15) * 15;
      if (Math.abs(rounded) <= 14 * 60 && Math.abs(diff - rounded) <= 5) { offset = rounded; tz_source = 'gps_utc'; }
    }
  }
  if (offset == null) {
    offset = -new Date(Y, M - 1, D, h, mi, s).getTimezoneOffset();
    tz_source = 'device';
  }
  return { taken_at: new Date(wallAsUtc - offset * 60000).toISOString(), local_offset_min: offset, tz_source };
}

export function checkTime(meta, now = Date.now()) {
  const t = Date.parse(meta.taken_at);
  if (t > now + RULES.maxFutureSkewMin * 60000) meta.errors.push('The capture time is in the future, so the phone clock or photo data is wrong. Check the date and time settings on the phone that took it.');
  if (new Date(t).getUTCFullYear() < RULES.earliestYear) meta.errors.push('The capture time is implausibly old. The camera clock was probably never set.');
  if (now - t > 365 * 86400000) meta.warnings.push('This photo is over a year old.');
  if (meta.tz_source === 'device') meta.warnings.push('The photo does not record its time zone; assumed to be the same as this device.');
}

// ---------- existing photo (gallery / file) ----------
export async function readFileMetadata(file) {
  const meta = { capture_method: 'file', errors: [], warnings: [], exif: {} };
  let tags = null, gps = null;
  try {
    const ex = await exifr();
    tags = await ex.parse(file, { tiff: true, exif: true, gps: true, ifd1: false, interop: false, xmp: false, reviveValues: false });
    gps = await ex.gps(file).catch(() => null);
  } catch (e) {
    if (!navigator.onLine) meta.errors.push('The photo reader is not available offline yet. Use the in-app camera, or connect once so the app can cache it.');
  }
  tags = tags || {};
  meta.exif = pickExif(tags, gps);

  const time = resolveCaptureTime(tags);
  if (!time) {
    meta.errors.push('This photo has no original capture time in its data, so it cannot be logged. Use the in-app camera, or pick the original photo straight from the camera roll (screenshots and photos forwarded through WhatsApp/Messenger lose this data).');
  } else {
    Object.assign(meta, time, { time_source: 'exif' });
    checkTime(meta);
  }

  if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude) && !(gps.latitude === 0 && gps.longitude === 0)) {
    meta.lat = gps.latitude;
    meta.lon = gps.longitude;
    meta.location_accuracy_m = numOrNull(tags.GPSHPositioningError);
    meta.location_source = 'exif';
  } else if (time) {
    const ageMin = (Date.now() - Date.parse(time.taken_at)) / 60000;
    if (ageMin <= RULES.maxFallbackPhotoAgeMin && ageMin >= -RULES.maxFutureSkewMin) {
      meta.needsLiveGps = true; // caller fetches a live fix; photo is fresh enough to assume same place
    } else {
      meta.errors.push(`This photo has no location in its data. Location can only be added from this phone's GPS when the photo is under ${RULES.maxFallbackPhotoAgeMin} minutes old. Turn on location for the camera app, or use the in-app camera.`);
    }
  }
  return meta;
}

function numOrNull(v) { const n = Number(Array.isArray(v) ? v[0] : v); return Number.isFinite(n) ? n : null; }

function pickExif(t, gps) {
  const keep = ['Make', 'Model', 'Software', 'DateTimeOriginal', 'CreateDate', 'ModifyDate', 'OffsetTimeOriginal', 'OffsetTime',
    'GPSDateStamp', 'GPSTimeStamp', 'GPSHPositioningError', 'GPSAltitude', 'ImageWidth', 'ImageHeight', 'ExifImageWidth', 'ExifImageHeight'];
  const out = {};
  for (const k of keep) if (t[k] != null) out[k] = Array.isArray(t[k]) || typeof t[k] !== 'object' ? t[k] : String(t[k]);
  if (gps) { out.GPSLatitude = gps.latitude; out.GPSLongitude = gps.longitude; }
  return out;
}

// ---------- live GPS ----------
export function currentPosition(timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('This device has no GPS / location service.'));
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 });
  });
}

// ---------- in-app capture: write EXIF into the JPEG so the file carries its own data ----------
function dms(deg) {
  const a = Math.abs(deg), d = Math.floor(a), mf = (a - d) * 60, m = Math.floor(mf), s = Math.round((mf - m) * 60 * 10000);
  return [[d, 1], [m, 1], [s, 10000]];
}
const pad = n => String(n).padStart(2, '0');

export async function embedExif(jpegBlob, { takenAt, offsetMin, lat, lon }) {
  try {
    await loadScript(PIEXIF_URL);
    const piexif = window.piexif;
    const local = new Date(takenAt.getTime() + offsetMin * 60000); // read with getUTC* = local wall time
    const wall = `${local.getUTCFullYear()}:${pad(local.getUTCMonth() + 1)}:${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
    const u = takenAt;
    const exifObj = {
      '0th': { [piexif.ImageIFD.Software]: 'The Sharkive web app', [piexif.ImageIFD.DateTime]: wall },
      Exif: { [piexif.ExifIFD.DateTimeOriginal]: wall, [piexif.ExifIFD.DateTimeDigitized]: wall },
      GPS: {
        [piexif.GPSIFD.GPSLatitudeRef]: lat >= 0 ? 'N' : 'S', [piexif.GPSIFD.GPSLatitude]: dms(lat),
        [piexif.GPSIFD.GPSLongitudeRef]: lon >= 0 ? 'E' : 'W', [piexif.GPSIFD.GPSLongitude]: dms(lon),
        [piexif.GPSIFD.GPSDateStamp]: `${u.getUTCFullYear()}:${pad(u.getUTCMonth() + 1)}:${pad(u.getUTCDate())}`,
        [piexif.GPSIFD.GPSTimeStamp]: [[u.getUTCHours(), 1], [u.getUTCMinutes(), 1], [u.getUTCSeconds(), 1]],
      },
    };
    const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(jpegBlob); });
    const withExif = piexif.insert(piexif.dump(exifObj), dataUrl);
    return await (await fetch(withExif)).blob();
  } catch (e) {
    console.warn('Could not embed EXIF; metadata is still stored with the record', e);
    return jpegBlob;
  }
}

export const LABELS = {
  time_source: { live_capture: 'In-app camera shutter', exif: 'Photo data (EXIF)' },
  tz_source: { device: 'device time zone (assumed)', exif_offset: 'photo data', gps_utc: 'GPS clock' },
  location_source: { live_gps: 'GPS at the shutter', exif: 'Photo data (EXIF GPS)', live_gps_at_upload: 'GPS when added (photo < 30 min old)' },
  capture_method: { in_app_camera: 'In-app camera', file: 'Existing photo' },
  context: { market: 'Landed or for sale', in_water: 'Alive, in the water', shallows: 'Alive, in the shallows' },
  sex: { male: 'Male (claspers)', female: 'Female (no claspers)', unknown: 'Can\'t tell' },
  life_stage: { neonate: 'Newborn (umbilical scar)', juvenile: 'Juvenile', adult: 'Adult', unknown: 'Not sure' },
  measure: { TL: 'total length (snout to tail tip)', FL: 'fork length (snout to tail fork)', DW: 'disc width (wing tip to wing tip)' },
  quality: { research: 'Research grade', verified: 'Verified' },
};

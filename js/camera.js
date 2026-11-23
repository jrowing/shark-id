// In-app camera. The shutter press is the capture time; GPS is watched the
// whole time the camera is open so a fix is ready at the moment of capture.
import { RULES } from './config.js?v=15';
import { embedExif } from './metadata.js?v=15';

export class Camera {
  constructor(video, onStatus) {
    this.video = video;
    this.onStatus = onStatus || (() => {});
    this.fixes = [];
    this.stream = null;
    this.watchId = null;
  }

  async open() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot open the camera. Use "Choose an existing photo" instead.');
    if (!('geolocation' in navigator)) throw new Error('This device has no location service, which the app needs to log where the photo was taken.');
    this.watchId = navigator.geolocation.watchPosition(
      pos => { this.fixes.push(pos); if (this.fixes.length > 50) this.fixes.shift(); this.onStatus(this.gpsStatus()); },
      err => this.onStatus({ ok: false, text: err.code === 1 ? 'Location permission denied — allow location to log sharks.' : 'Waiting for GPS…' }),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 60000 });
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1920 } }, audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.onStatus(this.gpsStatus());
  }

  gpsStatus() {
    const f = this.fixes.at(-1);
    if (!f) return { ok: false, text: 'Waiting for GPS…' };
    const acc = Math.round(f.coords.accuracy);
    return { ok: acc <= RULES.maxGpsAccuracyM, text: acc <= RULES.maxGpsAccuracyM ? `GPS ready (±${acc} m)` : `GPS weak (±${acc} m) — improving…` };
  }

  bestFixNear(t, maxAcc) {
    const ok = this.fixes.filter(f => Math.abs(f.timestamp - t) <= RULES.maxGpsFixGapMs && f.coords.accuracy <= maxAcc);
    ok.sort((a, b) => Math.abs(a.timestamp - t) - Math.abs(b.timestamp - t) || a.coords.accuracy - b.coords.accuracy);
    return ok[0] || null;
  }

  // Freeze a frame now; then wait (if needed) for a GPS fix close to that instant.
  async shutter() {
    const takenAt = new Date();
    const v = this.video;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth; canvas.height = v.videoHeight;
    canvas.getContext('2d').drawImage(v, 0, 0);
    const raw = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.9));

    const t = takenAt.getTime();
    let fix = this.bestFixNear(t, RULES.maxGpsAccuracyM);
    const warnings = [];
    if (!fix) {
      this.onStatus({ ok: false, text: 'Photo taken — waiting for a GPS fix…' });
      const deadline = Date.now() + RULES.gpsWaitAfterShutterMs;
      while (!fix && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 500));
        fix = this.bestFixNear(t, RULES.maxGpsAccuracyM);
      }
      if (!fix) {
        fix = this.bestFixNear(t, RULES.maxGpsAccuracyFallbackM);
        if (fix) warnings.push(`GPS accuracy was only ±${Math.round(fix.coords.accuracy)} m.`);
      }
    }
    if (!fix) throw new Error('No GPS fix within 30 seconds of taking the photo. Step outside or near a window, wait for "GPS ready", then try again.');

    const offsetMin = -takenAt.getTimezoneOffset();
    const blob = await embedExif(raw, { takenAt, offsetMin, lat: fix.coords.latitude, lon: fix.coords.longitude });
    return {
      blob,
      meta: {
        capture_method: 'in_app_camera',
        taken_at: takenAt.toISOString(), local_offset_min: offsetMin,
        time_source: 'live_capture', tz_source: 'device',
        lat: fix.coords.latitude, lon: fix.coords.longitude,
        location_accuracy_m: Math.round(fix.coords.accuracy), location_source: 'live_gps',
        exif: { gps_fix_time: new Date(fix.timestamp).toISOString(), gps_fix_gap_s: Math.round((fix.timestamp - t) / 1000), width: canvas.width, height: canvas.height },
        errors: [], warnings,
      },
    };
  }

  close() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null; this.watchId = null; this.fixes = [];
  }
}

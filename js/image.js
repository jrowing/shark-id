// Photo preparation: every upload is resized on the phone before it leaves.
// Full image: longest side 1600 px, JPEG ~0.2–0.6 MB, with the capture time and
// GPS written back into its EXIF. Thumbnail: 400 px for lists and the map.
import { embedExif } from './metadata.js?v=15';

export const FULL = { maxDim: 1600, quality: 0.82 };
export const THUMB = { maxDim: 400, quality: 0.7 };

async function decode(blob) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
    catch (e) { /* fall through to <img>, e.g. older Safari */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('This phone can\'t read that photo format. Use the in-app camera, or a JPEG photo.'));
      img.src = url;
    });
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

function encode(src, { maxDim, quality }) {
  const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not encode the photo'))), 'image/jpeg', quality));
}

// Returns { full, thumb } JPEG blobs.
export async function resizePhoto(blob) {
  const src = await decode(blob);
  try {
    const [full, thumb] = await Promise.all([encode(src, FULL), encode(src, THUMB)]);
    return { full, thumb };
  } finally { src.close?.(); }
}

// Resize and re-stamp EXIF from the record's verified capture data, so the
// stored file still carries its own time and place.
export async function prepareUpload(record, blob) {
  const { full, thumb } = await resizePhoto(blob);
  const stamped = await embedExif(full, {
    takenAt: new Date(record.taken_at),
    offsetMin: record.local_offset_min ?? 0,
    lat: record.lat, lon: record.lon,
  });
  return { full: stamped, thumb };
}

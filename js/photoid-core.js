// Photo-ID matching core: ORB keypoints + binary descriptors (OpenCV.js), matched
// with a ratio test and checked for geometric consistency with a RANSAC homography.
// The score is the number of RANSAC inliers: random spot patterns from different
// animals rarely line up, the same animal's spots do (after rotation, scale and
// some perspective change).
//
// No DOM here, so it can be tested in Node with the same OpenCV.js build.
export const MODEL = 'orb-v1';
export const PARAMS = { maxDim: 900, nfeatures: 800, ratio: 0.8, ransacPx: 6, minGood: 8 };
// Score bands (RANSAC inliers). Tuned on test pairs; revisit with real photos.
export const STRONG = 25;
export const POSSIBLE = 12;

// imageData: { data: Uint8ClampedArray RGBA, width, height } of the cropped region.
// Returns { keypoints: [[x, y], …], descriptors: Uint8Array (32 bytes each), width, height }.
export function extract(cv, imageData, { nfeatures = PARAMS.nfeatures } = {}) {
  const src = cv.matFromImageData(imageData);
  const gray = new cv.Mat(), eq = new cv.Mat(), kps = new cv.KeyPointVector(), desc = new cv.Mat(), noMask = new cv.Mat();
  let orb, clahe;
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    // Even out lighting so markings, not glare, drive the keypoints.
    clahe = new cv.CLAHE(3.0, new cv.Size(8, 8));
    clahe.apply(gray, eq);
    orb = new cv.ORB(nfeatures);
    orb.detectAndCompute(eq, noMask, kps, desc);
    const n = kps.size();
    const keypoints = [];
    for (let i = 0; i < n; i++) { const k = kps.get(i); keypoints.push([Math.round(k.pt.x * 10) / 10, Math.round(k.pt.y * 10) / 10]); }
    const descriptors = n ? new Uint8Array(desc.data.slice(0, n * 32)) : new Uint8Array(0);
    return { keypoints, descriptors, width: imageData.width, height: imageData.height };
  } finally {
    for (const m of [src, gray, eq, kps, desc, noMask]) m.delete();
    orb?.delete(); clahe?.delete();
  }
}

// Number of geometrically consistent matches between two feature sets.
export function score(cv, a, b, { ratio = PARAMS.ratio, ransacPx = PARAMS.ransacPx, minGood = PARAMS.minGood } = {}) {
  if (a.keypoints.length < minGood || b.keypoints.length < minGood) return { good: 0, inliers: 0 };
  const da = cv.matFromArray(a.keypoints.length, 32, cv.CV_8U, a.descriptors);
  const db = cv.matFromArray(b.keypoints.length, 32, cv.CV_8U, b.descriptors);
  const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const knn = new cv.DMatchVectorVector();
  try {
    bf.knnMatch(da, db, knn, 2);
    const good = [];
    const usedB = new Set();
    for (let i = 0; i < knn.size(); i++) {
      const m = knn.get(i);
      if (m.size() < 2) continue;
      const m0 = m.get(0), m1 = m.get(1);
      if (m0.distance < ratio * m1.distance && !usedB.has(m0.trainIdx)) { good.push(m0); usedB.add(m0.trainIdx); }
    }
    if (good.length < minGood) return { good: good.length, inliers: 0 };
    const ptsA = [], ptsB = [];
    for (const g of good) { ptsA.push(...a.keypoints[g.queryIdx]); ptsB.push(...b.keypoints[g.trainIdx]); }
    const ma = cv.matFromArray(good.length, 1, cv.CV_32FC2, ptsA);
    const mb = cv.matFromArray(good.length, 1, cv.CV_32FC2, ptsB);
    const mask = new cv.Mat();
    let H;
    try {
      H = cv.findHomography(ma, mb, cv.RANSAC, ransacPx, mask);
      if (H.empty()) return { good: good.length, inliers: 0 };
      let inliers = 0;
      for (let i = 0; i < mask.rows; i++) if (mask.data[i]) inliers++;
      return { good: good.length, inliers };
    } finally { ma.delete(); mb.delete(); mask.delete(); H?.delete(); }
  } finally { da.delete(); db.delete(); bf.delete(); knn.delete(); }
}

export function band(inliers) {
  return inliers >= STRONG ? 'strong' : inliers >= POSSIBLE ? 'possible' : 'weak';
}

// Descriptors travel as base64 text.
export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(b64) {
  const s = atob(b64 || '');
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

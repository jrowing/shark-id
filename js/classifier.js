// Species suggestion — non-generative.
// MobileNet V2 (ImageNet-pretrained) turns each photo into a 1280-number
// "fingerprint" (embedding). A new photo is compared with the fingerprints of
// every reviewer-confirmed photo (k-nearest neighbours, cosine similarity).
// The library grows with each approval, so the suggestions improve over time.
// Swap in a fine-tuned model later by changing MODEL_ID + embed().
import { AI } from './config.js?v=16';
import { loadScript } from './util.js?v=16';

export const MODEL_ID = 'mobilenet_v2_1.0_flipavg_v1';
const TFJS = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
const MOBILENET = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/dist/mobilenet.min.js';

// TensorFlow.js on its own (the explicit-image check needs it, not MobileNet).
export function loadTf() { return loadScript(TFJS); }

let modelPromise;
export function loadModel() {
  return (modelPromise ??= (async () => {
    await loadScript(TFJS);
    await loadScript(MOBILENET);
    const opts = { version: 2, alpha: 1.0 };
    if (AI.modelUrl) opts.modelUrl = AI.modelUrl;
    return window.mobilenet.load(opts);
  })().catch(e => { modelPromise = null; throw e; }));
}

// L2-normalised embedding averaged over the image and its mirror image
// (sharks are photographed facing either way).
export async function embed(img) {
  const model = await loadModel();
  const tf = window.tf;
  const vec = tf.tidy(() => {
    const x = tf.browser.fromPixels(img);
    const a = model.infer(x, true);
    const b = model.infer(tf.reverse(x, 1), true);
    const m = a.add(b).div(2).squeeze();
    return m.div(m.norm());
  });
  const out = Array.from(await vec.data());
  vec.dispose();
  return out.map(v => Math.round(v * 1e5) / 1e5); // compact for storage
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// Turn nearest neighbours [{species_id, sim}] into up to 3 species suggestions.
export function aggregate(neighbours, { library_size = 0, species_in_library = 0, source = 'server' } = {}) {
  if (!neighbours?.length) return { status: 'no_library', results: [], library_size: 0 };
  const nn = [...neighbours].sort((a, b) => b.sim - a.sim);
  const top = nn[0].sim;
  const agg = {};
  for (const n of nn) {
    const w = Math.exp((n.sim - top) / AI.temperature);
    const a = (agg[n.species_id] ??= { species_id: n.species_id, weight: 0, best_similarity: n.sim, votes: 0 });
    a.weight += w; a.votes += 1;
  }
  const total = Object.values(agg).reduce((s, a) => s + a.weight, 0);
  const results = Object.values(agg)
    .map(a => ({ species_id: a.species_id, confidence: +(a.weight / total).toFixed(3), best_similarity: +a.best_similarity.toFixed(3), votes: a.votes }))
    .sort((a, b) => b.confidence - a.confidence).slice(0, 3);
  return { status: 'ok', source, results, library_size, species_in_library };
}

// Offline fallback: compare with one average fingerprint per species.
export function rankCentroids(queryEmbedding, centroids) {
  const refs = (centroids || []).filter(c => c.embedding?.length === queryEmbedding.length);
  const nn = refs.map(c => {
    const norm = Math.sqrt(dot(c.embedding, c.embedding)) || 1;
    return { species_id: c.species_id, sim: dot(queryEmbedding, c.embedding) / norm };
  });
  return aggregate(nn, { library_size: refs.reduce((s, c) => s + c.n, 0), species_in_library: refs.length, source: 'offline' });
}

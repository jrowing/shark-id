// Species suggestion — non-generative.
// MobileNet V2 (ImageNet-pretrained) turns each photo into a 1280-number
// "fingerprint" (embedding). A new photo is compared with the fingerprints of
// every reviewer-confirmed photo (k-nearest neighbours, cosine similarity).
// The library grows with each approval, so the suggestions improve over time.
// Swap in a fine-tuned model later by changing MODEL_ID + embed().
import { AI } from './config.js';
import { loadScript } from './util.js';

export const MODEL_ID = 'mobilenet_v2_1.0_flipavg_v1';
const TFJS = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
const MOBILENET = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/dist/mobilenet.min.js';

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

// Returns { status, results:[{species_id, confidence, best_similarity, votes}], library_size }
export function rank(queryEmbedding, library, k = AI.k) {
  const refs = library.filter(r => r.embedding_model === MODEL_ID && r.embedding?.length === queryEmbedding.length);
  if (!refs.length) return { status: 'no_library', results: [], library_size: 0 };
  const nn = refs.map(r => ({ species_id: r.species_id, sim: dot(queryEmbedding, r.embedding) }))
    .sort((a, b) => b.sim - a.sim).slice(0, k);
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
  return { status: 'ok', results, library_size: refs.length, species_in_library: new Set(refs.map(r => r.species_id)).size };
}

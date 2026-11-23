// On-phone photo screening, before anything is uploaded.
//  • Explicit-image check: NSFW.js MobileNetV2 (models/nsfw, MIT licence, ~2.6 MB, cached).
//  • "Is it a fish?": the ImageNet classes of the MobileNet the app already uses
//    for species suggestions (it knows great white, tiger and hammerhead sharks,
//    rays and a dozen other fish), plus similarity to confirmed shark photos.
// This runs on the phone, so a determined person could skip it. It stops casual
// misuse and wrong-photo mistakes, and tells reviewers what to look at carefully.
import { loadModel as loadMobileNet, loadTf } from './classifier.js?v=14';

export const SCREEN_VERSION = 1;
const NSFW_MODEL = new URL('../models/nsfw/model.json', import.meta.url).href;
const NSFW_CLASSES = ['drawing', 'hentai', 'neutral', 'porn', 'sexy'];

// ImageNet classes that a photo of a landed shark plausibly falls into.
const FISHY = new Set(['great white shark', 'tiger shark', 'hammerhead', 'electric ray', 'stingray', 'tench', 'goldfish',
  'barracouta', 'eel', 'coho', 'rock beauty', 'anemone fish', 'sturgeon', 'gar', 'lionfish', 'puffer',
  'grey whale', 'killer whale', 'dugong']);
const SHARKS = new Set(['great white shark', 'tiger shark', 'hammerhead']);

export const RULES = {
  blockExplicit: 0.85,   // porn + hentai: refuse to upload
  flagExplicit: 0.30,    // porn + hentai: flag for reviewers
  flagSuggestive: 0.60,  // "sexy": flag for reviewers
  minFishy: 0.10,        // below this, and…
  minSimilarity: 0.55,   // …unlike every confirmed shark photo: "doesn't look like a shark"
};

export const FLAG_LABELS = {
  explicit: 'May be explicit or otherwise inappropriate',
  not_shark: 'Doesn\'t look like a shark or fish',
  not_screened: 'Not checked on the phone (offline, or sent from an older version of the app)',
};

let nsfwPromise;
async function loadNsfw() {
  await loadTf();
  return (nsfwPromise ??= window.tf.loadLayersModel(NSFW_MODEL).catch(e => { nsfwPromise = null; throw e; }));
}

async function nsfwScores(img) {
  const model = await loadNsfw();
  const tf = window.tf;
  const out = tf.tidy(() => {
    const x = tf.browser.fromPixels(img).toFloat().div(255);
    const r = tf.image.resizeBilinear(x, [224, 224], true).reshape([1, 224, 224, 3]);
    return model.predict(r);
  });
  const p = await out.data();
  out.dispose();
  return Object.fromEntries(NSFW_CLASSES.map((c, i) => [c, +p[i].toFixed(3)]));
}

async function fishScores(img) {
  const model = await loadMobileNet();
  const preds = await model.classify(img, 30);
  let fishy = 0, shark = 0;
  for (const p of preds) {
    const name = p.className.split(',')[0].trim().toLowerCase();
    if (FISHY.has(name)) fishy += p.probability;
    if (SHARKS.has(name)) shark += p.probability;
  }
  return { fishy: +fishy.toFixed(3), shark: +shark.toFixed(3), top: preds.slice(0, 3).map(p => p.className.split(',')[0]) };
}

// Pure decision from the scores (exported for testing).
export function decide({ nsfw, fish, bestSimilarity }) {
  const flags = [];
  let block = null;
  if (nsfw) {
    const explicit = nsfw.porn + nsfw.hentai;
    if (explicit >= RULES.blockExplicit) block = 'explicit';
    else if (explicit >= RULES.flagExplicit || nsfw.sexy >= RULES.flagSuggestive) flags.push('explicit');
  }
  if (fish && fish.fishy < RULES.minFishy && !(bestSimilarity >= RULES.minSimilarity)) flags.push('not_shark');
  if (!nsfw || !fish) flags.push('not_screened');
  return { flags, block };
}

// img: a loaded <img>/bitmap. bestSimilarity: top similarity from species matching, if any.
export async function screenPhoto(img, { bestSimilarity = null } = {}) {
  const [n, f] = await Promise.allSettled([nsfwScores(img), fishScores(img)]);
  const nsfw = n.status === 'fulfilled' ? n.value : null;
  const fish = f.status === 'fulfilled' ? f.value : null;
  if (!nsfw) console.warn('Explicit-image check unavailable', n.reason);
  if (!fish) console.warn('Fish check unavailable', f.reason);
  return { version: SCREEN_VERSION, nsfw, fish, best_similarity: bestSimilarity, ...decide({ nsfw, fish, bestSimilarity }) };
}

export const NOT_SCREENED = { version: SCREEN_VERSION, nsfw: null, fish: null, flags: ['not_screened'], block: null };

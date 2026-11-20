// Offline-first submission queue: everything is saved locally first, then
// uploaded whenever there is a connection (markets often have poor signal).
// Failed attempts keep their error message so the user can see what went wrong.
import * as idb from './idb.js';
import { submit } from './store.js';

const ATTEMPT_TIMEOUT_MS = 120000;
let flushing = null;

export async function enqueue(record, blob) {
  await idb.put('queue', { id: record.id, record, blob, queued_at: Date.now(), attempts: 0, last_error: null });
  flush();
}

export async function items() {
  return (await idb.all('queue')).sort((a, b) => a.queued_at - b.queued_at);
}

export async function count() {
  return (await idb.all('queue')).length;
}

export async function discard(id) {
  await idb.del('queue', id);
  window.dispatchEvent(new CustomEvent('queue-changed'));
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`Upload timed out after ${ms / 1000} s (slow or interrupted connection)`)), ms))]);
}

function describe(e) {
  if (!e) return 'Unknown error';
  const parts = [e.message || String(e)];
  if (e.code) parts.push(`code ${e.code}`);
  if (e.details) parts.push(e.details);
  if (e.hint) parts.push(e.hint);
  return parts.join(' · ');
}

export function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    if (!navigator.onLine) return;
    for (const item of await items()) {
      window.dispatchEvent(new CustomEvent('queue-changed', { detail: { uploading: item.id } }));
      try {
        await withTimeout(submit(item.record, item.blob), ATTEMPT_TIMEOUT_MS);
        await idb.del('queue', item.id);
      } catch (e) {
        console.warn('Upload failed, will retry later', e);
        await idb.put('queue', { ...item, attempts: (item.attempts || 0) + 1, last_error: describe(e), last_attempt: Date.now() });
      }
      window.dispatchEvent(new CustomEvent('queue-changed'));
    }
  })().finally(() => { flushing = null; window.dispatchEvent(new CustomEvent('queue-changed')); });
  return flushing;
}

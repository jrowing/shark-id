// Offline-first submission queue: everything is saved locally first, then
// uploaded whenever there is a connection (markets often have poor signal).
import * as idb from './idb.js';
import { submit } from './store.js';

let flushing = null;

export async function enqueue(record, blob) {
  await idb.put('queue', { id: record.id, record, blob, queued_at: Date.now() });
  flush();
}

export async function count() {
  return (await idb.all('queue')).length;
}

export function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    if (!navigator.onLine) return;
    const items = (await idb.all('queue')).sort((a, b) => a.queued_at - b.queued_at);
    for (const item of items) {
      try {
        await submit(item.record, item.blob);
        await idb.del('queue', item.id);
        window.dispatchEvent(new CustomEvent('queue-changed'));
      } catch (e) {
        console.warn('Upload failed, will retry later', e);
        break;
      }
    }
  })().finally(() => { flushing = null; window.dispatchEvent(new CustomEvent('queue-changed')); });
  return flushing;
}

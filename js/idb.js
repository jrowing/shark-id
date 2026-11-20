// Tiny IndexedDB wrapper: offline queue, demo-mode storage and caches.
const DB_NAME = 'shark-id';
const VERSION = 1;
const STORES = ['queue', 'demo_submissions', 'demo_references', 'cache'];
let dbPromise;

function open() {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const put = (store, value) => run(store, 'readwrite', s => s.put(value));
export const get = (store, id) => run(store, 'readonly', s => s.get(id));
export const all = (store) => run(store, 'readonly', s => s.getAll());
export const del = (store, id) => run(store, 'readwrite', s => s.delete(id));

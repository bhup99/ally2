/* Tiny promise-based IndexedDB wrapper for scan history.
   No dependencies. Stores one object store ("scans") keyed by entry id. */

const DB_NAME = 'allergy-scanner';
const STORE = 'scans';
const VERSION = 1;

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB not available'));
        return;
      }
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('by-timestamp', 'timestamp', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB open blocked'));
    }).catch((err) => {
      dbPromise = null; // allow a later retry
      throw err;
    });
  }
  return dbPromise;
}

function run(mode, work) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        let tx;
        try {
          tx = db.transaction(STORE, mode);
        } catch (err) {
          reject(err);
          return;
        }
        const store = tx.objectStore(STORE);
        let result;
        try {
          result = work(store);
        } catch (err) {
          reject(err);
          return;
        }
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      })
  );
}

/**
 * Save one scan entry. Entry shape:
 * { id, timestamp, source, image (Blob|null), extractedText,
 *   matchedAllergens: string[], matches: object[], verdict }
 */
export function saveScan(entry) {
  return run('readwrite', (store) => store.put(entry));
}

/** All entries, newest first. */
export function listScans() {
  return run('readonly', (store) => {
    const index = store.index('by-timestamp');
    const out = [];
    const req = index.openCursor(null, 'prev');
    return new Promise((resolve, reject) => {
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          out.push(cursor.value);
          cursor.continue();
        } else {
          resolve(out);
        }
      };
      req.onerror = () => reject(req.error || new Error('IndexedDB read failed'));
    });
  });
}

export function getScan(id) {
  return run('readonly', (store) => {
    return new Promise((resolve, reject) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('IndexedDB read failed'));
    });
  });
}

export function deleteScan(id) {
  return run('readwrite', (store) => store.delete(id));
}

export function clearScans() {
  return run('readwrite', (store) => store.clear());
}

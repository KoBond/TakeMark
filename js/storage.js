// Простое хранилище «ключ → значение» в IndexedDB с запасным вариантом localStorage.

const DB_NAME = 'takemark';
const STORE = 'kv';
const LS_PREFIX = 'takemark:';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('no indexedDB'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const ls = {
  get(k) {
    try { const v = localStorage.getItem(LS_PREFIX + k); return v ? JSON.parse(v) : undefined; }
    catch { return undefined; }
  },
  set(k, v) {
    try { localStorage.setItem(LS_PREFIX + k, JSON.stringify(v)); } catch { /* нет места */ }
  },
};

export const store = {
  async get(key) {
    try { return await tx('readonly', s => s.get(key)); }
    catch { return ls.get(key); }
  },
  async set(key, value) {
    // копия через JSON гарантирует, что значение сериализуемо
    const v = JSON.parse(JSON.stringify(value));
    try { await tx('readwrite', s => s.put(v, key)); }
    catch { ls.set(key, v); }
  },
};

/** Просим браузер не удалять данные автоматически (где поддерживается). */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      return await navigator.storage.persist();
    }
    return true;
  } catch { return false; }
}

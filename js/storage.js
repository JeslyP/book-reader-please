// Tiny IndexedDB wrapper. Books (with their parsed text and reading position) live on this device only.

const DB_NAME = "read-aloud";
const STORE = "books";
const AUDIO = "audio";

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "id" });
      if (!d.objectStoreNames.contains(AUDIO)) d.createObjectStore(AUDIO, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn, store = STORE) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    t.onerror = () => reject(t.error);
  });
}

export const saveBook = (book) => tx("readwrite", (s) => s.put(book));
export const getBook = (id) => tx("readonly", (s) => s.get(id));
export const deleteBook = (id) => tx("readwrite", (s) => s.delete(id));

// The library list doesn't need every book's full text, so strip it out.
export async function listBooks() {
  const all = await tx("readonly", (s) => s.getAll());
  return all
    .map(({ sections, ...rest }) => rest)
    .sort((a, b) => (b.lastOpened || b.addedAt) - (a.lastOpened || a.addedAt));
}

export async function savePosition(id, position, progress) {
  const book = await getBook(id);
  if (!book) return;
  book.position = position;
  book.progress = progress;
  book.lastOpened = Date.now();
  await saveBook(book);
}

// ---- Saved AI audio, so listening to the same text again doesn't cost ElevenLabs credits.

const AUDIO_LIMIT = 500 * 1024 * 1024; // keep at most ~500 MB, dropping the oldest clips first

export async function getAudio(key) {
  try {
    return (await tx("readonly", (s) => s.get(key), AUDIO)) || null;
  } catch {
    return null;
  }
}

export async function putAudio(key, blob, times) {
  try {
    await tx("readwrite", (s) => s.put({ key, blob, times, size: blob.size, savedAt: Date.now() }), AUDIO);
    const { bytes } = await audioUsage();
    if (bytes > AUDIO_LIMIT) await trimAudio(bytes - AUDIO_LIMIT * 0.9);
  } catch {
    // Storage full or private mode: playing still works, it just won't be saved.
  }
}

async function trimAudio(bytesToFree) {
  const all = await tx("readonly", (s) => s.getAll(), AUDIO);
  all.sort((a, b) => a.savedAt - b.savedAt);
  const doomed = [];
  for (const clip of all) {
    if (bytesToFree <= 0) break;
    doomed.push(clip.key);
    bytesToFree -= clip.size;
  }
  await tx("readwrite", (s) => doomed.forEach((k) => s.delete(k)), AUDIO);
}

export async function audioUsage() {
  let bytes = 0, clips = 0;
  const d = await db();
  await new Promise((resolve, reject) => {
    const req = d.transaction(AUDIO).objectStore(AUDIO).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve();
      bytes += c.value.size || 0;
      clips++;
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return { bytes, clips };
}

export const clearAudio = () => tx("readwrite", (s) => s.clear(), AUDIO);

export const settings = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem("ra:" + key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem("ra:" + key, JSON.stringify(value));
    } catch {}
  },
};

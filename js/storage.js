// Tiny IndexedDB wrapper. Books (with their parsed text and reading position) live on this device only.

const DB_NAME = "read-aloud";
const STORE = "books";

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result?.result ?? result);
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

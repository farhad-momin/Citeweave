// Browser storage for the web version (IndexedDB). Everything stays in this browser
// unless the researcher turns on sync.
//
// Stores
//   kv       small values (settings, sync state)          key -> value
//   cache    API responses with expiry                    key -> {value, expires}
//   papers   paper records, shared by every feature       id  -> paper
//   records  everything the researcher creates and syncs  key -> {key, kind, id, updated_at, deleted, data}
//
// Record kinds (see web/SPEC.md): collection, member, note, tags, map, table, history.

const DB_NAME = "citeweave";
const DB_VERSION = 1;
let _db = null;
let _memory = null; // fallback when IndexedDB is unavailable (private windows, tests)

function memoryDb() {
  if (!_memory) _memory = { kv: new Map(), cache: new Map(), papers: new Map(), records: new Map() };
  return _memory;
}

function open() {
  if (_db) return _db;
  if (typeof indexedDB === "undefined") {
    _db = Promise.resolve(null);
    return _db;
  }
  _db = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("cache")) db.createObjectStore("cache");
      if (!db.objectStoreNames.contains("papers")) db.createObjectStore("papers", { keyPath: "id" });
      if (!db.objectStoreNames.contains("records")) {
        const s = db.createObjectStore("records", { keyPath: "key" });
        s.createIndex("kind", "kind", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return _db;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// IndexedDB stores and returns copies; the memory fallback does the same, so changing an
// object after saving it (or after reading it) never changes what is stored.
const copy = (v) => (v === undefined || v === null || typeof v !== "object" ? v : structuredClone(v));

async function tx(store, mode, fn) {
  const db = await open();
  if (!db) return copy(await fn(null, memoryDb()[store]));
  const t = db.transaction(store, mode);
  const s = t.objectStore(store);
  const out = await fn(s, null);
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  return out;
}

const keyOf = (store, v) => (store === "papers" ? v.id : store === "records" ? v.key : null);

async function get(store, key) {
  return tx(store, "readonly", (s, m) => (s ? wrap(s.get(key)) : m.get(key)));
}

async function put(store, value, key) {
  return tx(store, "readwrite", (s, m) => {
    if (s) return wrap(key === undefined ? s.put(value) : s.put(value, key));
    m.set(key === undefined ? keyOf(store, value) : key, copy(value));
    return null;
  });
}

async function putMany(store, values) {
  if (!values.length) return null;
  return tx(store, "readwrite", (s, m) => {
    for (const v of values) {
      if (s) s.put(v);
      else m.set(keyOf(store, v), copy(v));
    }
    return null;
  });
}

async function del(store, key) {
  return tx(store, "readwrite", (s, m) => (s ? wrap(s.delete(key)) : m.delete(key)));
}

async function all(store) {
  return tx(store, "readonly", (s, m) => (s ? wrap(s.getAll()) : [...m.values()]));
}

async function allKeys(store) {
  return tx(store, "readonly", (s, m) => (s ? wrap(s.getAllKeys()) : [...m.keys()]));
}

async function clear(store) {
  return tx(store, "readwrite", (s, m) => (s ? wrap(s.clear()) : m.clear()));
}

export const kv = {
  get: (k) => get("kv", k),
  set: (k, v) => put("kv", v, k),
  del: (k) => del("kv", k),
};

export const cache = {
  async get(key) {
    const hit = await get("cache", key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      del("cache", key).catch(() => {});
      return undefined;
    }
    return hit.value;
  },
  set: (key, value, ttlSeconds) => put("cache", { value, expires: Date.now() + ttlSeconds * 1000 }, key),
  async prune() {
    const now = Date.now();
    const keys = await allKeys("cache");
    for (const k of keys) {
      const v = await get("cache", k);
      if (!v || v.expires < now) await del("cache", k);
    }
  },
  clear: () => clear("cache"),
};

export const papers = {
  get: (id) => get("papers", id),
  put: (p) => put("papers", p),
  putMany: (ps) => putMany("papers", ps),
  all: () => all("papers"),
};

export const records = {
  get: (key) => get("records", key),
  put: (rec) => put("records", rec),
  putMany: (recs) => putMany("records", recs),
  del: (key) => del("records", key),
  async all(kind) {
    const rows = await all("records");
    return kind ? rows.filter((r) => r.kind === kind) : rows;
  },
  clear: () => clear("records"),
};

export function resetForTests() {
  _db = Promise.resolve(null);
  _memory = null;
}
